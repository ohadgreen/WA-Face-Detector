/* Puts the two InsightFace models the engine loads into models/.
   models/ is gitignored like vendor/: w600k_r50.onnx is 174MB, over GitHub's
   100MB file limit. Run automatically after `npm install`, or with `npm run models`.

   Sources, in order: an existing InsightFace install (~/.insightface/models/buffalo_l),
   then the buffalo_l release zip. Every file is checked against a pinned SHA-256:
   a wrong model does not fail, it silently gives plausible but poor scores. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'models');
const local = join(homedir(), '.insightface/models/buffalo_l');
const ZIP = 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip';

const models = {
  'det_10g.onnx': '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91',
  'w600k_r50.onnx': '4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43',
};

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const ok = (file, hash) => existsSync(file) && sha(readFileSync(file)) === hash;

// Just enough of the zip format to pull two entries out of buffalo_l.zip
// (no zip64: the archive is under 4GB), so there is no unzip dependency and
// no reliance on which tar the platform ships.
function unzip(zip, wanted) {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const found = {};
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = zip.readUInt16LE(eocd + 10); i > 0; i--) {
    const method = zip.readUInt16LE(p + 10), size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen).split('/').pop();
    if (wanted.includes(name)) {
      const h = zip.readUInt32LE(p + 42);
      const start = h + 30 + zip.readUInt16LE(h + 26) + zip.readUInt16LE(h + 28);
      const data = zip.subarray(start, start + size);
      found[name] = method === 0 ? data : inflateRawSync(data);
    }
    p = next;
  }
  return found;
}

mkdirSync(out, { recursive: true });
let missing = Object.keys(models).filter((f) => !ok(join(out, f), models[f]));

for (const f of [...missing]) {
  if (!ok(join(local, f), models[f])) continue;
  copyFileSync(join(local, f), join(out, f));
  console.log(`copied ${f} from ${local}`);
  missing = missing.filter((m) => m !== f);
}

if (missing.length) {
  console.log(`downloading ${ZIP} (~290MB) for ${missing.join(', ')}...`);
  try {
    const res = await fetch(ZIP);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const files = unzip(Buffer.from(await res.arrayBuffer()), missing);
    for (const f of missing) {
      if (!files[f]) { console.error(`${f} is not in the zip`); continue; }
      if (sha(files[f]) !== models[f]) { console.error(`${f}: SHA-256 mismatch, not saved`); continue; }
      writeFileSync(join(out, f), files[f]);
      console.log(`extracted ${f}`);
    }
  } catch (e) { console.error('download failed:', e.message); }
}

const have = Object.keys(models).filter((f) => ok(join(out, f), models[f])).length;
console.log(`models ${have}/${Object.keys(models).length} in models/`);
if (have < Object.keys(models).length) process.exitCode = 1;
