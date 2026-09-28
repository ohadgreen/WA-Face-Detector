# AGENTS.md

Guidance for AI coding agents working in this repo. Read this before changing code.
`README.md` covers human setup; this file covers the constraints and the traps.

## What this is

A Manifest V3 Chrome extension that finds photos of a specific child inside
WhatsApp group albums and queues the matches for another chat. All face
recognition runs locally in the browser. No images or embeddings leave the
machine.

There is **no build step**. Plain files, loaded unpacked. Do not introduce a
bundler, a transpiler, or a framework without being asked — `vendor/` holds 42MB
of WASM and the config cost outweighs the benefit.

## Architecture

Four contexts. Getting these confused is the most common source of bugs.

```
panel.js / panel.html    extension origin (chrome-extension://)
                         owns: ORT sessions, IndexedDB models, face matching, all UI
        |  chrome.tabs.sendMessage  ->  { __cpf:'call', action, args }
relay.js                 ISOLATED content-script world
                         a pipe with no logic; do not add logic here
        |  window.postMessage  ->  { __cpf:'req', id, action, args }
page.js                  MAIN content-script world
                         the ONLY file that may touch wa-js or WhatsApp internals
background.js            service worker: side-panel behaviour, Alt+Shift+R reload
```

Adding a capability usually means: a new `actions.<name>` in `page.js`, then a
`callPage('<name>', args)` from `panel.js`. `relay.js` needs no change — it
forwards anything.

### Why recognition lives in the panel

Content scripts inherit the **page's** IndexedDB origin (`web.whatsapp.com`), so
models cached there would be re-requested constantly. The panel is a clean
extension origin. Do not move inference into the content script.

Images cross the boundary as data URLs, **one at a time**. This is deliberate:
memory stays flat regardless of batch size. Do not batch-transfer whole albums.

## Hard rules

These are product decisions, not preferences. Do not change them without the
owner explicitly asking.

1. **No programmatic sending.** `pasteToChat` puts images in the composer and
   stops. The user presses Enter. `WPP.chat.sendFileMessage` exists and would
   work — using it moves the account from reading WhatsApp's internals to acting
   through them, which is what actually draws bans. The number at risk belongs
   to a parent in the class group.
2. **No remote code.** MV3 forbids it and the CSP will block it. Everything loads
   from `vendor/` or the repo. No CDN script tags, no `eval`, no dynamic import
   of remote URLs.
3. **Never persist photos.** Reference photos are embedded at setup time and
   discarded; only the 512-float vectors go into `chrome.storage.local`. Thumbnails
   in the review grid are in-memory for the session only. Group photos contain
   other people's children.
4. **No sender filtering.** Explicitly requested. All image messages in the window
   are processed regardless of who posted them.
5. **Work is only offered when there is work.** A watch with no new messages since
   `lastSeen` shows a disabled button. `lastSeen` only advances when the user
   clicks "Mark as seen", so an interrupted scan costs nothing.
6. **Never commit `vendor/` or `node_modules/`.** Regenerate with `npm run vendor`.

## The non-obvious technical constraints

Each of these cost a debugging session. Do not "simplify" them away.

- **The detector must run on WASM.** SCRFD contains an `AveragePool` with
  `ceil_mode` that ORT's WebGPU backend does not implement. Requesting `webgpu`
  for the detector throws at first inference, not at load. The recogniser is fine
  on WebGPU and is where the time actually goes (~0.3s per detected face, vs
  ~0.3s per photo for detection).
- **`ort.env.wasm.numThreads = 1` is required.** Extension pages are not
  cross-origin isolated, so `SharedArrayBuffer` is unavailable and the threaded
  build aborts.
- **Both WASM builds must be vendored.** The plain pair
  (`ort-wasm-simd-threaded.{mjs,wasm}`) and the jsep pair. Requesting the `wasm`
  provider loads the plain build; omitting it produces a confusing
  `no available backend found ... Aborted(...)`.
- **`WPP.webpack` does not exist** in wa-js 4.x. Readiness is `WPP.isFullReady`
  plus the `conn.main_ready` event. `page.js` waits on both, and polls, because
  the event may already have fired.
- **Album children are separate messages** sharing an id suffix after the
  underscore. `WPP.chat.getMessages(chatId, { count: -1, media: 'image' })`
  returns them all. Do not go back to scraping the DOM — the media viewer is
  virtualised, its nav buttons have no stable attributes, and that approach was
  abandoned after it returned 5 of 32 images.
- **`getMessages` only sees the local store.** If a user reports missing older
  photos, the fix is scrolling back in that chat once, not a code change.

## lib/face.js

A plain-JS port of InsightFace: SCRFD decoding, 5-point similarity-transform
alignment, ArcFace embedding. It is **numerically verified** against the Python
reference — bounding boxes within 0.15px, embeddings at 0.9987 cosine.

If you touch detection, alignment, or preprocessing, that parity must be
re-established. Wrong alignment does not throw; it silently produces plausible
embeddings with mushy scores. Specific hazards:

- Anchors are duplicated **consecutively** per cell (`cell0, cell0, cell1, ...`),
  2 per cell, strides 8/16/32.
- Detector input is `(pixel - 127.5) / 128`; the recogniser is
  `(pixel - 127.5) / 127.5`. They differ. This is not a typo.
- Scoring uses **max over references**, never the mean. Averaging a frontal and a
  profile reference yields a vector matching neither.

## Thresholds

Per child, not global. Real measured data from this project: one child
photographed close to the camera separated cleanly at 0.40; a sibling usually
further away needed 0.23, with matched faces of 41-47px against the first child's
71-83px in the same photos. Any code or copy implying a single global threshold
is wrong.

Blurred and profile faces are missed. That is a model limitation, not something
to tune around, and not a bug to "fix".

## Verifying a change

There are no automated tests. Before claiming something works:

- `node --check` every changed file. `panel.js` and `lib/face.js` are ES modules;
  the others are classic scripts.
- Confirm `manifest.json` still parses and every referenced path exists.
- Reload the extension, then **refresh WhatsApp Web** if `page.js` or `relay.js`
  changed — content scripts are not re-injected by a reload.
- Watch the panel log. It is the primary diagnostic surface and shows per-photo
  progress, backend selection, and full error messages. Keep it that way: when
  adding a step that can fail, log before and after it. Truncating error strings
  has already hidden one root cause.

Check the right console for the context you changed — an error in one is
invisible in the others. `panel.js`: right-click the side panel → Inspect.
`page.js`/`relay.js`: WhatsApp Web's console. `background.js`:
`chrome://extensions` → service worker.

## Style

Plain modern JS, no TypeScript, match the existing style: semicolons, 2-space indent, single quotes.
Comments explain *why*, especially for the constraints above; a future reader
will otherwise "clean up" the WASM pinning or the one-at-a-time transfer and
reintroduce a solved bug.
