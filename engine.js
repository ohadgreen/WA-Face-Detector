/* Offscreen document: the only place ONNX Runtime runs. The panel and the
   background both send it work over chrome.runtime. Offscreen documents get
   no chrome API except runtime, so it has no storage, tabs or UI. It reads
   the models from IndexedDB, which is on the same extension origin as the
   panel that stores them. */
import { analyse, cosine, embed } from './lib/face.js';

ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
ort.env.logLevel = 'error';
// Extension pages aren't cross-origin isolated, so SharedArrayBuffer is unavailable
// and the threaded build would abort. Pin to one thread.
ort.env.wasm.numThreads = 1;

/* ---------- model storage (read-only here; the panel writes it) ---------- */

const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('cpf-models', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('m');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idbGet = async (k) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction('m').objectStore('m').get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
};

/* ---------- images ---------- */

async function decode(dataUrl, maxSide = 2048) {
  const blob = await (await fetch(dataUrl)).blob();
  // Labelled so auto-watch skips this one photo instead of pausing: a file
  // the browser can't decode says nothing about the engine itself.
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    .catch((e) => { throw new Error('could not decode image: ' + (e?.message || e)); });
  let { width: w, height: h } = bmp;
  const longest = Math.max(w, h);
  if (longest > maxSide) { const s = maxSide / longest; w = Math.round(w * s); h = Math.round(h * s); }
  const cv = new OffscreenCanvas(w, h);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const d = cx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2]; }
  return { data: rgb, width: w, height: h };
}

/* ---------- sessions ---------- */

let detSession = null, recSession = null, info = null;

async function makeSession(buf, label, eps) {
  const notes = [];
  for (const ep of eps) {
    try {
      const s = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: [ep] });
      return { s, ep, notes };
    } catch (e) { notes.push(`${label}: ${ep} failed - ${String(e.message || e)}`); }
  }
  throw new Error(`${label}: no backend available (${notes.join('; ')})`);
}

// Time per face decides whether a WASM fallback is fast enough, so measure
// it once on load. The untimed first run also compiles the WebGPU shaders.
async function timeRecogniser() {
  const crop = { data: new Uint8Array(112 * 112 * 3), width: 112, height: 112 };
  await embed(recSession, crop, ort.Tensor);
  const t0 = performance.now();
  for (let i = 0; i < 3; i++) await embed(recSession, crop, ort.Tensor);
  return Math.round((performance.now() - t0) / 3);
}

async function ensureModels() {
  if (detSession && recSession) return true;
  const d = await idbGet('det'), r = await idbGet('rec');
  if (!d || !r) return false;
  // SCRFD uses an AveragePool variant WebGPU doesn't implement, so detector stays on WASM.
  const det = await makeSession(d, 'detector', ['wasm']);
  const rec = await makeSession(r, 'recogniser', ['webgpu', 'wasm']);
  detSession = det.s; recSession = rec.s;
  info = { det: det.ep, rec: rec.ep, notes: [...det.notes, ...rec.notes], recMs: await timeRecogniser() };
  console.log('[engine] models ready', info);
  return true;
}

async function needModels() {
  if (!(await ensureModels())) throw new Error('no models - set them up in the panel');
}

/* ---------- requests ---------- */

const ops = {
  async status() {
    const models = await ensureModels();
    return { models, gpu: 'gpu' in navigator, ...(info || {}) };
  },
  // The panel stored new model files: drop the sessions so the next call reloads.
  async reload() {
    await detSession?.release?.(); await recSession?.release?.();
    detSession = recSession = info = null;
    return true;
  },
  // Reference photos at setup: the largest face in each, any size.
  async embed({ dataUrls }) {
    await needModels();
    const out = [];
    for (const url of dataUrls) {
      const { faces } = await analyse(detSession, recSession, await decode(url),
        { Tensor: ort.Tensor, minFace: 0, detSize: 640 });
      if (!faces.length) { out.push({ ok: false, reason: 'no face' }); continue; }
      faces.sort((a, b) => b.px - a.px);
      out.push({ ok: true, px: faces[0].px, embedding: Array.from(faces[0].embedding) });
    }
    return out;
  },
  // One detection pass serves every watch on the photo; only the comparison
  // is per watch. Scoring is max over references, never the mean.
  async analyse({ dataUrl, watches }) {
    await needModels();
    const { faces, detected } = await analyse(detSession, recSession, await decode(dataUrl),
      { Tensor: ort.Tensor, minFace: 30, detSize: 640 });
    const results = watches.map((w) => {
      const refs = w.refs.map((r) => Float32Array.from(r));
      let best = 0, px = 0;
      for (const f of faces) for (const r of refs) {
        const c = cosine(r, f.embedding);
        if (c > best) { best = c; px = f.px; }
      }
      return { id: w.id, best, px };
    });
    return { detected, results };
  },
};

// One request at a time: the panel's manual scan and auto-watch share these
// sessions, and an ORT session must not run two inferences at once.
let chain = Promise.resolve();
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.__cpf !== 'engine') return;
  const op = ops[msg.op];
  const run = chain.then(() => {
    if (!op) throw new Error('unknown engine op: ' + msg.op);
    return op(msg.args || {});
  });
  chain = run.catch(() => {});
  run.then((result) => sendResponse({ ok: true, result }),
           (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});
