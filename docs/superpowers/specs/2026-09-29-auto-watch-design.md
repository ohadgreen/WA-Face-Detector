# Auto-watch: background matching with alerts

Date: 2026-09-29 · Status: approved · Target version: 0.6

## Goal

Once a watch is set, new photos arriving in its WhatsApp group are matched in the
background, and the user is alerted when the child appears — without opening the
panel or starting a scan.

**Success looks like:** a matching photo posted to a watched group produces a
badge and a Windows notification within about a minute, while the WhatsApp Web
tab is open, including when that tab is in the background or Chrome is
minimised. Nothing is ever sent automatically.

## Constraints

- **Requires an open WhatsApp Web tab in a running Chrome.** The tab is the only
  way the extension reaches WhatsApp. Photos that arrive while it is closed are
  picked up by catch-up when it next opens.
- All AGENTS.md hard rules still hold. In particular: no programmatic sending
  (rule 1), no remote code (rule 2), photos are never persisted (rule 3 — the
  match queue stores message ids and scores only), no sender filtering (rule 4).
- Images still cross context boundaries as data URLs, one at a time.
- `lib/face.js` is not modified. Its numerical parity must survive the move.
- No build step, no new dependencies.

## Out of scope

- **Periodic safety-net check** (a `chrome.alarms` catch-up every few minutes).
  Considered and deferred by the owner. Consequence: photos that WhatsApp syncs
  in bulk after sleep or a reconnect may not fire `chat.new_message`, and are
  then only picked up at the next catch-up trigger (tab load or background
  restart).
- Alerts while WhatsApp Web is closed or the machine is asleep.
- A single pass for several children in one group via the manual scan (the
  engine's `analyse` accepts several watches, so auto-watch gets this for free;
  manual scan keeps one watch per run).

## Architecture

```
WhatsApp tab                          extension origin (chrome-extension://)
────────────                          ───────────────────────────────────────
page.js (MAIN)                        background.js (service worker)
  · existing actions                    · owns the engine's lifecycle
  · NEW: emits newImage + ready         · auto-watch queue, one photo at a time
        │                               · writes autoState + pending
relay.js (ISOLATED)                     · badge, notifications, catch-up
  · still a pipe                           │  ▲
  · NEW: forwards page events ────►        ▼  │  runtime messages
    to chrome.runtime                   engine.html / engine.js (offscreen, NEW)
                                          · ORT sessions, lib/face.js, decode
                                          · models read from IndexedDB
                                          · embed · analyse · status
                                          · no storage, no UI, no WhatsApp
                                        panel.js (side panel)
                                          · UI: setup, review, manual scan
                                          · calls the engine instead of ORT
```

### Units

**`engine.html` + `engine.js` (new).** The only place ONNX Runtime runs.
Takes over from `panel.js`: ORT env setup (`wasmPaths`, `numThreads = 1`),
`makeSession`, `ensureModels` (detector pinned to `wasm`, recogniser
`webgpu` then `wasm`), `idbGet`, and `decode`. Stateless apart from the loaded
sessions. Handles one request at a time (internal promise chain). It is an
offscreen document, so the only `chrome.*` API it has is `chrome.runtime`: it
cannot read `chrome.storage` or reach tabs. The models are in IndexedDB on the
extension origin, which it can read directly. The manifest CSP
(`'wasm-unsafe-eval'`) applies to it as an extension page.

**`background.js`.** Creates the engine with
`chrome.offscreen.createDocument({ url: 'engine.html', reasons: ['WORKERS'], justification: 'On-device face recognition for watched groups' })`
and checks it exists (`chrome.runtime.getContexts`) before each call. Runs the
auto-watch loop, owns `autoState` and `pending`, sets the badge, raises
notifications. Talks to the WhatsApp tab with the same
`chrome.tabs.sendMessage({ __cpf: 'call', … })` protocol the panel uses.
Existing behaviour (side-panel on action click, Alt+Shift+R reload) stays.

**`page.js`.** Still the only file that touches wa-js. Adds a
`WPP.on('chat.new_message', …)` listener that, for `type === 'image'`, posts an
event with metadata only. Posts a `ready` event once `ready` resolves. It does
not know which chats are watched — it has no storage access, and the
background filters.

**`relay.js`.** Adds the reverse pipe: `{ __cpf: 'evt' }` window messages are
forwarded with `chrome.runtime.sendMessage`. No logic.

**`panel.js`.** Loses ORT, model loading, and `decode`. Keeps model *storage*
(the file pickers still `idbPut`), `thumbnail`, and all UI. Setup embedding and
manual scan call the engine.

### Messages

| From → to | Message | Reply |
|---|---|---|
| page → relay | `window.postMessage({ __cpf: 'evt', type: 'newImage', data: { id, chatId, t } })` | — |
| page → relay | `window.postMessage({ __cpf: 'evt', type: 'ready' })` | — |
| relay → background | `chrome.runtime.sendMessage({ __cpf: 'evt', type, data })` | — |
| panel/background → engine | `{ __cpf: 'engine', op: 'status' }` | `{ ok, result: { models: bool, det: ep, rec: ep } }` |
| panel → engine | `{ __cpf: 'engine', op: 'embed', args: { dataUrls } }` | `{ ok, result: [{ ok: true, px, embedding } \| { ok: false, reason }] }` |
| panel/background → engine | `{ __cpf: 'engine', op: 'analyse', args: { dataUrl, watches: [{ id, refs, threshold }] } }` | `{ ok, result: { detected, results: [{ id, best, px }] } }` |
| panel → background | `{ __cpf: 'bg', op: 'ensureEngine' \| 'catchUp' \| 'markSeen' \| 'reset', args }` | `{ ok, result }` |

Every `chrome.runtime.sendMessage` reaches every extension context, so each
listener ignores `__cpf` values that are not its own. `analyse` uses
`minFace: 30, detSize: 640`; `embed` uses `minFace: 0` and returns the largest
face, both as today.

## Data and state

One writer per storage key, so the panel and background never overwrite each
other's changes.

| Key (`chrome.storage.local`) | Writer | Contents |
|---|---|---|
| `watches` (existing) | panel | as today, plus `auto` (boolean). Missing means on, so existing watches get Auto-watch. |
| `autoState` (new) | background | `{ [watchId]: { lastChecked } }` — unix seconds of the newest photo analysed |
| `pending` (new) | background | `{ [watchId]: [{ id, t, score, px }] }` — matches awaiting review. No images. |

| Key (`chrome.storage.session`) | Writer | Contents |
|---|---|---|
| `autoLog` | background | last 200 background log lines |

The panel changes background-owned state only by messaging the background
(`catchUp`, `markSeen`, `reset`). The panel still writes `lastSeen` and `auto`
itself, because they live in `watches`; it then tells the background, which
re-reads `watches` before every photo.

**Two markers per watch.** `lastSeen` (existing, set by the user via Mark as
seen) means *reviewed up to here*. `lastChecked` (new, set by the background)
means *analysed up to here*.

### The loop

1. **Start point.** When a watch has Auto-watch on and no `lastChecked`, it is
   initialised to `sinceOf(watch)`: `lastSeen`, or 10 days back
   (`FIRST_SCAN_DAYS`) if never seen.
2. **Catch-up triggers:** a `ready` event from the page, and every background
   start (top-level code runs on each wake). For each auto watch, call
   `listNewImages({ chatId: src, since: lastChecked - 1 })` and enqueue the
   photos oldest first. The `- 1` is deliberate: photos in one album share a
   timestamp, so a restart between two siblings must list the one at
   `lastChecked` again. A photo is analysed for a watch when
   `t >= lastChecked`, and `pending` de-duplicates by id, so re-analysing a
   sibling is harmless.
3. **Live:** a `newImage` event whose `chatId` is the `src` of at least one
   auto watch joins the queue; per-watch `t >= lastChecked` is checked when it
   is processed. A watch with no `autoState` yet is skipped until catch-up has
   initialised it, so a live photo cannot jump it past its 10-day window. The queue is kept ordered by `t` and de-duplicates by message
   id. Processing does not start while a catch-up listing is in flight, so a
   live photo can never be analysed ahead of older ones still being listed.
4. **Processing**, one photo at a time: `downloadImage` from the tab, one
   `analyse` against every auto watch on that chat, append any
   `best >= threshold` to that watch's `pending`, then set `lastChecked` to
   `max(lastChecked, t)` for those watches. Oldest-first order keeps it moving
   forward, so stopping at any point loses nothing and repeats nothing.
   `FIRST_SCAN_DAYS` and `sinceOf` are needed by both panel and background.
   They are duplicated in `background.js` (not shared), each copy with a
   comment naming the other so a change is made in both.
5. **Failures.** `Media not found`: counted, skipped, `lastChecked` still
   advances. Any other error: the loop pauses *without* advancing and resumes
   on the next trigger or event.

### Alerts

- **Badge:** total `pending` count across watches (`chrome.action.setBadgeText`),
  recomputed whenever `pending` changes. `!` with a tooltip when the engine has
  no models.
- **Notification** (`chrome.notifications`): one per batch, not per photo —
  e.g. *"3 new photos of carmel in כיתה א2"*. Raised when the queue drains, and
  at most once a minute per watch while a long batch is still running.
- **Click:** focuses the WhatsApp tab and its window, then tries
  `chrome.sidePanel.open({ windowId })`. Chrome may refuse that outside a
  direct user gesture; the badge is the fallback. To be confirmed in testing.

## UI changes

- **Setup, saved watches:** an Auto-watch toggle per watch (the panel writes
  `auto`, then sends `catchUp`), next to the existing Reset and Remove.
  Remove also sends `reset`, so the removed watch's `autoState` and `pending`
  go with it. The "Add a group to watch" form gets
  the same toggle, default on.
- **Photos, auto watch card:** shows *"N matches waiting"* and a **Review**
  button. Review builds the existing grid from `pending`: each id is
  downloaded again, thumbnailed in memory, and shown with its stored score and
  px. An id whose media is gone shows as *no longer available*.
  - **Add to composer:** unchanged.
  - **Mark as seen:** the panel sets `lastSeen` to the watch's `lastChecked`
    as read when Review opened, then sends `markSeen({ watchId, ids })` with
    the ids shown. The background removes only those ids from `pending`, so
    matches that arrive while the review is open are kept.
- **Photos, manual watch card** (Auto-watch off): unchanged, with the scan
  running through the engine.
- **Reset** (existing button): the panel sets `lastSeen = 0` as today, then
  sends `reset`, which clears that watch's `autoState` and `pending` and runs
  catch-up, so an auto watch re-covers the last 10 days. The button is enabled
  when the watch has a `lastSeen` or anything pending.
- **Turning Auto-watch off:** background processing stops for that watch;
  `pending` is kept until reviewed.
- **Log:** the panel shows `autoLog` lines live (via `storage.onChanged`),
  prefixed `[auto]`, alongside its own.

## Error handling

| Situation | Behaviour |
|---|---|
| Models not stored | Engine returns "no models". Auto-watch pauses; badge shows `!`. |
| No WhatsApp tab, or tab reloading | Loop pauses without advancing; the next `ready` restarts catch-up. |
| Background put to sleep mid-queue | In-memory queue is lost; the next background start runs catch-up from `lastChecked`. |
| Engine page closed or crashed | Recreated before the next call; one retry, then pause. |
| `Media not found` | Counted and skipped. |
| Pending photo expired by review time | Shown as *no longer available*; the rest of the review works. |
| Manual scan while background is busy | Engine serialises requests; both run slower. |

## Risks to settle first

1. **WebGPU inside an offscreen document.** Unverified. First implementation
   step is the engine with model loading only, logging the backend each model
   gets. If the recogniser falls back to WASM, measure seconds per face on a
   real photo and report before building further.
2. **`sidePanel.open` from a notification click.** May be refused; the badge
   is the fallback.
3. **`chat.new_message` for bulk-synced messages** after sleep or reconnect.
   Possibly not fired; accepted, given the periodic check is out of scope.

## Manifest

Add `offscreen` and `notifications` to `permissions`. Version `0.6`.

## Verification

The queue and cursor rules live in a pure module, `lib/auto-state.js`, with no
`chrome.*` calls, and get unit tests in `tests/auto-state.test.js` using Node's
built-in runner (`node --test tests/`; no dependency added). Everything that
touches Chrome or WhatsApp is verified by hand.

1. `node --test tests/` passes.
1. `node --check` every changed file (`panel.js`, `engine.js`, `lib/face.js`
   are ES modules; the others are classic scripts). Confirm `manifest.json`
   parses and every referenced path exists.
2. **Parity after the move:** re-embed `car_ref1.jpg` through the engine and
   compare with the vector stored in the carmel watch; expect cosine ≥ 0.999.
3. **End-to-end, with the owner's phone:**
   - Make a small test group, add a watch, post a photo of the child: badge and
     notification within seconds.
   - Post a photo without the child: no alert.
   - Repeat with WhatsApp in a background tab, and with Chrome minimised.
   - Close WhatsApp Web, post a photo, reopen it: catch-up picks it up.
   - Review, Mark as seen (including a match that arrives while reviewing),
     Reset, and the Auto-watch toggle behave as above.
4. Consoles: the engine page is under `chrome://extensions` → *Inspect views:
   engine.html*.

## Documentation

AGENTS.md:
- Architecture diagram: five contexts, with the engine.
- Replace "Why recognition lives in the panel" with the engine page's role;
  the reasoning (clean extension origin for IndexedDB models) carries over.
- `relay.js` now pipes both directions.
- Memory Saver: add `web.whatsapp.com` to *Always keep these sites active* in
  `chrome://settings/performance`, or Chrome may discard the tab and stop
  events.
- Console list: add the engine page.

README: the Memory Saver setting, in the user setup steps.
