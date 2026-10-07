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
      // A skipped photo (expired media) was never looked at: "0" would be a
      // claim the scan can't make. Matches that were found still show.
      if (!ids.length && mine.some((p) => (w.gone || []).includes(p.id))) continue;
      parts.push({
        watchId: w.id, name: w.name, state: 'done', count: ids.length,
        reviewed: ids.length > 0 && ids.every((id) => w.found[id]), ids,
      });
    }
    return parts;
  }

  /* Which photos a WhatsApp message row shows. page.js maps the open chat's
     messages, in order, to plain records { short, key, type, t, fromMe,
     parent } (short = msg.id.id, key = serialised id, parent = the
     serialised parentMsgKey or null); everything else is here, tested.
     A row's data-id comes in three shapes (as of 2026-10):
     - an image message's short id: that photo;
     - an 'album' message's short id: the images whose parent is its key;
     - 'album-<first>-<last>-<n>': WhatsApp grouping photos sent one by one
       (no album message), named by its first and last photo's short ids. */
  function indexMessages(records) {
    const byShort = new Map(), children = new Map(), pos = new Map();
    records.forEach((r, i) => {
      byShort.set(r.short, r);
      pos.set(r.short, i);
      if (r.type !== 'image' || !r.parent) return;
      if (!children.has(r.parent)) children.set(r.parent, []);
      children.get(r.parent).push(r);
    });
    return { records, byShort, children, pos };
  }

  const GROUPED = /^album-([^-]+)-([^-]+)-\d+$/;

  /** { msg, photos }: msg is the row's message record (null if unknown);
      photos are [{ id, t }] with serialised ids. Videos are not scanned, so
      they are never counted. */
  function rowPhotos(dataId, index) {
    const photo = (r) => ({ id: r.key, t: r.t });
    const grouped = GROUPED.exec(dataId);
    if (grouped) {
      const [, first, last] = grouped;
      const msg = index.byShort.get(first) || null;
      const a = index.pos.get(first), b = index.pos.get(last);
      // Both ends must be loaded, or the count would be a guess.
      if (a === undefined || b === undefined) return { msg, photos: [] };
      const run = index.records.slice(Math.min(a, b), Math.max(a, b) + 1);
      return { msg, photos: run.filter((r) => r.type === 'image').map(photo) };
    }
    const msg = index.byShort.get(dataId) || null;
    if (!msg) return { msg: null, photos: [] };
    if (msg.type === 'image') return { msg, photos: [photo(msg)] };
    if (msg.type === 'album') return { msg, photos: (index.children.get(msg.key) || []).map(photo) };
    return { msg, photos: [] };
  }

  function partText(part, strings) {
    if (part.state === 'progress') return `${part.name} · ${strings.inProgress}`;
    return `${part.name} ${part.count}${part.reviewed ? ' ✓' : ''}`;
  }

  globalThis.CpfAlbumLabel = { labelFor, partText, indexMessages, rowPhotos };
})();
