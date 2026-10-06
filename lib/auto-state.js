/* Background auto-watch rules, kept free of chrome.* so they can be unit
   tested in Node (tests/auto-state.test.js). background.js does the I/O.

   Each watch has a cursor: lastChecked (unix seconds of the newest photo
   analysed) plus atChecked (ids already analysed at exactly that second).
   Photos in one album share a timestamp, so the time alone can't say which
   siblings are done. */

export const isAuto = (w) => w.auto !== false;

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
  if (photo.t > c.lastChecked) return { ...c, lastChecked: photo.t, atChecked: [photo.id] };
  if (photo.t === c.lastChecked && !c.atChecked.includes(photo.id)) {
    return { ...c, atChecked: [...c.atChecked, photo.id] };
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

/** A photo that can't be fetched (expired media): move past it. */
export const skipResult = (state, photo, targets) => recordResult(state, photo, [], targets);

// Errors meaning WhatsApp can't be reached right now. These come from the
// extension's own messaging (background callPage, relay timeout), not from
// WhatsApp's answer about a message.
const UNREACHABLE = /no WhatsApp Web tab|WhatsApp tab not answering|page timeout|Receiving end does not exist|Extension context invalidated/i;

/** What the loop does when a photo fails at `stage` ('download' | 'analyse').
    'pause' keeps the photo queued and retries on the next trigger; 'skip'
    moves past it. A pause holds up every photo behind it, so it is only for
    failures that would hit every photo alike: WhatsApp unreachable, or the
    engine broken. Anything WhatsApp says about one message (expired media,
    "not contains media", ...) and an image the engine can't decode are skips. */
export function onFailure(stage, message) {
  if (stage === 'download') return UNREACHABLE.test(message) ? 'pause' : 'skip';
  return /^could not decode image/i.test(message) ? 'skip' : 'pause';
}

/** Remove the reviewed ids only; matches that arrived during review stay. */
export function markSeen(pending, watchId, ids) {
  const p = { ...pending };
  const keep = (p[watchId] || []).filter((x) => !ids.includes(x.id));
  if (keep.length) p[watchId] = keep; else delete p[watchId];
  return p;
}

export function forget({ autoState, pending, found = {} }, watchId) {
  const a = { ...autoState }, p = { ...pending }, f = { ...found };
  delete a[watchId]; delete p[watchId]; delete f[watchId];
  return { autoState: a, pending: p, found: f };
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
