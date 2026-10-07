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

test('a photo that could not be checked (expired): no confident 0', () => {
  const w = W('a', { gone: ['m2'] });
  assert.deepEqual(plain(labelFor([ph('m1', 150), ph('m2', 150)], chat(w))), []);
});

test('a photo that could not be checked, others matched: the matches still show', () => {
  const w = W('a', { gone: ['m2'], found: { m1: false } });
  assert.deepEqual(plain(labelFor([ph('m1', 150), ph('m2', 150)], chat(w))), [done('a', 1, false, ['m1'])]);
});

// Which photos a row shows. Records are the open chat's messages in order,
// as page.js maps them: { short, key, type, t, fromMe, parent }.
const { indexMessages, rowPhotos } = ctx.CpfAlbumLabel;
const rec = (short, type, t, over = {}) => ({
  short, key: `false_g1@g.us_${short}_p@lid`, type, t, fromMe: false, parent: null, ...over,
});
const keysOf = (r) => plain(r.photos).map((p) => p.id);

test('rowPhotos: a single photo row is that photo', () => {
  const idx = indexMessages([rec('T1', 'chat', 90), rec('P1', 'image', 100)]);
  const r = rowPhotos('P1', idx);
  assert.equal(r.msg.short, 'P1');
  assert.deepEqual(plain(r.photos), [{ id: 'false_g1@g.us_P1_p@lid', t: 100 }]);
});

test("rowPhotos: an 'album' message row is the images that point back to it", () => {
  const album = rec('AL', 'album', 100);
  const idx = indexMessages([
    album,
    rec('A1', 'image', 101, { parent: album.key }),
    rec('V1', 'video', 101, { parent: album.key }),
    rec('A2', 'image', 102, { parent: album.key }),
    rec('X1', 'image', 103),
  ]);
  assert.deepEqual(keysOf(rowPhotos('AL', idx)), [`false_g1@g.us_A1_p@lid`, `false_g1@g.us_A2_p@lid`]);
});

test("rowPhotos: WhatsApp's own grouping 'album-<first>-<last>-<n>' is the images from first to last", () => {
  const idx = indexMessages([
    rec('T1', 'chat', 90),
    rec('3EB0A', 'image', 100), rec('3EB0B', 'image', 100), rec('3EB0C', 'video', 101), rec('3EB0D', 'image', 101),
    rec('3EB0E', 'image', 102),
  ]);
  const r = rowPhotos('album-3EB0A-3EB0D-4', idx);
  assert.equal(r.msg.short, '3EB0A');
  assert.deepEqual(keysOf(r), ['3EB0A', '3EB0B', '3EB0D'].map((s) => `false_g1@g.us_${s}_p@lid`));
});

test("rowPhotos: WhatsApp's own grouping whose last photo isn't loaded shows nothing rather than a part", () => {
  const idx = indexMessages([rec('3EB0A', 'image', 100), rec('3EB0B', 'image', 100)]);
  const r = rowPhotos('album-3EB0A-3EB0Z-3', idx);
  assert.equal(r.msg.short, '3EB0A');
  assert.deepEqual(plain(r.photos), []);
});

test('rowPhotos: an unknown row or a text message has no photos', () => {
  const idx = indexMessages([rec('T1', 'chat', 90)]);
  assert.deepEqual(plain(rowPhotos('nope', idx)), { msg: null, photos: [] });
  assert.deepEqual(plain(rowPhotos('T1', idx).photos), []);
});
