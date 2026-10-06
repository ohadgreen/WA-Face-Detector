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
                         also draws the in-chat album labels (only its own
                         data-cpf-label hosts), with rules from lib/album-label.js
```

Message tags: `call`/`req`/`res` are extension → page requests; `evt` is
page → background events (`ready`, `newImage`, `openAlbum`, `labelsBroken`); `engine` is a request to the
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

For the in-chat album labels the background also writes `found` (every match,
ids and scores, kept after Mark as seen, pruned after `FOUND_DAYS` = 30),
`gone` (photos skipped as expired, same shape and pruning) and a start point
`autoState[id].from` (photos before it were never checked and get no label;
cursors from before labels get `lastChecked + 1`). A label must never say "0"
unless every photo it covers was actually analysed: albums older than the
`found` window, before `from`, or with a skipped photo and no match get no
label. A label click is written by the background to `openAlbum` in
`chrome.storage.session`; the panel only reads it. The background pushes the
label state for every watched group to the page with `albumState`, at most
once a second.

Each watch's cursor is `lastChecked` + `atChecked` (ids done at exactly that
second), because album photos share a timestamp. The rules are in
`lib/auto-state.js` and unit-tested in `tests/auto-state.test.js` — change
them there, test-first.

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
   clicks "Mark as seen", or when "Add to composer" succeeds (which marks the
   whole review as seen), so an interrupted scan costs nothing. An album
   review (opened from an in-chat label) never changes `lastSeen`.
6. **Never commit `vendor/` or `node_modules/`.** Regenerate with `npm run vendor`.

## The non-obvious technical constraints

Each of these cost a debugging session. Do not "simplify" them away.

- **The detector must run on WASM.** SCRFD contains an `AveragePool` with
  `ceil_mode` that ORT's WebGPU backend does not implement. Requesting `webgpu`
  for the detector throws at first inference, not at load. The recogniser is fine
  on WebGPU and is where the time actually goes (~0.3s per detected face, vs
  ~0.3s per photo for detection).
- **The manifest CSP must include `'wasm-unsafe-eval'`.** Without an explicit
  `content_security_policy.extension_pages`, the panel can get a bare
  `script-src 'self'`, which blocks `WebAssembly.instantiate()`. ORT reports it
  as `no available backend found ... CompileError ... Content Security policy`.
  This permits WASM compilation only — not JS `eval` or remote code — so it does
  not conflict with hard rule 2.
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
- **`getMessages` with `media` is not scoped to the chat.** On current builds it
  goes through WhatsApp's `msgFindQuery('media', …)` and wa-js filters only by
  type, so other chats' images come back. `listNewImages` keeps messages whose
  `id.remote` is the watched chat. Do not drop that filter — it also stops
  `newest` (and so `lastSeen`) being advanced by another chat.
- **Older media links expire.** WhatsApp's CDN URLs carry an expiry (`oe=`, hex
  unix time); past it the fetch is a 403 and `downloadMedia` throws
  `Media not found`. The app recovers by asking the sender's phone to re-upload —
  do not trigger that (hard rule 1). This is why a never-seen watch only looks
  back `FIRST_SCAN_DAYS` (10), scans newest first, and counts these failures
  instead of logging each one.
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
- **Any extension reload disconnects the relay in open WhatsApp tabs.** Calls
  to the page then fail with `Receiving end does not exist` until the tab is
  refreshed — not only after `page.js`/`relay.js` changes. Album labels
  already drawn stay frozen and clicks do nothing until then.
- **Never locate WhatsApp elements by visible text or accessibility labels.**
  They change with WhatsApp's language.
- **All knowledge of WhatsApp's message markup is in `chatIndex` and
  `photosInRow` (page.js).** If labels go missing after a WhatsApp update, fix
  there; the panel log says `chat labels: message rows not found`. As of
  2026-10: a row's `data-id` is the message's *short* id (`msg.id.id`), so
  `MsgStore.get(dataId)` finds nothing — rows resolve through
  `ChatStore.get(chatId).msgs`. An album row is a message of type `album`; its
  photos are separate `image` messages whose `parentMsgKey` is the album's key.
  Rows have no `.message-out`/`.message-in`; the side comes from
  `msg.id.fromMe`. `chrome.sidePanel.open` works from a label click relayed
  page → relay → background.
- **`lib/album-label.js` is a classic script**, loaded before `page.js`,
  because `page.js` can't import modules. It duplicates `notYetChecked` from
  `lib/auto-state.js` — change both. Its tests load it with `node:vm`.

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

`npm test` runs the unit tests for `lib/auto-state.js` and `lib/album-label.js` (Node's built-in
runner, no dependencies). Everything that touches Chrome or WhatsApp is
checked by hand. Before claiming something works:

- `npm test` and `npm run check` (every source file parses; every path
  `manifest.json` references exists). `panel.js`, `engine.js`, `background.js`
  and `lib/*.js` are ES modules; `page.js` and `relay.js` are classic scripts.
- Bump `manifest.json` `version` for every change to the extension.
- Reload the extension, then **refresh WhatsApp Web** — every reload
  disconnects the content scripts in open tabs, and they are not re-injected.
- Watch the panel log. It is the primary diagnostic surface and shows per-photo
  progress, backend selection, and full error messages. Keep it that way: when
  adding a step that can fail, log before and after it. Truncating error strings
  has already hidden one root cause.

Check the right console for the context you changed — an error in one is
invisible in the others. `panel.js`: right-click the side panel → Inspect.
`page.js`/`relay.js`: WhatsApp Web's console. `background.js`:
`chrome://extensions` → service worker. `engine.js`: `chrome://extensions` →
*Inspect views: engine.html*. Background activity also appears in the panel
log with an `[auto]` prefix.

## Style

Plain modern JS, no TypeScript, match the existing style: semicolons, 2-space indent, single quotes.
Comments explain *why*, especially for the constraints above; a future reader
will otherwise "clean up" the WASM pinning or the one-at-a-time transfer and
reintroduce a solved bug.
