import { analyse, cosine } from './lib/face.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const lines = [];
const log = (s) => {
  lines.push(s); if (lines.length > 300) lines.shift();
  logEl.textContent = lines.join('\n'); logEl.scrollTop = logEl.scrollHeight;
};
window.addEventListener('error', (e) => log('ERROR: ' + e.message));
window.addEventListener('unhandledrejection', (e) => log('ERROR: ' + (e.reason?.message || e.reason)));

ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
ort.env.logLevel = 'error';
// Extension pages aren't cross-origin isolated, so SharedArrayBuffer is unavailable
// and the threaded build would abort. Pin to one thread.
ort.env.wasm.numThreads = 1;

/* ---------- talking to the page ---------- */

async function callPage(action, args) {
  const [tab] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tab) throw new Error('Open WhatsApp Web in a tab first');
  const res = await chrome.tabs.sendMessage(tab.id, { __cpf: 'call', action, args });
  if (!res) throw new Error('no response from page - reload WhatsApp Web');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

/* ---------- model storage (IndexedDB, extension origin) ---------- */

const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('cpf-models', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('m');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idbGet = async (k) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction('m').objectStore('m').get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
};
const idbPut = async (k, v) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('m', 'readwrite');
    t.objectStore('m').put(v, k);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
};

let detSession = null, recSession = null;

async function makeSession(buf, label, eps) {
  for (const ep of eps) {
    try {
      const s = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: [ep] });
      log(`${label}: ${ep}`);
      return s;
    } catch (e) { log(`${label}: ${ep} failed - ${String(e.message || e)}`); }
  }
  throw new Error(label + ': no backend available');
}

async function ensureModels() {
  if (detSession && recSession) return true;
  const d = await idbGet('det'), r = await idbGet('rec');
  if (!d || !r) return false;
  log('loading models...');
  // SCRFD uses an AveragePool variant WebGPU doesn't implement, so detector stays on WASM.
  detSession = await makeSession(d, 'detector', ['wasm']);
  recSession = await makeSession(r, 'recogniser', ['webgpu', 'wasm']);
  log('models ready');
  return true;
}

async function showModelState() {
  const have = (await idbGet('det')) && (await idbGet('rec'));
  $('modelState').textContent = have ? '\u2713 models stored' : 'not set up yet';
}

for (const [inputId, key] of [['detFile', 'det'], ['recFile', 'rec']]) {
  $(inputId).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    log(`storing ${f.name} (${(f.size / 1e6).toFixed(0)}MB)...`);
    await idbPut(key, await f.arrayBuffer());
    detSession = recSession = null;
    await showModelState();
    log('stored');
  });
}

/* ---------- image helpers ---------- */

async function decode(dataUrl, maxSide = 2048) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  let { width: w, height: h } = bmp;
  const longest = Math.max(w, h);
  if (longest > maxSide) { const s = maxSide / longest; w = Math.round(w * s); h = Math.round(h * s); }
  const cv = new OffscreenCanvas(w, h);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const d = cx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2]; }
  return { data: rgb, width: w, height: h };
}

async function thumbnail(dataUrl, size = 220) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const s = size / Math.max(bmp.width, bmp.height);
  const cv = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close();
  const out = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(out); });
}

/* ---------- watches ---------- */

const getWatches = async () => (await chrome.storage.local.get('watches')).watches || [];
const setWatches = (w) => chrome.storage.local.set({ watches: w });

let groups = [], allChats = [];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadGroups() {
  log('reading chat list...');
  const { groups: g, people, self } = await callPage('listGroups');
  groups = g;
  allChats = [...(self ? [self] : []), ...g, ...people];

  $('srcGroup').innerHTML = g.map((x) =>
    `<option value="${x.id}">${esc(x.name)}</option>`).join('');

  const opt = (x) => `<option value="${x.id}">${esc(x.name)}</option>`;
  $('dstGroup').innerHTML =
    (self ? `<optgroup label="Testing">${opt(self)}</optgroup>` : '') +
    `<optgroup label="Groups">${g.map(opt).join('')}</optgroup>` +
    `<optgroup label="Direct chats">${people.map(opt).join('')}</optgroup>`;

  applyFilters();

  // restore whatever was chosen last time
  const saved = await chrome.storage.local.get(['last_src', 'last_dst']);
  for (const [which, selId, key] of [['src', 'srcGroup', 'last_src'], ['dst', 'dstGroup', 'last_dst']]) {
    const id = saved[key];
    const opt = id && $(selId).querySelector(`option[value="${CSS.escape(id)}"]`);
    if (opt) { $(selId).value = id; picked[which] = allChats.find((c) => c.id === id) || null; }
    showPick(which);
  }
  log(`${g.length} groups, ${people.length} direct chats`);
}

/* Filtering hides rows but must never change what you picked. The selection
   is deliberately kept in a variable rather than read off the <select>, so a
   hidden-but-chosen row still counts. */
const picked = { src: null, dst: null };

function showPick(which) {
  const el = $(which + 'Pick');
  const chat = picked[which];
  el.textContent = chat ? chat.name : 'nothing selected';
  el.classList.toggle('set', !!chat);
}

function applyFilter(boxId, selId) {
  const q = ($(boxId)?.value || '').toLowerCase();
  for (const o of $(selId).querySelectorAll('option')) {
    o.hidden = !!q && !o.textContent.toLowerCase().includes(q);
  }
}
function applyFilters() {
  applyFilter('srcFilter', 'srcGroup');
  applyFilter('dstFilter', 'dstGroup');
}

$('srcFilter').addEventListener('input', () => applyFilter('srcFilter', 'srcGroup'));
$('dstFilter').addEventListener('input', () => applyFilter('dstFilter', 'dstGroup'));

for (const [which, selId] of [['src', 'srcGroup'], ['dst', 'dstGroup']]) {
  $(selId).addEventListener('change', async () => {
    const id = $(selId).value;
    picked[which] = allChats.find((c) => c.id === id)
                 || groups.find((c) => c.id === id) || { id, name: id };
    showPick(which);
    await chrome.storage.local.set({ ['last_' + which]: id });
  });
}
$('refreshGroups').addEventListener('click', () => loadGroups().catch((e) => log(e.message)));

$('addWatch').addEventListener('click', async () => {
  try {
    if (!(await ensureModels())) { log('set up the models first'); return; }
    const files = [...$('refFiles').files];
    if (!files.length) { log('pick at least one reference photo'); return; }
    const name = $('childName').value.trim() || 'child';

    log(`embedding ${files.length} reference photo(s)...`);
    const refs = [];
    for (const f of files) {
      const img = await decode(await fileToDataUrl(f));
      const { faces } = await analyse(detSession, recSession, img,
        { Tensor: ort.Tensor, minFace: 0, detSize: 640 });
      if (!faces.length) { log(`  no face in ${f.name}, skipped`); continue; }
      faces.sort((a, b) => b.px - a.px);
      refs.push(Array.from(faces[0].embedding));
      log(`  ${f.name}: ok (${faces[0].px}px)`);
    }
    if (!refs.length) { log('no usable references'); return; }

    if (!picked.src || !picked.dst) {
      log('pick a source group and a destination first (click a row in each list)');
      return;
    }
    const watches = await getWatches();
    watches.push({
      id: 'w' + Date.now(), name,
      src: picked.src.id, srcName: picked.src.name,
      dst: picked.dst.id, dstName: picked.dst.name,
      threshold: parseFloat($('thresh').value) || 0.35,
      refs, lastSeen: 0,
    });
    await setWatches(watches);
    log(`saved: ${name} \u2014 watching "${picked.src.name}" \u2192 sending to "${picked.dst.name}"`);
    $('refFiles').value = ''; $('childName').value = '';
    await renderSetup(); await renderWatches();
  } catch (e) { log('ERROR: ' + e.message); }
});

const fileToDataUrl = (f) => new Promise((res) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f);
});

async function renderSetup() {
  const watches = await getWatches();
  $('setupList').innerHTML = watches.length
    ? watches.map((w) => `<div class="row" style="justify-content:space-between;padding:6px 0;
        border-bottom:1px solid var(--line)">
        <span><b>${w.name}</b> <span class="muted">&larr; ${w.srcName}</span></span>
        <button class="act ghost" data-del="${w.id}" style="padding:3px 9px;font-size:11px">Remove</button>
      </div>`).join('')
    : '<p class="hint">Nothing yet.</p>';
  $('setupList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    await setWatches((await getWatches()).filter((w) => w.id !== b.dataset.del));
    await renderSetup(); await renderWatches();
  }));
}

/* ---------- the run pane ---------- */

async function renderWatches() {
  const watches = await getWatches();
  const box = $('watchList');
  if (!watches.length) {
    box.innerHTML = '<div class="card"><p class="hint">No watches yet. Open Setup to add one.</p></div>';
    return;
  }
  box.innerHTML = watches.map((w) => `
    <div class="card watch" data-w="${w.id}">
      <div class="row" style="justify-content:space-between">
        <span class="title">${w.name}</span>
        <span class="pill none" data-count="${w.id}">checking...</span>
      </div>
      <p class="hint" style="margin:6px 0">${w.srcName} &rarr; ${w.dstName}
        &middot; threshold ${w.threshold}
        &middot; last seen ${w.lastSeen ? new Date(w.lastSeen * 1000).toLocaleString() : 'never'}</p>
      <button class="act" data-scan="${w.id}" disabled>Check for new photos</button>
    </div>`).join('');

  for (const w of watches) {
    try {
      const { fresh } = await callPage('listNewImages', { chatId: w.src, since: w.lastSeen });
      const pill = box.querySelector(`[data-count="${w.id}"]`);
      const btn = box.querySelector(`[data-scan="${w.id}"]`);
      if (fresh.length) {
        pill.textContent = `${fresh.length} new`;
        pill.className = 'pill';
        btn.disabled = false;
        btn.textContent = `Find ${w.name} in ${fresh.length} new photos`;
        btn.addEventListener('click', () => scan(w).catch((e) => log('ERROR: ' + e.message)));
      } else {
        pill.textContent = 'up to date';
        btn.textContent = 'Nothing new';
      }
    } catch (e) { log(`${w.name}: ${e.message}`); }
  }
}

let current = null;

async function scan(w) {
  if (!(await ensureModels())) { log('set up the models first'); return; }
  const { fresh, newest } = await callPage('listNewImages', { chatId: w.src, since: w.lastSeen });
  log(`\n${w.name}: ${fresh.length} new photos`);
  const refs = w.refs.map((r) => Float32Array.from(r));
  const rows = [];
  const t0 = performance.now();

  for (let i = 0; i < fresh.length; i++) {
    const m = fresh[i];
    try {
      const { dataUrl } = await callPage('downloadImage', { id: m.id });
      const img = await decode(dataUrl);
      const { faces, detected } = await analyse(detSession, recSession, img,
        { Tensor: ort.Tensor, minFace: 30, detSize: 640 });
      let best = 0, px = 0;
      for (const f of faces) for (const r of refs) {
        const c = cosine(r, f.embedding);
        if (c > best) { best = c; px = f.px; }
      }
      if (best >= w.threshold) rows.push({ id: m.id, score: best, px, thumb: await thumbnail(dataUrl) });
      const el = (performance.now() - t0) / 1000;
      log(`  [${i + 1}/${fresh.length}] ${detected} faces, best ${best.toFixed(3)}` +
          `  ${(el / (i + 1)).toFixed(1)}s/photo  eta ${Math.round(el / (i + 1) * (fresh.length - i - 1))}s`);
    } catch (e) { log(`  [${i + 1}] failed: ${e.message}`); }
  }

  rows.sort((a, b) => b.score - a.score);
  current = { watch: w, rows, newest };
  log(`${rows.length} match(es) above ${w.threshold}`);
  renderReview();
}

function renderReview() {
  const { watch, rows } = current;
  $('reviewCard').hidden = false;
  $('reviewTitle').textContent = `${rows.length} photo(s) of ${watch.name}`;
  $('reviewHint').textContent = rows.length
    ? `Untick anything wrong, then add them to ${watch.dstName}. You press Enter to send.`
    : 'Nothing matched. "Mark as seen" to skip these next time.';
  $('grid').innerHTML = rows.map((r, i) => `
    <label class="thumb"><img src="${r.thumb}">
      <span class="s"><input type="checkbox" data-i="${i}" checked>${r.score.toFixed(3)}
      <span class="muted">${r.px}px</span></span></label>`).join('');
  $('sendBtn').disabled = !rows.length;
}

$('sendBtn').addEventListener('click', async () => {
  try {
    const picked = [...$('grid').querySelectorAll('input:checked')]
      .map((cb) => current.rows[+cb.dataset.i].id);
    if (!picked.length) { log('nothing selected'); return; }
    log(`opening ${current.watch.dstName} and pasting ${picked.length} photo(s)...`);
    const res = await callPage('pasteToChat', { chatId: current.watch.dst, ids: picked });
    log(`${res.pasted} in the composer - switch to WhatsApp and press Enter`);
  } catch (e) { log('ERROR: ' + e.message); }
});

$('doneBtn').addEventListener('click', async () => {
  const watches = await getWatches();
  const w = watches.find((x) => x.id === current.watch.id);
  w.lastSeen = current.newest;
  await setWatches(watches);
  $('reviewCard').hidden = true;
  current = null;
  log('marked as seen');
  await renderWatches();
});

/* ---------- tabs ---------- */

$('tabRun').addEventListener('click', () => {
  $('tabRun').classList.add('on'); $('tabSetup').classList.remove('on');
  $('paneRun').classList.add('on'); $('paneSetup').classList.remove('on');
});
$('tabSetup').addEventListener('click', async () => {
  $('tabSetup').classList.add('on'); $('tabRun').classList.remove('on');
  $('paneSetup').classList.add('on'); $('paneRun').classList.remove('on');
  if (!groups.length) await loadGroups().catch((e) => log(e.message));
  else if (!$('srcGroup').options.length) await loadGroups().catch((e) => log(e.message));
});

(async () => {
  await showModelState();
  await renderSetup();
  try { const p = await callPage('ping'); log(`connected to WhatsApp (wa-js ${p.version})`); }
  catch (e) { log(e.message); }
  await renderWatches();
})();
