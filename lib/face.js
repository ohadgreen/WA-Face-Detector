/**
 * face.js - InsightFace (SCRFD + ArcFace) in plain JavaScript.
 *
 * Works in Node and the browser. Images are plain objects:
 *   { data: Uint8Array (RGB, w*h*3), width, height }
 *
 * The delicate parts, and the reason this is a module rather than inline code:
 *   - SCRFD anchor decoding (2 anchors per cell, strides 8/16/32)
 *   - the 5-point similarity-transform alignment ArcFace expects
 * Get either wrong and embeddings come out plausible but subtly useless.
 */

export const ARCFACE_DST = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
  [41.5493, 92.3655], [70.7299, 92.2041],
];

/** Bilinear resize using OpenCV's pixel-centre convention. */
export function resizeRGB(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 3);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(Math.floor(fy), sh - 1);
    const y1 = Math.min(y0 + 1, sh - 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.min(Math.floor(fx), sw - 1);
      const x1 = Math.min(x0 + 1, sw - 1);
      const wx = fx - x0;
      const i00 = (y0 * sw + x0) * 3, i01 = (y0 * sw + x1) * 3;
      const i10 = (y1 * sw + x0) * 3, i11 = (y1 * sw + x1) * 3;
      const o = (y * dw + x) * 3;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - wx) + src[i01 + c] * wx;
        const bot = src[i10 + c] * (1 - wx) + src[i11 + c] * wx;
        out[o + c] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return out;
}

function nms(dets, thresh) {
  const order = dets.map((d, i) => i).sort((a, b) => dets[b].score - dets[a].score);
  const keep = [];
  const area = (b) => (b[2] - b[0] + 1) * (b[3] - b[1] + 1);
  while (order.length) {
    const i = order.shift();
    keep.push(i);
    const bi = dets[i].bbox, ai = area(bi);
    for (let k = order.length - 1; k >= 0; k--) {
      const bj = dets[order[k]].bbox;
      const w = Math.max(0, Math.min(bi[2], bj[2]) - Math.max(bi[0], bj[0]) + 1);
      const h = Math.max(0, Math.min(bi[3], bj[3]) - Math.max(bi[1], bj[1]) + 1);
      const inter = w * h;
      if (inter / (ai + area(bj) - inter) > thresh) order.splice(k, 1);
    }
  }
  return keep.map((i) => dets[i]);
}

/**
 * @returns {Array<{bbox:[x1,y1,x2,y2], kps:number[][], score:number}>}
 */
export async function detect(session, img, opts = {}) {
  const { detSize = 640, thresh = 0.5, nmsThresh = 0.4, Tensor } = opts;
  const imRatio = img.height / img.width;
  let newW, newH;
  if (imRatio > 1) { newH = detSize; newW = Math.round(detSize / imRatio); }
  else { newW = detSize; newH = Math.round(detSize * imRatio); }
  const detScale = newH / img.height;

  const resized = resizeRGB(img.data, img.width, img.height, newW, newH);
  const n = detSize * detSize;
  const blob = new Float32Array(3 * n);
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const s = (y * newW + x) * 3, d = y * detSize + x;
      blob[d] = (resized[s] - 127.5) / 128;
      blob[n + d] = (resized[s + 1] - 127.5) / 128;
      blob[2 * n + d] = (resized[s + 2] - 127.5) / 128;
    }
  }

  const feeds = {};
  feeds[session.inputNames[0]] = new Tensor('float32', blob, [1, 3, detSize, detSize]);
  const out = await session.run(feeds);
  const names = session.outputNames;
  const fmc = 3, strides = [8, 16, 32], numAnchors = 2;

  const dets = [];
  for (let idx = 0; idx < fmc; idx++) {
    const stride = strides[idx];
    const scores = out[names[idx]].data;
    const bboxPreds = out[names[idx + fmc]].data;
    const kpsPreds = out[names[idx + fmc * 2]].data;
    const gw = Math.floor(detSize / stride);

    for (let i = 0; i < scores.length; i++) {
      if (scores[i] < thresh) continue;
      // anchors are duplicated consecutively: cell0,cell0,cell1,cell1,...
      const cell = Math.floor(i / numAnchors);
      const cx = (cell % gw) * stride;
      const cy = Math.floor(cell / gw) * stride;
      const b = i * 4;
      const bbox = [
        cx - bboxPreds[b] * stride, cy - bboxPreds[b + 1] * stride,
        cx + bboxPreds[b + 2] * stride, cy + bboxPreds[b + 3] * stride,
      ];
      const k = i * 10, kps = [];
      for (let j = 0; j < 5; j++) {
        kps.push([cx + kpsPreds[k + j * 2] * stride, cy + kpsPreds[k + j * 2 + 1] * stride]);
      }
      dets.push({ bbox, kps, score: scores[i] });
    }
  }

  return nms(dets, nmsThresh).map((d) => ({
    score: d.score,
    bbox: d.bbox.map((v) => v / detScale),
    kps: d.kps.map(([x, y]) => [x / detScale, y / detScale]),
  }));
}

/**
 * Least-squares 2D similarity transform (rotation + uniform scale + translation)
 * mapping src points onto dst. Same result as skimage SimilarityTransform,
 * which is what InsightFace uses to align faces before embedding.
 */
export function similarityTransform(src, dst) {
  const n = src.length;
  const mean = (pts, i) => pts.reduce((s, p) => s + p[i], 0) / n;
  const sxm = mean(src, 0), sym = mean(src, 1);
  const dxm = mean(dst, 0), dym = mean(dst, 1);
  let num = 0, den = 0, cross = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sxm, py = src[i][1] - sym;
    const qx = dst[i][0] - dxm, qy = dst[i][1] - dym;
    num += px * qx + py * qy;
    cross += px * qy - py * qx;
    den += px * px + py * py;
  }
  const a = num / den, b = cross / den;
  return [
    [a, -b, dxm - (a * sxm - b * sym)],
    [b, a, dym - (b * sxm + a * sym)],
  ];
}

function invertAffine(M) {
  const [[a, b, c], [d, e, f]] = M;
  const det = a * e - b * d;
  return [
    [e / det, -b / det, (b * f - e * c) / det],
    [-d / det, a / det, (d * c - a * f) / det],
  ];
}

/** Warp the face onto the canonical 112x112 ArcFace crop. */
export function normCrop(img, kps, size = 112) {
  const M = similarityTransform(kps, ARCFACE_DST);
  const I = invertAffine(M);
  const out = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = I[0][0] * x + I[0][1] * y + I[0][2];
      const sy = I[1][0] * x + I[1][1] * y + I[1][2];
      const o = (y * size + x) * 3;
      if (sx < 0 || sy < 0 || sx > img.width - 1 || sy > img.height - 1) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, img.width - 1), y1 = Math.min(y0 + 1, img.height - 1);
      const wx = sx - x0, wy = sy - y0;
      const i00 = (y0 * img.width + x0) * 3, i01 = (y0 * img.width + x1) * 3;
      const i10 = (y1 * img.width + x0) * 3, i11 = (y1 * img.width + x1) * 3;
      for (let c = 0; c < 3; c++) {
        const top = img.data[i00 + c] * (1 - wx) + img.data[i01 + c] * wx;
        const bot = img.data[i10 + c] * (1 - wx) + img.data[i11 + c] * wx;
        out[o + c] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return { data: out, width: size, height: size };
}

/** @returns {Float32Array} L2-normalised 512-d embedding. */
export async function embed(session, crop, Tensor) {
  const n = crop.width * crop.height;
  const blob = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    blob[i] = (crop.data[i * 3] - 127.5) / 127.5;
    blob[n + i] = (crop.data[i * 3 + 1] - 127.5) / 127.5;
    blob[2 * n + i] = (crop.data[i * 3 + 2] - 127.5) / 127.5;
  }
  const feeds = {};
  feeds[session.inputNames[0]] = new Tensor('float32', blob, [1, 3, crop.height, crop.width]);
  const out = await session.run(feeds);
  const v = out[session.outputNames[0]].data;
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  const e = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) e[i] = v[i] / norm;
  return e;
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Detect + embed every face big enough to be worth the cost. */
export async function analyse(detSession, recSession, img, opts = {}) {
  const { minFace = 40, Tensor } = opts;
  const faces = await detect(detSession, img, opts);
  const results = [];
  let skipped = 0;
  for (const f of faces) {
    const px = Math.min(f.bbox[2] - f.bbox[0], f.bbox[3] - f.bbox[1]);
    if (px < minFace) { skipped++; continue; }
    const crop = normCrop(img, f.kps);
    results.push({ ...f, px: Math.round(px), embedding: await embed(recSession, crop, Tensor) });
  }
  return { faces: results, detected: faces.length, skipped };
}
