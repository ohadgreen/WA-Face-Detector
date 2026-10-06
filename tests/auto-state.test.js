import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuto, initState, catchUpSince, targetsFor, PhotoQueue,
  recordResult, skipResult, markSeen, forget, pendingTotal, Batcher, notifyText, onFailure,
  ensureFrom, pruneFound, albumStates, FOUND_DAYS,
} from '../lib/auto-state.js';

const G = 'g1@g.us';
const W = (id, over = {}) => ({
  id, name: 'kid-' + id, src: G, srcName: 'Class', threshold: 0.35, refs: [], lastSeen: 0, ...over,
});
const P = (id, t, chatId = G) => ({ id, chatId, t });
const C = (lastChecked, atChecked = []) => ({ lastChecked, atChecked });
const hit = (id, best, px = 60) => ({ id, best, px });

test('isAuto: missing flag means on, false means off', () => {
  assert.equal(isAuto(W('a')), true);
  assert.equal(isAuto(W('a', { auto: true })), true);
  assert.equal(isAuto(W('a', { auto: false })), false);
});

test('initState: lastSeen wins, otherwise the first-scan window; from is the same start point', () => {
  assert.deepEqual(initState(W('a', { lastSeen: 500 }), 10_000_000, 10), { ...C(500), from: 500 });
  const start = 10_000_000 - 864_000;
  assert.deepEqual(initState(W('a'), 10_000_000, 10), { ...C(start), from: start });
});

test('catchUpSince: one second before the watch furthest behind on that group (two cursors)', () => {
  const ws = [W('a'), W('b'), W('c', { src: 'g2@g.us' })];
  const st = { a: C(300), b: C(200), c: C(50) };
  assert.equal(catchUpSince(ws, st, G), 199);
  assert.equal(catchUpSince(ws, st, 'g2@g.us'), 49);
});

test('catchUpSince: null when no initialised auto watch is on that group', () => {
  assert.equal(catchUpSince([W('a', { auto: false })], { a: C(100) }, G), null);
  assert.equal(catchUpSince([W('a')], {}, G), null);
});

test('targetsFor: a watch with no autoState yet is skipped (no autoState yet)', () => {
  const t = targetsFor([W('a'), W('b')], { a: C(100) }, P('m1', 150));
  assert.deepEqual(t.map((w) => w.id), ['a']);
});

test('targetsFor: other chats, manual watches and photos already behind the cursor are excluded', () => {
  const ws = [W('a'), W('b', { auto: false }), W('c', { src: 'g2@g.us' })];
  const st = { a: C(100), b: C(0), c: C(0) };
  assert.deepEqual(targetsFor(ws, st, P('m1', 150)).map((w) => w.id), ['a']);
  assert.deepEqual(targetsFor(ws, st, P('m0', 90)), []);
});

test('targetsFor: only the watches behind the photo (two cursors)', () => {
  const t = targetsFor([W('a'), W('b')], { a: C(100), b: C(300) }, P('m1', 200));
  assert.deepEqual(t.map((w) => w.id), ['a']);
});

test('album siblings sharing a timestamp are all analysed', () => {
  const ws = [W('a')];
  let s = { autoState: { a: C(90) }, pending: {} };
  const p1 = P('m1', 100), p2 = P('m2', 100);
  s = recordResult(s, p1, [hit('a', 0.5)], targetsFor(ws, s.autoState, p1));
  const t2 = targetsFor(ws, s.autoState, p2);
  assert.deepEqual(t2.map((w) => w.id), ['a']);
  s = recordResult(s, p2, [hit('a', 0.6)], t2);
  assert.deepEqual(s.pending.a.map((x) => x.id), ['m1', 'm2']);
  assert.deepEqual(s.autoState.a, C(100, ['m1', 'm2']));
});

test('restart mid-album: re-listing at lastChecked skips done siblings, keeps the rest', () => {
  const ws = [W('a')];
  let s = { autoState: { a: C(90) }, pending: {} };
  const p1 = P('m1', 100), p2 = P('m2', 100);
  s = recordResult(s, p1, [hit('a', 0.5)], targetsFor(ws, s.autoState, p1));
  // Background restarts: catch-up lists from lastChecked - 1, so both siblings come back.
  assert.equal(catchUpSince(ws, s.autoState, G), 99);
  assert.deepEqual(targetsFor(ws, s.autoState, p1), []);
  assert.deepEqual(targetsFor(ws, s.autoState, p2).map((w) => w.id), ['a']);
  // Even if m1 were analysed again, pending would not duplicate it.
  s = recordResult(s, p1, [hit('a', 0.5)], ws);
  assert.equal(s.pending.a.length, 1);
});

test('recordResult: a newer photo resets atChecked', () => {
  const s = recordResult({ autoState: { a: C(100, ['m1']) }, pending: {} }, P('m9', 120), [hit('a', 0.1)], [W('a')]);
  assert.deepEqual(s.autoState.a, C(120, ['m9']));
});

test('recordResult: below threshold advances the cursor without a match', () => {
  const s = recordResult({ autoState: { a: C(90) }, pending: {} }, P('m1', 100), [hit('a', 0.2)], [W('a')]);
  assert.deepEqual(s.matched, []);
  assert.deepEqual(s.pending, {});
  assert.equal(s.autoState.a.lastChecked, 100);
});

test('recordResult: the cursor never moves backwards', () => {
  const s = recordResult({ autoState: { a: C(200) }, pending: {} }, P('m1', 150), [hit('a', 0.9)], [W('a')]);
  assert.deepEqual(s.autoState.a, C(200));
});

test('recordResult: per-watch thresholds, reports which watches matched', () => {
  const ws = [W('a', { threshold: 0.35 }), W('b', { threshold: 0.5 })];
  const s = recordResult({ autoState: { a: C(0), b: C(0) }, pending: {} }, P('m1', 100),
    [hit('a', 0.4, 70), hit('b', 0.4, 70)], ws);
  assert.deepEqual(s.matched, ['a']);
  assert.deepEqual(s.pending, { a: [{ id: 'm1', t: 100, score: 0.4, px: 70 }] });
  assert.equal(s.autoState.b.lastChecked, 100);
});

test('recordResult does not mutate its input', () => {
  const input = { autoState: { a: C(90) }, pending: {} };
  recordResult(input, P('m1', 100), [hit('a', 0.9)], [W('a')]);
  assert.deepEqual(input, { autoState: { a: C(90) }, pending: {} });
});

test('skipResult advances the cursor only', () => {
  const s = skipResult({ autoState: { a: C(90) }, pending: {} }, P('m1', 100), [W('a')]);
  assert.deepEqual(s.matched, []);
  assert.deepEqual(s.pending, {});
  assert.deepEqual(s.autoState.a, C(100, ['m1']));
});

test('PhotoQueue: oldest first, a photo already queued is not added twice', () => {
  const q = new PhotoQueue();
  assert.equal(q.add([P('m3', 300), P('m1', 100)]), 2);
  assert.equal(q.add([P('m2', 200), P('m1', 100)]), 1);
  assert.equal(q.size, 3);
  assert.deepEqual([q.shift(), q.shift(), q.shift()].map((p) => p.id), ['m1', 'm2', 'm3']);
  assert.equal(q.peek(), undefined);
});

test('PhotoQueue: a photo taken off the queue can be queued again (reset, new watch)', () => {
  const q = new PhotoQueue();
  q.add([P('m1', 100)]);
  q.shift();
  assert.equal(q.add([P('m1', 100)]), 1);
});

test('markSeen removes only the reviewed ids', () => {
  const pending = { a: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], b: [{ id: 'x' }] };
  assert.deepEqual(markSeen(pending, 'a', ['m1', 'm2']), { a: [{ id: 'm3' }], b: [{ id: 'x' }] });
  assert.deepEqual(markSeen(pending, 'a', ['m1', 'm2', 'm3']), { b: [{ id: 'x' }] });
  assert.equal(pending.a.length, 3);
});

test('forget drops a watch from autoState, pending and found', () => {
  const s = forget({
    autoState: { a: C(1), b: C(2) }, pending: { a: [{ id: 'm1' }] }, found: { a: [{ id: 'm1' }], b: [{ id: 'x' }] },
  }, 'a');
  assert.deepEqual(s, { autoState: { b: C(2) }, pending: {}, found: { b: [{ id: 'x' }] }, gone: {} });
});

test('pendingTotal sums every watch', () => {
  assert.equal(pendingTotal({}), 0);
  assert.equal(pendingTotal({ a: [{}, {}], b: [{}] }), 3);
});

test('Batcher: nothing due mid-batch, everything due when drained', () => {
  const b = new Batcher(60_000);
  b.add('a', 1_000); b.add('a', 2_000); b.add('b', 3_000);
  assert.deepEqual(b.due(10_000, false), []);
  assert.deepEqual(b.due(10_000, true), [{ watchId: 'a', n: 2 }, { watchId: 'b', n: 1 }]);
  assert.deepEqual(b.due(20_000, true), []);
});

test('Batcher: a long batch is announced once its first match is a minute old', () => {
  const b = new Batcher(60_000);
  b.add('a', 0); b.add('a', 30_000);
  assert.deepEqual(b.due(59_999, false), []);
  assert.deepEqual(b.due(60_000, false), [{ watchId: 'a', n: 2 }]);
  b.add('a', 61_000);
  assert.deepEqual(b.due(62_000, false), []);
});

test('onFailure: a download error about the photo itself is skipped, so it cannot block the queue', () => {
  const noMedia = 'Message false_120363426317453506@g.us_3ADC21CE7E2112C27E4B_266013144789051@lid not contains media';
  assert.equal(onFailure('download', noMedia), 'skip');
  assert.equal(onFailure('download', 'Media not found'), 'skip');
});

test('onFailure: a download error meaning WhatsApp is unreachable pauses', () => {
  assert.equal(onFailure('download', 'no WhatsApp Web tab open'), 'pause');
  assert.equal(onFailure('download', 'WhatsApp tab not answering - refresh it'), 'pause');
  assert.equal(onFailure('download', 'page timeout: downloadImage'), 'pause');
});

test('onFailure: engine errors pause, except an image the engine cannot decode', () => {
  assert.equal(onFailure('analyse', 'no models - set them up in the panel'), 'pause');
  assert.equal(onFailure('analyse', 'engine did not answer'), 'pause');
  assert.equal(onFailure('analyse', 'some ORT failure'), 'pause');
  assert.equal(onFailure('analyse', 'could not decode image: InvalidStateError'), 'skip');
});

test('notifyText', () => {
  assert.equal(notifyText(W('a', { name: 'carmel', srcName: 'כיתה א2' }), 1), '1 new photo of carmel in כיתה א2');
  assert.equal(notifyText(W('a', { name: 'carmel', srcName: 'כיתה א2' }), 3), '3 new photos of carmel in כיתה א2');
});

test('ensureFrom: a cursor from before album labels labels only photos after it', () => {
  // from = lastChecked + 1: the album at exactly lastChecked was checked
  // before found existed, so it must get no label rather than a wrong 0.
  const out = ensureFrom({ a: C(300, ['m1']), b: { ...C(400), from: 100 } });
  assert.deepEqual(out, { a: { ...C(300, ['m1']), from: 301 }, b: { ...C(400), from: 100 } });
});

test('recordResult: the cursor keeps its from', () => {
  const s = recordResult({ autoState: { a: { ...C(90), from: 50 } }, pending: {} }, P('m1', 100), [hit('a', 0.1)], [W('a')]);
  assert.deepEqual(s.autoState.a, { ...C(100, ['m1']), from: 50 });
});

test('recordResult: a match goes into found as well as pending, once', () => {
  let s = { autoState: { a: C(90) }, pending: {}, found: {} };
  s = recordResult(s, P('m1', 100), [hit('a', 0.5, 70)], [W('a')]);
  assert.deepEqual(s.found, { a: [{ id: 'm1', t: 100, score: 0.5, px: 70 }] });
  s = recordResult(s, P('m1', 100), [hit('a', 0.5, 70)], [W('a')]);
  assert.equal(s.found.a.length, 1);
});

test('recordResult: state written before album labels (no found) still works', () => {
  const s = recordResult({ autoState: { a: C(90) }, pending: {} }, P('m1', 100), [hit('a', 0.5, 70)], [W('a')]);
  assert.deepEqual(s.found.a.map((x) => x.id), ['m1']);
});

test('pruneFound drops matches older than FOUND_DAYS and empty watches', () => {
  const now = 10_000_000, old = now - FOUND_DAYS * 86400 - 1, edge = now - FOUND_DAYS * 86400;
  const out = pruneFound({ a: [{ id: 'm1', t: old }, { id: 'm2', t: edge }], b: [{ id: 'x', t: old }] }, now);
  assert.deepEqual(out, { a: [{ id: 'm2', t: edge }] });
});

// albumStates(watches, { autoState, pending, found, gone }, strings, nowSec)
const NOW = 1_000; // early enough that the found window never clamps

test('albumStates: per group, cursor plus found flagged reviewed when no longer waiting', () => {
  const ws = [W('a', { refs: [[1, 2]] }), W('b', { src: 'g2@g.us' })];
  const autoState = { a: { ...C(200, ['m3']), from: 100 }, b: { ...C(50), from: 10 } };
  const pending = { a: [{ id: 'm2' }] };
  const found = { a: [{ id: 'm1', t: 120 }, { id: 'm2', t: 150 }] };
  const gone = { a: [{ id: 'm4', t: 130 }] };
  const out = albumStates(ws, { autoState, pending, found, gone }, { inProgress: 'in progress' }, NOW);
  assert.deepEqual(out, {
    strings: { inProgress: 'in progress' },
    chats: [
      { chatId: G, watches: [{ id: 'a', name: 'kid-a', from: 100, lastChecked: 200, atChecked: ['m3'],
        found: { m1: true, m2: false }, gone: ['m4'] }] },
      { chatId: 'g2@g.us', watches: [{ id: 'b', name: 'kid-b', from: 10, lastChecked: 50, atChecked: [],
        found: {}, gone: [] }] },
    ],
  });
  assert.ok(!JSON.stringify(out).includes('refs'));
});

test('albumStates: skips manual watches and watches with no cursor yet', () => {
  const ws = [W('a', { auto: false }), W('b'), W('c')];
  const out = albumStates(ws, { autoState: { a: C(1), c: C(5) }, pending: {}, found: {} }, {}, NOW);
  assert.deepEqual(out.chats.map((c) => c.watches.map((w) => w.id)), [['c']]);
  assert.equal(out.chats[0].watches[0].from, 6); // no from yet: same as ensureFrom
});

test('albumStates: two watches on one group share one entry', () => {
  const out = albumStates([W('a'), W('b')], { autoState: { a: C(1), b: C(2) }, pending: {}, found: {} }, {}, NOW);
  assert.equal(out.chats.length, 1);
  assert.deepEqual(out.chats[0].watches.map((w) => w.id), ['a', 'b']);
});

test('albumStates: from never reaches back past the found window', () => {
  // Matches older than FOUND_DAYS are pruned, so an older album would read 0.
  const now = 100 + FOUND_DAYS * 86400 + 50;
  const out = albumStates([W('a')], { autoState: { a: { ...C(now - 10), from: 100 } }, pending: {}, found: {} }, {}, now);
  assert.equal(out.chats[0].watches[0].from, now - FOUND_DAYS * 86400);
});

test('skipResult records the photo as gone for each target, once', () => {
  let s = { autoState: { a: C(90), b: C(90) }, pending: {}, found: {}, gone: {} };
  s = skipResult(s, P('m1', 100), [W('a'), W('b')]);
  assert.deepEqual(s.gone, { a: [{ id: 'm1', t: 100 }], b: [{ id: 'm1', t: 100 }] });
  s = skipResult(s, P('m1', 100), [W('a')]);
  assert.equal(s.gone.a.length, 1);
});

test('forget clears gone too', () => {
  const s = forget({ autoState: { a: C(1) }, pending: {}, found: {}, gone: { a: [{ id: 'm1', t: 1 }] } }, 'a');
  assert.deepEqual(s.gone, {});
});
