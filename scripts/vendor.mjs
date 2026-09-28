/* Copies third-party runtime files into vendor/.
   vendor/ is gitignored, so the repo stays small and the licences stay upstream.
   Run automatically after `npm install`, or manually with `npm run vendor`. */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
mkdirSync(vendor, { recursive: true });

const ort = join(root, 'node_modules/onnxruntime-web/dist');
const wa = join(root, 'node_modules/@wppconnect/wa-js/dist');

const files = [
  [join(wa, 'wppconnect-wa.js'), 'wa-js.js'],
  [join(ort, 'ort.all.min.js'), 'ort.all.min.js'],
  // plain build: the detector runs on WASM (SCRFD uses an AveragePool
  // variant the WebGPU backend doesn't implement)
  [join(ort, 'ort-wasm-simd-threaded.mjs'), 'ort-wasm-simd-threaded.mjs'],
  [join(ort, 'ort-wasm-simd-threaded.wasm'), 'ort-wasm-simd-threaded.wasm'],
  // jsep build: the recogniser runs on WebGPU when available
  [join(ort, 'ort-wasm-simd-threaded.jsep.mjs'), 'ort-wasm-simd-threaded.jsep.mjs'],
  [join(ort, 'ort-wasm-simd-threaded.jsep.wasm'), 'ort-wasm-simd-threaded.jsep.wasm'],
];

let n = 0;
for (const [src, name] of files) {
  if (!existsSync(src)) { console.error('missing:', src); process.exitCode = 1; continue; }
  copyFileSync(src, join(vendor, name));
  n++;
}
console.log(`vendored ${n}/${files.length} files into vendor/`);
