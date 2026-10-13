import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED, normalize, resolveLang, dirOf, t, isSelfDst, STRINGS } from '../lib/i18n.js';

test('normalize: Hebrew tags, including the legacy iw and any case or separator', () => {
  for (const tag of ['he', 'he-IL', 'he_IL', 'HE', 'iw', 'iw-IL']) assert.equal(normalize(tag), 'he', tag);
});

test('normalize: any English tag is en', () => {
  for (const tag of ['en', 'en-US', 'en_GB', 'EN']) assert.equal(normalize(tag), 'en', tag);
});

test('normalize: unsupported or missing is null', () => {
  for (const tag of ['fr', 'ar', 'hebrew', '', null, undefined, 42]) assert.equal(normalize(tag), null, String(tag));
});

test('resolveLang: an explicit preference wins over WhatsApp and the browser', () => {
  assert.equal(resolveLang({ pref: 'en', wa: 'he', browser: 'he' }), 'en');
  assert.equal(resolveLang({ pref: 'he', wa: 'en', browser: 'en-US' }), 'he');
});

test("resolveLang: 'auto', missing or garbage preference follows WhatsApp", () => {
  for (const pref of ['auto', undefined, null, 'fr', '']) {
    assert.equal(resolveLang({ pref, wa: 'he-IL', browser: 'en-US' }), 'he', String(pref));
  }
});

test('resolveLang: no WhatsApp language falls back to the browser, then English', () => {
  assert.equal(resolveLang({ wa: null, browser: 'he' }), 'he');
  assert.equal(resolveLang({ wa: 'fr', browser: 'iw' }), 'he');   // unsupported WhatsApp tag
  assert.equal(resolveLang({ wa: 'fr', browser: 'de' }), 'en');
  assert.equal(resolveLang({}), 'en');
});

test('dirOf', () => {
  assert.equal(dirOf('he'), 'rtl');
  assert.equal(dirOf('en'), 'ltr');
});

test('t: string entries and {placeholders}', () => {
  assert.equal(t('en', 'checkedUpTo', { when: 'today' }), 'checked up to today');
  assert.equal(t('he', 'checkedUpTo', { when: 'היום' }), 'נבדק עד היום');
});

test('t: a placeholder with no value stays visible rather than becoming "undefined"', () => {
  assert.equal(t('en', 'checkedUpTo'), 'checked up to {when}');
});

test('t: unknown language falls back to English; unknown key returns the key', () => {
  assert.equal(t('fr', 'remove'), 'Remove');
  assert.equal(t(undefined, 'remove'), 'Remove');
  assert.equal(t('he', 'noSuchKey'), 'noSuchKey');
});

test('t: notify, singular and plural in both languages', () => {
  const v = (n) => ({ n, name: 'Nir', group: 'כיתה א2' });
  assert.equal(t('en', 'notify', v(1)), '1 new photo of Nir in כיתה א2');
  assert.equal(t('en', 'notify', v(3)), '3 new photos of Nir in כיתה א2');
  assert.equal(t('he', 'notify', v(1)), 'תמונה חדשה אחת של Nir בקבוצה כיתה א2');
  assert.equal(t('he', 'notify', v(3)), '3 תמונות חדשות של Nir בקבוצה כיתה א2');
});

test('arrows point the reading direction in each language', () => {
  assert.equal(t('en', 'arrowTo'), '→');
  assert.equal(t('he', 'arrowTo'), '←');
  assert.equal(t('en', 'arrowFrom'), '←');
  assert.equal(t('he', 'arrowFrom'), '→');
});

// Every count-dependent entry is called with these; a template reading a
// variable that isn't passed would print "undefined".
const VARS = { name: 'Nir', group: 'G', album: true };
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('completeness: every key has English and Hebrew of the same kind', () => {
  for (const [key, e] of Object.entries(STRINGS)) {
    for (const lang of SUPPORTED) assert.ok(lang in e, `${key} has no ${lang}`);
    assert.equal(typeof e.en, typeof e.he, `${key}: en and he differ in kind`);
  }
});

test('completeness: string entries use the same placeholders in both languages', () => {
  for (const [key, e] of Object.entries(STRINGS)) {
    if (typeof e.en !== 'string') continue;
    assert.deepEqual(placeholders(e.he), placeholders(e.en), key);
  }
});

test('completeness: function entries give non-empty text for 0, 1, 2 and 11', () => {
  for (const [key, e] of Object.entries(STRINGS)) {
    if (typeof e.en !== 'function') continue;
    for (const lang of SUPPORTED) {
      for (const n of [0, 1, 2, 11]) {
        const s = e[lang]({ ...VARS, n });
        assert.ok(typeof s === 'string' && s.trim(), `${key}/${lang}/${n} is empty`);
        assert.ok(!s.includes('undefined'), `${key}/${lang}/${n}: ${s}`);
      }
    }
  }
});

test('entries are plain text: panel.js puts them into innerHTML', () => {
  for (const [key, e] of Object.entries(STRINGS)) {
    for (const lang of SUPPORTED) {
      const s = typeof e[lang] === 'function' ? e[lang]({ ...VARS, n: 2 }) : e[lang];
      assert.ok(!/[<&]/.test(s), `${key}/${lang} contains markup: ${s}`);
    }
  }
});

test('isSelfDst: new watches by kind, old ones by their saved English name', () => {
  assert.equal(isSelfDst({ dstKind: 'self', dstName: 'Message yourself' }), true);
  assert.equal(isSelfDst({ dstName: 'Message yourself (test)' }), true);   // saved before 0.13
  assert.equal(isSelfDst({ dstName: 'Message yourself' }), true);
  assert.equal(isSelfDst({ dstKind: 'group', dstName: 'Grandparents' }), false);
  assert.equal(isSelfDst({ dstName: 'Grandparents' }), false);
  assert.equal(isSelfDst({}), false);
});
