# Auto-watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New photos in watched WhatsApp groups are matched in the background, and the user gets a badge and a Windows notification when their child appears.

**Architecture:** All ONNX Runtime work moves from the side panel into an offscreen document (`engine.html`/`engine.js`), which the panel and the background service worker both call over `chrome.runtime`. `page.js` emits a metadata-only event for every new image and a `ready` event. `relay.js` forwards them to the background, which queues photos oldest first, runs them through the engine one at a time, and records matches as message ids. The cursor and queue rules are a pure module (`lib/auto-state.js`) with Node unit tests.

**Tech Stack:** Chrome MV3 (service worker as ES module, `chrome.offscreen`, `chrome.notifications`, `chrome.action` badge, `chrome.storage.local/session`), onnxruntime-web 1.30 (vendored), wa-js 4.6 (vendored), plain ES modules, Node 26 built-in test runner.

**Spec:** [docs/superpowers/specs/2026-09-29-auto-watch-design.md](../specs/2026-09-29-auto-watch-design.md). Read it before starting. This plan argues from it.

## Global Constraints

- AGENTS.md hard rules hold throughout: no programmatic sending; no remote code, no `eval`; never persist photos (queue stores message ids and scores only); no sender filtering; `vendor/` and `node_modules/` are never committed.
- No build step, no bundler, no new npm dependencies. Tests use `node:test` and `node:assert/strict` only.
- `lib/face.js` is not modified.
- Style: plain modern JS, semicolons, 2-space indent, single quotes. Comments explain *why*.
- `panel.js`, `engine.js`, `lib/*.js` and (from Task 5) `background.js` are ES modules. `page.js` and `relay.js` are classic scripts.
- `FIRST_SCAN_DAYS = 10` exists in both `panel.js` and `background.js`, each with a comment naming the other.
- Manifest version becomes `0.6` (Task 1) and stays there for this whole feature.
- Storage writers: `watches` is written only by the panel; `autoState`, `pending` and session `autoLog` only by the background.
- This folder is not a git repository. There are no commit steps; each task ends with a checkpoint instead.
- After changing `page.js` or `relay.js`: reload the extension **and** refresh WhatsApp Web. After `manifest.json`, `background.js` or `engine.*`: reload the extension. After `panel.*`: close and reopen the side panel.

## Review Focus

1. **Album photos share one timestamp.** Every photo in an album must be analysed, not just the first. Pinned by the "album siblings" test in Task 3.
2. **Background restarts mid-album.** Re-listing the photo at `lastChecked` must not add a duplicate match or skip the rest of the album. Pinned by the "restart mid-album" test in Task 3.
3. **A live photo reaches a watch before its first catch-up.** It must not move the watch past its 10-day window. Pinned by the "no autoState yet" test in Task 3.
4. **Two watches on one group at different cursors.** A photo is analysed only for the watches behind it, and catch-up lists from the one furthest behind. Pinned by the "two cursors" tests in Task 3.
5. **A match arrives while the user is reviewing.** "Mark as seen" must keep it waiting. Pinned by the `markSeen` test in Task 3 and step 8.8 in Task 8.

---

### Task 1: Engine page and the WebGPU check

Creates the offscreen engine with model loading only, and shows in the panel log which backend each model got and how long one face takes. **This task ends at a decision point with the owner.**

**Files:**
- Create: `engine.html`
- Create: `engine.js`
- Create: `scripts/check.mjs`
- Modify: `background.js` (append)
- Modify: `manifest.json` (`version`, `permissions`)
- Modify: `package.json` (`scripts`)
- Modify: `panel.js` (add `bg`/`engine` helpers after `callPage`; log engine status at startup)

**Interfaces:**
- Produces, `engine.js`: listens for `{ __cpf: 'engine', op, args }`, replies `{ ok: true, result }` or `{ ok: false, error }`. Ops: `status()` → `{ models: boolean, gpu: boolean, det?: 'wasm', rec?: 'webgpu'|'wasm', recMs?: number, notes?: string[] }`, and `reload()` → `true`. Requests run one at a time.
- Produces, `background.js`: listens for `{ __cpf: 'bg', op, args }`, replies `{ ok, result }` / `{ ok: false, error }`. Op: `ensureEngine()`. Also `async function ensureEngine()` for use inside the background.
- Produces, `panel.js`: `async function bg(op, args)` → `result`, and `async function engine(op, args)` → `result`. Both throw `Error` on failure.

- [ ] **Step 1.1: Add the static check script**

Create `scripts/check.mjs`:

```js
// Static checks that stand in for a build: every source file parses, and
// everything manifest.json points at exists. Run: npm run check
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
let bad = 0;

const referenced = [
  m.background.service_worker, m.side_panel.default_path,
  ...m.content_scripts.flatMap((c) => c.js), 'engine.html',
];
for (const f of referenced) {
  if (!existsSync(join(root, f))) { console.log('MISSING', f); bad++; }
}

const sources = ['background.js', 'engine.js', 'page.js', 'panel.js', 'relay.js',
  'lib/face.js', 'lib/auto-state.js'];
for (const f of sources) {
  if (!existsSync(join(root, f))) continue;
  try { execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' }); }
  catch (e) { console.log('SYNTAX', f, '\n' + e.stderr); bad++; }
}

console.log(bad ? `${bad} problem(s)`
  : `ok - manifest ${m.version}, permissions: ${m.permissions.join(', ')}`);
process.exit(bad ? 1 : 0);
```

In `package.json`, replace the `scripts` block with:

```json
  "scripts": {
    "vendor": "node scripts/vendor.mjs",
    "postinstall": "node scripts/vendor.mjs",
    "check": "node scripts/check.mjs",
    "test": "node --test tests/"
  },
```

- [ ] **Step 1.2: Run the check to see it fail**

Run: `npm run check`
Expected: `MISSING engine.html`, `1 problem(s)`, exit code 1.

- [ ] **Step 1.3: Create the engine page**

Create `engine.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Class Photo Filter engine</title>
<script src="vendor/ort.all.min.js"></script>
<script type="module" src="engine.js"></script>
```

Create `engine.js`:

```js
/* Offscreen document: the only place ONNX Runtime runs. The panel and the
   background both send it work over chrome.runtime. Offscreen documents get
   no chrome API except runtime, so it has no storage, tabs or UI. It reads
   the models from IndexedDB, which is on the same extension origin as the
   panel that stores them. */
import { embed } from './lib/face.js';

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
```

- [ ] **Step 1.4: Let the background create the engine**

Append to `background.js` (below the existing `chrome.commands` listener):

```js

/* ---------- engine (offscreen document) ---------- */

// Created on demand, then left open. Chrome allows one offscreen document per
// extension; `creating` stops two callers racing to create it.
let creating = null;
async function ensureEngine() {
  const have = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (have.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: 'engine.html',
    reasons: ['WORKERS'],
    justification: 'On-device face recognition for watched groups',
  }).finally(() => { creating = null; });
  await creating;
}

/* ---------- requests from the panel ---------- */

const bgOps = {
  ensureEngine,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.__cpf !== 'bg') return;
  const op = bgOps[msg.op];
  Promise.resolve()
    .then(() => {
      if (!op) throw new Error('unknown background op: ' + msg.op);
      return op(msg.args || {});
    })
    .then((result) => sendResponse({ ok: true, result: result ?? null }),
          (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});
```

- [ ] **Step 1.5: Manifest permission and version**

In `manifest.json`, change `"version": "0.5"` to `"version": "0.6"`, and change the `permissions` array to:

```json
  "permissions": [
    "storage",
    "sidePanel",
    "tabs",
    "offscreen"
  ],
```

- [ ] **Step 1.6: Panel helpers and the status line**

In `panel.js`, directly after the `callPage` function (the block ending `return res.result;\n}` under `/* ---------- talking to the page ---------- */`), insert:

```js

/* ---------- the background and the engine ---------- */

async function bg(op, args) {
  const res = await chrome.runtime.sendMessage({ __cpf: 'bg', op, args });
  if (!res?.ok) throw new Error('background: ' + (res?.error || 'no answer'));
  return res.result;
}

// Recognition runs in the offscreen engine (engine.js). The background owns
// its lifecycle, so make sure it exists before each call.
async function engine(op, args) {
  await bg('ensureEngine');
  const res = await chrome.runtime.sendMessage({ __cpf: 'engine', op, args });
  if (!res) throw new Error('engine did not answer');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

async function logEngine() {
  const s = await engine('status');
  if (!s.models) { log('engine: models not set up'); return; }
  log(`engine: detector ${s.det}, recogniser ${s.rec} (${s.recMs}ms/face,` +
      ` navigator.gpu ${s.gpu ? 'present' : 'absent'})`);
  for (const n of s.notes) log('  ' + n);
}
```

In the startup block at the bottom of `panel.js`, change:

```js
  try { const p = await callPage('ping'); log(`connected to WhatsApp (wa-js ${p.version})`); }
  catch (e) { log(e.message); }
  await renderWatches();
```

to:

```js
  try { const p = await callPage('ping'); log(`connected to WhatsApp (wa-js ${p.version})`); }
  catch (e) { log(e.message); }
  await logEngine().catch((e) => log('engine: ' + e.message));
  await renderWatches();
```

- [ ] **Step 1.7: Run the static check**

Run: `npm run check`
Expected: `ok - manifest 0.6, permissions: storage, sidePanel, tabs, offscreen`, exit code 0.

- [ ] **Step 1.8: See it in Chrome**

Reload the extension at `chrome://extensions`, then open the side panel.
Expected in the panel log, after the `connected to WhatsApp` line:
`engine: detector wasm, recogniser webgpu (NNms/face, navigator.gpu present)`.
`chrome://extensions` now lists **Inspect views: engine.html** under the extension. Its console shows `[engine] models ready {…}`.

If instead the line says `recogniser wasm`, the lines under it give the reason for the WebGPU failure.

- [ ] **Step 1.9: Checkpoint with the owner — STOP**

Report the exact engine line (backend, ms/face, `navigator.gpu`) and any note lines. For comparison, the panel's old manual scan ran at about 1.5 s per photo with the recogniser on WebGPU.
- If the recogniser is on **webgpu**, continue to Task 2.
- If it is on **wasm**, tell the owner the ms/face figure. A class-photo burst is about 30 photos with a few faces each. Wait for the owner to decide before continuing.

---

### Task 2: Move recognition from the panel to the engine

Setup embedding and the manual scan both run in the engine. The panel keeps model *storage* and thumbnails.

**Files:**
- Modify: `engine.js` (import line, `decode`, `needModels`, `embed` and `analyse` ops)
- Modify: `panel.js` (remove ORT code, `decode`, and the `lib/face.js` import; use `engine()`)
- Modify: `panel.html` (remove the ORT script tag)

**Interfaces:**
- Consumes: `engine(op, args)`, `bg(op, args)` (Task 1).
- Produces, engine ops:
  - `embed({ dataUrls: string[] })` → `Array<{ ok: true, px: number, embedding: number[] } | { ok: false, reason: 'no face' }>`. Uses the largest face per photo, `minFace: 0`.
  - `analyse({ dataUrl: string, watches: Array<{ id: string, refs: number[][], threshold: number }> })` → `{ detected: number, results: Array<{ id: string, best: number, px: number }> }`. Uses `minFace: 30`.
  - Both throw `Error('no models - set them up in the panel')` when the models are missing. The background matches `/no models/i`.

- [ ] **Step 2.1: Engine ops**

In `engine.js`, change `import { embed } from './lib/face.js';` to:

```js
import { analyse, cosine, embed } from './lib/face.js';
```

Below the `idbGet` definition, add `decode`, moved verbatim from `panel.js`:

```js

/* ---------- images ---------- */

async function decode(dataUrl, maxSide = 2048) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
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
```

Below `ensureModels`, add:

```js

async function needModels() {
  if (!(await ensureModels())) throw new Error('no models - set them up in the panel');
}
```

Add these two entries inside the `ops` object, after `reload`:

```js
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
```

- [ ] **Step 2.2: Remove ORT from the panel**

In `panel.html`, delete the line `<script src="vendor/ort.all.min.js"></script>`.

In `panel.js`:
1. Delete line 1, `import { analyse, cosine } from './lib/face.js';`.
2. Delete the ORT setup block: the lines from `ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');` through `ort.env.wasm.numThreads = 1;`, including the two comment lines between them.
3. Replace everything from `let detSession = null, recSession = null;` through the end of `async function ensureModels() { … }` with:

```js
// Recognition runs in the engine (engine.js); this only asks whether it has models.
const ensureModels = async () => (await engine('status')).models;
```

4. In the model file `change` handler, replace `detSession = recSession = null;` with:

```js
    await engine('reload');
```

5. Delete the whole `async function decode(dataUrl, maxSide = 2048) { … }`. Keep `thumbnail`.

- [ ] **Step 2.3: Setup embeds through the engine**

In the `addWatch` click handler in `panel.js`, replace:

```js
    log(`embedding ${files.length} reference photo(s)...`);
    const refs = [];
    for (const f of files) {
      const img = await decode(await fileToDataUrl(f));
      const { faces } = await analyse(detSession, recSession, img,
        { Tensor: ort.Tensor, minFace: 0, detSize: 640 });
      if (!faces.length) { log(`  no face in ${f.name}, skipped`); continue; }
      faces.sort((a, b) => b.px - a.px);
      refs.push(Array.from(faces[0].embedding));
      log(`  ${f.name}: ok (${faces[0].px}px)`);
    }
```

with:

```js
    log(`embedding ${files.length} reference photo(s)...`);
    const dataUrls = [];
    for (const f of files) dataUrls.push(await fileToDataUrl(f));
    const refs = [];
    (await engine('embed', { dataUrls })).forEach((r, i) => {
      if (!r.ok) { log(`  no face in ${files[i].name}, skipped`); return; }
      refs.push(r.embedding);
      log(`  ${files[i].name}: ok (${r.px}px)`);
    });
```

- [ ] **Step 2.4: Manual scan analyses through the engine**

In `scan(w)` in `panel.js`, delete the line `const refs = w.refs.map((r) => Float32Array.from(r));`, and replace:

```js
      const img = await decode(dataUrl);
      const { faces, detected } = await analyse(detSession, recSession, img,
        { Tensor: ort.Tensor, minFace: 30, detSize: 640 });
      let best = 0, px = 0;
      for (const f of faces) for (const r of refs) {
        const c = cosine(r, f.embedding);
        if (c > best) { best = c; px = f.px; }
      }
```

with:

```js
      const { detected, results: [{ best, px }] } = await engine('analyse',
        { dataUrl, watches: [{ id: w.id, refs: w.refs, threshold: w.threshold }] });
```

- [ ] **Step 2.5: Static check and leftovers**

Run: `npm run check`
Expected: `ok - manifest 0.6, …`.

Search `panel.js` for leftovers: `ort\.|detSession|recSession|decode\(|cosine|analyse\(`.
Expected: no matches. (`engine('analyse'` does not match `analyse\(`.)

- [ ] **Step 2.6: Parity check — matching must be unchanged**

Reload the extension and open the side panel. In **Setup**, pick `car_ref1.jpg` in *Reference photos of that child*, but don't save. Right-click the panel → Inspect → Console, and run:

```js
const f = document.getElementById('refFiles').files[0];
const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
await chrome.runtime.sendMessage({ __cpf: 'bg', op: 'ensureEngine' });
const [e] = (await chrome.runtime.sendMessage({ __cpf: 'engine', op: 'embed', args: { dataUrls: [url] } })).result;
const { watches } = await chrome.storage.local.get('watches');
const ref = watches.find((w) => w.name === 'carmel').refs[0];
console.log('cosine vs stored ref:', e.embedding.reduce((s, v, i) => s + v * ref[i], 0).toFixed(5), e.px + 'px');
```

Expected: `cosine vs stored ref: 0.999xx` or higher, and `270px`. Those match the original setup log, where `refs[0]` came from `car_ref1.jpg` at 270px. If the recogniser changed backend since setup (WebGPU vs WASM), ≥ 0.998 is acceptable. Anything lower means the move changed the preprocessing, so stop and investigate.

Clear the file input afterwards (reopen the panel).

- [ ] **Step 2.7: Manual scan still works**

On the **Photos** tab, start *Find carmel in N new photos*, let 5 or more photos run, then press **Stop scan**.
Expected: per-photo lines in the same form as before (`[k/N] F faces, best 0.xxx  S.Ss/photo`), at roughly the old speed, and a review card showing whatever matched.

- [ ] **Step 2.8: Checkpoint**

No commit (not a git repository). Record the parity cosine and the s/photo figure in the task report.

---

### Task 3: Queue and cursor rules (`lib/auto-state.js`), test-first

Pure functions with no `chrome.*` calls, so they can run under Node.

**Files:**
- Create: `tests/auto-state.test.js`
- Create: `lib/auto-state.js`

**Interfaces:**
- Produces (all exported from `lib/auto-state.js`). Types used below:
  - `Watch = { id, name, src, srcName, threshold, refs, lastSeen, auto? }`
  - `Photo = { id: string, chatId: string, t: number }`
  - `Cursor = { lastChecked: number, atChecked: string[] }`, where `atChecked` holds the ids already analysed at exactly `lastChecked`
  - `AutoState = { [watchId]: Cursor }`
  - `Pending = { [watchId]: Array<{ id, t, score, px }> }`
- Exports:
  - `isAuto(w) → boolean`: `w.auto !== false`.
  - `initState(w, nowSec, days) → Cursor`: `{ lastChecked: w.lastSeen || nowSec - days*86400, atChecked: [] }`.
  - `catchUpSince(watches, autoState, src) → number | null`: the smallest `lastChecked - 1` among auto watches on `src` that have state; `null` if there are none.
  - `targetsFor(watches, autoState, photo) → Watch[]`: auto watches on `photo.chatId` that have state and haven't analysed this photo yet.
  - `class PhotoQueue`: `add(photos) → number added`, `peek() → Photo | undefined`, `shift() → Photo | undefined`, `size`. It keeps photos ordered by `t` and ignores a photo already *in* the queue.
  - `recordResult({ autoState, pending }, photo, results, targets) → { autoState, pending, matched: string[] }`
  - `skipResult({ autoState, pending }, photo, targets) → { autoState, pending, matched: [] }`
  - `markSeen(pending, watchId, ids) → Pending`
  - `forget({ autoState, pending }, watchId) → { autoState, pending }`
  - `pendingTotal(pending) → number`
  - `class Batcher(intervalMs = 60000)`: `add(watchId, nowMs)`, `due(nowMs, drained) → Array<{ watchId, n }>`
  - `notifyText(w, n) → string`

- [ ] **Step 3.1: Write the failing tests**

Create `tests/auto-state.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuto, initState, catchUpSince, targetsFor, PhotoQueue,
  recordResult, skipResult, markSeen, forget, pendingTotal, Batcher, notifyText,
} from '../lib/auto-state.js';

const G = 'g1@g.us';
const W = (id, over = {}) => ({
  id, name: 'kid-' + id, src: G, srcName: 'Class', threshold: 0.35, refs: [], lastSeen: 0, ...over,
});
const P = (id, t, chatId = G) => ({ id, chatId, t });
const C = (lastChecked, atChecked = []) => ({ lastChecked, atChecked });
const hit = (id, best, px = 60) => ({ id, best, px });

test('isAuto: missing flag means on, false means off', () => {
  assert.equal(isAuto(W('a')), true);
  assert.equal(isAuto(W('a', { auto: true })), true);
  assert.equal(isAuto(W('a', { auto: false })), false);
});

test('initState: lastSeen wins, otherwise the first-scan window', () => {
  assert.deepEqual(initState(W('a', { lastSeen: 500 }), 10_000_000, 10), C(500));
  assert.deepEqual(initState(W('a'), 10_000_000, 10), C(10_000_000 - 864_000));
});

test('catchUpSince: one second before the watch furthest behind on that group (two cursors)', () => {
  const ws = [W('a'), W('b'), W('c', { src: 'g2@g.us' })];
  const st = { a: C(300), b: C(200), c: C(50) };
  assert.equal(catchUpSince(ws, st, G), 199);
  assert.equal(catchUpSince(ws, st, 'g2@g.us'), 49);
});

test('catchUpSince: null when no initialised auto watch is on that group', () => {
  assert.equal(catchUpSince([W('a', { auto: false })], { a: C(100) }, G), null);
  assert.equal(catchUpSince([W('a')], {}, G), null);
});

test('targetsFor: a watch with no autoState yet is skipped (no autoState yet)', () => {
  const t = targetsFor([W('a'), W('b')], { a: C(100) }, P('m1', 150));
  assert.deepEqual(t.map((w) => w.id), ['a']);
});

test('targetsFor: other chats, manual watches and photos already behind the cursor are excluded', () => {
  const ws = [W('a'), W('b', { auto: false }), W('c', { src: 'g2@g.us' })];
  const st = { a: C(100), b: C(0), c: C(0) };
  assert.deepEqual(targetsFor(ws, st, P('m1', 150)).map((w) => w.id), ['a']);
  assert.deepEqual(targetsFor(ws, st, P('m0', 90)), []);
});

test('targetsFor: only the watches behind the photo (two cursors)', () => {
  const t = targetsFor([W('a'), W('b')], { a: C(100), b: C(300) }, P('m1', 200));
  assert.deepEqual(t.map((w) => w.id), ['a']);
});

test('album siblings sharing a timestamp are all analysed', () => {
  const ws = [W('a')];
  let s = { autoState: { a: C(90) }, pending: {} };
  const p1 = P('m1', 100), p2 = P('m2', 100);
  s = recordResult(s, p1, [hit('a', 0.5)], targetsFor(ws, s.autoState, p1));
  const t2 = targetsFor(ws, s.autoState, p2);
  assert.deepEqual(t2.map((w) => w.id), ['a']);
  s = recordResult(s, p2, [hit('a', 0.6)], t2);
  assert.deepEqual(s.pending.a.map((x) => x.id), ['m1', 'm2']);
  assert.deepEqual(s.autoState.a, C(100, ['m1', 'm2']));
});

test('restart mid-album: re-listing at lastChecked skips done siblings, keeps the rest', () => {
  const ws = [W('a')];
  let s = { autoState: { a: C(90) }, pending: {} };
  const p1 = P('m1', 100), p2 = P('m2', 100);
  s = recordResult(s, p1, [hit('a', 0.5)], targetsFor(ws, s.autoState, p1));
  // Background restarts: catch-up lists from lastChecked - 1, so both siblings come back.
  assert.equal(catchUpSince(ws, s.autoState, G), 99);
  assert.deepEqual(targetsFor(ws, s.autoState, p1), []);
  assert.deepEqual(targetsFor(ws, s.autoState, p2).map((w) => w.id), ['a']);
  // Even if m1 were analysed again, pending would not duplicate it.
  s = recordResult(s, p1, [hit('a', 0.5)], ws);
  assert.equal(s.pending.a.length, 1);
});

test('recordResult: a newer photo resets atChecked', () => {
  const s = recordResult({ autoState: { a: C(100, ['m1']) }, pending: {} }, P('m9', 120), [hit('a', 0.1)], [W('a')]);
  assert.deepEqual(s.autoState.a, C(120, ['m9']));
});

test('recordResult: below threshold advances the cursor without a match', () => {
  const s = recordResult({ autoState: { a: C(90) }, pending: {} }, P('m1', 100), [hit('a', 0.2)], [W('a')]);
  assert.deepEqual(s.matched, []);
  assert.deepEqual(s.pending, {});
  assert.equal(s.autoState.a.lastChecked, 100);
});

test('recordResult: the cursor never moves backwards', () => {
  const s = recordResult({ autoState: { a: C(200) }, pending: {} }, P('m1', 150), [hit('a', 0.9)], [W('a')]);
  assert.deepEqual(s.autoState.a, C(200));
});

test('recordResult: per-watch thresholds, reports which watches matched', () => {
  const ws = [W('a', { threshold: 0.35 }), W('b', { threshold: 0.5 })];
  const s = recordResult({ autoState: { a: C(0), b: C(0) }, pending: {} }, P('m1', 100),
    [hit('a', 0.4, 70), hit('b', 0.4, 70)], ws);
  assert.deepEqual(s.matched, ['a']);
  assert.deepEqual(s.pending, { a: [{ id: 'm1', t: 100, score: 0.4, px: 70 }] });
  assert.equal(s.autoState.b.lastChecked, 100);
});

test('recordResult does not mutate its input', () => {
  const input = { autoState: { a: C(90) }, pending: {} };
  recordResult(input, P('m1', 100), [hit('a', 0.9)], [W('a')]);
  assert.deepEqual(input, { autoState: { a: C(90) }, pending: {} });
});

test('skipResult advances the cursor only', () => {
  const s = skipResult({ autoState: { a: C(90) }, pending: {} }, P('m1', 100), [W('a')]);
  assert.deepEqual(s.matched, []);
  assert.deepEqual(s.pending, {});
  assert.deepEqual(s.autoState.a, C(100, ['m1']));
});

test('PhotoQueue: oldest first, a photo already queued is not added twice', () => {
  const q = new PhotoQueue();
  assert.equal(q.add([P('m3', 300), P('m1', 100)]), 2);
  assert.equal(q.add([P('m2', 200), P('m1', 100)]), 1);
  assert.equal(q.size, 3);
  assert.deepEqual([q.shift(), q.shift(), q.shift()].map((p) => p.id), ['m1', 'm2', 'm3']);
  assert.equal(q.peek(), undefined);
});

test('PhotoQueue: a photo taken off the queue can be queued again (reset, new watch)', () => {
  const q = new PhotoQueue();
  q.add([P('m1', 100)]);
  q.shift();
  assert.equal(q.add([P('m1', 100)]), 1);
});

test('markSeen removes only the reviewed ids', () => {
  const pending = { a: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], b: [{ id: 'x' }] };
  assert.deepEqual(markSeen(pending, 'a', ['m1', 'm2']), { a: [{ id: 'm3' }], b: [{ id: 'x' }] });
  assert.deepEqual(markSeen(pending, 'a', ['m1', 'm2', 'm3']), { b: [{ id: 'x' }] });
  assert.equal(pending.a.length, 3);
});

test('forget drops a watch from both maps', () => {
  const s = forget({ autoState: { a: C(1), b: C(2) }, pending: { a: [{ id: 'm1' }] } }, 'a');
  assert.deepEqual(s, { autoState: { b: C(2) }, pending: {} });
});

test('pendingTotal sums every watch', () => {
  assert.equal(pendingTotal({}), 0);
  assert.equal(pendingTotal({ a: [{}, {}], b: [{}] }), 3);
});

test('Batcher: nothing due mid-batch, everything due when drained', () => {
  const b = new Batcher(60_000);
  b.add('a', 1_000); b.add('a', 2_000); b.add('b', 3_000);
  assert.deepEqual(b.due(10_000, false), []);
  assert.deepEqual(b.due(10_000, true), [{ watchId: 'a', n: 2 }, { watchId: 'b', n: 1 }]);
  assert.deepEqual(b.due(20_000, true), []);
});

test('Batcher: a long batch is announced once its first match is a minute old', () => {
  const b = new Batcher(60_000);
  b.add('a', 0); b.add('a', 30_000);
  assert.deepEqual(b.due(59_999, false), []);
  assert.deepEqual(b.due(60_000, false), [{ watchId: 'a', n: 2 }]);
  b.add('a', 61_000);
  assert.deepEqual(b.due(62_000, false), []);
});

test('notifyText', () => {
  assert.equal(notifyText(W('a', { name: 'carmel', srcName: 'כיתה א2' }), 1), '1 new photo of carmel in כיתה א2');
  assert.equal(notifyText(W('a', { name: 'carmel', srcName: 'כיתה א2' }), 3), '3 new photos of carmel in כיתה א2');
});
```

- [ ] **Step 3.2: Run the tests to see them fail**

Run: `npm test`
Expected: FAIL. The test file cannot load: `Cannot find module …/lib/auto-state.js`.

- [ ] **Step 3.3: Implement**

Create `lib/auto-state.js`:

```js
/* Background auto-watch rules, kept free of chrome.* so they can be unit
   tested in Node (tests/auto-state.test.js). background.js does the I/O.

   Each watch has a cursor: lastChecked (unix seconds of the newest photo
   analysed) plus atChecked (ids already analysed at exactly that second).
   Photos in one album share a timestamp, so the time alone can't say which
   siblings are done. */

export const isAuto = (w) => w.auto !== false;

/** Where a watch starts: where the user last reviewed, or `days` back. */
export const initState = (w, nowSec, days) => ({
  lastChecked: w.lastSeen || nowSec - days * 86400,
  atChecked: [],
});

/** `since` for listNewImages (which returns t > since): one second before
    the watch on `src` that is furthest behind, so photos at exactly
    lastChecked are listed again and atChecked decides. */
export function catchUpSince(watches, autoState, src) {
  const cursors = watches
    .filter((w) => isAuto(w) && w.src === src && autoState[w.id])
    .map((w) => autoState[w.id].lastChecked);
  return cursors.length ? Math.min(...cursors) - 1 : null;
}

const notYetChecked = (c, photo) =>
  photo.t > c.lastChecked || (photo.t === c.lastChecked && !c.atChecked.includes(photo.id));

/** Watches this photo still needs analysing for. A watch with no cursor is
    left alone until catch-up initialises it, so a live photo can't jump it
    past its first-scan window. */
export const targetsFor = (watches, autoState, photo) =>
  watches.filter((w) => isAuto(w) && w.src === photo.chatId
    && autoState[w.id] && notYetChecked(autoState[w.id], photo));

function advance(c, photo) {
  if (photo.t > c.lastChecked) return { lastChecked: photo.t, atChecked: [photo.id] };
  if (photo.t === c.lastChecked && !c.atChecked.includes(photo.id)) {
    return { lastChecked: c.lastChecked, atChecked: [...c.atChecked, photo.id] };
  }
  return c;
}

/** Photos waiting to be analysed, oldest first. Only de-duplicates against
    what is still queued: a photo taken off can come back (after a reset, or
    for a newly added watch), and targetsFor decides whether it needs work. */
export class PhotoQueue {
  #items = [];
  #queued = new Set();

  add(photos) {
    let added = 0;
    for (const p of photos) {
      if (this.#queued.has(p.id)) continue;
      this.#queued.add(p.id);
      this.#items.push(p);
      added++;
    }
    this.#items.sort((a, b) => a.t - b.t);
    return added;
  }

  peek() { return this.#items[0]; }

  shift() {
    const p = this.#items.shift();
    if (p) this.#queued.delete(p.id);
    return p;
  }

  get size() { return this.#items.length; }
}

/** Apply one analysed photo: advance every target's cursor, and queue a
    match for each target at or above its own threshold. Pending holds ids
    and scores only - never images. */
export function recordResult({ autoState, pending }, photo, results, targets) {
  const a = { ...autoState }, p = { ...pending }, matched = [];
  for (const w of targets) {
    a[w.id] = advance(a[w.id] || { lastChecked: 0, atChecked: [] }, photo);
    const r = results.find((x) => x.id === w.id);
    if (!r || r.best < w.threshold) continue;
    const list = p[w.id] || [];
    if (list.some((x) => x.id === photo.id)) continue;
    p[w.id] = [...list, { id: photo.id, t: photo.t, score: r.best, px: r.px }];
    matched.push(w.id);
  }
  return { autoState: a, pending: p, matched };
}

/** A photo that can't be fetched (expired media): move past it. */
export const skipResult = (state, photo, targets) => recordResult(state, photo, [], targets);

/** Remove the reviewed ids only; matches that arrived during review stay. */
export function markSeen(pending, watchId, ids) {
  const p = { ...pending };
  const keep = (p[watchId] || []).filter((x) => !ids.includes(x.id));
  if (keep.length) p[watchId] = keep; else delete p[watchId];
  return p;
}

export function forget({ autoState, pending }, watchId) {
  const a = { ...autoState }, p = { ...pending };
  delete a[watchId]; delete p[watchId];
  return { autoState: a, pending: p };
}

export const pendingTotal = (pending) =>
  Object.values(pending).reduce((n, list) => n + list.length, 0);

/** One notification per batch: a watch's matches are announced when the
    queue drains, or once the batch's first match is `intervalMs` old. */
export class Batcher {
  #batches = new Map();

  constructor(intervalMs = 60_000) { this.intervalMs = intervalMs; }

  add(watchId, nowMs) {
    const b = this.#batches.get(watchId);
    if (b) b.n++; else this.#batches.set(watchId, { n: 1, since: nowMs });
  }

  due(nowMs, drained) {
    const out = [];
    for (const [watchId, b] of this.#batches) {
      if (!drained && nowMs - b.since < this.intervalMs) continue;
      out.push({ watchId, n: b.n });
      this.#batches.delete(watchId);
    }
    return out;
  }
}

export const notifyText = (w, n) =>
  `${n} new photo${n === 1 ? '' : 's'} of ${w.name} in ${w.srcName}`;
```

- [ ] **Step 3.4: Run the tests to see them pass**

Run: `npm test`
Expected: all 23 tests pass, `# fail 0`.

- [ ] **Step 3.5: Static check**

Run: `npm run check`
Expected: `ok - manifest 0.6, …`.

- [ ] **Step 3.6: Checkpoint**

No commit. Paste the `npm test` summary into the task report.

---

### Task 4: Page events and the relay's return pipe

**Files:**
- Modify: `page.js` (just before the final `console.log`)
- Modify: `relay.js` (append)

**Interfaces:**
- Produces: `chrome.runtime.sendMessage({ __cpf: 'evt', type: 'ready' })` once wa-js is ready, and `{ __cpf: 'evt', type: 'newImage', data: { id: string, chatId: string, t: number } }` for every incoming or outgoing image in any chat. `chatId` uses the same format as `listGroups` ids (`…@g.us`). The sender's `sender.tab` is the WhatsApp tab.

- [ ] **Step 4.1: Emit events from the page**

In `page.js`, insert directly above the final `console.log('%c[class-photo-filter]'…` line:

```js
  /* Events for the background's auto-watch. Metadata only: the image itself
     is fetched later with downloadImage, one at a time. Every chat's images
     are reported, because only the background knows which chats are watched. */
  const emit = (type, data) => window.postMessage({ __cpf: 'evt', type, data }, '*');
  ready.then(() => {
    emit('ready');
    WPP.on('chat.new_message', (m) => {
      if (m?.type !== 'image') return;
      emit('newImage', { id: String(m.id), chatId: String(m.id.remote), t: m.t });
    });
  });
```

- [ ] **Step 4.2: Forward them from the relay**

Append to `relay.js`:

```js

// The other direction: page events (new images, ready) go to the background.
// Still a pipe - which chats matter is decided there.
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.__cpf !== 'evt') return;
  try {
    chrome.runtime.sendMessage({ __cpf: 'evt', type: e.data.type, data: e.data.data })
      .catch(() => {}); // no listener awake yet; the next event or catch-up covers it
  } catch { /* extension was reloaded; this tab needs a refresh to reconnect */ }
});
```

- [ ] **Step 4.3: Static check**

Run: `npm run check`
Expected: `ok - …`.

- [ ] **Step 4.4: See the events arrive**

Reload the extension. Open the background console (`chrome://extensions` → *service worker*) and run:

```js
chrome.runtime.onMessage.addListener((m, s) => { if (m.__cpf === 'evt') console.log(m, s.tab?.id); });
```

Refresh WhatsApp Web.
Expected: `{__cpf: 'evt', type: 'ready'}` with a tab id.

From your phone, send any image to *Message yourself*.
Expected: `{__cpf: 'evt', type: 'newImage', data: {id: '…', chatId: '…@c.us', t: …}}`. (That listener is temporary and disappears when the service worker stops.)

- [ ] **Step 4.5: Checkpoint**

No commit.

---

### Task 5: The background loop

Catch-up, the queue, one photo at a time, `pending`, the badge, and the `[auto]` log. Notifications come in Task 6.

**Files:**
- Modify: `manifest.json` (`background.type`)
- Modify: `background.js` (becomes a module, adds everything below)
- Modify: `panel.js` (comment on `FIRST_SCAN_DAYS`)

**Interfaces:**
- Consumes: `lib/auto-state.js` (Task 3); `ensureEngine`/`bgOps` (Task 1); engine `analyse` (Task 2); page actions `listNewImages({ chatId, since }) → { fresh: [{ id, t, … }] }` and `downloadImage({ id }) → { dataUrl }`; `evt` messages (Task 4).
- Produces:
  - Background ops: `catchUp()` → `true` (starts catch-up without waiting for it), `markSeen({ watchId, ids })` → `true`, `reset({ watchId })` → `true` (forgets the watch's state and starts catch-up).
  - Storage: `local.autoState` and `local.pending` in the shapes defined in Task 3, and `session.autoLog: Array<{ n: number, s: string }>` (the last 200 entries, `n` increasing).
  - A function hook `onMatch(watchId)`, empty in this task, which Task 6 fills.

- [ ] **Step 5.1: Service worker as a module**

In `manifest.json`, change the `background` block to:

```json
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
```

- [ ] **Step 5.2: Imports and the log**

At the very top of `background.js`, add:

```js
import {
  isAuto, initState, catchUpSince, targetsFor, PhotoQueue,
  recordResult, skipResult, markSeen, forget, pendingTotal,
} from './lib/auto-state.js';
```

Below the existing `chrome.commands` listener (above the engine section), add:

```js

// Duplicated in panel.js - change both. A watch never marked as seen starts
// this far back, because WhatsApp's links for older media have expired.
const FIRST_SCAN_DAYS = 10;

/* ---------- log: shown live in the panel with an [auto] prefix ---------- */

let logWrite = Promise.resolve();
function alog(s) {
  console.log('[auto]', s);
  logWrite = logWrite.then(async () => {
    const { autoLog = [] } = await chrome.storage.session.get('autoLog');
    autoLog.push({ n: (autoLog.at(-1)?.n ?? 0) + 1, s });
    await chrome.storage.session.set({ autoLog: autoLog.slice(-200) });
  }).catch(() => {});
}
```

- [ ] **Step 5.3: Engine calls with one retry, and page calls**

Below `ensureEngine` in `background.js`, add:

```js

// A missing or crashed engine page is recreated and the call retried once.
// Errors the engine itself reports (e.g. no models) are not retried.
async function engine(op, args) {
  for (let attempt = 0; ; attempt++) {
    await ensureEngine();
    const res = await chrome.runtime.sendMessage({ __cpf: 'engine', op, args })
      .catch((e) => ({ ok: false, error: e.message, lost: true }));
    if (res?.ok) return res.result;
    if ((!res || res.lost) && attempt === 0) continue;
    throw new Error(res?.error || 'engine did not answer');
  }
}

/* ---------- the WhatsApp tab ---------- */

async function callPage(action, args) {
  const [tab] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tab) throw new Error('no WhatsApp Web tab open');
  const res = await chrome.tabs.sendMessage(tab.id, { __cpf: 'call', action, args })
    .catch(() => null);
  if (!res) throw new Error('WhatsApp tab not answering - refresh it');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}
```

- [ ] **Step 5.4: State writes and the badge**

Add below `callPage`:

```js

/* ---------- state: autoState and pending are written only here ---------- */

const load = async () => {
  const { watches = [], autoState = {}, pending = {} } =
    await chrome.storage.local.get(['watches', 'autoState', 'pending']);
  return { watches, autoState, pending };
};

// Every write goes through this chain, so the loop and panel requests
// (markSeen, reset) can't interleave a read-modify-write.
let writing = Promise.resolve();
function mutate(fn) {
  const run = writing.then(async () => {
    const { autoState, pending } = await load();
    const out = fn({ autoState, pending });
    await chrome.storage.local.set({ autoState: out.autoState, pending: out.pending });
    await updateBadge(out.pending);
    return out;
  });
  writing = run.catch(() => {});
  return run;
}

let modelsMissing = false;
async function updateBadge(pending) {
  pending ??= (await load()).pending;
  const n = pendingTotal(pending);
  await chrome.action.setBadgeBackgroundColor({ color: modelsMissing ? '#b3261e' : '#1a7f4b' });
  await chrome.action.setBadgeText({ text: modelsMissing ? '!' : n ? String(n) : '' });
  await chrome.action.setTitle({
    title: modelsMissing ? 'Class Photo Filter - set up the models in the panel'
      : n ? `Class Photo Filter - ${n} match(es) waiting` : 'Class Photo Filter',
  });
}
```

- [ ] **Step 5.5: Catch-up, the queue and processing**

Add below `updateBadge`:

```js

/* ---------- the auto-watch loop ---------- */

const queue = new PhotoQueue();
let listing = 0;     // catch-ups in flight; processing waits for them
let running = false;

// Filled in by notifications (Task 6).
function onMatch(_watchId) {}

async function catchUp(reason) {
  listing++;
  try {
    const now = Math.floor(Date.now() / 1000);
    const autos = (await load()).watches.filter(isAuto);
    if (!autos.length) return;
    const { autoState } = await mutate((s) => {
      const a = { ...s.autoState };
      for (const w of autos) a[w.id] ??= initState(w, now, FIRST_SCAN_DAYS);
      return { autoState: a, pending: s.pending };
    });
    let added = 0;
    for (const src of new Set(autos.map((w) => w.src))) {
      const since = catchUpSince(autos, autoState, src);
      if (since === null) continue;
      const { fresh } = await callPage('listNewImages', { chatId: src, since });
      added += queue.add(fresh.map((m) => ({ id: m.id, chatId: src, t: m.t })));
    }
    alog(`catch-up (${reason}): ${added} photo(s) to check`);
  } catch (e) {
    alog(`catch-up (${reason}) paused: ${e.message}`);
  } finally {
    listing--;
    pump();
  }
}

async function onNewImage(photo) {
  const { watches } = await load();
  if (!watches.some((w) => isAuto(w) && w.src === photo.chatId)) return;
  queue.add([photo]);
  pump();
}

// Oldest first, one at a time. A photo leaves the queue only once its
// result is recorded, so a pause or a stopped worker loses nothing: the
// next trigger resumes from each watch's cursor.
async function pump() {
  if (running || listing) return;
  running = true;
  let checked = 0, unavailable = 0, paused = false;
  try {
    while (queue.size && !listing) {
      const photo = queue.peek();
      const { watches, autoState } = await load();
      const targets = targetsFor(watches, autoState, photo);
      if (!targets.length) { queue.shift(); continue; }
      try {
        const { dataUrl } = await callPage('downloadImage', { id: photo.id });
        const out = await engine('analyse', {
          dataUrl, watches: targets.map((w) => ({ id: w.id, refs: w.refs, threshold: w.threshold })),
        });
        modelsMissing = false;
        const { matched } = await mutate((s) => recordResult(s, photo, out.results, targets));
        checked++;
        alog(`${targets[0].srcName}: ${out.detected} faces - ` +
          out.results.map((r) => `${targets.find((w) => w.id === r.id).name} ${r.best.toFixed(3)}`).join(', '));
        for (const id of matched) {
          alog(`match: ${targets.find((w) => w.id === id).name} in ${targets[0].srcName}`);
          onMatch(id);
        }
      } catch (e) {
        if (!/media not found/i.test(e.message)) {
          modelsMissing = /no models/i.test(e.message);
          await updateBadge();
          alog(`paused: ${e.message}`);
          paused = true;
          break;
        }
        unavailable++;
        await mutate((s) => skipResult(s, photo, targets));
      }
      queue.shift();
    }
  } finally {
    running = false;
    if (checked || unavailable) {
      alog(`checked ${checked} photo(s)` + (unavailable ? `, ${unavailable} no longer available` : ''));
    }
  }
  // Photos may have arrived after the loop's last check.
  if (!paused && queue.size && !listing) pump();
}
```

- [ ] **Step 5.6: Wire up events, panel ops, and the start-up catch-up**

Replace the `bgOps` object from Task 1 with:

```js
const bgOps = {
  ensureEngine,
  // Not awaited: a first catch-up can take minutes.
  async catchUp() { catchUp('panel'); return true; },
  async markSeen({ watchId, ids }) {
    await mutate((s) => ({ autoState: s.autoState, pending: markSeen(s.pending, watchId, ids) }));
    return true;
  },
  async reset({ watchId }) {
    await mutate((s) => forget(s, watchId));
    catchUp('reset');
    return true;
  },
};
```

At the end of `background.js`, add:

```js

/* ---------- events from the WhatsApp tab ---------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.__cpf !== 'evt') return;
  if (msg.type === 'ready') catchUp('WhatsApp ready');
  else if (msg.type === 'newImage') onNewImage(msg.data);
});

// Every start of this worker - install, browser start, or waking from idle -
// catches up, because the in-memory queue did not survive the last stop.
// catchUp increments `listing` before its first await, so a live event
// arriving right after start waits for it.
catchUp('background start');
updateBadge();
```

- [ ] **Step 5.7: Name the duplicate in the panel**

In `panel.js`, change the comment above `const FIRST_SCAN_DAYS = 10;` to:

```js
// A watch that was never marked as seen only looks this far back. WhatsApp's
// CDN links for older media expire (403, surfaced as "Media not found"), so a
// full-history first scan spends most of its time on photos it cannot fetch.
// Duplicated in background.js - change both.
```

- [ ] **Step 5.8: Tests and static check**

Run: `npm test` then `npm run check`
Expected: all tests pass; `ok - manifest 0.6, …`.

- [ ] **Step 5.9: See the loop run**

Reload the extension and refresh WhatsApp Web. Open the background console.
Expected, in order:
1. `[auto] catch-up (background start): N photo(s) to check`, or `… paused: no WhatsApp Web tab open` if the worker started before the tab.
2. `[auto] catch-up (WhatsApp ready): …`.
3. One line per photo, such as `[auto] כיתה א2: 5 faces - carmel 0.092`.
4. A `checked N photo(s)…` summary.

The existing carmel watch has no `auto` field, so it counts as on. Its first catch-up covers the period since its `lastSeen`, or the last 10 days.

When a line scores at or above 0.39 (carmel's threshold), the toolbar badge shows a count. In the background DevTools → Application → Extension storage → Local, `pending` holds `{ id, t, score, px }` entries and no image data. `autoState` holds `{ lastChecked, atChecked }`.

Close the WhatsApp tab and click the extension icon.
Expected: `[auto] catch-up (background start) paused: no WhatsApp Web tab open` may appear when the worker wakes, and nothing else fails.

- [ ] **Step 5.10: Checkpoint**

No commit. Report how many photos the first catch-up checked, and how long it took.

---

### Task 6: Notifications

**Files:**
- Modify: `manifest.json` (`permissions`)
- Modify: `background.js`

**Interfaces:**
- Consumes: `Batcher`, `notifyText` (Task 3); `onMatch`, `pump`, `alog`, `load` (Task 5).
- Produces: a notification per batch, and on click an attempt to open the side panel plus focusing the WhatsApp tab.

- [ ] **Step 6.1: Permission**

In `manifest.json`, add `"notifications"` to the end of `permissions`:

```json
  "permissions": [
    "storage",
    "sidePanel",
    "tabs",
    "offscreen",
    "notifications"
  ],
```

- [ ] **Step 6.2: Batching, icon, and announcing**

In `background.js`, add `Batcher, notifyText` to the import list from `./lib/auto-state.js`.

Replace:

```js
// Filled in by notifications (Task 6).
function onMatch(_watchId) {}
```

with:

```js
const batches = new Batcher(60_000);
function onMatch(watchId) { batches.add(watchId, Date.now()); }

// Basic notifications require an icon, and the extension ships none, so
// draw one once.
let iconUrl = null;
async function notifyIcon() {
  if (iconUrl) return iconUrl;
  const cv = new OffscreenCanvas(128, 128);
  const cx = cv.getContext('2d');
  cx.fillStyle = '#1a7f4b';
  cx.beginPath(); cx.roundRect(8, 8, 112, 112, 24); cx.fill();
  cx.fillStyle = '#fff';
  cx.font = 'bold 72px sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText('C', 64, 68);
  const bytes = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return (iconUrl = 'data:image/png;base64,' + btoa(bin));
}

async function announce(drained) {
  const due = batches.due(Date.now(), drained);
  if (!due.length) return;
  const { watches } = await load();
  for (const { watchId, n } of due) {
    const w = watches.find((x) => x.id === watchId);
    if (!w) continue;
    await chrome.notifications.create(`cpf-${watchId}-${Date.now()}`, {
      type: 'basic', iconUrl: await notifyIcon(),
      title: 'Class Photo Filter', message: notifyText(w, n), priority: 1,
    });
    alog(`notified: ${notifyText(w, n)}`);
  }
}
```

- [ ] **Step 6.3: Announce from the loop**

In `pump()`, directly after the closing `}` of the `for (const id of matched) { … }` loop (still inside the inner `try`), add:

```js
        await announce(false);
```

After the `finally { … }` block of `pump()` and before `if (!paused && queue.size && !listing) pump();`, add:

```js
  // Drained, or paused and possibly not resuming soon: don't hold matches back.
  if (paused || !queue.size) await announce(true);
```

- [ ] **Step 6.4: Clicking a notification**

Change the `evt` listener to remember the WhatsApp tab:

```js
// The WhatsApp tab, from its most recent event, so a notification click can
// open the side panel without awaiting a tab query first.
let waTab = null;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.__cpf !== 'evt') return;
  if (sender.tab) waTab = { id: sender.tab.id, windowId: sender.tab.windowId };
  if (msg.type === 'ready') catchUp('WhatsApp ready');
  else if (msg.type === 'newImage') onNewImage(msg.data);
});
```

Below it, add:

```js

chrome.notifications.onClicked.addListener((id) => {
  // sidePanel.open only works inside the click's user gesture, so it is
  // called before anything is awaited. Chrome may still refuse; the badge
  // is the fallback.
  const opening = waTab
    ? chrome.sidePanel.open({ windowId: waTab.windowId })
    : Promise.reject(new Error('WhatsApp tab not known since the background restarted'));
  opening.catch((e) => alog(`side panel not opened from the notification: ${e.message}`));
  chrome.notifications.clear(id);
  focusWhatsApp();
});

async function focusWhatsApp() {
  const [tab] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tab) return;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}
```

- [ ] **Step 6.5: Tests and static check**

Run: `npm test` then `npm run check`
Expected: all pass; `ok - manifest 0.6, permissions: storage, sidePanel, tabs, offscreen, notifications`.

- [ ] **Step 6.6: See a notification**

Reload the extension. In Windows, Settings → System → Notifications must allow Chrome.

`batches` and `announce` are module-scoped and can't be called from a console, so test through the real path: from your phone, post a photo of the child into the watched group.

Expected: within seconds, the background log shows `match: …`, `notified: 1 new photo of carmel in …`, a Windows notification appears, and the badge count goes up.

Click the notification.
Expected: the WhatsApp tab comes to the front. Either the side panel opens, or the log shows `side panel not opened from the notification: …`. Note which one happened; the spec treats this as a risk to confirm.

- [ ] **Step 6.7: Checkpoint**

No commit. Record whether the side panel opened from the click.

---

### Task 7: Panel — Setup (Auto-watch toggle, Reset, Remove)

**Files:**
- Modify: `panel.html` (CSS, form checkbox)
- Modify: `panel.js` (import, `addWatch`, `renderSetup`)

**Interfaces:**
- Consumes: `bg(op, args)` (Task 1); background ops `catchUp`, `reset` (Task 5); `isAuto` (Task 3).
- Produces: `watches[i].auto: boolean` on new watches. The existing handlers for Reset and Remove now also clear the background's state.

- [ ] **Step 7.1: Markup and style**

In `panel.html`, add to the `<style>` block:

```css
  label.check { display: flex; align-items: center; gap: 6px; margin: 10px 0 0;
                text-transform: none; letter-spacing: 0; font-size: 12.5px; color: inherit; }
  label.check.inline { margin: 0; font-size: 11px; color: var(--muted); }
```

In the *Add a group to watch* card, directly after `<p class="hint">Start at 0.35. Lower it if the child is usually far from the camera.</p>`, add:

```html
      <label class="check"><input type="checkbox" id="autoWatch" checked>
        Auto-watch: check new photos in the background and alert me</label>
```

- [ ] **Step 7.2: Save with the flag and start catch-up**

At the top of `panel.js`, add:

```js
import { isAuto } from './lib/auto-state.js';
```

In the `addWatch` handler, change `refs, lastSeen: 0,` to:

```js
      refs, lastSeen: 0, auto: $('autoWatch').checked,
```

and after `await setWatches(watches);` add:

```js
    if ($('autoWatch').checked) await bg('catchUp');
```

- [ ] **Step 7.3: Toggle, Reset and Remove in the saved list**

Replace the whole `async function renderSetup() { … }` with:

```js
async function renderSetup() {
  const watches = await getWatches();
  const { pending = {} } = await chrome.storage.local.get('pending');
  $('setupList').innerHTML = watches.length
    ? watches.map((w) => `<div class="row" style="justify-content:space-between;padding:6px 0;
        border-bottom:1px solid var(--line)">
        <span><b>${esc(w.name)}</b> <span class="muted">&larr; ${esc(w.srcName)}</span></span>
        <span class="row" style="gap:6px">
          <label class="check inline" title="Check new photos in the background and alert me">
            <input type="checkbox" data-auto="${w.id}" ${isAuto(w) ? 'checked' : ''}>Auto</label>
          <button class="act ghost" data-reset="${w.id}" style="padding:3px 9px;font-size:11px"
            title="Forget last seen and waiting matches; the next check covers the last ${FIRST_SCAN_DAYS} days"
            ${w.lastSeen || pending[w.id]?.length ? '' : 'disabled'}>Reset</button>
          <button class="act ghost" data-del="${w.id}" style="padding:3px 9px;font-size:11px">Remove</button>
        </span>
      </div>`).join('')
    : '<p class="hint">Nothing yet.</p>';

  const on = (sel, ev, fn) => $('setupList').querySelectorAll(sel).forEach((el) =>
    el.addEventListener(ev, () => fn(el).catch((e) => log('ERROR: ' + e.message))));

  // The panel writes `auto` (watches is panel-owned); the background re-reads
  // watches before every photo, so turning it off takes effect at once.
  on('[data-auto]', 'change', async (cb) => {
    const all = await getWatches();
    const w = all.find((x) => x.id === cb.dataset.auto);
    w.auto = cb.checked;
    await setWatches(all);
    log(`${w.name}: auto-watch ${w.auto ? 'on' : 'off'}`);
    if (w.auto) await bg('catchUp');
    await renderWatches();
  });

  // Remove from watches first, so the background's catch-up can't recreate
  // its state, then have the background forget it.
  on('[data-del]', 'click', async (b) => {
    await setWatches((await getWatches()).filter((w) => w.id !== b.dataset.del));
    await bg('reset', { watchId: b.dataset.del });
    await renderSetup(); await renderWatches();
  });

  // Undo "Mark as seen" without re-embedding references: lastSeen goes back to
  // never, and the background drops the cursor and waiting matches, so the
  // next check covers the first-scan window again.
  on('[data-reset]', 'click', async (b) => {
    const all = await getWatches();
    const w = all.find((x) => x.id === b.dataset.reset);
    w.lastSeen = 0;
    await setWatches(all);
    await bg('reset', { watchId: w.id });
    log(`${w.name}: reset - next check covers the last ${FIRST_SCAN_DAYS} days`);
    await renderSetup(); await renderWatches();
  });
}
```

- [ ] **Step 7.4: Static check**

Run: `npm run check`
Expected: `ok - …`.

- [ ] **Step 7.5: Try it**

Close and reopen the side panel, then open **Setup**.
Expected: carmel shows **Auto** ticked. Reset is enabled if carmel has a `lastSeen` or waiting matches.

Untick Auto. The log shows `carmel: auto-watch off`. Post a photo into the group: the background log shows nothing for it. Tick Auto again: the background runs `catch-up (panel)` and picks up that photo.

Click Reset. The background log shows `catch-up (reset): N photo(s) to check` covering the 10-day window, and the badge clears and then refills as matches come in.

- [ ] **Step 7.6: Checkpoint**

No commit.

---

### Task 8: Panel — Photos (waiting matches, Review, Mark as seen, `[auto]` log)

**Files:**
- Modify: `panel.html` (CSS for unavailable thumbnails)
- Modify: `panel.js` (`renderWatches`, new `review`, `renderReview`, `doneBtn`, the `[auto]` log, storage listener)

**Interfaces:**
- Consumes: `local.pending`, `local.autoState`, `session.autoLog` (Task 5); `bg('markSeen', { watchId, ids })` (Task 5); `isAuto` (Task 3).
- Produces: `current = { watch, rows, auto: true, upTo, skipped: 0 }` for auto reviews. Rows are `{ id, score, px, thumb: string | null, gone?: string }`.

- [ ] **Step 8.1: Style for unavailable photos**

In `panel.html`, add to `<style>`:

```css
  .thumb.gone { cursor: default; }
  .thumb .ph { height: 88px; display: flex; align-items: center; justify-content: center;
               background: #eee; border-radius: 4px; color: var(--muted); font-size: 11px;
               text-align: center; padding: 4px; }
```

- [ ] **Step 8.2: Watch cards for auto watches**

Replace the whole `async function renderWatches() { … }` with:

```js
async function renderWatches() {
  const watches = await getWatches();
  const { pending = {}, autoState = {} } = await chrome.storage.local.get(['pending', 'autoState']);
  const box = $('watchList');
  if (!watches.length) {
    box.innerHTML = '<div class="card"><p class="hint">No watches yet. Open Setup to add one.</p></div>';
    return;
  }
  const when = (t) => new Date(t * 1000).toLocaleString();
  box.innerHTML = watches.map((w) => isAuto(w) ? `
    <div class="card watch" data-w="${w.id}">
      <div class="row" style="justify-content:space-between">
        <span class="title">${esc(w.name)}</span>
        <span class="pill ${pending[w.id]?.length ? '' : 'none'}">${pending[w.id]?.length
          ? `${pending[w.id].length} waiting` : 'watching'}</span>
      </div>
      <p class="hint" style="margin:6px 0">${esc(w.srcName)} &rarr; ${esc(w.dstName)}
        &middot; threshold ${w.threshold} &middot; auto-watch on
        &middot; checked up to ${autoState[w.id] ? when(autoState[w.id].lastChecked) : 'not yet'}</p>
      <button class="act" data-review="${w.id}" ${pending[w.id]?.length ? '' : 'disabled'}>${pending[w.id]?.length
        ? `Review ${pending[w.id].length} photo(s) of ${esc(w.name)}` : 'No matches waiting'}</button>
    </div>` : `
    <div class="card watch" data-w="${w.id}">
      <div class="row" style="justify-content:space-between">
        <span class="title">${esc(w.name)}</span>
        <span class="pill none" data-count="${w.id}">checking...</span>
      </div>
      <p class="hint" style="margin:6px 0">${esc(w.srcName)} &rarr; ${esc(w.dstName)}
        &middot; threshold ${w.threshold}
        &middot; last seen ${w.lastSeen ? when(w.lastSeen)
          : `never (first check covers the last ${FIRST_SCAN_DAYS} days)`}</p>
      <button class="act" data-scan="${w.id}" disabled>Check for new photos</button>
    </div>`).join('');

  box.querySelectorAll('[data-review]').forEach((b) => b.addEventListener('click', () =>
    review(watches.find((w) => w.id === b.dataset.review)).catch((e) => log('ERROR: ' + e.message))));

  for (const w of watches.filter((x) => !isAuto(x))) {
    try {
      const { fresh } = await callPage('listNewImages', { chatId: w.src, since: sinceOf(w) });
      const pill = box.querySelector(`[data-count="${w.id}"]`);
      const btn = box.querySelector(`[data-scan="${w.id}"]`);
      if (!pill || !btn) continue; // re-rendered meanwhile
      if (fresh.length) {
        pill.textContent = `${fresh.length} new`;
        pill.className = 'pill';
        btn.disabled = false;
        btn.textContent = `Find ${w.name} in ${fresh.length} new photos`;
        btn.addEventListener('click', () => scan(w).catch((e) => log('ERROR: ' + e.message)));
      } else {
        pill.textContent = 'up to date';
        btn.textContent = 'Nothing new';
      }
    } catch (e) { log(`${w.name}: ${e.message}`); }
  }
}
```

- [ ] **Step 8.3: Review from `pending`**

Add directly after `scan(w)`:

```js
// Waiting matches hold ids and scores only (photos are never stored), so
// each one is downloaded again here and thumbnailed in memory.
async function review(w) {
  const { pending = {}, autoState = {} } = await chrome.storage.local.get(['pending', 'autoState']);
  const list = [...(pending[w.id] || [])].sort((a, b) => b.score - a.score);
  // Read now, so matches that arrive during the review aren't covered by it.
  const upTo = autoState[w.id]?.lastChecked || 0;
  log(`\n${w.name}: loading ${list.length} waiting match(es)...`);
  const rows = [];
  for (const p of list) {
    try {
      const { dataUrl } = await callPage('downloadImage', { id: p.id });
      rows.push({ id: p.id, score: p.score, px: p.px, thumb: await thumbnail(dataUrl) });
    } catch (e) {
      rows.push({ id: p.id, score: p.score, px: p.px, thumb: null,
        gone: /media not found/i.test(e.message) ? 'no longer available' : e.message });
    }
  }
  current = { watch: w, rows, auto: true, upTo, skipped: 0 };
  renderReview();
}
```

- [ ] **Step 8.4: Review grid shows unavailable photos**

In `renderReview()`, replace the `$('grid').innerHTML = …` statement and the `$('sendBtn').disabled = …` line with:

```js
  $('grid').innerHTML = rows.map((r, i) => r.thumb ? `
    <label class="thumb"><img src="${r.thumb}">
      <span class="s"><input type="checkbox" data-i="${i}" checked>${r.score.toFixed(3)}
      <span class="muted">${r.px}px</span></span></label>` : `
    <div class="thumb gone"><div class="ph">${esc(r.gone)}</div>
      <span class="s">${r.score.toFixed(3)} <span class="muted">${r.px}px</span></span></div>`).join('');
  $('sendBtn').disabled = !rows.some((r) => r.thumb);
```

(Manual-scan rows always have a `thumb`, so they render exactly as before.)

- [ ] **Step 8.5: Mark as seen for both kinds**

Replace the whole `$('doneBtn').addEventListener('click', …)` block with:

```js
$('doneBtn').addEventListener('click', async () => {
  try {
    const watches = await getWatches();
    const w = watches.find((x) => x.id === current.watch.id);
    if (!w) throw new Error('that watch was removed');
    w.lastSeen = current.auto ? Math.max(w.lastSeen || 0, current.upTo) : current.newest;
    await setWatches(watches);
    // Only the rows shown here: matches that arrived during the review stay waiting.
    if (current.auto) await bg('markSeen', { watchId: w.id, ids: current.rows.map((r) => r.id) });
    $('reviewCard').hidden = true;
    current = null;
    log('marked as seen');
    await renderWatches(); await renderSetup();
  } catch (e) { log('ERROR: ' + e.message); }
});
```

- [ ] **Step 8.6: `[auto]` lines in the panel log, live updates**

Add just above the `/* ---------- tabs ---------- */` comment:

```js
/* ---------- background activity ---------- */

// The background keeps its own short log in session storage; show it here so
// the panel stays the one place to look.
let autoSeq = 0;
function showAutoLog(entries = []) {
  for (const { n, s } of entries) if (n > autoSeq) { autoSeq = n; log('[auto] ' + s); }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.autoLog) showAutoLog(changes.autoLog.newValue);
  if (area === 'local' && changes.pending) {
    renderWatches().catch((e) => log(e.message));
    renderSetup().catch((e) => log(e.message));
  }
});
```

In the startup block at the bottom, change `await renderWatches();` to:

```js
  await renderWatches();
  const { autoLog = [] } = await chrome.storage.session.get('autoLog');
  showAutoLog(autoLog.slice(-20));
```

- [ ] **Step 8.7: Static check and tests**

Run: `npm run check` then `npm test`
Expected: `ok - …`; all tests pass.

- [ ] **Step 8.8: Try the review flow**

Close and reopen the side panel.
Expected: the carmel card shows `N waiting` and **Review N photo(s) of carmel**. The log shows the last few `[auto]` lines, and new ones appear live.

Click **Review**. Thumbnails load, highest score first. Any expired photo shows as a grey *no longer available* tile with no checkbox.

While the review is open, post another photo of the child to the group. After the background matches it, the card's count goes up by one.

Click **Mark as seen**.
Expected: the card shows `1 waiting` (the photo that arrived during the review), the badge shows 1, and Setup's Reset stays enabled.

Click **Review** again, then **Add to composer**: the photos land in the destination composer, and nothing is sent.

- [ ] **Step 8.9: Checkpoint**

No commit.

---

### Task 9: Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 9.1: AGENTS.md — architecture**

Replace the section from `## Architecture` down to just before `## Hard rules` with:

````markdown
## Architecture

Five contexts. Getting these confused is the most common source of bugs.

```
panel.js / panel.html    extension origin (chrome-extension://)
                         owns: all UI, model *storage* (IndexedDB), thumbnails
                         calls the engine for embedding and manual scans
engine.js / engine.html  offscreen document, extension origin
                         owns: ORT sessions, lib/face.js, image decoding
                         only chrome.runtime is available here - no storage, no tabs
background.js            service worker (ES module)
                         owns: the engine's lifecycle, the auto-watch loop,
                         autoState + pending, badge, notifications, Alt+Shift+R
        |  chrome.tabs.sendMessage  ->  { __cpf:'call', action, args }
        |  <-  chrome.runtime.sendMessage  { __cpf:'evt', type, data }
relay.js                 ISOLATED content-script world
                         a pipe in both directions; do not add logic here
        |  window.postMessage  <->  { __cpf:'req'|'res'|'evt', ... }
page.js                  MAIN content-script world
                         the ONLY file that may touch wa-js or WhatsApp internals
```

Message tags: `call`/`req`/`res` are extension → page requests; `evt` is
page → background events (`ready`, `newImage`); `engine` is a request to the
engine; `bg` is a panel → background request. Every `chrome.runtime.sendMessage`
reaches every extension context, so each listener ignores tags that aren't its own.

Adding a page capability usually means a new `actions.<name>` in `page.js`,
then `callPage('<name>', args)` from `panel.js` or `background.js`. `relay.js`
needs no change — it forwards anything.

### Why recognition lives in the engine page

Content scripts inherit the **page's** IndexedDB origin (`web.whatsapp.com`), so
models cached there would be re-requested constantly. Extension pages share one
clean origin, which is why both the panel (which stores the models) and the
engine (which loads them) can use the same `cpf-models` database. The engine is
an offscreen document so recognition keeps running when the side panel is
closed. Do not move inference into a content script, and do not load ORT in
the panel again — two copies means double the memory.

Images cross each boundary as data URLs, **one at a time**. This is deliberate:
memory stays flat regardless of batch size. Do not batch-transfer whole albums.

### Auto-watch state

`chrome.storage.local` has one writer per key: `watches` → panel;
`autoState` and `pending` → background. The panel changes background state
only by messaging it (`catchUp`, `markSeen`, `reset`). `pending` holds message
ids and scores, never images.

Each watch's cursor is `lastChecked` + `atChecked` (ids done at exactly that
second), because album photos share a timestamp. The rules are in
`lib/auto-state.js` and unit-tested in `tests/auto-state.test.js` — change
them there, test-first.
````

- [ ] **Step 9.2: AGENTS.md — constraints and verifying**

In *The non-obvious technical constraints*, add at the end of the bullet list:

```markdown
- **Offscreen documents only get `chrome.runtime`.** The engine can't read
  `chrome.storage` or reach tabs; the background passes it everything it needs.
- **`sidePanel.open` needs a user gesture.** From a notification click it must
  be called before any `await`. Chrome may refuse it anyway; the badge is the
  fallback.
- **Chrome's Memory Saver can discard the WhatsApp tab**, which stops all
  events. Users should add `web.whatsapp.com` to *Always keep these sites
  active* in `chrome://settings/performance`.
- **Background catch-up runs on every worker start and every `ready` event,
  not on a timer.** Photos WhatsApp syncs in bulk after sleep may not fire
  `chat.new_message` and wait for the next trigger. A periodic check was
  considered and deferred by the owner.
```

In *Verifying a change*, replace the sentence `There are no automated tests. Before claiming something works:` and the first two bullets under it with:

```markdown
`npm test` runs the unit tests for `lib/auto-state.js` (Node's built-in
runner, no dependencies). Everything that touches Chrome or WhatsApp is
checked by hand. Before claiming something works:

- `npm test` and `npm run check` (every source file parses; every path
  `manifest.json` references exists). `panel.js`, `engine.js`, `background.js`
  and `lib/*.js` are ES modules; `page.js` and `relay.js` are classic scripts.
- Bump `manifest.json` `version` for every change to the extension.
```

In the console paragraph at the end of that section, change:

```markdown
`page.js`/`relay.js`: WhatsApp Web's console. `background.js`:
`chrome://extensions` → service worker.
```

to:

```markdown
`page.js`/`relay.js`: WhatsApp Web's console. `background.js`:
`chrome://extensions` → service worker. `engine.js`: `chrome://extensions` →
*Inspect views: engine.html*. Background activity also appears in the panel
log with an `[auto]` prefix.
```

- [ ] **Step 9.3: README**

In `README.md`:

1. In *What it does*, replace items 2–4 with:

```markdown
2. When new photos arrive, checks them in the background — even with the side
   panel closed — using WhatsApp Web's own data layer.
3. Runs face detection + recognition against reference photos of your child.
4. Shows a badge on the extension icon and a Windows notification when there
   are matches, and lists them for review.
```

2. In *Setup*, add after item 2:

```markdown
3. **Keep WhatsApp Web active** — in `chrome://settings/performance`, add
   `web.whatsapp.com` to *Always keep these sites active*. Otherwise Chrome's
   Memory Saver may unload the tab and background watching stops until you
   return to it. Background watching only works while a WhatsApp Web tab is
   open.
```

3. In *Dev loop*, replace the table with:

```markdown
| Change | What to do |
|---|---|
| `panel.js`, `panel.html` | Close and reopen the side panel |
| `engine.js`, `engine.html`, `lib/` | Reload the extension (the engine page stays open otherwise) |
| `page.js`, `relay.js` | Reload the extension, then refresh WhatsApp Web |
| `manifest.json`, `background.js` | Reload the extension |

`npm test` runs the unit tests; `npm run check` syntax-checks every source file
and the manifest's paths.
```

4. In *Where the consoles are*, change `Four contexts, four separate consoles.` to `Five contexts, five separate consoles.` and add this table row:

```markdown
| `engine.js` | `chrome://extensions` → "Inspect views: engine.html" |
```

5. Replace the *Architecture* code block and the paragraph after it (`Recognition lives in the panel because …`) with:

````markdown
```
panel.js       extension origin. UI, model storage (IndexedDB), thumbnails.
engine.js      offscreen document. ORT sessions and face matching.
background.js  service worker. Auto-watch loop, badge, notifications.
   |  chrome.tabs.sendMessage / chrome.runtime.sendMessage
relay.js       ISOLATED world. A dumb pipe in both directions.
   |  window.postMessage
page.js        MAIN world. The only file that touches wa-js / WhatsApp internals.
```

Recognition lives in an offscreen extension page: content scripts inherit the
*page's* IndexedDB origin, which would mean re-picking 174MB of models on every
WhatsApp reload, and the side panel isn't running when it's closed. The engine
keeps the models loaded while Chrome runs. Images cross each boundary as data
URLs, one at a time, which keeps memory flat regardless of batch size.
````

6. In *Layout*, replace the listing with:

```markdown
manifest.json      MV3 manifest
background.js      service worker: auto-watch loop, badge, notifications, reload hotkey
engine.html/.js    offscreen document: ONNX Runtime sessions and matching
page.js            MAIN world bridge (wa-js)
relay.js           ISOLATED world relay
panel.html/.js     side panel UI
lib/face.js        SCRFD + ArcFace in plain JS
lib/auto-state.js  auto-watch queue and cursor rules (pure, unit-tested)
tests/             node --test unit tests
scripts/vendor.mjs copies runtime files from node_modules into vendor/
scripts/check.mjs  syntax + manifest path check
vendor/            gitignored; regenerate with `npm run vendor`
```

- [ ] **Step 9.4: Checkpoint**

Reread both files once to confirm no section still says recognition runs in the panel. Search for `lives in the panel` and `Four contexts`; expected: no matches. No commit.

---

### Task 10: End-to-end check with the owner

Needs the owner's phone. Each line is pass/fail. Report every result, including failures.

**Files:** none (fixes found here become their own follow-up change).

- [ ] **Step 10.1: Setup**

The owner makes a small WhatsApp test group (just themselves plus one other number, or a group they own). In Setup, add a watch on it with carmel's reference photos, threshold 0.39, destination *Message yourself (test)*, Auto-watch ticked.
Expected: the background log shows `catch-up (panel)`.

- [ ] **Step 10.2: The alert path**

| # | Action | Expected |
|---|---|---|
| a | Post a photo of the child to the test group, with WhatsApp Web the active tab | Within seconds: an `[auto]` match line, a Windows notification "1 new photo of … in …", badge +1 |
| b | Post a photo without the child | An `[auto]` line with a low score; no notification; badge unchanged |
| c | Switch Chrome to another tab, then post a photo of the child | Same as (a) |
| d | Minimise Chrome, then post a photo of the child | Same as (a) |
| e | Post an album of 3 photos of the child at once | 3 `[auto]` lines; **one** notification "3 new photos …"; badge +3 |
| f | Close the WhatsApp Web tab, post a photo of the child, reopen WhatsApp Web | `catch-up (WhatsApp ready): 1 photo(s) to check`, then the match and a notification |
| g | Click a notification | WhatsApp comes to the front; the side panel opens, or the log says why it didn't |

- [ ] **Step 10.3: The review path**

| # | Action | Expected |
|---|---|---|
| h | Review → Add to composer | Photos are in the destination composer; nothing is sent until Enter |
| i | Review, post another matching photo, then Mark as seen | The new one stays waiting; badge shows 1 |
| j | Untick Auto; post a matching photo | No `[auto]` line for it |
| k | Tick Auto again | `catch-up (panel)` picks up the photo from (j) |
| l | Reset the test watch | Badge drops by its waiting count, then catch-up re-checks the last 10 days |
| m | Remove the test watch | Its matches leave the badge; nothing more is checked for that group |

- [ ] **Step 10.4: Report**

Give the owner the pass/fail table, the WebGPU result from Task 1, the parity cosine from Task 2, and the side-panel-from-notification result. Any failure becomes a separate fix. Version stays 0.6 until this feature is signed off.
