# Album labels in the WhatsApp chat

Date: 2026-10-05 · Status: approved · Target version: next minor

## Goal

While reading a watched group in WhatsApp Web, every photo album shows a small
label saying how many photos of your child it contains, or that it is still
being checked. Clicking the label opens the side panel on a review of just that
album.

**Success looks like:** an album posted to a watched group shows *in progress*,
then *Nir 3* when the background finishes. Clicking it opens the panel with
those three photos, ready for Add to composer. After review the label reads
*Nir 3 ✓*. An album without the child reads a dimmed *Nir 0*.

## Decisions (agreed with the owner)

1. **Every album gets a label, whoever sent it.** Hard rule 4 (no sender
   filtering) is unchanged.
2. **Clicking opens the normal review, limited to that album.** Same grid, Add
   to composer and Mark as seen; those clear only that album's photos from
   waiting. The label keeps its count afterwards, marked reviewed (✓).
3. **Labels only for watches with Auto-watch on.** A group whose watches are all
   manual shows no labels.
4. **An album checked with no match shows a dimmed, unclickable "0"**, so
   "checked, not there" can be told from "not scanned" or "labels broken".
5. **A single photo is an album of one** and is labelled the same way.
6. **Several children watched in one group share one label**, e.g.
   *Nir 3 · Maya 1*; clicking a child's part opens that child's review.
7. **Approach A:** the background pushes per-group state to the page; `page.js`
   draws the labels. `relay.js` stays a pipe.

## Constraints

- All AGENTS.md hard rules hold. Labels only read from WhatsApp and add the
  extension's own elements; nothing is done through WhatsApp (rule 1). `found`
  holds ids and scores, never images (rule 3).
- `page.js` stays the only file that touches WhatsApp internals, and all
  knowledge of WhatsApp's markup is confined to one function in it.
- WhatsApp elements are never located by visible text or accessibility labels;
  those change with WhatsApp's language.
- One writer per storage key. No build step, no new dependencies, no new
  permissions.

## Out of scope

- Labels for manual (Auto-watch off) watches (Decision 3).
- Albums older than a watch's start point (`from`): never scanned, so no label.
- Labels in the chat list, media viewer, or anywhere but the open conversation.
- Retroactive results for albums checked before this ships (see *Existing
  watches*).

## Architecture

```
background.js ── callPage('albumState', payload) ──► relay.js ──► page.js
   · writes found, autoState.from                                · caches payload per group
   · pushes on ready / result change                             · observes message rows
   · on openAlbum: sidePanel.open,                               · draws labels (closed shadow root)
     then session.openAlbum                                      · click → evt 'openAlbum'
        ▲                                                                │
        └──────────────── evt 'openAlbum' / 'labelsBroken' ◄─────────────┘
panel.js
   · on session.openAlbum: album-scoped review
lib/album-label.js (NEW, classic script, MAIN world, before page.js)
   · pure label rules, unit-tested via node:vm
```

## Data and state

| Key | Area | Writer | Contents |
|---|---|---|---|
| `found` (new) | local | background | `{ [watchId]: [{ id, t, score, px }] }`: every match recorded, ids and scores only |
| `autoState[watchId].from` (new field) | local | background | unix seconds; the watch's start point, set once |
| `openAlbum` (new) | session | background | `{ watchId, ids, at }`: the last label click |
| `pending`, `autoState` cursor | local | background | unchanged |

**`found`.**
- `recordResult` appends each match to both `pending` and `found`,
  de-duplicated by id.
- `markSeen` changes `pending` only, so an album keeps its count after review.
- `forget` (Reset, Remove) clears the watch's `found` along with its `pending`
  and `autoState`.
- On every write, entries with `t` older than 30 days (`FOUND_DAYS`, in
  `lib/auto-state.js`) are dropped; WhatsApp's media links have expired by then.

**Reviewed** means: a match in `found` whose id is not in `pending`.

**`from`.**
- `initState` sets `from` to the same value as the initial `lastChecked`: the
  watch's `lastSeen`, or `FIRST_SCAN_DAYS` back.
- After a Reset, `from` is set again by the next `initState`.

**Existing watches.** A cursor without `from` gets `from = lastChecked` the
first time the background loads it. Albums those watches checked before this
ships have no `found` entries, so they get no label rather than a wrong "0".

## Label rules (`lib/album-label.js`)

Input: the photo ids in one row, each with its `t` from WhatsApp's message
store, plus the group's payload. For each watch in the payload:

1. Drop photos with no `t` (not in WhatsApp's store).
2. If every remaining photo has `t < from`, this watch contributes nothing to the
   row.
3. If any photo with `t >= from` is not yet checked, the state is
   **in progress**. Not checked means `t > lastChecked`, or `t === lastChecked`
   and the id is not in `atChecked`. This is the same rule as `notYetChecked` in
   `lib/auto-state.js`, duplicated with a comment naming the other copy because
   one file is a classic script and the other a module.
4. Otherwise **count** = the row's ids that are in this watch's found set.
   **reviewed** = count > 0 and every one of them is flagged reviewed.

Output: `[{ watchId, name, state: 'progress' | 'done', count, reviewed, ids }]`,
in payload order; empty means no label for the row. `ids` are the matched ids,
which a click sends.

The file is a plain script that assigns `globalThis.CpfAlbumLabel`, because
`page.js` is a classic MAIN-world script and cannot import modules. It is listed
before `page.js` in the same `content_scripts` entry.

## Background → page: `albumState`

New page action `albumState(payload)`:

```js
{
  chatId,
  strings: { inProgress: 'in progress', reviewed: 'reviewed' },
  watches: [{ id, name, from, lastChecked, atChecked, found: { [msgId]: reviewed } }],
}
```

- Only Auto-watch watches whose `src` is `chatId`. An empty `watches` list
  removes that group's labels.
- `strings` carries all label text, so `page.js` needs no language knowledge.
  When the Hebrew spec lands, the background builds these with `t()`.
- The background sends it:
  - for every watched group on `ready`;
  - for the affected group after any `mutate` that changes its `autoState`,
    `pending` or `found`, at most once per second per group during a batch,
    with a trailing send so the last state always arrives;
  - after `catchUp('panel')` and `reset`, which follow Auto-watch toggles and
    removals.
- A failed send (no tab, tab not answering) is ignored. The next `ready`
  re-sends everything.
- Face data (`refs`) is never included.

## The label (`page.js`)

**State.** `albumState` stores the payload in a `Map` keyed by `chatId`, in
memory only, and re-renders visible rows if that chat is open.

**Open chat.** Tracked with wa-js's active-chat event (exact event confirmed in
check 3). Labels are drawn only while the open chat has a payload with at least
one watch.

**Rows.**
- A `MutationObserver` on WhatsApp's conversation container collects added
  rows. Work is batched into one pass per animation frame.
- WhatsApp's message list is virtualised: rows that scroll back in are new
  elements and are labelled again.

**`photoIdsInRow(row)`** is the only code that knows WhatsApp's message markup.
It returns the image message ids a row displays. Its body is written from the
findings of check 1, e.g. the row's `data-id`, expanded through WhatsApp's
message store to an album's child photos. Each id's `t` is read from the
message store, not from the screen.

**Drawing.**
- One host element per row, marked `data-cpf-label` and reused when already
  present, placed directly under the bubble on the bubble's side.
- Content goes in a **closed shadow root**: WhatsApp's scripts cannot read the
  child's name through normal DOM access, and WhatsApp's CSS cannot restyle it.
- The pill has one part per watch:
  - count > 0: `Nir 3`, or `Nir 3 ✓` when reviewed. Clickable, with a pointer
    cursor and the extension's green.
  - count = 0: `Nir 0`, dimmed, not clickable.
  - in progress: `Nir · in progress`, dimmed, not clickable.
- The host is removed when the row's result becomes empty.

**Click.** Posts `evt 'openAlbum' { chatId, watchId, ids }`. The relay forwards
it unchanged.

**Breakage signal.** If the open chat has a payload and contains image messages
in WhatsApp's store, but `photoIdsInRow` has matched no row for 30 seconds,
`page.js` posts `evt 'labelsBroken'` once per page load. The background logs
`chat labels: message rows not found - WhatsApp's layout may have changed`.

## Click to review

**Background**, on `evt 'openAlbum'`:
1. **First statement, before any `await`:**
   `chrome.sidePanel.open({ tabId: sender.tab.id })`, because Chrome requires
   the user gesture.
2. `chrome.storage.session.set({ openAlbum: { watchId, ids, at: Date.now() } })`.
3. If the open was refused, log `side panel not opened from the chat label -
   click the extension icon to see the album`.

**Panel.**
- On start, if `openAlbum.at` is under 2 minutes old, and on every change of
  `openAlbum`, it switches to Photos and runs the album review.
- It remembers the last `at` it handled in memory. It never writes the key.
- An album review replaces any open review, without marking the replaced one.
- If the watch no longer exists, it logs `that watch was removed` and opens
  nothing.

**Album review.** This is `review(w, { ids })`, an album scope on the existing
function:
- **Rows:** `found[w.id]` entries whose id is in `ids`, best score first. Each
  is downloaded again and thumbnailed in memory; an expired one shows *no
  longer available*.
- **Title:** `N photo(s) of Nir in this album`.
- **Add to composer:** paste, then mark seen (as in 0.9).
- **Mark as seen:** `bg('markSeen', { watchId, ids })`. **`lastSeen` is not
  changed.** One album is not the whole watch; this is the one difference from
  the whole-watch review and gets a comment saying so.
- **Already reviewed** (none of the ids in `pending`): the review still opens
  and Add to composer still works, for sending again. Mark as seen is disabled,
  with the tooltip `already reviewed`.

The whole-watch Review button is unchanged and still lists every waiting
match, album photos included.

## Error handling

| Situation | Behaviour |
|---|---|
| WhatsApp markup changed; no rows match | No labels; `labelsBroken` logged once; everything else unaffected |
| `sidePanel.open` refused | Request kept 2 minutes; log tells the user to click the icon |
| Photo not in WhatsApp's store | Left out of that row's label |
| Watch removed after a label was drawn | Background has pushed an empty state; a stale click logs `that watch was removed` |
| Extension reloaded | `page.js` keeps running but its relay is cut: labels freeze and clicks do nothing until WhatsApp is refreshed (existing constraint) |
| Background asleep when a label is clicked | The message wakes it; the page still holds the last payload |
| Album photo expired by review time | Shown as *no longer available*; the rest of the review works |

## Checks before any feature code

A throwaway console script on a real watched group. Nothing from it is kept
except the findings, which go into `photoIdsInRow` and AGENTS.md.

1. **Row markup.** What does a message row carry (`data-id`?), and how does an
   album bubble map to its child image messages?
2. **Opening the panel from the chat.** Does `chrome.sidePanel.open` succeed
   when the click travels page → relay → background? If not, the design is
   unchanged but the fallback becomes the normal path ("click the label, then
   the icon"); report to the owner before building on that.
3. **Active chat.** Which wa-js event reports the open chat, and does it fire on
   page load with a chat already open?

## Verification

Test-first for the pure rules, as AGENTS.md requires.

`tests/auto-state.test.js` (extended):
- `recordResult` appends to `found`, de-duplicated.
- `markSeen` leaves `found` unchanged.
- `forget` clears `found`.
- Pruning drops entries older than `FOUND_DAYS`.
- `initState` sets `from`; a cursor without `from` gets `from = lastChecked`.

`tests/album-label.test.js` (new, loads `lib/album-label.js` with `node:vm`):
- every photo before `from` → nothing;
- partly checked → in progress;
- checked with 0 matches, 3 matches, and 3 reviewed;
- a shared timestamp with partial `atChecked`;
- two watches on one row;
- photos with no `t`.

`npm test` and `npm run check` pass.

By hand, on a real watched group:
1. Post an album with the child: *in progress*, then *Nir N*, plus the existing
   notification.
2. Click the label: the panel opens on that album's review. Mark as seen: the
   label gains ✓ and the badge drops by N.
3. Add to composer from an album review: photos pasted, nothing sent, label ✓.
4. Post a photo without the child: dimmed *Nir 0*.
5. Scroll the album out of view and back: label redrawn.
6. Open an unwatched group: no labels. Turn Auto-watch off: labels disappear.
7. Two watches on one group: one shared label, each part opens its own review.
8. Reopen an already-reviewed album: opens, Mark as seen disabled.

## Manifest

- Add `lib/album-label.js` to the MAIN-world `content_scripts` entry, before
  `page.js`. `scripts/check.mjs` adds it to its syntax list.
- No new permissions (`sidePanel` is already present).
- Version: next minor step.

## Documentation

AGENTS.md:
- Architecture: `page.js` now also writes to WhatsApp's page, only its own
  `data-cpf-label` hosts. `evt` types gain `openAlbum` and `labelsBroken`.
- Storage section: `found`, `openAlbum`, `autoState.from` and their writers.
- New rule: never locate WhatsApp elements by visible text or accessibility
  labels.
- Constraints: the findings of checks 1–3, and that `photoIdsInRow` is the one
  place to fix after a WhatsApp update.

README: one line describing the in-chat labels.

## Relation to the Hebrew spec

Independent. Label text comes from the background in `strings` either way;
whichever ships second routes it through `t()`.

## Findings (Task 1 of the plan, 2026-10-06)

- **Row markup:** each message row is a `[data-id]` element whose value is the
  message's *short* id (`msg.id.id`, e.g. `AC82CED4EEF42A6CCD68EBBE213A2325`),
  not the serialised key, so `MsgStore.get(dataId)` finds nothing. Rows are
  resolved through the open chat's messages
  (`WPP.whatsapp.ChatStore.get(chatId).msgs.getModelsArray()`, keyed by
  `m.id.id`). Rows are not nested.
- **Albums:** an album row's message has `type: 'album'`. Its photos are
  separate `image` messages (videos too, which are ignored) with
  `associationType: 'MEDIA_ALBUM'` and `parentMsgKey` equal to the album's
  serialised key. Their `t` can be a few seconds after the album's. A single
  photo's row is the `image` message itself.
- **Outgoing rows:** WhatsApp no longer has `.message-out`/`.message-in`; the
  label's side comes from the message's `id.fromMe`.
- **Active chat:** `WPP.chat.getActiveChat()?.id?.toString()` works.
- **Side panel from a label click:** opens (page → relay → background →
  `chrome.sidePanel.open({ windowId })`).
