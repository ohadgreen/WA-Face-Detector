/* MAIN world. The only place that touches WhatsApp's internals.
   Everything here is read-only except pasteToChat, which puts images into the
   composer and stops. You still press Enter. */

(() => {
  const ready = new Promise((res) => {
    if (typeof WPP === 'undefined') return;
    if (WPP.isFullReady) return res();
    WPP.on('conn.main_ready', () => res());
    const poll = setInterval(() => {
      if (WPP.isFullReady) { clearInterval(poll); res(); }
    }, 500);
  });

  const albumOf = (m) => {
    const id = m.id.toString();
    const tail = id.split('_').pop();
    return tail.includes('@') ? tail : id;
  };

  const blobToDataUrl = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(blob);
  });

  const actions = {
    async ping() {
      await ready;
      return { version: WPP.version, ready: WPP.isFullReady };
    },

    /** Groups for sources; groups + your own chats for destinations. */
    async listGroups() {
      await ready;
      const nameOf = (c) => c.name || c.formattedTitle || c.contact?.name
                         || c.contact?.pushname || c.id.user || '(unnamed)';
      const groups = (await WPP.chat.list({ onlyGroups: true }))
        .map((c) => ({ id: c.id.toString(), name: nameOf(c), kind: 'group' }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const people = (await WPP.chat.list({ onlyUsers: true, count: 200 }))
        .map((c) => ({ id: c.id.toString(), name: nameOf(c), kind: 'person' }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Message-yourself chat: the safest possible destination while developing.
      let self = null;
      try {
        const me = WPP.conn.getMyUserId();
        self = { id: me.toString(), name: 'Message yourself (test)', kind: 'self' };
      } catch (e) { /* older builds may not expose it */ }

      return { groups, people, self };
    },

    /** Image messages newer than `since` (unix seconds). No sender filtering. */
    async listNewImages({ chatId, since }) {
      await ready;
      const msgs = await WPP.chat.getMessages(chatId, { count: -1, media: 'image' });
      const fresh = msgs
        .filter((m) => m.t > (since || 0))
        .sort((a, b) => a.t - b.t)
        .map((m) => ({
          id: m.id.toString(),
          t: m.t,
          album: albumOf(m),
          w: m.width || 0,
          h: m.height || 0,
        }));
      return { total: msgs.length, fresh, newest: msgs.reduce((a, m) => Math.max(a, m.t), 0) };
    },

    /** One image, as a data URL so it survives extension messaging. */
    async downloadImage({ id }) {
      await ready;
      const blob = await WPP.chat.downloadMedia(id);
      return { dataUrl: await blobToDataUrl(blob), type: blob.type, size: blob.size };
    },

    /** Open the destination chat and drop the chosen images into its composer. */
    async pasteToChat({ chatId, ids }) {
      await ready;
      await WPP.chat.openChatBottom(chatId);
      await new Promise((r) => setTimeout(r, 900));

      const files = [];
      for (const id of ids) {
        const blob = await WPP.chat.downloadMedia(id);
        const name = `photo-${id.split('_')[0]}.jpg`;
        files.push(new File([blob], name, { type: blob.type || 'image/jpeg' }));
      }

      const box = document.querySelector('[contenteditable="true"][data-tab]')
               || document.querySelector('footer [contenteditable="true"]');
      if (!box) throw new Error('composer not found - is the chat open?');
      box.focus();

      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      box.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt,
      }));
      return { pasted: files.length };
    },
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.__cpf !== 'req') return;
    const { id, action, args } = e.data;
    try {
      if (!actions[action]) throw new Error('unknown action: ' + action);
      const result = await actions[action](args || {});
      window.postMessage({ __cpf: 'res', id, result }, '*');
    } catch (err) {
      window.postMessage({ __cpf: 'res', id, error: err?.message || String(err) }, '*');
    }
  });

  console.log('%c[class-photo-filter]', 'color:#1a7f4b;font-weight:700', 'page bridge ready');
})();
