import { isAuto } from './lib/auto-state.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const lines = [];
const log = (s) => {
  lines.push(s); if (lines.length > 300) lines.shift();
  logEl.textContent = lines.join('\n'); logEl.scrollTop = logEl.scrollHeight;
};
window.addEventListener('error', (e) => log('ERROR: ' + e.message));
window.addEventListener('unhandledrejection', (e) => log('ERROR: ' + (e.reason?.message || e.reason)));

/* ---------- talking to the page ---------- */

async function callPage(action, args) {
  const [tab] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tab) throw new Error('Open WhatsApp Web in a tab first');
  const res = await chrome.tabs.sendMessage(tab.id, { __cpf: 'call', action, args });
  if (!res) throw new Error('no response from page - reload WhatsApp Web');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

/* ---------- the background and the engine ---------- */

async function bg(op, args) {
  const res = await chrome.runtime.sendMessage({ __cpf: 'bg', op, args });
  if (!res?.ok) throw new Error('background: ' + (res?.error || 'no answer'));
  return res.result;
}

// Recognition runs in the offscreen engine (engine.js). The background owns
// its lifecycle, so make sure it exists before each call.
async function engine(op, args) {
  await bg('ensureEngine');
  const res = await chrome.runtime.sendMessage({ __cpf: 'engine', op, args });
  if (!res) throw new Error('engine did not answer');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

async function logEngine() {
  const s = await engine('status');
  if (!s.models) { log('engine: models not set up'); return; }
  log(`engine: detector ${s.det}, recogniser ${s.rec} (${s.recMs}ms/face,` +
      ` navigator.gpu ${s.gpu ? 'present' : 'absent'})`);
  for (const n of s.notes) log('  ' + n);
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

// Recognition runs in the engine (engine.js); this only asks whether it has models.
const ensureModels = async () => (await engine('status')).models;

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
    await engine('reload');
    await showModelState();
    log('stored');
  });
}

/* ---------- image helpers ---------- */

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

// A watch that was never marked as seen only looks this far back. WhatsApp's
// CDN links for older media expire (403, surfaced as "Media not found"), so a
// full-history first scan spends most of its time on photos it cannot fetch.
// Duplicated in background.js - change both.
const FIRST_SCAN_DAYS = 10;
const sinceOf = (w) => w.lastSeen || Math.floor(Date.now() / 1000) - FIRST_SCAN_DAYS * 86400;

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
    (self ? opt(self) : '') +
    `<optgroup label="Groups">${g.map(opt).join('')}</optgroup>` +
    `<optgroup label="Direct chats">${people.map(opt).join('')}</optgroup>`;

  applyFilters();

  // restore whatever was chosen last time; matches go to yourself by default
  const saved = await chrome.storage.local.get(['last_src', 'last_dst']);
  for (const [which, selId, key] of [['src', 'srcGroup', 'last_src'], ['dst', 'dstGroup', 'last_dst']]) {
    const id = saved[key] || (which === 'dst' ? self?.id : null);
    const opt = id && $(selId).querySelector(`option[value="${CSS.escape(id)}"]`);
    if (opt) { $(selId).value = id; picked[which] = allChats.find((c) => c.id === id) || null; }
    setOpen(which, !picked[which]);
  }
  log(`${g.length} groups, ${people.length} direct chats`);
}

/* Filtering hides rows but must never change what you picked. The selection
   is deliberately kept in a variable rather than read off the <select>, so a
   hidden-but-chosen row still counts. */
const picked = { src: null, dst: null };

const open = { src: true, dst: true };

function showPick(which) {
  const el = $(which + 'Pick');
  const chat = picked[which];
  el.innerHTML = chat
    ? `<span>${esc(chat.name)}</span>` + (open[which] ? '' : '<span class="chg">change</span>')
    : 'nothing selected';
  el.classList.toggle('set', !!chat);
  el.classList.toggle('folded', !open[which]);
  updateSaveState();
}

// Save is offered only when the form is complete, and not while a save is
// running (embedding takes seconds; a second click would save a duplicate).
// A successful save clears the name and photos, which disables it again.
let saving = false;
function updateSaveState() {
  const missing = [
    !picked.src && 'group to watch',
    !picked.dst && 'where to send matches',
    !$('childName').value.trim() && "child's name",
    !$('refFiles').files.length && 'reference photos',
  ].filter(Boolean);
  $('addWatch').disabled = saving || missing.length > 0;
  $('addWatch').title = missing.length ? 'Still needed: ' + missing.join(', ') : '';
}
$('childName').addEventListener('input', updateSaveState);
$('refFiles').addEventListener('change', updateSaveState);
updateSaveState();

// Once a chat is picked the list folds away so the choice is what you see.
// Only a picked side can fold; an empty one always shows its list.
function setOpen(which, isOpen) {
  open[which] = isOpen || !picked[which];
  $(which + 'Filter').hidden = !open[which];
  $(which + 'Group').hidden = !open[which];
  showPick(which);
  if (open[which]) $(which + 'Group').selectedOptions[0]?.scrollIntoView({ block: 'nearest' });
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
  const record = () => {
    const id = $(selId).value;
    if (!id) return;
    picked[which] = allChats.find((c) => c.id === id)
                 || groups.find((c) => c.id === id) || { id, name: id };
    showPick(which);
    chrome.storage.local.set({ ['last_' + which]: id });
  };
  $(selId).addEventListener('change', record);
  // Fold on a deliberate pick (click or Enter), not on 'change': arrowing
  // through the list fires 'change' on every row and would fold it mid-browse.
  // Each records first so folding never depends on 'change' having fired yet.
  $(selId).addEventListener('click', (e) => {
    if (e.target.tagName === 'OPTION') { record(); setOpen(which, false); }
  });
  $(selId).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && $(selId).value) { e.preventDefault(); record(); setOpen(which, false); }
  });
  $(which + 'Pick').addEventListener('click', () => setOpen(which, !open[which]));
}
$('refreshGroups').addEventListener('click', () => loadGroups().catch((e) => log(e.message)));

$('addWatch').addEventListener('click', async () => {
  saving = true;
  updateSaveState();
  try {
    if (!(await ensureModels())) { log('set up the models first'); return; }
    const files = [...$('refFiles').files];
    if (!files.length) { log('pick at least one reference photo'); return; }
    const name = $('childName').value.trim() || 'child';

    log(`embedding ${files.length} reference photo(s)...`);
    const dataUrls = [];
    for (const f of files) dataUrls.push(await fileToDataUrl(f));
    const refs = [];
    (await engine('embed', { dataUrls })).forEach((r, i) => {
      if (!r.ok) { log(`  no face in ${files[i].name}, skipped`); return; }
      refs.push(r.embedding);
      log(`  ${files[i].name}: ok (${r.px}px)`);
    });
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
      refs, lastSeen: 0, auto: $('autoWatch').checked,
    });
    await setWatches(watches);
    if ($('autoWatch').checked) await bg('catchUp');
    log(`saved: ${name} \u2014 watching "${picked.src.name}" \u2192 sending to "${picked.dst.name}"`);
    $('refFiles').value = ''; $('childName').value = '';
    await renderSetup(); await renderWatches();
  } catch (e) { log('ERROR: ' + e.message); }
  finally {
    // A failed save keeps the inputs, so the button comes back for a retry.
    saving = false;
    updateSaveState();
  }
});

const fileToDataUrl = (f) => new Promise((res) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f);
});

async function renderSetup() {
  const watches = await getWatches();
  const { pending = {} } = await chrome.storage.local.get('pending');
  $('setupList').innerHTML = watches.length
    ? watches.map((w) => `<div class="row" style="justify-content:space-between;padding:6px 0;
        border-bottom:1px solid var(--line)">
        <span><b>${esc(w.name)}</b> <span class="muted">&larr; ${esc(w.srcName)}</span></span>
        <span class="row" style="gap:6px">
          <label class="check inline" title="Check new photos in the background and alert me">
            <input type="checkbox" data-auto="${w.id}" ${isAuto(w) ? 'checked' : ''}>Auto</label>
          <button class="act ghost" data-reset="${w.id}" style="padding:3px 9px;font-size:11px"
            title="Forget last seen and waiting matches; the next check covers the last ${FIRST_SCAN_DAYS} days"
            ${w.lastSeen || pending[w.id]?.length ? '' : 'disabled'}>Reset</button>
          <button class="act ghost" data-del="${w.id}" style="padding:3px 9px;font-size:11px">Remove</button>
        </span>
      </div>`).join('')
    : '<p class="hint">Nothing yet.</p>';

  const on = (sel, ev, fn) => $('setupList').querySelectorAll(sel).forEach((el) =>
    el.addEventListener(ev, () => fn(el).catch((e) => log('ERROR: ' + e.message))));

  // The panel writes `auto` (watches is panel-owned); the background re-reads
  // watches before every photo, so turning it off takes effect at once.
  on('[data-auto]', 'change', async (cb) => {
    const all = await getWatches();
    const w = all.find((x) => x.id === cb.dataset.auto);
    w.auto = cb.checked;
    await setWatches(all);
    log(`${w.name}: auto-watch ${w.auto ? 'on' : 'off'}`);
    if (w.auto) await bg('catchUp');
    await renderWatches();
  });

  // Remove from watches first, so the background's catch-up can't recreate
  // its state, then have the background forget it.
  on('[data-del]', 'click', async (b) => {
    await setWatches((await getWatches()).filter((w) => w.id !== b.dataset.del));
    await bg('reset', { watchId: b.dataset.del });
    await renderSetup(); await renderWatches();
  });

  // Undo "Mark as seen" without re-embedding references: lastSeen goes back to
  // never, and the background drops the cursor and waiting matches, so the
  // next check covers the first-scan window again.
  on('[data-reset]', 'click', async (b) => {
    const all = await getWatches();
    const w = all.find((x) => x.id === b.dataset.reset);
    w.lastSeen = 0;
    await setWatches(all);
    await bg('reset', { watchId: w.id });
    log(`${w.name}: reset - next check covers the last ${FIRST_SCAN_DAYS} days`);
    await renderSetup(); await renderWatches();
  });
}

/* ---------- the run pane ---------- */

async function renderWatches() {
  const watches = await getWatches();
  const { pending = {}, autoState = {} } = await chrome.storage.local.get(['pending', 'autoState']);
  const box = $('watchList');
  if (!watches.length) {
    box.innerHTML = '<div class="card"><p class="hint">No watches yet. Open Setup to add one.</p></div>';
    return;
  }
  const when = (t) => new Date(t * 1000).toLocaleString();
  box.innerHTML = watches.map((w) => isAuto(w) ? `
    <div class="card watch" data-w="${w.id}">
      <div class="row" style="justify-content:space-between">
        <span class="title">${esc(w.name)}</span>
        <span class="pill ${pending[w.id]?.length ? '' : 'none'}">${pending[w.id]?.length
          ? `${pending[w.id].length} waiting` : 'watching'}</span>
      </div>
      <p class="hint" style="margin:6px 0">${esc(w.srcName)} &rarr; ${esc(w.dstName)}
        &middot; threshold ${w.threshold} &middot; auto-watch on
        &middot; checked up to ${autoState[w.id] ? when(autoState[w.id].lastChecked) : 'not yet'}</p>
      <button class="act" data-review="${w.id}" ${pending[w.id]?.length ? '' : 'disabled'}>${pending[w.id]?.length
        ? `Review ${pending[w.id].length} photo(s) of ${esc(w.name)}` : 'No matches waiting'}</button>
    </div>` : `
    <div class="card watch" data-w="${w.id}">
      <div class="row" style="justify-content:space-between">
        <span class="title">${esc(w.name)}</span>
        <span class="pill none" data-count="${w.id}">checking...</span>
      </div>
      <p class="hint" style="margin:6px 0">${esc(w.srcName)} &rarr; ${esc(w.dstName)}
        &middot; threshold ${w.threshold}
        &middot; last seen ${w.lastSeen ? when(w.lastSeen)
          : `never (first check covers the last ${FIRST_SCAN_DAYS} days)`}</p>
      <button class="act" data-scan="${w.id}" disabled>Check for new photos</button>
    </div>`).join('');

  box.querySelectorAll('[data-review]').forEach((b) => b.addEventListener('click', () =>
    review(watches.find((w) => w.id === b.dataset.review)).catch((e) => log('ERROR: ' + e.message))));

  for (const w of watches.filter((x) => !isAuto(x))) {
    try {
      const { fresh } = await callPage('listNewImages', { chatId: w.src, since: sinceOf(w) });
      const pill = box.querySelector(`[data-count="${w.id}"]`);
      const btn = box.querySelector(`[data-scan="${w.id}"]`);
      if (!pill || !btn) continue; // re-rendered meanwhile
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
let stopRequested = false;

$('stopBtn').addEventListener('click', () => {
  stopRequested = true;
  $('stopBtn').disabled = true;
  log('stopping after the current photo...');
});

async function scan(w) {
  if (!(await ensureModels())) { log('set up the models first'); return; }
  const { fresh, newest, otherChats } = await callPage('listNewImages', { chatId: w.src, since: sinceOf(w) });
  // Newest first: recent photos are the ones wanted, and the ones whose
  // media links are still valid. A stopped scan has covered the latest.
  fresh.sort((a, b) => b.t - a.t);
  log(`\n${w.name}: ${fresh.length} new photos` +
      (w.lastSeen ? '' : ` (first check: last ${FIRST_SCAN_DAYS} days)`));
  if (otherChats) log(`  ignored ${otherChats} image(s) WhatsApp returned from other chats`);
  const rows = [];
  const t0 = performance.now();
  let unavailable = 0, done = 0;

  stopRequested = false;
  $('stopBtn').disabled = false;
  $('stopBtn').hidden = false;
  for (let i = 0; i < fresh.length; i++) {
    if (stopRequested) break;
    const m = fresh[i];
    done = i + 1;
    try {
      const { dataUrl } = await callPage('downloadImage', { id: m.id });
      const { detected, results: [{ best, px }] } = await engine('analyse',
        { dataUrl, watches: [{ id: w.id, refs: w.refs, threshold: w.threshold }] });
      if (best >= w.threshold) rows.push({ id: m.id, score: best, px, thumb: await thumbnail(dataUrl) });
      const el = (performance.now() - t0) / 1000;
      log(`  [${i + 1}/${fresh.length}] ${detected} faces, best ${best.toFixed(3)}` +
          `  ${(el / (i + 1)).toFixed(1)}s/photo  eta ${Math.round(el / (i + 1) * (fresh.length - i - 1))}s`);
    } catch (e) {
      // Expired CDN links are expected for older media; count them rather
      // than filling the log. Anything else is a real error and is shown.
      if (/media not found/i.test(e.message)) unavailable++;
      else log(`  [${i + 1}] failed: ${e.message}`);
    }
  }
  $('stopBtn').hidden = true;

  const skipped = fresh.length - done;
  if (skipped) log(`stopped after ${done} of ${fresh.length} photos`);
  if (unavailable) log(`${unavailable} photo(s) no longer available on WhatsApp (too old)`);
  rows.sort((a, b) => b.score - a.score);
  current = { watch: w, rows, newest, skipped };
  log(`${rows.length} match(es) above ${w.threshold}`);
  renderReview();
}

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

function renderReview() {
  const { watch, rows, skipped } = current;
  $('reviewCard').hidden = false;
  $('reviewTitle').textContent = `${rows.length} photo(s) of ${watch.name}` +
    (current.album ? ' in this album' : '');
  $('reviewHint').textContent = (rows.length
    ? `Untick anything wrong, then add them to ${watch.dstName}. You press Enter to send.`
    : 'Nothing matched. "Mark as seen" to skip these next time.')
    // lastSeen is a single timestamp, so marking a stopped scan as seen also
    // skips the older photos it never reached. Say so before they click.
    + (skipped ? ` Scan was stopped: "Mark as seen" also skips the ${skipped} older photo(s) not checked.` : '');
  $('grid').innerHTML = rows.map((r, i) => r.thumb ? `
    <label class="thumb"><img src="${r.thumb}">
      <span class="s"><input type="checkbox" data-i="${i}" checked>${r.score.toFixed(3)}
      <span class="muted">${r.px}px</span></span></label>` : `
    <div class="thumb gone"><div class="ph">${esc(r.gone)}</div>
      <span class="s">${r.score.toFixed(3)} <span class="muted">${r.px}px</span></span></div>`).join('');
  $('sendBtn').disabled = !rows.some((r) => r.thumb);
  $('doneBtn').disabled = !!current.reviewed;
  $('doneBtn').title = current.reviewed ? 'already reviewed' : '';
}

$('sendBtn').addEventListener('click', async () => {
  try {
    const picked = [...$('grid').querySelectorAll('input:checked')]
      .map((cb) => current.rows[+cb.dataset.i].id);
    if (!picked.length) { log('nothing selected'); return; }
    log(`opening ${current.watch.dstName} and pasting ${picked.length} photo(s)...`);
    const res = await callPage('pasteToChat', { chatId: current.watch.dst, ids: picked });
    log(`${res.pasted} in the composer - switch to WhatsApp and press Enter`);
    // Handled once pasted: the whole review (unticked rows included) is seen.
    // A failed paste throws above and leaves the review open for a retry.
    await markSeen();
  } catch (e) { log('ERROR: ' + e.message); }
});

async function markSeen() {
  const watches = await getWatches();
  const w = watches.find((x) => x.id === current.watch.id);
  if (!w) throw new Error('that watch was removed');
  // One album is not the whole watch: an album review clears its own photos
  // from waiting but leaves lastSeen where it was.
  if (!current.album) {
    w.lastSeen = current.auto ? Math.max(w.lastSeen || 0, current.upTo) : current.newest;
    await setWatches(watches);
  }
  // Only the rows shown here: matches that arrived during the review stay waiting.
  if (current.auto) await bg('markSeen', { watchId: w.id, ids: current.rows.map((r) => r.id) });
  $('reviewCard').hidden = true;
  current = null;
  log('marked as seen');
  await renderWatches(); await renderSetup();
}

$('doneBtn').addEventListener('click', () => markSeen().catch((e) => log('ERROR: ' + e.message)));

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

/* ---------- background activity ---------- */

// The background keeps its own short log in session storage; show it here so
// the panel stays the one place to look.
let autoSeq = 0;
function showAutoLog(entries = []) {
  for (const { n, s } of entries) if (n > autoSeq) { autoSeq = n; log('[auto] ' + s); }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.autoLog) showAutoLog(changes.autoLog.newValue);
  if (area === 'session' && changes.openAlbum) {
    openAlbum(changes.openAlbum.newValue).catch((e) => log('ERROR: ' + e.message));
  }
  if (area === 'local' && changes.pending) {
    renderWatches().catch((e) => log(e.message));
    renderSetup().catch((e) => log(e.message));
  }
});

/* ---------- tabs ---------- */

function showTab(which) {
  for (const [tab, pane] of [['tabRun', 'paneRun'], ['tabSetup', 'paneSetup']]) {
    const on = tab === which;
    $(tab).classList.toggle('on', on);
    $(tab).setAttribute('aria-selected', on);
    $(pane).classList.toggle('on', on);
  }
}
$('tabRun').addEventListener('click', () => showTab('tabRun'));
$('tabSetup').addEventListener('click', async () => {
  showTab('tabSetup');
  if (!groups.length) await loadGroups().catch((e) => log(e.message));
  else if (!$('srcGroup').options.length) await loadGroups().catch((e) => log(e.message));
});

(async () => {
  await showModelState();
  await renderSetup();
  try { const p = await callPage('ping'); log(`connected to WhatsApp (wa-js ${p.version})`); }
  catch (e) { log(e.message); }
  await logEngine().catch((e) => log('engine: ' + e.message));
  await renderWatches();
  const { autoLog = [], openAlbum: req } = await chrome.storage.session.get(['autoLog', 'openAlbum']);
  showAutoLog(autoLog.slice(-20));
  // A label clicked just before the panel opened (or when Chrome refused to
  // open it): honour it if recent, ignore a stale one.
  if (req && Date.now() - req.at < 120_000) await openAlbum(req).catch((e) => log('ERROR: ' + e.message));
})();
