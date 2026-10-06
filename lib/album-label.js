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
