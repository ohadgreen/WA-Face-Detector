import {
  isAuto, initState, catchUpSince, targetsFor, PhotoQueue,
  recordResult, skipResult, markSeen, forget, pendingTotal, Batcher, notifyText, onFailure,
  ensureFrom, pruneFound, albumStates,
} from './lib/auto-state.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/* Alt+Shift+R rebuilds the extension without visiting chrome://extensions.
   Content scripts are NOT re-injected into open tabs, so refresh WhatsApp Web too. */
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'reload-extension') chrome.runtime.reload();
});

// Duplicated in panel.js - change both. A watch never marked as seen starts
// this far back, because WhatsApp's links for older media have expired.
const FIRST_SCAN_DAYS = 10;

/* ---------- log: shown live in the panel with an [auto] prefix ---------- */

let logWrite = Promise.resolve();
function alog(s) {
  console.log('[auto]', s);
  logWrite = logWrite.then(async () => {
    const { autoLog = [] } = await chrome.storage.session.get('autoLog');
    autoLog.push({ n: (autoLog.at(-1)?.n ?? 0) + 1, s });
    await chrome.storage.session.set({ autoLog: autoLog.slice(-200) });
  }).catch(() => {});
}

/* ---------- engine (offscreen document) ---------- */

// Created on demand, then left open. Chrome allows one offscreen document per
// extension; `creating` stops two callers racing to create it.
let creating = null;
async function ensureEngine() {
  const have = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (have.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: 'engine.html',
    reasons: ['WORKERS'],
    justification: 'On-device face recognition for watched groups',
  }).finally(() => { creating = null; });
  await creating;
}

// A missing or crashed engine page is recreated and the call retried once.
// Errors the engine itself reports (e.g. no models) are not retried.
async function engine(op, args) {
  for (let attempt = 0; ; attempt++) {
    await ensureEngine();
    const res = await chrome.runtime.sendMessage({ __cpf: 'engine', op, args })
      .catch((e) => ({ ok: false, error: e.message, lost: true }));
    if (res?.ok) return res.result;
    if ((!res || res.lost) && attempt === 0) continue;
    throw new Error(res?.error || 'engine did not answer');
  }
}

/* ---------- the WhatsApp tab ---------- */

async function callPage(action, args) {
  const [tab] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tab) throw new Error('no WhatsApp Web tab open');
  const res = await chrome.tabs.sendMessage(tab.id, { __cpf: 'call', action, args })
    .catch(() => null);
  if (!res) throw new Error('WhatsApp tab not answering - refresh it');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

/* ---------- state: autoState and pending are written only here ---------- */

const load = async () => {
  const { watches = [], autoState = {}, pending = {}, found = {}, gone = {} } =
    await chrome.storage.local.get(['watches', 'autoState', 'pending', 'found', 'gone']);
  return { watches, autoState: ensureFrom(autoState), pending, found, gone };
};

// Every write goes through this chain, so the loop and panel requests
// (markSeen, reset) can't interleave a read-modify-write. `fn` may return
// only the parts it changes; the rest are carried over.
let writing = Promise.resolve();
function mutate(fn) {
  const run = writing.then(async () => {
    const { autoState, pending, found, gone } = await load();
    const out = { autoState, pending, found, gone, ...fn({ autoState, pending, found, gone }) };
    const now = Math.floor(Date.now() / 1000);
    out.found = pruneFound(out.found, now);
    out.gone = pruneFound(out.gone, now); // same { id, t } lists, same window
    await chrome.storage.local.set({
      autoState: out.autoState, pending: out.pending, found: out.found, gone: out.gone,
    });
    await updateBadge(out.pending);
    pushLabels();
    return out;
  });
  writing = run.catch(() => {});
  return run;
}

let modelsMissing = false;
async function updateBadge(pending) {
  pending ??= (await load()).pending;
  const n = pendingTotal(pending);
  await chrome.action.setBadgeBackgroundColor({ color: modelsMissing ? '#b3261e' : '#1a7f4b' });
  await chrome.action.setBadgeText({ text: modelsMissing ? '!' : n ? String(n) : '' });
  await chrome.action.setTitle({
    title: modelsMissing ? 'Class Photo Filter - set up the models in the panel'
      : n ? `Class Photo Filter - ${n} match(es) waiting` : 'Class Photo Filter',
  });
}

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
    const { watches, ...state } = await load();
    await callPage('albumState', albumStates(watches, state, LABEL_STRINGS, Math.floor(Date.now() / 1000)))
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

/* ---------- the auto-watch loop ---------- */

const queue = new PhotoQueue();
let listing = 0;     // catch-ups in flight; processing waits for them
let running = false;

const batches = new Batcher(60_000);
function onMatch(watchId) { batches.add(watchId, Date.now()); }

// Basic notifications require an icon, and the extension ships none, so
// draw one once.
let iconUrl = null;
async function notifyIcon() {
  if (iconUrl) return iconUrl;
  const cv = new OffscreenCanvas(128, 128);
  const cx = cv.getContext('2d');
  cx.fillStyle = '#1a7f4b';
  cx.beginPath(); cx.roundRect(8, 8, 112, 112, 24); cx.fill();
  cx.fillStyle = '#fff';
  cx.font = 'bold 72px sans-serif';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText('C', 64, 68);
  const bytes = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return (iconUrl = 'data:image/png;base64,' + btoa(bin));
}

async function announce(drained) {
  const due = batches.due(Date.now(), drained);
  if (!due.length) return;
  const { watches } = await load();
  for (const { watchId, n } of due) {
    const w = watches.find((x) => x.id === watchId);
    if (!w) continue;
    await chrome.notifications.create(`cpf-${watchId}-${Date.now()}`, {
      type: 'basic', iconUrl: await notifyIcon(),
      title: 'Class Photo Filter', message: notifyText(w, n), priority: 1,
    });
    alog(`notified: ${notifyText(w, n)}`);
  }
}

async function catchUp(reason) {
  listing++;
  try {
    const now = Math.floor(Date.now() / 1000);
    const autos = (await load()).watches.filter(isAuto);
    if (!autos.length) return;
    const { autoState } = await mutate((s) => {
      const a = { ...s.autoState };
      for (const w of autos) a[w.id] ??= initState(w, now, FIRST_SCAN_DAYS);
      return { autoState: a, pending: s.pending };
    });
    let added = 0;
    for (const src of new Set(autos.map((w) => w.src))) {
      const since = catchUpSince(autos, autoState, src);
      if (since === null) continue;
      const { fresh } = await callPage('listNewImages', { chatId: src, since });
      added += queue.add(fresh.map((m) => ({ id: m.id, chatId: src, t: m.t })));
    }
    alog(`catch-up (${reason}): ${added} photo(s) to check`);
  } catch (e) {
    alog(`catch-up (${reason}) paused: ${e.message}`);
  } finally {
    listing--;
    pump();
  }
}

async function onNewImage(photo) {
  const { watches } = await load();
  if (!watches.some((w) => isAuto(w) && w.src === photo.chatId)) return;
  queue.add([photo]);
  pump();
}

// Oldest first, one at a time. A photo leaves the queue only once its
// result is recorded, so a pause or a stopped worker loses nothing: the
// next trigger resumes from each watch's cursor.
async function pump() {
  if (running || listing) return;
  running = true;
  let checked = 0, unavailable = 0, paused = false;
  try {
    while (queue.size && !listing) {
      const photo = queue.peek();
      const { watches, autoState } = await load();
      const targets = targetsFor(watches, autoState, photo);
      if (!targets.length) { queue.shift(); continue; }
      let stage = 'download';
      try {
        const { dataUrl } = await callPage('downloadImage', { id: photo.id });
        stage = 'analyse';
        const out = await engine('analyse', {
          dataUrl, watches: targets.map((w) => ({ id: w.id, refs: w.refs, threshold: w.threshold })),
        });
        modelsMissing = false;
        const { matched } = await mutate((s) => recordResult(s, photo, out.results, targets));
        checked++;
        alog(`${targets[0].srcName}: ${out.detected} faces - ` +
          out.results.map((r) => `${targets.find((w) => w.id === r.id).name} ${r.best.toFixed(3)}`).join(', '));
        for (const id of matched) {
          alog(`match: ${targets.find((w) => w.id === id).name} in ${targets[0].srcName}`);
          onMatch(id);
        }
        await announce(false);
      } catch (e) {
        if (onFailure(stage, e.message) === 'pause') {
          modelsMissing = /no models/i.test(e.message);
          await updateBadge();
          alog(`paused: ${e.message}`);
          paused = true;
          break;
        }
        // About this photo only; skip it so it can't hold up the queue.
        // Expired media is routine and only counted; anything else is named.
        if (/media not found/i.test(e.message)) unavailable++;
        else alog(`${targets[0].srcName}: skipped a photo - ${e.message}`);
        await mutate((s) => skipResult(s, photo, targets));
      }
      queue.shift();
    }
  } finally {
    running = false;
    if (checked || unavailable) {
      alog(`checked ${checked} photo(s)` + (unavailable ? `, ${unavailable} no longer available` : ''));
    }
  }
  // Drained, or paused and possibly not resuming soon: don't hold matches back.
  if (paused || !queue.size) await announce(true);
  // Photos may have arrived after the loop's last check.
  if (!paused && queue.size && !listing) pump();
}

/* ---------- requests from the panel ---------- */

const bgOps = {
  ensureEngine,
  // Not awaited: a first catch-up can take minutes.
  async catchUp() { catchUp('panel'); return true; },
  async markSeen({ watchId, ids }) {
    await mutate((s) => ({ autoState: s.autoState, pending: markSeen(s.pending, watchId, ids) }));
    return true;
  },
  async reset({ watchId }) {
    await mutate((s) => forget(s, watchId));
    catchUp('reset');
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.__cpf !== 'bg') return;
  const op = bgOps[msg.op];
  Promise.resolve()
    .then(() => {
      if (!op) throw new Error('unknown background op: ' + msg.op);
      return op(msg.args || {});
    })
    .then((result) => sendResponse({ ok: true, result: result ?? null }),
          (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});

/* ---------- events from the WhatsApp tab ---------- */

// The WhatsApp tab, from its most recent event, so a notification click can
// open the side panel without awaiting a tab query first.
let waTab = null;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.__cpf !== 'evt') return;
  if (sender.tab) waTab = { id: sender.tab.id, windowId: sender.tab.windowId };
  if (msg.type === 'ready') { catchUp('WhatsApp ready'); pushLabels(); }
  else if (msg.type === 'newImage') onNewImage(msg.data);
  else if (msg.type === 'openAlbum') openAlbum(msg.data, sender);
  else if (msg.type === 'labelsBroken') {
    alog("chat labels: message rows not found - WhatsApp's layout may have changed");
  }
});

chrome.notifications.onClicked.addListener((id) => {
  // sidePanel.open only works inside the click's user gesture, so it is
  // called before anything is awaited. Chrome may still refuse; the badge
  // is the fallback.
  const opening = waTab
    ? chrome.sidePanel.open({ windowId: waTab.windowId })
    : Promise.reject(new Error('WhatsApp tab not known since the background restarted'));
  opening.catch((e) => alog(`side panel not opened from the notification: ${e.message}`));
  chrome.notifications.clear(id);
  focusWhatsApp();
});

async function focusWhatsApp() {
  const [tab] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tab) return;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

// Every start of this worker - install, browser start, or waking from idle -
// catches up, because the in-memory queue did not survive the last stop.
// catchUp increments `listing` before its first await, so a live event
// arriving right after start waits for it.
catchUp('background start');
updateBadge();
