# Class Photo Filter

A Chrome extension that finds photos of a specific child in WhatsApp group albums
and queues the matches for another chat. Everything runs locally: face recognition
happens in the browser, no images are uploaded anywhere, and nothing is sent
without a keystroke from you.

## What it does

1. Watches one or more WhatsApp groups (e.g. a class-parents group).
2. When new photos arrive, checks them in the background — even with the side
   panel closed — using WhatsApp Web's own data layer.
3. Runs face detection + recognition against reference photos of your child.
4. Shows a badge on the extension icon and a Windows notification when there
   are matches, and lists them for review.
5. Pastes the ones you keep into a destination chat's composer. **You press Enter.**

Each watch is independent, so one child per group with its own threshold and
destination.

## Setup

```bash
npm install          # also vendors the runtime files into vendor/
```

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → pick
this folder.

Open WhatsApp Web, click the extension icon to open the side panel, and go to
**Setup**:

1. **Models** — pick `det_10g.onnx` and `w600k_r50.onnx` once. They're cached in
   IndexedDB and never asked for again. Get them by running InsightFace once in
   Python, or download the `buffalo_l` pack from the InsightFace model zoo. They
   land in `~/.insightface/models/buffalo_l/`.
2. **Add a watch** — source group, destination, child's name, a few reference
   photos, and a threshold. Leave **Auto-watch** ticked to have new photos
   checked in the background.
3. **Keep WhatsApp Web active** — in `chrome://settings/performance`, add
   `web.whatsapp.com` to *Always keep these sites active*. Otherwise Chrome's
   Memory Saver may unload the tab and background watching stops until you
   return to it. Background watching only works while a WhatsApp Web tab is
   open.

Only the 512-float embeddings are stored, never the reference photos themselves.

### Thresholds

Start at 0.35 and tune per child. Thresholds do **not** transfer between
children: a child usually photographed close to the camera separates cleanly
around 0.40, while one usually further away may need 0.23. Pick a value in the
gap between the lowest true match and the highest false one.

## Dev loop

| Change | What to do |
|---|---|
| `panel.js`, `panel.html` | Close and reopen the side panel |
| `engine.js`, `engine.html`, `lib/`, `background.js`, `manifest.json` | Reload the extension, then refresh WhatsApp Web |
| `page.js`, `relay.js` | Reload the extension, then refresh WhatsApp Web |

`Alt+Shift+R` reloads the extension from anywhere in Chrome. Any reload
disconnects the content scripts already running in open WhatsApp tabs, and
they are not re-injected, so refresh WhatsApp Web after every reload.
Otherwise the panel shows `Receiving end does not exist`.

`npm test` runs the unit tests; `npm run check` syntax-checks every source file
and the manifest's paths.

### Where the consoles are

Five contexts, five separate consoles. An error in one is invisible in the others.

| Part | Where to look |
|---|---|
| `page.js` (MAIN world) | WhatsApp Web DevTools console |
| `relay.js` (ISOLATED world) | Same console, switch the context dropdown off `top` |
| `panel.js` | Right-click inside the side panel → Inspect |
| `background.js` | `chrome://extensions` → "service worker" |
| `engine.js` | `chrome://extensions` → "Inspect views: engine.html" |

Background activity also shows in the panel log, prefixed `[auto]`.

`chrome://extensions` also grows an **Errors** button that aggregates across contexts.

## Architecture

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

`lib/face.js` is a plain-JS port of InsightFace's SCRFD detection, 5-point
similarity-transform alignment, and ArcFace embedding. It is verified against the
Python implementation: bounding boxes agree within 0.15px and embeddings reach
0.9987 cosine.

### Backends

The detector runs on WASM because SCRFD uses an `AveragePool` with `ceil_mode`
that ONNX Runtime's WebGPU backend doesn't implement. The recogniser runs on
WebGPU when available and falls back to WASM. Threads are pinned to 1 because
extension pages aren't cross-origin isolated, so `SharedArrayBuffer` is absent.

## Caveats

- `page.js` reads WhatsApp Web's internal store via wa-js. That's unofficial and
  could break whenever Meta ships a new build. Sending is deliberately left as a
  paste into the composer rather than a programmatic send.
- The composer selector in `pasteToChat` is the only DOM-dependent code left. If
  pasting stops working, that's where to look.
- Blurred and profile faces are missed. That's a limitation of the models, not a
  threshold you can tune around.

## Layout

```
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
