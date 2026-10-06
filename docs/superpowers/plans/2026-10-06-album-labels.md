# Album Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every photo album in a watched WhatsApp group shows a label with how many photos of the child it contains (or *in progress*); clicking it opens the side panel on a review of just that album.

**Architecture:** The background keeps every match in a new `found` key and pushes a compact label state for all watched groups to `page.js` (throttled, trailing). `page.js` observes WhatsApp's conversation rows, asks a pure classic-script module (`lib/album-label.js`) what each row's label is, and draws it in a closed shadow root. A click travels page → relay → background, which opens the side panel and leaves the request in session storage for the panel's album-scoped review.

**Tech Stack:** Manifest V3 Chrome extension, plain JS (no build step), wa-js (`vendor/wa-js.js`), Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-05-album-labels-design.md` (approved). Read it before starting.

**Deliberate simplifications of the spec** (same behaviour, less machinery):
- One `albumState` push carries *all* watched groups, replacing the page's whole label state. The spec said per group; a full push also clears labels for a group whose watch was turned off while the background was asleep, with no bookkeeping.
- Each child is its own chip inside one label host, instead of one pill with `·` separators (`Nir · in progress · Maya 3` would be ambiguous).
- `labelsBroken` fires when a watched group is open and WhatsApp's store resolves **no** row for 30 s (or `#main` is missing). The spec's extra "group has images in the store" check is dropped; text-only stretches of chat still have resolvable rows, so it doesn't false-alarm.

## Global Constraints

- AGENTS.md hard rules hold: no programmatic sending (rule 1); never persist photos — `found` holds `{ id, t, score, px }` only (rule 3); no sender filtering (rule 4).
- `page.js` is the only file that touches WhatsApp internals; all knowledge of WhatsApp's message markup lives in `photosInRow` in `page.js`.
- Never locate WhatsApp elements by visible text or accessibility labels.
- One writer per storage key: `found`, `autoState` (incl. `from`), `pending` → background; `openAlbum` (session) → background; `watches` → panel.
- No build step, no new dependencies, no new permissions.
- `relay.js` is not changed.
- Labels only for Auto-watch watches; photos with `t < from` get no label.
- `FOUND_DAYS = 30`; label push at most once per second, trailing; panel honours an `openAlbum` request on start only if under 2 minutes old; `labelsBroken` after 30 s, once per page load.
- An album review never changes `lastSeen`.
- Style: semicolons, 2-space indent, single quotes, comments explain *why*.
- Bump `manifest.json` `version` one minor step (0.10 → 0.11, or one above whatever is current).
- After any extension reload, refresh WhatsApp Web before testing.

## Review Focus

1. **Label's own DOM writes re-triggering the observer** — a reasonable person expects an idle WhatsApp tab to stay idle. Pinned by the observer filter in Task 5 Step 3 and the CPU check in Task 7 Step 4 (item 9).
2. **Album straddling the watch's start (`from`)** — only photos after `from` count; older siblings must not turn the label into *in progress* or inflate the count. Test in Task 3 (`album straddling from`).
3. **Cursor not initialised yet** (watch just added, catch-up still listing) — no label rather than a wrong one. Test in Task 2 (`albumStates: skips manual watches and watches with no cursor yet`).
4. **The same click request seen twice** (panel start + `onChanged`) — opens one review, not two. Pinned by `albumHandled` in Task 6 Step 2 and Task 7 Step 4 (item 2).
5. **Child or group names with markup characters** — must render as text in the chip. Pinned by `textContent` in Task 5 Step 3 and a test in Task 3 (`partText keeps names as plain text`).

---

### Task 1: Check WhatsApp's markup and the side-panel gesture (throwaway)

Nothing from this task is kept except the findings. It decides the body of `photosInRow` (Task 5) and whether label clicks can open the panel.

**Files:**
- Temporarily modify: `background.js` (reverted in Step 5)
- Modify: `docs/superpowers/specs/2026-10-05-album-labels-design.md` (append findings)

**Interfaces:**
- Consumes: nothing.
- Produces: a *Findings* section in the spec naming (a) which `photosInRow` variant from Task 5 applies, (b) whether `sidePanel.open` works from a label click, (c) the active-chat call, (d) whether `.message-out` marks outgoing rows.

- [ ] **Step 1: Inspect rows on a real watched group**

Open WhatsApp Web, open a watched group, scroll so at least one multi-photo album, one single photo, one text message and one of your own messages are on screen. In the WhatsApp tab's DevTools console (top frame, where `WPP` is defined) run:

```js
(() => {
  const main = document.querySelector('#main');
  console.log('#main present:', !!main);
  const rows = [...main.querySelectorAll('[data-id]')];
  console.table(rows.slice(-25).map((el) => {
    const m = WPP.whatsapp.MsgStore.get(el.dataset.id);
    return {
      id: el.dataset.id.slice(0, 60),
      nestedInRow: !!el.parentElement.closest('[data-id]'),
      innerIds: el.querySelectorAll('[data-id]').length,
      type: m?.type, t: m?.t, author: String(m?.author || ''),
      out: !!el.querySelector('.message-out'),
    };
  }));
  console.log('active chat:', WPP.chat.getActiveChat()?.id?.toString());
})();
```

Record:
- Does every album photo appear as its own `[data-id]` (nested inside the album row, `innerIds > 0`)? → **variant (a)**.
- Or does an album bubble carry one `[data-id]` (the first or last photo) with `innerIds = 0`? → **variant (b)**.
- Neither (no `data-id`, or `MsgStore.get` returns `undefined` for image rows) → **stop and report to the owner**; the design needs a different row strategy.
- Does `out` correctly mark your own messages?
- Does `WPP.chat.getActiveChat()` return the open group's id? Switch chats and run that line again.

- [ ] **Step 2: For variant (b) only — check the album run**

With an album's `[data-id]` from Step 1 in `id`:

```js
(() => {
  const id = '<paste the album row data-id>';
  const m = WPP.whatsapp.MsgStore.get(id);
  const msgs = WPP.whatsapp.ChatStore.get(m.id.remote).msgs.getModelsArray();
  const i = msgs.indexOf(m);
  console.table(msgs.slice(Math.max(0, i - 3), i + 12).map((x) => ({
    id: x.id.toString().slice(0, 60), type: x.type, t: x.t, author: String(x.author || ''),
  })));
})();
```

Record whether the album's photos are the consecutive same-author `image` messages starting at (or ending at) that id, and the direction.

- [ ] **Step 3: Temporarily add a gesture probe to the background**

In `background.js`, inside the `__cpf: 'evt'` listener (the one that handles `ready`), add as the first line after the `waTab` assignment:

```js
  if (msg.type === 'probeOpen') {
    chrome.sidePanel.open({ windowId: sender.tab.windowId })
      .then(() => console.log('probe: side panel opened'),
            (e) => console.log('probe: side panel refused -', e.message));
    return;
  }
```

Reload the extension (Alt+Shift+R), close the side panel, refresh WhatsApp Web.

- [ ] **Step 4: Click-test the probe**

In the WhatsApp console:

```js
document.addEventListener('click', () => window.postMessage({ __cpf: 'evt', type: 'probeOpen' }, '*'),
  { once: true, capture: true });
```

Click anywhere in WhatsApp. Check the service worker console (`chrome://extensions` → service worker): `probe: side panel opened` or `probe: side panel refused - …`. Record which, and whether the panel appeared.

- [ ] **Step 5: Revert the probe and record findings**

Remove the Step 3 lines from `background.js` (`git diff background.js` must be empty). Append to the spec:

```markdown
## Findings (Task 1 of the plan, <date>)

- Row markup: variant (a|b) — <one line on what a row carries>.
- Album run (variant b only): <same-author consecutive images, starting|ending at the row id>.
- Outgoing rows: `.message-out` (works|does not work).
- Active chat: `WPP.chat.getActiveChat()` (works|<alternative>).
- Side panel from a label click: (opens|refused: "<message>").
```

If the panel was **refused**, stop and report to the owner before Task 4 (spec: "report to the owner before building on that").

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-05-album-labels-design.md docs/superpowers/plans/2026-10-06-album-labels.md
git commit -m "docs: album labels spec, plan and markup findings"
```

---

### Task 2: `found`, `from` and the label payload in `lib/auto-state.js`

**Files:**
- Modify: `lib/auto-state.js`
- Test: `tests/auto-state.test.js`

**Interfaces:**
- Consumes: existing `isAuto`, `recordResult`, `forget`, `initState`.
- Produces (all exported from `lib/auto-state.js`):
  - `FOUND_DAYS` — `30`
  - `initState(w, nowSec, days)` → `{ lastChecked, atChecked: [], from }` (`from === lastChecked`)
  - `ensureFrom(autoState)` → new map; any cursor without `from` gets `from = lastChecked`
  - `recordResult({ autoState, pending, found = {} }, photo, results, targets)` → `{ autoState, pending, found, matched }`; cursors keep `from`
  - `forget({ autoState, pending, found = {} }, watchId)` → `{ autoState, pending, found }`
  - `pruneFound(found, nowSec, days = FOUND_DAYS)` → new map without entries older than `days`
  - `albumStates(watches, autoState, pending, found, strings)` → `{ strings, chats: [{ chatId, watches: [{ id, name, from, lastChecked, atChecked, found: { [msgId]: reviewedBool } }] }] }`

- [ ] **Step 1: Write the failing tests**

In `tests/auto-state.test.js`, extend the import:

```js
import {
  isAuto, initState, catchUpSince, targetsFor, PhotoQueue,
  recordResult, skipResult, markSeen, forget, pendingTotal, Batcher, notifyText, onFailure,
  ensureFrom, pruneFound, albumStates, FOUND_DAYS,
} from '../lib/auto-state.js';
```

Replace the existing `initState` test with:

```js
test('initState: lastSeen wins, otherwise the first-scan window; from is the same start point', () => {
  assert.deepEqual(initState(W('a', { lastSeen: 500 }), 10_000_000, 10), { ...C(500), from: 500 });
  const start = 10_000_000 - 864_000;
  assert.deepEqual(initState(W('a'), 10_000_000, 10), { ...C(start), from: start });
});
```

Replace the existing `forget` test with:

```js
test('forget drops a watch from autoState, pending and found', () => {
  const s = forget({
    autoState: { a: C(1), b: C(2) }, pending: { a: [{ id: 'm1' }] }, found: { a: [{ id: 'm1' }], b: [{ id: 'x' }] },
  }, 'a');
  assert.deepEqual(s, { autoState: { b: C(2) }, pending: {}, found: { b: [{ id: 'x' }] } });
});
```

Append:

```js
test('ensureFrom: a cursor from before album labels starts labelling where it is', () => {
  const out = ensureFrom({ a: C(300, ['m1']), b: { ...C(400), from: 100 } });
  assert.deepEqual(out, { a: { ...C(300, ['m1']), from: 300 }, b: { ...C(400), from: 100 } });
});

test('recordResult: the cursor keeps its from', () => {
  const s = recordResult({ autoState: { a: { ...C(90), from: 50 } }, pending: {} }, P('m1', 100), [hit('a', 0.1)], [W('a')]);
  assert.deepEqual(s.autoState.a, { ...C(100, ['m1']), from: 50 });
});

test('recordResult: a match goes into found as well as pending, once', () => {
  let s = { autoState: { a: C(90) }, pending: {}, found: {} };
  s = recordResult(s, P('m1', 100), [hit('a', 0.5, 70)], [W('a')]);
  assert.deepEqual(s.found, { a: [{ id: 'm1', t: 100, score: 0.5, px: 70 }] });
  s = recordResult(s, P('m1', 100), [hit('a', 0.5, 70)], [W('a')]);
  assert.equal(s.found.a.length, 1);
});

test('recordResult: state written before album labels (no found) still works', () => {
  const s = recordResult({ autoState: { a: C(90) }, pending: {} }, P('m1', 100), [hit('a', 0.5, 70)], [W('a')]);
  assert.deepEqual(s.found.a.map((x) => x.id), ['m1']);
});

test('pruneFound drops matches older than FOUND_DAYS and empty watches', () => {
  const now = 10_000_000, old = now - FOUND_DAYS * 86400 - 1, edge = now - FOUND_DAYS * 86400;
  const out = pruneFound({ a: [{ id: 'm1', t: old }, { id: 'm2', t: edge }], b: [{ id: 'x', t: old }] }, now);
  assert.deepEqual(out, { a: [{ id: 'm2', t: edge }] });
});

test('albumStates: per group, cursor plus found flagged reviewed when no longer waiting', () => {
  const ws = [W('a', { refs: [[1, 2]] }), W('b', { src: 'g2@g.us' })];
  const autoState = { a: { ...C(200, ['m3']), from: 100 }, b: { ...C(50), from: 10 } };
  const pending = { a: [{ id: 'm2' }] };
  const found = { a: [{ id: 'm1', t: 120 }, { id: 'm2', t: 150 }] };
  const out = albumStates(ws, autoState, pending, found, { inProgress: 'in progress' });
  assert.deepEqual(out, {
    strings: { inProgress: 'in progress' },
    chats: [
      { chatId: G, watches: [{ id: 'a', name: 'kid-a', from: 100, lastChecked: 200, atChecked: ['m3'],
        found: { m1: true, m2: false } }] },
      { chatId: 'g2@g.us', watches: [{ id: 'b', name: 'kid-b', from: 10, lastChecked: 50, atChecked: [], found: {} }] },
    ],
  });
  assert.ok(!JSON.stringify(out).includes('refs'));
});

test('albumStates: skips manual watches and watches with no cursor yet', () => {
  const ws = [W('a', { auto: false }), W('b'), W('c')];
  const out = albumStates(ws, { a: C(1), c: C(5) }, {}, {}, {});
  assert.deepEqual(out.chats.map((c) => c.watches.map((w) => w.id)), [['c']]);
  assert.equal(out.chats[0].watches[0].from, 5); // no from yet: falls back to lastChecked
});

test('albumStates: two watches on one group share one entry', () => {
  const out = albumStates([W('a'), W('b')], { a: C(1), b: C(2) }, {}, {}, {});
  assert.equal(out.chats.length, 1);
  assert.deepEqual(out.chats[0].watches.map((w) => w.id), ['a', 'b']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ensureFrom`/`pruneFound`/`albumStates`/`FOUND_DAYS` are not exported (SyntaxError on import), so the whole file fails.

- [ ] **Step 3: Implement in `lib/auto-state.js`**

Replace `initState`:

```js
/** Where a watch starts: where the user last reviewed, or `days` back.
    `from` keeps that start point for in-chat labels: photos before it were
    never checked, so they get no label rather than a wrong "0". */
export const initState = (w, nowSec, days) => {
  const start = w.lastSeen || nowSec - days * 86400;
  return { lastChecked: start, atChecked: [], from: start };
};

/** Cursors written before album labels have no `from`. The albums they
    checked earlier have no `found` entries, so labelling starts from where
    each cursor is now. */
export function ensureFrom(autoState) {
  const a = {};
  for (const [id, c] of Object.entries(autoState)) {
    a[id] = c.from === undefined ? { ...c, from: c.lastChecked } : c;
  }
  return a;
}
```

Replace `advance` so it keeps every other cursor field (`from`):

```js
function advance(c, photo) {
  if (photo.t > c.lastChecked) return { ...c, lastChecked: photo.t, atChecked: [photo.id] };
  if (photo.t === c.lastChecked && !c.atChecked.includes(photo.id)) {
    return { ...c, atChecked: [...c.atChecked, photo.id] };
  }
  return c;
}
```

Replace `recordResult`:

```js
/** Apply one analysed photo: advance every target's cursor, and record a
    match for each target at or above its own threshold - in `pending`
    (waiting for review) and in `found` (kept after review, for the in-chat
    album labels). Both hold ids and scores only - never images. */
export function recordResult({ autoState, pending, found = {} }, photo, results, targets) {
  const a = { ...autoState }, p = { ...pending }, f = { ...found }, matched = [];
  for (const w of targets) {
    a[w.id] = advance(a[w.id] || { lastChecked: 0, atChecked: [] }, photo);
    const r = results.find((x) => x.id === w.id);
    if (!r || r.best < w.threshold) continue;
    const entry = { id: photo.id, t: photo.t, score: r.best, px: r.px };
    if (!(f[w.id] || []).some((x) => x.id === photo.id)) f[w.id] = [...(f[w.id] || []), entry];
    const list = p[w.id] || [];
    if (list.some((x) => x.id === photo.id)) continue;
    p[w.id] = [...list, entry];
    matched.push(w.id);
  }
  return { autoState: a, pending: p, found: f, matched };
}
```

Replace `forget`:

```js
export function forget({ autoState, pending, found = {} }, watchId) {
  const a = { ...autoState }, p = { ...pending }, f = { ...found };
  delete a[watchId]; delete p[watchId]; delete f[watchId];
  return { autoState: a, pending: p, found: f };
}
```

Append at the end of the file:

```js
/** Matches are kept this long for the in-chat labels. WhatsApp's media
    links have expired by then, so an older label could not be reviewed. */
export const FOUND_DAYS = 30;

export function pruneFound(found, nowSec, days = FOUND_DAYS) {
  const cutoff = nowSec - days * 86400, f = {};
  for (const [id, list] of Object.entries(found)) {
    const keep = list.filter((x) => x.t >= cutoff);
    if (keep.length) f[id] = keep;
  }
  return f;
}

/** What the WhatsApp page needs to draw album labels, for every group with
    an Auto-watch watch whose cursor exists: each watch's cursor and its
    matches, flagged reviewed once no longer waiting. Never the face
    references - this goes into WhatsApp's page. */
export function albumStates(watches, autoState, pending, found, strings) {
  const chats = new Map();
  for (const w of watches) {
    const c = autoState[w.id];
    if (!isAuto(w) || !c) continue;
    const waiting = new Set((pending[w.id] || []).map((x) => x.id));
    const f = {};
    for (const x of found[w.id] || []) f[x.id] = !waiting.has(x.id);
    if (!chats.has(w.src)) chats.set(w.src, []);
    chats.get(w.src).push({
      id: w.id, name: w.name, from: c.from ?? c.lastChecked,
      lastChecked: c.lastChecked, atChecked: c.atChecked, found: f,
    });
  }
  return { strings, chats: [...chats].map(([chatId, ws]) => ({ chatId, watches: ws })) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests (the 26 existing, two of them replaced, plus 8 new).

- [ ] **Step 5: Commit**

```bash
git add lib/auto-state.js tests/auto-state.test.js
git commit -m "feat: keep matches in found and a start point per watch for album labels"
```

---

### Task 3: Label rules — `lib/album-label.js`

**Files:**
- Create: `lib/album-label.js`
- Test: `tests/album-label.test.js`
- Modify: `manifest.json` (content script order), `scripts/check.mjs` (syntax list)

**Interfaces:**
- Consumes: the `chats[i]` shape from Task 2's `albumStates`.
- Produces: `globalThis.CpfAlbumLabel = { labelFor, partText }`
  - `labelFor(photos, chat)` — `photos: [{ id, t }]` (`t` may be `undefined`), `chat`: one `albumStates().chats` entry or `undefined` → `[{ watchId, name, state: 'progress' | 'done', count, reviewed, ids }]`
  - `partText(part, strings)` → `'Nir 3'`, `'Nir 3 ✓'`, `'Nir 0'`, `'Nir · in progress'`

- [ ] **Step 1: Write the failing tests**

Create `tests/album-label.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// lib/album-label.js is a classic script (page.js can't import modules), so
// run it in a sandbox and take the global it defines.
const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../lib/album-label.js', import.meta.url), 'utf8'), ctx);
const { labelFor, partText } = ctx.CpfAlbumLabel;
// Objects made in the sandbox have its own prototypes, which strict
// deepEqual rejects; compare plain copies.
const plain = (x) => JSON.parse(JSON.stringify(x));

const W = (id, over = {}) => ({
  id, name: 'kid-' + id, from: 100, lastChecked: 200, atChecked: [], found: {}, ...over,
});
const chat = (...watches) => ({ chatId: 'g1@g.us', watches });
const ph = (id, t) => ({ id, t });
const done = (id, count, reviewed, ids) => ({ watchId: id, name: 'kid-' + id, state: 'done', count, reviewed, ids });
const progress = (id) => ({ watchId: id, name: 'kid-' + id, state: 'progress', count: 0, reviewed: false, ids: [] });

test('every photo before the watch started: no label', () => {
  assert.deepEqual(plain(labelFor([ph('m1', 50), ph('m2', 99)], chat(W('a')))), []);
});

test('a photo the watch has not reached yet: in progress', () => {
  assert.deepEqual(plain(labelFor([ph('m1', 150), ph('m2', 250)], chat(W('a')))), [progress('a')]);
});

test('checked with no matches: 0', () => {
  assert.deepEqual(plain(labelFor([ph('m1', 150), ph('m2', 160)], chat(W('a')))), [done('a', 0, false, [])]);
});

test('checked with matches, one still waiting: count, not reviewed', () => {
  const w = W('a', { found: { m1: true, m3: false } });
  assert.deepEqual(plain(labelFor([ph('m1', 150), ph('m2', 150), ph('m3', 150)], chat(w))),
    [done('a', 2, false, ['m1', 'm3'])]);
});

test('every match reviewed: reviewed', () => {
  const w = W('a', { found: { m1: true, m2: true } });
  assert.deepEqual(plain(labelFor([ph('m1', 150), ph('m2', 150)], chat(w))), [done('a', 2, true, ['m1', 'm2'])]);
});

test('album straddling from: only the photos after from count', () => {
  const w = W('a', { found: { m2: false } });
  assert.deepEqual(plain(labelFor([ph('m1', 90), ph('m2', 150)], chat(w))), [done('a', 1, false, ['m2'])]);
});

test('shared timestamp: a sibling not in atChecked is still in progress', () => {
  const half = W('a', { lastChecked: 200, atChecked: ['m1'] });
  assert.deepEqual(plain(labelFor([ph('m1', 200), ph('m2', 200)], chat(half))), [progress('a')]);
  const all = W('a', { lastChecked: 200, atChecked: ['m1', 'm2'] });
  assert.deepEqual(plain(labelFor([ph('m1', 200), ph('m2', 200)], chat(all))), [done('a', 0, false, [])]);
});

test('two watches on one row: one part each, in payload order', () => {
  const a = W('a', { found: { m1: false } });
  const b = W('b', { lastChecked: 120 });
  assert.deepEqual(plain(labelFor([ph('m1', 150)], chat(a, b))), [done('a', 1, false, ['m1']), progress('b')]);
});

test("photos missing from WhatsApp's store are left out", () => {
  const w = W('a', { found: { m2: false } });
  assert.deepEqual(plain(labelFor([ph('m1', undefined), ph('m2', 150)], chat(w))), [done('a', 1, false, ['m2'])]);
  assert.deepEqual(plain(labelFor([ph('m1', undefined)], chat(w))), []);
});

test('no state for the chat: no label', () => {
  assert.deepEqual(plain(labelFor([ph('m1', 150)], undefined)), []);
});

test('partText', () => {
  const s = { inProgress: 'in progress' };
  assert.equal(partText(done('a', 3, false, []), s), 'kid-a 3');
  assert.equal(partText(done('a', 3, true, []), s), 'kid-a 3 ✓');
  assert.equal(partText(done('a', 0, false, []), s), 'kid-a 0');
  assert.equal(partText(progress('a'), s), 'kid-a · in progress');
});

test('partText keeps names as plain text', () => {
  const part = { ...done('a', 1, false, []), name: '<b>Nir</b>' };
  assert.equal(partText(part, {}), '<b>Nir</b> 1'); // page.js sets it with textContent
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ENOENT ... lib/album-label.js`.

- [ ] **Step 3: Create `lib/album-label.js`**

```js
/* Album label rules for the in-chat labels. A classic script, not a module:
   page.js runs as a classic MAIN-world script and this file is loaded just
   before it (manifest.json). Unit-tested in Node through node:vm
   (tests/album-label.test.js). No DOM and no WhatsApp here - page.js finds
   a row's photos, this decides what the row's label says. */
(() => {
  // Same rule as notYetChecked in lib/auto-state.js - change both. Photos in
  // one album share a timestamp, so at exactly lastChecked the ids decide.
  const notYetChecked = (w, p) =>
    p.t > w.lastChecked || (p.t === w.lastChecked && !w.atChecked.includes(p.id));

  /** photos: [{ id, t }] shown in one row; t is undefined when WhatsApp's
      store doesn't have the message. chat: one entry of the background's
      albumStates().chats, or undefined. One part per watch with something
      to say; an empty list means no label. */
  function labelFor(photos, chat) {
    const known = photos.filter((p) => typeof p.t === 'number');
    const parts = [];
    for (const w of chat?.watches || []) {
      // Photos before the watch started were never checked.
      const mine = known.filter((p) => p.t >= w.from);
      if (!mine.length) continue;
      if (mine.some((p) => notYetChecked(w, p))) {
        parts.push({ watchId: w.id, name: w.name, state: 'progress', count: 0, reviewed: false, ids: [] });
        continue;
      }
      const ids = mine.map((p) => p.id).filter((id) => Object.hasOwn(w.found, id));
      parts.push({
        watchId: w.id, name: w.name, state: 'done', count: ids.length,
        reviewed: ids.length > 0 && ids.every((id) => w.found[id]), ids,
      });
    }
    return parts;
  }

  function partText(part, strings) {
    if (part.state === 'progress') return `${part.name} · ${strings.inProgress}`;
    return `${part.name} ${part.count}${part.reviewed ? ' ✓' : ''}`;
  }

  globalThis.CpfAlbumLabel = { labelFor, partText };
})();
```

- [ ] **Step 4: Load it before `page.js` and add it to the syntax check**

In `manifest.json`, the MAIN-world content script entry becomes:

```json
      "js": [
        "vendor/wa-js.js",
        "lib/album-label.js",
        "page.js"
      ],
```

In `scripts/check.mjs`, the `sources` list becomes:

```js
const sources = ['background.js', 'engine.js', 'page.js', 'panel.js', 'relay.js',
  'lib/face.js', 'lib/auto-state.js', 'lib/album-label.js'];
```

- [ ] **Step 5: Run tests and checks**

Run: `npm test && npm run check`
Expected: all tests PASS; `ok - manifest 0.10, permissions: storage, sidePanel, tabs, offscreen, notifications`.

- [ ] **Step 6: Commit**

```bash
git add lib/album-label.js tests/album-label.test.js manifest.json scripts/check.mjs
git commit -m "feat: album label rules as a classic script for page.js"
```

---

### Task 4: Background — keep `found`, push labels, handle label clicks

**Files:**
- Modify: `background.js`

**Interfaces:**
- Consumes: `ensureFrom`, `pruneFound`, `albumStates` (Task 2); page action `albumState` (Task 5 — until then the push fails silently, by design).
- Produces:
  - page call `callPage('albumState', { strings, chats })`
  - handles `evt 'openAlbum' { chatId, watchId, ids }` and `evt 'labelsBroken'`
  - `chrome.storage.session` key `openAlbum: { watchId, ids, at }` (read by Task 6)
  - `chrome.storage.local` key `found` (read by Task 6)

- [ ] **Step 1: Import the new rules**

```js
import {
  isAuto, initState, catchUpSince, targetsFor, PhotoQueue,
  recordResult, skipResult, markSeen, forget, pendingTotal, Batcher, notifyText, onFailure,
  ensureFrom, pruneFound, albumStates,
} from './lib/auto-state.js';
```

- [ ] **Step 2: Load and write `found`; push labels after every write**

Replace `load` and `mutate`:

```js
const load = async () => {
  const { watches = [], autoState = {}, pending = {}, found = {} } =
    await chrome.storage.local.get(['watches', 'autoState', 'pending', 'found']);
  return { watches, autoState: ensureFrom(autoState), pending, found };
};

// Every write goes through this chain, so the loop and panel requests
// (markSeen, reset) can't interleave a read-modify-write. `fn` may return
// only the parts it changes; the rest are carried over.
let writing = Promise.resolve();
function mutate(fn) {
  const run = writing.then(async () => {
    const { autoState, pending, found } = await load();
    const out = { autoState, pending, found, ...fn({ autoState, pending, found }) };
    out.found = pruneFound(out.found, Math.floor(Date.now() / 1000));
    await chrome.storage.local.set({ autoState: out.autoState, pending: out.pending, found: out.found });
    await updateBadge(out.pending);
    pushLabels();
    return out;
  });
  writing = run.catch(() => {});
  return run;
}
```

- [ ] **Step 3: Add the label push** (below `updateBadge`)

```js
/* ---------- in-chat album labels ---------- */

// Label text lives here, not in page.js, so the page needs no language.
const LABEL_STRINGS = { inProgress: 'in progress', reviewed: 'reviewed' };

// One push carries every watched group and replaces the page's whole label
// state, so a group whose watch was turned off loses its labels too. At most
// once a second while a batch runs; it reads state when it fires, so the
// last change always gets through.
let pushTimer = null;
function pushLabels() {
  pushTimer ??= setTimeout(async () => {
    pushTimer = null;
    const { watches, autoState, pending, found } = await load();
    await callPage('albumState', albumStates(watches, autoState, pending, found, LABEL_STRINGS))
      .catch(() => {}); // no tab or not ready: the next 'ready' pushes again
  }, 1000);
}

// Auto-watch toggled or a watch removed in the panel (it owns `watches`).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.watches) pushLabels();
});

// sidePanel.open needs the click's user gesture, so it is the first call,
// before anything is awaited. Chrome may still refuse; the request then
// waits in session storage until the panel is opened by hand.
function openAlbum({ watchId, ids }, sender) {
  const opening = sender.tab
    ? chrome.sidePanel.open({ windowId: sender.tab.windowId })
    : Promise.reject(new Error('the click came from no tab'));
  opening.catch((e) => alog('side panel not opened from the chat label - ' +
    `click the extension icon to see the album (${e.message})`));
  chrome.storage.session.set({ openAlbum: { watchId, ids, at: Date.now() } });
}
```

- [ ] **Step 4: Route the new events**

In the `__cpf: 'evt'` listener, replace the two dispatch lines with:

```js
  if (msg.type === 'ready') { catchUp('WhatsApp ready'); pushLabels(); }
  else if (msg.type === 'newImage') onNewImage(msg.data);
  else if (msg.type === 'openAlbum') openAlbum(msg.data, sender);
  else if (msg.type === 'labelsBroken') {
    alog("chat labels: message rows not found - WhatsApp's layout may have changed");
  }
```

- [ ] **Step 5: Check and smoke-test**

Run: `npm test && npm run check`
Expected: PASS / `ok`.

Reload the extension, refresh WhatsApp Web. Panel log shows the usual `[auto] catch-up (WhatsApp ready)` line and no errors. In the service worker console: `chrome.storage.local.get('found').then(console.log)` → `{ found: {} }` or existing matches after the next match; `chrome.storage.local.get('autoState').then(console.log)` → every cursor has `from` after the first write.

- [ ] **Step 6: Commit**

```bash
git add background.js
git commit -m "feat: background keeps found, pushes album label state, opens the panel from a label"
```

---

### Task 5: `page.js` — draw the labels

**Files:**
- Modify: `page.js`

**Interfaces:**
- Consumes: `globalThis.CpfAlbumLabel` (Task 3); `albumState` payload (Task 4); Task 1 findings.
- Produces: page action `albumState({ strings, chats })` → `true`; events `evt 'openAlbum' { chatId, watchId, ids }`, `evt 'labelsBroken' {}`.

- [ ] **Step 1: Add the `albumState` action**

Inside the `actions` object, after `pasteToChat`:

```js
    /** Label state for every watched group, from the background. Replaces
        what was there; kept in memory only. */
    async albumState({ strings, chats }) {
      labels.strings = strings || {};
      labels.chats = new Map((chats || []).map((c) => [c.chatId, c]));
      scheduleLabels();
      return true;
    },
```

- [ ] **Step 2: Add `photosInRow` — use the variant Task 1 found**

At the end of the IIFE, before the final `console.log`, add the section header and the store lookup:

```js
  /* ---------- album labels in the open chat ---------- */

  const labels = { strings: {}, chats: new Map() };

  // WhatsApp's in-memory message store. Synchronous, unlike
  // WPP.chat.getMessageById, which may fetch.
  const msgById = (id) => {
    try { return WPP.whatsapp.MsgStore.get(id) || null; } catch { return null; }
  };
```

Then **variant (a)** (each album photo has its own nested `[data-id]`):

```js
  /* The ONLY code that knows WhatsApp's message markup. When labels stop
     appearing after a WhatsApp update, fix this (see AGENTS.md).
     A row is the outermost element with data-id = the serialised message
     id; an album row nests one [data-id] per photo. Returns [{ id, t }] for
     the image messages the row shows. */
  function photosInRow(row) {
    const ids = [row.dataset.id, ...[...row.querySelectorAll('[data-id]')].map((x) => x.dataset.id)];
    const out = [];
    for (const id of new Set(ids)) {
      const m = msgById(id);
      if (m?.type === 'image') out.push({ id, t: m.t });
    }
    return out;
  }
```

or **variant (b)** (an album bubble carries one id; its photos are the consecutive same-author images — adjust the loop direction to Task 1's finding):

```js
  /* The ONLY code that knows WhatsApp's message markup. When labels stop
     appearing after a WhatsApp update, fix this (see AGENTS.md).
     A row is the outermost element with data-id = the serialised message
     id. An album bubble carries only its first photo's id; WhatsApp groups
     consecutive images from one sender, so take that run from the store.
     Returns [{ id, t }] for the image messages the row shows. */
  function photosInRow(row) {
    const m = msgById(row.dataset.id);
    if (m?.type !== 'image') return [];
    let msgs = [];
    try { msgs = WPP.whatsapp.ChatStore.get(m.id.remote).msgs.getModelsArray(); } catch { /* fall through */ }
    const out = [];
    for (let i = msgs.indexOf(m); i >= 0 && i < msgs.length; i++) {
      const x = msgs[i];
      if (x.type !== 'image' || String(x.author) !== String(m.author)) break;
      out.push({ id: x.id.toString(), t: x.t });
    }
    return out.length ? out : [{ id: row.dataset.id, t: m.t }];
  }
```

Keep exactly one of the two.

- [ ] **Step 3: Add drawing, the observer and the breakage signal** (right after `photosInRow`)

```js
  const activeChatId = () => {
    try { return WPP.chat.getActiveChat()?.id?.toString() || null; } catch { return null; }
  };

  // Closed shadow roots: WhatsApp's scripts can't read the child's name
  // through normal DOM access, and WhatsApp's CSS can't restyle the label.
  const shadows = new WeakMap(); // host -> { root, key }
  const LABEL_CSS = `
    .chips { display: inline-flex; flex-wrap: wrap; gap: 6px; font: 600 11.5px system-ui, sans-serif; }
    .chip { border: 0; border-radius: 10px; padding: 2px 9px; font: inherit;
            background: #1a7f4b; color: #fff; cursor: pointer; }
    .chip.dim { background: rgba(127, 127, 127, .18); color: #667781; cursor: default; }`;

  function drawLabel(row, chatId, parts) {
    let host = row.querySelector(':scope > [data-cpf-label]');
    if (!parts.length) { host?.remove(); return; }
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-cpf-label', '');
      shadows.set(host, { root: host.attachShadow({ mode: 'closed' }), key: '' });
      row.append(host);
    }
    const s = shadows.get(host);
    const key = JSON.stringify([parts, labels.strings]);
    if (s.key === key) return; // unchanged: don't touch the DOM
    s.key = key;
    const out = !!row.querySelector('.message-out');
    host.style.cssText = `display:flex;justify-content:${out ? 'flex-end' : 'flex-start'};padding:2px 12px 4px`;
    const style = document.createElement('style');
    style.textContent = LABEL_CSS;
    const chips = document.createElement('span');
    chips.className = 'chips';
    for (const p of parts) {
      const clickable = p.state === 'done' && p.count > 0;
      const chip = document.createElement(clickable ? 'button' : 'span');
      chip.className = clickable ? 'chip' : 'chip dim';
      chip.textContent = CpfAlbumLabel.partText(p, labels.strings); // text, never HTML
      if (clickable) {
        if (p.reviewed) chip.title = labels.strings.reviewed || '';
        chip.addEventListener('click', (e) => {
          // Keep WhatsApp from treating it as a click on the album.
          e.preventDefault(); e.stopPropagation();
          emit('openAlbum', { chatId, watchId: p.watchId, ids: p.ids });
        });
      }
      chips.append(chip);
    }
    s.root.replaceChildren(style, chips);
  }

  const removeLabels = () => document.querySelectorAll('[data-cpf-label]').forEach((h) => h.remove());

  // Labels disappearing silently after a WhatsApp update would look like
  // "no matches"; say so once in the panel log instead.
  let brokenSince = null, brokenSent = false;
  function watchBreakage(resolved) {
    if (resolved === null || resolved > 0) { brokenSince = null; return; }
    brokenSince ??= Date.now();
    if (!brokenSent && Date.now() - brokenSince > 30_000) { brokenSent = true; emit('labelsBroken', {}); }
  }

  function drawLabels() {
    const chatId = activeChatId();
    const chat = chatId && labels.chats.get(chatId);
    if (!chat) { removeLabels(); watchBreakage(null); return; }
    const main = document.querySelector('#main');
    if (!main) { watchBreakage(0); return; }
    let resolved = 0;
    for (const row of main.querySelectorAll('[data-id]')) {
      if (row.parentElement?.closest('[data-id]')) continue; // part of another row
      if (msgById(row.dataset.id)) resolved++;
      drawLabel(row, chatId, CpfAlbumLabel.labelFor(photosInRow(row), chat));
    }
    watchBreakage(resolved);
  }

  // One pass per animation frame however many mutations arrive.
  let labelFrame = 0;
  function scheduleLabels() {
    labelFrame ||= requestAnimationFrame(() => { labelFrame = 0; drawLabels(); });
  }

  // The message list is virtualised: rows scrolling back in are new elements
  // and get labelled again. Our own host insertions/removals are ignored, or
  // drawing would re-trigger itself.
  const ours = (n) => n.nodeType === 1 && n.hasAttribute('data-cpf-label');
  ready.then(() => {
    new MutationObserver((muts) => {
      if (muts.every((m) => [...m.addedNodes, ...m.removedNodes].every(ours))) return;
      scheduleLabels();
    }).observe(document.body, { childList: true, subtree: true });
    // A chat switch or a quiet chat may not mutate in a way we see; recheck.
    setInterval(scheduleLabels, 5000);
  });
```

- [ ] **Step 4: Check, then try it**

Run: `npm test && npm run check`
Expected: PASS / `ok`.

Reload the extension, refresh WhatsApp Web, open a watched group (Auto-watch on) and scroll to recent albums:
- Albums checked since the watch's `from` show chips (`kid 0` dimmed, or `kid N` green).
- Unwatched groups show none.
- WhatsApp console has no errors from `page.js`.

- [ ] **Step 5: Commit**

```bash
git add page.js
git commit -m "feat: draw album labels in the open WhatsApp chat"
```

---

### Task 6: Panel — album-scoped review

**Files:**
- Modify: `panel.js`

**Interfaces:**
- Consumes: `chrome.storage.session.openAlbum` (Task 4), `chrome.storage.local.found` (Task 4).
- Produces: `review(w, ids = null)`; `current.album`, `current.reviewed`.

- [ ] **Step 1: Give `review` an album scope**

Replace `review`:

```js
// Waiting matches hold ids and scores only (photos are never stored), so
// each one is downloaded again here and thumbnailed in memory. With `ids`
// (a click on an in-chat album label) it shows that album's matches from
// `found` instead, reviewed or not.
async function review(w, ids = null) {
  const { pending = {}, autoState = {}, found = {} } =
    await chrome.storage.local.get(['pending', 'autoState', 'found']);
  const source = ids ? (found[w.id] || []).filter((p) => ids.includes(p.id)) : (pending[w.id] || []);
  const list = [...source].sort((a, b) => b.score - a.score);
  // Read now, so matches that arrive during the review aren't covered by it.
  const upTo = autoState[w.id]?.lastChecked || 0;
  const waiting = new Set((pending[w.id] || []).map((p) => p.id));
  log(`\n${w.name}: loading ${list.length} ${ids ? 'album' : 'waiting'} match(es)...`);
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
  current = {
    watch: w, rows, auto: true, upTo, skipped: 0,
    album: !!ids, reviewed: !!ids && !list.some((p) => waiting.has(p.id)),
  };
  renderReview();
}
```

In `renderReview`, replace the title line and add the Mark-as-seen state after the `sendBtn` line:

```js
  $('reviewTitle').textContent = `${rows.length} photo(s) of ${watch.name}` +
    (current.album ? ' in this album' : '');
```

```js
  $('doneBtn').disabled = !!current.reviewed;
  $('doneBtn').title = current.reviewed ? 'already reviewed' : '';
```

In `markSeen`, replace the two `lastSeen` lines (`w.lastSeen = …` and `await setWatches(watches);`) with:

```js
  // One album is not the whole watch: an album review clears its own photos
  // from waiting but leaves lastSeen where it was.
  if (!current.album) {
    w.lastSeen = current.auto ? Math.max(w.lastSeen || 0, current.upTo) : current.newest;
    await setWatches(watches);
  }
```

- [ ] **Step 2: Open album requests**

Add after the `doneBtn` listener:

```js
/* ---------- album label clicks ---------- */

// The background writes the request (one writer per key); the panel only
// reads it and remembers the last one handled, so the start-up check and
// onChanged can't open the same album twice.
let albumHandled = 0;
async function openAlbum(req) {
  if (!req || req.at <= albumHandled) return;
  albumHandled = req.at;
  showTab('tabRun');
  const w = (await getWatches()).find((x) => x.id === req.watchId);
  if (!w) { log('that watch was removed'); return; }
  await review(w, req.ids);
}
```

In the `chrome.storage.onChanged` listener, add:

```js
  if (area === 'session' && changes.openAlbum) {
    openAlbum(changes.openAlbum.newValue).catch((e) => log('ERROR: ' + e.message));
  }
```

In the start-up IIFE, replace the last two lines with:

```js
  const { autoLog = [], openAlbum: req } = await chrome.storage.session.get(['autoLog', 'openAlbum']);
  showAutoLog(autoLog.slice(-20));
  // A label clicked just before the panel opened (or when Chrome refused to
  // open it): honour it if recent, ignore a stale one.
  if (req && Date.now() - req.at < 120_000) await openAlbum(req).catch((e) => log('ERROR: ' + e.message));
```

`showTab` is defined later in the file as a function declaration, so it is hoisted; no move needed.

- [ ] **Step 3: Check, then try it**

Run: `npm test && npm run check`
Expected: PASS / `ok`.

Reload the extension, refresh WhatsApp Web. Click a green chip on an album: the panel opens on Photos with "N photo(s) of kid in this album". Mark as seen: the card closes, the chip gains ✓ within about a second, the badge drops by N, and the watch's "last seen" in the card is unchanged.

- [ ] **Step 4: Commit**

```bash
git add panel.js
git commit -m "feat: album-scoped review opened from an in-chat label"
```

---

### Task 7: Docs, version, and end-to-end verification

**Files:**
- Modify: `AGENTS.md`, `README.md`, `manifest.json`

- [ ] **Step 1: Bump the version**

`manifest.json`: `"version": "0.11"` (or one minor step above the current value).

- [ ] **Step 2: AGENTS.md**

- In the architecture block, under `page.js`, add a line: `also draws the in-chat album labels (only its own data-cpf-label hosts)`.
- In the message-tags paragraph: `evt` is page → background events (`ready`, `newImage`, `openAlbum`, `labelsBroken`).
- In *Auto-watch state*: `found` → background (every match, ids and scores, pruned after 30 days; kept after Mark as seen); `autoState[id].from` (the watch's start point; photos before it get no label); `openAlbum` in session storage → background, read by the panel.
- Under *Hard rules*, rule 5: add "An album review (from an in-chat label) never changes `lastSeen`."
- In *The non-obvious technical constraints*, add:
  - **Never locate WhatsApp elements by visible text or accessibility labels.** They change with WhatsApp's language.
  - **All knowledge of WhatsApp's message markup is in `photosInRow` (page.js).** Labels missing after a WhatsApp update → fix there; the panel log says `chat labels: message rows not found`. Record Task 1's findings here (row variant, `.message-out`, active chat call, side-panel result).
  - **`lib/album-label.js` is a classic script** because `page.js` can't import modules; it duplicates `notYetChecked` from `lib/auto-state.js` — change both.
- In *Verifying a change*: `npm test` also runs `tests/album-label.test.js`.

- [ ] **Step 3: README.md**

In the feature list (near "Pastes the ones you keep…"), add one line:

```markdown
6. In a watched group, labels each album with how many photos of your child it contains; click one to review just that album.
```

(Renumber if the list's numbering differs.)

- [ ] **Step 4: End-to-end by hand**

Reload the extension, refresh WhatsApp Web, Auto-watch on for a test group. With the owner's phone:

1. Post an album with the child: chip shows `kid · in progress`, then `kid N`; the usual notification appears.
2. Click the chip: panel opens on that album's review (once — not twice). Mark as seen: chip gains ✓, badge drops by N, watch's "last seen" unchanged.
3. Post another album with the child, click its chip, Add to composer: photos are in the composer, **nothing is sent**, chip gains ✓.
4. Post a photo without the child: dimmed `kid 0`, not clickable.
5. Scroll the album out of view and back: chip redrawn.
6. Open an unwatched group: no chips. Turn Auto-watch off in Setup: chips disappear within about a second.
7. Two watches on one group: one chip per child; each opens its own review.
8. Reopen an already-reviewed album: review opens, Mark as seen disabled with tooltip "already reviewed".
9. With a watched group open and idle for a minute, Chrome's Task Manager (Shift+Esc) shows the WhatsApp tab near 0% CPU (no observer loop).
10. Close the side panel, click a chip: panel opens (or, if Task 1 found it refused, the log says to click the icon and opening the panel within 2 minutes shows the album).

- [ ] **Step 5: Final checks and commit**

Run: `npm test && npm run check`
Expected: PASS / `ok - manifest 0.11, …`.

```bash
git add AGENTS.md README.md manifest.json
git commit -m "docs: album labels in AGENTS.md and README; version 0.11"
```
