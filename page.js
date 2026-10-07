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
      const found = await WPP.chat.getMessages(chatId, { count: -1, media: 'image' });
      // On current builds getMessages goes through WhatsApp's media query and
      // only filters by type, so images from other chats can come back. Keep
      // this chat's own; `newest` must not be advanced by another chat either.
      const msgs = found.filter((m) => m.id?.remote?.toString() === chatId);
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
      return {
        total: msgs.length, fresh, otherChats: found.length - msgs.length,
        newest: msgs.reduce((a, m) => Math.max(a, m.t), 0),
      };
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

    /** Label state for every watched group, from the background. Replaces
        what was there; kept in memory only. */
    async albumState({ strings, chats }) {
      labels.strings = strings || {};
      labels.chats = new Map((chats || []).map((c) => [c.chatId, c]));
      scheduleLabels();
      return true;
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

  /* Events for the background's auto-watch. Metadata only: the image itself
     is fetched later with downloadImage, one at a time. Every chat's images
     are reported, because only the background knows which chats are watched. */
  const emit = (type, data) => window.postMessage({ __cpf: 'evt', type, data }, '*');
  ready.then(() => {
    emit('ready');
    WPP.on('chat.new_message', (m) => {
      if (m?.type !== 'image') return;
      emit('newImage', { id: String(m.id), chatId: String(m.id.remote), t: m.t });
    });
  });

  /* ---------- album labels in the open chat ---------- */

  const labels = { strings: {}, chats: new Map() };

  /* The open chat's messages, in order, as the plain records
     lib/album-label.js works on. Rows carry the message's SHORT id
     (msg.id.id), so they resolve through the chat's messages, not
     MsgStore.get; the row shapes themselves are decoded by
     CpfAlbumLabel.rowPhotos (see AGENTS.md). Built once per drawing pass. */
  function chatIndex(chatId) {
    let msgs = [];
    try { msgs = WPP.whatsapp.ChatStore.get(chatId).msgs.getModelsArray(); } catch { /* nothing loaded */ }
    return CpfAlbumLabel.indexMessages(msgs.map((m) => ({
      short: m.id.id, key: m.id.toString(), type: m.type, t: m.t,
      fromMe: !!m.id.fromMe, parent: m.parentMsgKey ? String(m.parentMsgKey) : null,
    })));
  }

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

  // WhatsApp has no in/out class on rows any more; the message knows.
  function drawLabel(row, chatId, parts, fromMe) {
    let host = row.querySelector(':scope > [data-cpf-label]');
    if (!parts.length) { host?.remove(); return; }
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-cpf-label', '');
      shadows.set(host, { root: host.attachShadow({ mode: 'closed' }), key: '' });
      row.append(host);
    }
    const s = shadows.get(host);
    const key = JSON.stringify([parts, labels.strings, fromMe]);
    if (s.key === key) return; // unchanged: don't touch the DOM
    s.key = key;
    host.style.cssText = `display:flex;justify-content:${fromMe ? 'flex-end' : 'flex-start'};padding:2px 12px 4px`;
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
    const index = chatIndex(chatId);
    let resolved = 0;
    for (const row of main.querySelectorAll('[data-id]')) {
      if (row.parentElement?.closest('[data-id]')) continue; // part of another row
      const { msg, photos } = CpfAlbumLabel.rowPhotos(row.dataset.id, index);
      if (msg) resolved++;
      drawLabel(row, chatId, CpfAlbumLabel.labelFor(photos, chat), !!msg?.fromMe);
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

  console.log('%c[class-photo-filter]', 'color:#1a7f4b;font-weight:700', 'page bridge ready');
})();
