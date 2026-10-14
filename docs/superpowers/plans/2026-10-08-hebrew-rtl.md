# Hebrew and RTL UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The side panel, toolbar tooltip, notifications and in-chat album labels follow WhatsApp Web's language (English or Hebrew, right to left for Hebrew), with a manual override in Setup.

**Architecture:** A new pure module, `lib/i18n.js`, holds both dictionaries and the rules for choosing a language. `page.js` reports WhatsApp's raw language tag with `ready` (and on change). The background stores it as `waLang` and uses it for the badge tooltip, notifications and album-label strings. The panel resolves the language from `waLang` + `uiLangPref` the same way, sets `<html lang dir>`, fills `data-i18n` elements, renders dynamic text through `t()`, and re-renders live when either key changes.

**Tech Stack:** Manifest V3 Chrome extension, plain JS (no build step), wa-js, Node's built-in test runner, `chrome.i18n` for the manifest only.

**Spec:** `docs/superpowers/specs/2026-10-01-hebrew-rtl-design.md`. Read it before starting.

**Where this plan goes beyond the spec** (the spec predates album labels, merged in 0.11–0.12):
- **Album labels are translated too.** `background.js` already passes label strings to the page (`LABEL_STRINGS`). They now come from `t()`, and a language change pushes them again.
- **`page.js` always watches `<html lang>`** and emits a `lang` event when it changes. The spec makes this conditional on Risk 2. It costs six lines, does no harm when a language change reloads the page, and still works if WhatsApp stops reloading.
- **Safety reveal.** If `panel.js` never runs, for example because a module fails to load, a CSS animation shows the English panel after one second. Without it the panel would stay blank (the spec's `finally` only covers a failed storage read).
- **`isSelfDst` lives in `lib/i18n.js`** so it can be unit-tested.
- **English plurals fixed** where the old text said `photo(s)` / `match(es)`, because every count now goes through a function entry anyway.
- **Missing review photos** are stored as `gone: 'expired'` and translated when drawn, not stored as English text, so a language switch reaches them.

## Global Constraints

- AGENTS.md hard rules hold. `page.js` only *reads* WhatsApp's language; it never changes it (rule 1).
- No build step, no new dependencies, no new permissions.
- `chrome.i18n.getMessage` is not used for UI text. `chrome.i18n` is used only for the manifest (`__MSG_*__`) and for `chrome.i18n.getUILanguage()` as the browser fallback.
- Languages: `'en'` and `'he'` only; anything else falls back to English.
- The log stays English and left to right. This includes everything passed to `log()` / `alog()` and all error messages.
- The extension name stays "Class Photo Filter" in both languages (badge tooltip, notification title, `<h1>`, `_locales/*/messages.json` `appName`).
- Hebrew copy is gender-neutral: nouns or infinitives for buttons, impersonal "אפשר…" / "יש ל…" for instructions, and "הילד/ה" for the child.
- One writer per storage key: `waLang` → background; `uiLangPref` → panel; `watches` → panel (now with optional `dstKind`).
- The resolved language is never stored. Every context computes `resolveLang({ pref: uiLangPref, wa: waLang, browser: chrome.i18n.getUILanguage() })`.
- `page.js` stays the only file that touches WhatsApp. It returns the raw tag; `lib/i18n.js` normalises it.
- `relay.js` is not changed.
- Dictionary entries are plain text with no `<` or `&`, because `panel.js` inserts them into `innerHTML`. Names never go into a dictionary string raw: in `innerHTML` they are passed as `nm(name)`, which is escaped and wrapped in `<bdi>`.
- Style: semicolons, 2-space indent, single quotes, and comments that explain *why*.
- `manifest.json` `version` goes up one minor step once for this feature: `0.12` → `0.13`.
- After any extension reload, refresh WhatsApp Web before testing.

## Review Focus

1. **Panel shown before the language is known.** A reasonable person expects no flash of English and never a blank panel. The `finally` in Task 6 Step 3 and the CSS reveal in Task 5 Step 3 pin this, and Task 8 Step 4 (items 1 and 9) checks it.
2. **Watches saved before this change** with destination `Message yourself (test)` should show the translated self-chat name. Pinned by the `isSelfDst` tests in Task 2.
3. **`panel.html` and the dictionary drifting apart.** A typo'd `data-i18n` key would show the raw key in Hebrew, and English HTML that differs from the dictionary would change text when switching back to English. Pinned by the `panel.html` tests in Task 5.
4. **Switching language with a review open** should keep the thumbnails (nothing downloaded again), and the review should not reappear after it was closed. Pinned by the `current && !reviewCard.hidden` guard in Task 6 Step 2 and Task 8 Step 4 (item 2).
5. **Odd language tags** (`he_IL`, `HE`, `iw`, `''`, `null`, `fr`, a garbage `uiLangPref`) should resolve predictably, never throw, and never produce `undefined`. Pinned by the `normalize` / `resolveLang` tests in Task 2.

---

### Task 1: Find out how WhatsApp exposes its language (by hand, owner)

This needs a WhatsApp account switched to Hebrew, so the owner runs it. Nothing in it is kept except the findings, which decide the body of `waLanguage()` in Task 4. It covers spec Risks 1 and 2.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-hebrew-rtl-design.md` (append a Findings section)

**Interfaces:**
- Consumes: nothing.
- Produces: a *Findings* section in the spec recording (a) whether `<html lang>` follows WhatsApp's language, (b) the `localStorage` key that holds the preference, if one exists, and its value format, and (c) whether changing the language reloads the page.

- [x] **Step 1: Read the language with WhatsApp in English**

Open WhatsApp Web. In its DevTools console (top frame) run:

```js
(() => {
  const h = document.documentElement;
  console.log('html lang:', JSON.stringify(h.lang), 'dir:', JSON.stringify(h.dir));
  console.table(Object.keys(localStorage).filter((k) => /lang|locale/i.test(k))
    .map((k) => ({ key: k, value: String(localStorage.getItem(k)).slice(0, 80) })));
  window.__cpfProbe = 1;
})();
```

Note the output.

- [x] **Step 2: Switch WhatsApp to Hebrew and read again**

WhatsApp Web → Settings → General → Language → עברית. Then in the console:

```js
console.log('probe survived (no reload):', window.__cpfProbe === 1);
```

Then run the Step 1 snippet again and note the output.

- [x] **Step 3: Record the findings in the spec**

Append to `docs/superpowers/specs/2026-10-01-hebrew-rtl-design.md`:

```markdown
## Findings (Task 1 of the plan, <date>)

- `<html lang>`: English → `"<value>"`, Hebrew → `"<value>"` (follows the language | fixed | empty).
- `localStorage`: key `<key>` holds the preference, value `<format, e.g. "he" with quotes>` | no such key.
- Changing the language: reloads the page | does not reload (`<html lang>` changes in place | does not change).
```

If `<html lang>` follows the language, the `localStorage` read in Task 4 is a fallback only. If neither source exists, Task 4 drops both reads, `waLanguage()` returns `null`, and the browser language and the Setup override carry the feature (spec, Risk 1).

- [x] **Step 4: Commit the spec and this plan**

```bash
git add docs/superpowers/specs/2026-10-01-hebrew-rtl-design.md docs/superpowers/plans/2026-10-08-hebrew-rtl.md
git commit -m "docs: Hebrew/RTL spec, implementation plan and WhatsApp language findings"
```

---

### Task 2: `lib/i18n.js`: dictionaries and language rules

**Files:**
- Create: `lib/i18n.js`
- Create: `tests/i18n.test.js`
- Modify: `lib/auto-state.js` (`notifyText`, near the end of the file)
- Modify: `tests/auto-state.test.js:194-197` (`notifyText` test)

**Interfaces:**
- Consumes: nothing.
- Produces (all named exports of `lib/i18n.js`):
  - `SUPPORTED: ['en', 'he']`
  - `normalize(tag: any) → 'en' | 'he' | null`
  - `resolveLang({ pref?, wa?, browser? }) → 'en' | 'he'`
  - `dirOf(lang) → 'rtl' | 'ltr'`
  - `t(lang, key: string, vars?: object) → string`. It never throws. A missing language falls back to English, and a missing key returns the key.
  - `isSelfDst(w: { dstKind?, dstName? }) → boolean`
  - `STRINGS`: the dictionary, exported for tests. Keys and their variables are listed in Step 3.
  - `lib/auto-state.js`: `notifyText(w, n, lang) → string` (was `notifyText(w, n)`).

- [ ] **Step 1: Write the failing tests**

Create `tests/i18n.test.js`:

```js
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
```

In `tests/auto-state.test.js`, replace the `notifyText` test (lines 194-197) with:

```js
test('notifyText', () => {
  const w = W('a', { name: 'carmel', srcName: 'כיתה א2' });
  assert.equal(notifyText(w, 1, 'en'), '1 new photo of carmel in כיתה א2');
  assert.equal(notifyText(w, 3, 'en'), '3 new photos of carmel in כיתה א2');
  assert.equal(notifyText(w, 3, 'he'), '3 תמונות חדשות של carmel בקבוצה כיתה א2');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. `tests/i18n.test.js` cannot import `../lib/i18n.js` (`ERR_MODULE_NOT_FOUND`). In `auto-state.test.js` the Hebrew `notifyText` assertion fails (it returns the English text).

- [ ] **Step 3: Write `lib/i18n.js`**

```js
/* UI text in English and Hebrew, and which language to show. Pure: no
   chrome.* and no DOM, so it is unit-tested in Node (tests/i18n.test.js)
   and shared by panel.js, background.js and lib/auto-state.js.

   Not chrome.i18n: that always answers in the browser's UI language, fixed
   at browser start, and this follows WhatsApp's language while running.
   chrome.i18n is used only for the manifest (_locales/).

   Entries are plain text (no < or &): panel.js puts them into innerHTML,
   with names passed in already escaped and wrapped in <bdi>. Hebrew copy is
   gender-neutral - nouns and infinitives, never imperatives, and "הילד/ה".
   Anything that depends on a number is a function, because Hebrew number
   agreement is not "add an s". The log and error messages stay English and
   never come through here. */

export const SUPPORTED = ['en', 'he'];

/** Raw tag (WhatsApp's, the browser's) → a supported language or null.
    'iw' is the legacy code for Hebrew that some systems still report. */
export function normalize(tag) {
  if (typeof tag !== 'string') return null;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  if (base === 'he' || base === 'iw') return 'he';
  if (base === 'en') return 'en';
  return null;
}

/** The Setup choice unless it is 'auto' (or missing), then WhatsApp's
    language, then the browser's, then English. */
export function resolveLang({ pref, wa, browser } = {}) {
  if (SUPPORTED.includes(pref)) return pref;
  return normalize(wa) || normalize(browser) || 'en';
}

export const dirOf = (lang) => (lang === 'he' ? 'rtl' : 'ltr');

// Not translated until the owner picks a Hebrew name (spec, Decision 3).
const APP = 'Class Photo Filter';

const s = (n, one, many) => (n === 1 ? one : many);

export const STRINGS = {
  // ---- panel.html (data-i18n*) - the English must match the HTML exactly
  tabSetup: { en: 'Setup', he: 'הגדרות' },
  tabPhotos: { en: 'Photos', he: 'תמונות' },
  addToComposer: { en: 'Add to composer', he: 'הוספה לתיבת ההודעה' },
  markSeen: { en: 'Mark as seen', he: 'סימון כנצפה' },
  stopScan: { en: 'Stop scan', he: 'עצירת הסריקה' },
  language: { en: 'Language', he: 'שפה' },
  langAuto: { en: 'Automatic (follow WhatsApp)', he: 'אוטומטית (לפי WhatsApp)' },
  models: { en: 'Models', he: 'מודלים' },
  modelsHintBefore: { en: 'Pick these once from', he: 'יש לבחור אותם פעם אחת מהתיקייה' },
  modelsHintAfter: {
    en: ". They're stored in the extension and never asked for again.",
    he: '. הם נשמרים בתוסף, ואין צורך לבחור אותם שוב.',
  },
  addGroup: { en: 'Add a group to watch', he: 'הוספת קבוצה למעקב' },
  watchThisGroup: { en: 'Watch this group', he: 'הקבוצה למעקב' },
  filterByName: { en: 'filter by name...', he: 'סינון לפי שם...' },
  sendMatchesTo: { en: 'Send matches to', he: 'לאן לשלוח את ההתאמות' },
  childName: { en: "Child's name", he: 'שם הילד/ה' },
  childNameExample: { en: 'e.g. Nir', he: 'למשל: ניר' },
  refPhotos: { en: 'Reference photos of that child', he: 'תמונות ייחוס של הילד/ה' },
  matchThreshold: { en: 'Match threshold', he: 'סף התאמה' },
  thresholdHint: {
    en: 'Start at 0.35. Lower it if the child is usually far from the camera.',
    he: 'מומלץ להתחיל מ־0.35, ולהנמיך אם הילד/ה מצולם/ת בדרך כלל מרחוק.',
  },
  autoWatchLabel: {
    en: 'Auto-watch: check new photos in the background and alert me',
    he: 'מעקב אוטומטי: בדיקת תמונות חדשות ברקע והתראה עליהן',
  },
  saveWatch: { en: 'Save watch', he: 'שמירת המעקב' },
  reloadGroups: { en: 'Reload groups', he: 'טעינת הקבוצות מחדש' },
  savedWatches: { en: 'Saved watches', he: 'מעקבים שמורים' },

  // ---- panel.js: Setup
  groups: { en: 'Groups', he: 'קבוצות' },
  directChats: { en: 'Direct chats', he: 'צ׳אטים פרטיים' },
  messageYourself: { en: 'Message yourself', he: 'הודעה לעצמי' },
  modelsStored: { en: '✓ models stored', he: '✓ המודלים שמורים' },
  modelsNotSet: { en: 'not set up yet', he: 'עדיין לא הוגדרו' },
  nothingSelected: { en: 'nothing selected', he: 'לא נבחר דבר' },
  change: { en: 'change', he: 'שינוי' },
  stillNeeded: { en: 'Still needed: {items}', he: 'חסר עדיין: {items}' },
  needSrc: { en: 'group to watch', he: 'קבוצה למעקב' },
  needDst: { en: 'where to send matches', he: 'לאן לשלוח את ההתאמות' },
  needName: { en: "child's name", he: 'שם הילד/ה' },
  needRefs: { en: 'reference photos', he: 'תמונות ייחוס' },
  nothingYet: { en: 'Nothing yet.', he: 'עדיין אין מעקבים.' },
  autoShort: { en: 'Auto', he: 'אוטומטי' },
  autoTitle: {
    en: 'Check new photos in the background and alert me',
    he: 'בדיקת תמונות חדשות ברקע והתראה עליהן',
  },
  reset: { en: 'Reset', he: 'איפוס' },
  resetTitle: {
    en: 'Forget last seen and waiting matches; the next check covers the last {days} days',
    he: 'מחיקת הצפייה האחרונה וההתאמות הממתינות; הבדיקה הבאה תכסה את {days} הימים האחרונים',
  },
  remove: { en: 'Remove', he: 'הסרה' },

  // ---- panel.js: Photos
  noWatches: {
    en: 'No watches yet. Open Setup to add one.',
    he: 'אין עדיין מעקבים. אפשר להוסיף מעקב בלשונית הגדרות.',
  },
  nWaiting: { en: ({ n }) => `${n} waiting`, he: ({ n }) => s(n, '1 ממתינה', `${n} ממתינות`) },
  watching: { en: 'watching', he: 'במעקב' },
  thresholdIs: { en: 'threshold {v}', he: 'סף {v}' },
  autoOn: { en: 'auto-watch on', he: 'מעקב אוטומטי פעיל' },
  checkedUpTo: { en: 'checked up to {when}', he: 'נבדק עד {when}' },
  notYet: { en: 'not yet', he: 'עדיין לא' },
  reviewN: {
    en: ({ n, name }) => `Review ${n} photo${s(n, '', 's')} of ${name}`,
    he: ({ n, name }) => s(n, `צפייה בתמונה אחת של ${name}`, `צפייה ב־${n} תמונות של ${name}`),
  },
  noMatchesWaiting: { en: 'No matches waiting', he: 'אין התאמות ממתינות' },
  checking: { en: 'checking...', he: 'בבדיקה...' },
  nNew: { en: ({ n }) => `${n} new`, he: ({ n }) => s(n, '1 חדשה', `${n} חדשות`) },
  upToDate: { en: 'up to date', he: 'מעודכן' },
  checkForNew: { en: 'Check for new photos', he: 'בדיקת תמונות חדשות' },
  findIn: {
    en: ({ n, name }) => `Find ${name} in ${n} new photo${s(n, '', 's')}`,
    he: ({ n, name }) => s(n, `חיפוש ${name} בתמונה חדשה אחת`, `חיפוש ${name} ב־${n} תמונות חדשות`),
  },
  nothingNew: { en: 'Nothing new', he: 'אין תמונות חדשות' },
  lastSeen: { en: 'last seen {when}', he: 'נצפה לאחרונה {when}' },
  lastSeenNever: {
    en: 'last seen never (first check covers the last {days} days)',
    he: 'טרם נצפה (הבדיקה הראשונה תכסה את {days} הימים האחרונים)',
  },
  reviewTitle: {
    en: ({ n, name, album }) => `${n} photo${s(n, '', 's')} of ${name}${album ? ' in this album' : ''}`,
    he: ({ n, name, album }) => s(n, `תמונה אחת של ${name}`, `${n} תמונות של ${name}`)
      + (album ? ' באלבום הזה' : ''),
  },
  reviewHint: {
    en: 'Untick anything wrong, then add them to {dst}. You press Enter to send.',
    he: 'אפשר לבטל את הסימון של מה שלא מתאים, ואז להוסיף את השאר אל {dst}. השליחה עצמה ב־Enter, ידנית.',
  },
  // Names the "Mark as seen" button: keep in step with markSeen above.
  reviewNone: {
    en: 'Nothing matched. "Mark as seen" to skip these next time.',
    he: 'לא נמצאו התאמות. "סימון כנצפה" ידלג עליהן בפעם הבאה.',
  },
  reviewStopped: {
    en: ({ n }) => `Scan was stopped: "Mark as seen" also skips the ${n} older photo${s(n, '', 's')} not checked.`,
    he: ({ n }) => s(n, 'הסריקה נעצרה: "סימון כנצפה" ידלג גם על התמונה הישנה שלא נבדקה.',
      `הסריקה נעצרה: "סימון כנצפה" ידלג גם על ${n} התמונות הישנות שלא נבדקו.`),
  },
  noLongerAvailable: { en: 'no longer available', he: 'כבר לא זמינה' },
  alreadyReviewed: { en: 'already reviewed', he: 'כבר סומן כנצפה' },
  // Between two names: "group → destination", "child ← group". Unicode
  // doesn't mirror arrows in right-to-left text, so each language has its own.
  arrowTo: { en: '→', he: '←' },
  arrowFrom: { en: '←', he: '→' },

  // ---- background.js: toolbar tooltip, notifications, in-chat labels
  badgeIdle: { en: APP, he: APP },
  badgeWaiting: {
    en: ({ n }) => `${APP} - ${n} match${s(n, '', 'es')} waiting`,
    he: ({ n }) => `${APP} - ${s(n, 'התאמה אחת ממתינה', `${n} התאמות ממתינות`)}`,
  },
  badgeNoModels: {
    en: `${APP} - set up the models in the panel`,
    he: `${APP} - יש להגדיר את המודלים בחלונית`,
  },
  // "בקבוצה X" rather than "בX": a Hebrew prefix glued to a Latin group name reads badly.
  notify: {
    en: ({ n, name, group }) => `${n} new photo${s(n, '', 's')} of ${name} in ${group}`,
    he: ({ n, name, group }) => s(n, `תמונה חדשה אחת של ${name} בקבוצה ${group}`,
      `${n} תמונות חדשות של ${name} בקבוצה ${group}`),
  },
  labelInProgress: { en: 'in progress', he: 'בבדיקה' },
  labelReviewed: { en: 'reviewed', he: 'נצפה' },
};

/** Text for `key` in `lang`. Never throws: English when the language lacks
    it, the key itself when nothing has it, and a {placeholder} with no
    value stays visible - all easy to spot, none fatal. */
export function t(lang, key, vars = {}) {
  const e = STRINGS[key];
  if (!e) return key;
  const v = e[lang] ?? e.en;
  if (typeof v === 'function') return v(vars);
  return v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Is a watch's destination the "Message yourself" chat? New watches say
    so in dstKind. Watches saved before 0.13 only have the English name
    page.js gave it ("Message yourself (test)" at the time), which is why
    nothing needs migrating. */
export const isSelfDst = (w) =>
  w.dstKind === 'self' || /^Message yourself/.test(w.dstName || '');
```

- [ ] **Step 4: Make `notifyText` delegate**

In `lib/auto-state.js`, add at the top, after the header comment:

```js
import { t } from './i18n.js';
```

Replace:

```js
export const notifyText = (w, n) =>
  `${n} new photo${n === 1 ? '' : 's'} of ${w.name} in ${w.srcName}`;
```

with:

```js
export const notifyText = (w, n, lang) => t(lang, 'notify', { n, name: w.name, group: w.srcName });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. All the old tests, plus the new `i18n.test.js` tests.

- [ ] **Step 6: Commit**

```bash
git add lib/i18n.js lib/auto-state.js tests/i18n.test.js tests/auto-state.test.js
git commit -m "feat: English and Hebrew dictionaries and language resolution (lib/i18n.js)"
```

---

### Task 3: Manifest locales, the static check, and the version

**Files:**
- Create: `_locales/en/messages.json`
- Create: `_locales/he/messages.json`
- Modify: `manifest.json`
- Modify: `scripts/check.mjs`

**Interfaces:**
- Consumes: `lib/i18n.js` exists (added to the syntax-check list).
- Produces: `npm run check` fails when a locale file is missing, does not parse, or lacks a `__MSG_*__` the manifest uses.

- [ ] **Step 1: Make the check demand the locales (failing)**

In `scripts/check.mjs`, add `'lib/i18n.js'` to `sources`:

```js
const sources = ['background.js', 'engine.js', 'page.js', 'panel.js', 'relay.js',
  'lib/face.js', 'lib/auto-state.js', 'lib/album-label.js', 'lib/i18n.js'];
```

Insert this before the final `console.log`:

```js
// chrome.i18n fills the manifest's __MSG_x__ from _locales/<lang>/messages.json.
// A missing one shows the raw placeholder on the Extensions page, or makes
// Chrome refuse to load the extension, with nothing in any console.
const used = [...new Set([...JSON.stringify(m).matchAll(/__MSG_(\w+)__/g)].map((x) => x[1]))];
if (used.length && !m.default_locale) { console.log('LOCALE manifest has __MSG_ but no default_locale'); bad++; }
for (const loc of ['en', 'he']) {
  let msgs;
  try { msgs = JSON.parse(readFileSync(join(root, '_locales', loc, 'messages.json'), 'utf8')); }
  catch (e) { console.log('LOCALE', loc, e.message); bad++; continue; }
  for (const k of used) if (!msgs[k]?.message) { console.log('LOCALE', loc, 'missing', k); bad++; }
}
```

- [ ] **Step 2: Switch the manifest to messages**

In `manifest.json`, change these fields (leave everything else as it is):

```json
  "name": "__MSG_appName__",
  "version": "0.13",
  "description": "__MSG_appDesc__",
  "default_locale": "en",
```

```json
  "action": {
    "default_title": "__MSG_appName__"
  },
```

```json
      "description": "__MSG_reloadDesc__"
```

(The last one is `commands.reload-extension.description`.)

- [ ] **Step 3: Run the check to verify it fails**

Run: `npm run check`
Expected: FAIL with `LOCALE en ENOENT…` and `LOCALE he ENOENT…`, then `2 problem(s)`.

- [ ] **Step 4: Add the locale files**

`_locales/en/messages.json`:

```json
{
  "appName": { "message": "Class Photo Filter" },
  "appDesc": { "message": "Finds photos of your child in WhatsApp group albums and queues them for the family chat." },
  "reloadDesc": { "message": "Reload this extension" }
}
```

`_locales/he/messages.json` (`appName` stays English until the owner picks a Hebrew name; it is a one-line change here):

```json
{
  "appName": { "message": "Class Photo Filter" },
  "appDesc": { "message": "מוצא תמונות של הילד/ה באלבומים של קבוצות WhatsApp ומכין אותן לשליחה לצ׳אט המשפחתי." },
  "reloadDesc": { "message": "טעינה מחדש של התוסף" }
}
```

- [ ] **Step 5: Run the check and the tests**

Run: `npm run check && npm test`
Expected: `ok - manifest 0.13, permissions: storage, sidePanel, tabs, offscreen, notifications`, and all tests pass.

- [ ] **Step 6: Commit**

```bash
git add _locales manifest.json scripts/check.mjs
git commit -m "feat: manifest name and descriptions through _locales; check verifies them; version 0.13"
```

---

### Task 4: WhatsApp's language reaches the background (page.js, background.js)

These files run only inside Chrome. Verification here is `npm run check`, `npm test`, and the manual checks in Task 8.

**Files:**
- Modify: `page.js:47-52` (self chat), `page.js:139-146` (`ready`), plus a new helper and observer
- Modify: `background.js` (imports, `updateBadge`, label strings, `announce`, `evt` listener, `storage.onChanged`)

**Interfaces:**
- Consumes: `t`, `resolveLang` from `lib/i18n.js`; `notifyText(w, n, lang)` from Task 2; the Findings from Task 1.
- Produces:
  - The page event `ready` now carries `{ lang: string | null }`. A new page event `lang` carries `{ lang: string | null }`.
  - `chrome.storage.local.waLang` holds the raw tag or `null`, and is written only by the background, only when it changes.
  - `listGroups().self.name` is `'Message yourself'`, still with `kind: 'self'`.

- [ ] **Step 1: `page.js`: read WhatsApp's language**

Insert after the `blobToDataUrl` helper (around line 26). Per the Task 1 Findings, `<html lang>` is the only source:

```js
  // WhatsApp's UI language, as the raw tag it uses (lib/i18n.js normalises
  // it). Read only - nothing here changes WhatsApp's settings. WhatsApp sets
  // <html lang> from its own language setting ("he" with dir="rtl" when set
  // to Hebrew). Not localStorage's WALangPhonePref: that is the phone's
  // language, and stays "en-GB" with WhatsApp Web in Hebrew (spec, Findings).
  function waLanguage() {
    return document.documentElement.lang || null;
  }
```

- [ ] **Step 2: `page.js`: send it with `ready`, and on change**

Replace:

```js
  ready.then(() => {
    emit('ready');
```

with:

```js
  ready.then(() => {
    emit('ready', { lang: waLanguage() });
    // If WhatsApp ever switches language without reloading, follow it
    // anyway. When it does reload, this never fires and 'ready' covers it.
    new MutationObserver(() => emit('lang', { lang: waLanguage() }))
      .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
```

- [ ] **Step 3: `page.js`: name the self chat neutrally**

Replace:

```js
      // Message-yourself chat: the safest possible destination while developing.
      let self = null;
      try {
        const me = WPP.conn.getMyUserId();
        self = { id: me.toString(), name: 'Message yourself (test)', kind: 'self' };
```

with:

```js
      // Message-yourself chat: the default destination. The panel shows it by
      // kind, in the UI language; this name is only a fallback.
      let self = null;
      try {
        const me = WPP.conn.getMyUserId();
        self = { id: me.toString(), name: 'Message yourself', kind: 'self' };
```

- [ ] **Step 4: `background.js`: language helpers**

After the existing `import { … } from './lib/auto-state.js';` add:

```js
import { t, resolveLang } from './lib/i18n.js';
```

After the `alog` function, add:

```js
/* ---------- language: follows WhatsApp, as the panel does ---------- */

// Same inputs and the same resolveLang as the panel, so the tooltip and
// notifications can't disagree with it. Never stored resolved.
async function uiLang() {
  const { waLang, uiLangPref } = await chrome.storage.local.get(['waLang', 'uiLangPref']);
  return resolveLang({ pref: uiLangPref, wa: waLang, browser: chrome.i18n.getUILanguage() });
}

// waLang is written only here. Only on a change, so an open panel doesn't
// re-render on every WhatsApp reload.
async function saveWaLang(lang) {
  const next = lang ?? null;
  const { waLang = null } = await chrome.storage.local.get('waLang');
  if (waLang !== next) await chrome.storage.local.set({ waLang: next });
}
```

- [ ] **Step 5: `background.js`: translate the tooltip**

In `updateBadge`, replace the `chrome.action.setTitle({ … })` call with:

```js
  const lang = await uiLang();
  await chrome.action.setTitle({
    title: modelsMissing ? t(lang, 'badgeNoModels')
      : n ? t(lang, 'badgeWaiting', { n }) : t(lang, 'badgeIdle'),
  });
```

- [ ] **Step 6: `background.js`: translate the album labels**

Replace:

```js
// Label text lives here, not in page.js, so the page needs no language.
const LABEL_STRINGS = { inProgress: 'in progress', reviewed: 'reviewed' };
```

with:

```js
// Label text lives here, not in page.js, so the page needs no dictionary.
const labelStrings = (lang) => ({ inProgress: t(lang, 'labelInProgress'), reviewed: t(lang, 'labelReviewed') });
```

In `pushLabels`, replace:

```js
    await callPage('albumState', albumStates(watches, state, LABEL_STRINGS, Math.floor(Date.now() / 1000)))
```

with:

```js
    const strings = labelStrings(await uiLang());
    await callPage('albumState', albumStates(watches, state, strings, Math.floor(Date.now() / 1000)))
```

Replace the `storage.onChanged` listener under it:

```js
// Auto-watch toggled or a watch removed in the panel (it owns `watches`).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.watches) pushLabels();
});
```

with:

```js
// Auto-watch toggled or a watch removed in the panel (it owns `watches`), or
// the language changed: labels and the tooltip are redrawn in it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const relang = changes.waLang || changes.uiLangPref;
  if (changes.watches || relang) pushLabels();
  if (relang) updateBadge().catch(() => {});
});
```

- [ ] **Step 7: `background.js`: translate notifications, keep the log English**

In `announce`, replace:

```js
  const { watches } = await load();
  for (const { watchId, n } of due) {
    const w = watches.find((x) => x.id === watchId);
    if (!w) continue;
    await chrome.notifications.create(`cpf-${watchId}-${Date.now()}`, {
      type: 'basic', iconUrl: await notifyIcon(),
      title: 'Class Photo Filter', message: notifyText(w, n), priority: 1,
    });
    alog(`notified: ${notifyText(w, n)}`);
```

with:

```js
  const { watches } = await load();
  const lang = await uiLang();
  for (const { watchId, n } of due) {
    const w = watches.find((x) => x.id === watchId);
    if (!w) continue;
    await chrome.notifications.create(`cpf-${watchId}-${Date.now()}`, {
      type: 'basic', iconUrl: await notifyIcon(),
      title: 'Class Photo Filter', message: notifyText(w, n, lang), priority: 1,
    });
    alog(`notified: ${notifyText(w, n, 'en')}`); // the log stays English
```

- [ ] **Step 8: `background.js`: store the language from page events**

In the `evt` listener, replace:

```js
  if (msg.type === 'ready') { catchUp('WhatsApp ready'); pushLabels(); }
```

with:

```js
  if (msg.type === 'ready') {
    saveWaLang(msg.data?.lang).catch(() => {});
    catchUp('WhatsApp ready'); pushLabels();
  }
  else if (msg.type === 'lang') saveWaLang(msg.data?.lang).catch(() => {});
```

- [ ] **Step 9: Check and test**

Run: `npm run check && npm test`
Expected: `ok - manifest 0.13, …` and all tests pass.

- [ ] **Step 10: Commit**

```bash
git add page.js background.js
git commit -m "feat: background follows WhatsApp's language for the tooltip, notifications and album labels"
```

---

### Task 5: `panel.html`: translatable markup, RTL-safe CSS, language card

**Files:**
- Modify: `panel.html`
- Test: `tests/i18n.test.js` (append)

**Interfaces:**
- Consumes: `STRINGS` from Task 2.
- Produces, for Task 6:
  - Attributes: `data-i18n="key"` (sets `textContent`), `data-i18n-ph` (`placeholder`), `data-i18n-title` (`title`), `data-i18n-label` (`label`, used on `<optgroup>`).
  - `<html class="i18n-pending">`, which Task 6 removes.
  - `<select id="langPref">` with the values `auto` | `en` | `he`.

- [ ] **Step 1: Write the failing tests**

Add `import { readFileSync } from 'node:fs';` to the imports at the top of `tests/i18n.test.js`, then append:

```js
// panel.html keeps its English text so the file reads naturally; applyStatic
// overwrites it from the dictionary. Both must agree, or switching back to
// English would change wording, and a typo'd key would show the raw key.
const html = readFileSync(new URL('../panel.html', import.meta.url), 'utf8');
const squash = (x) => x.replace(/\s+/g, ' ').trim();

test('panel.html: every data-i18n* key exists in the dictionary', () => {
  const keys = [...html.matchAll(/data-i18n(?:-ph|-title|-label)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 20, 'expected the panel to be marked up');
  for (const k of keys) assert.ok(k in STRINGS, `unknown key ${k}`);
});

test('panel.html: the English in the HTML is the English in the dictionary', () => {
  for (const [, key, text] of html.matchAll(/<\w+[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
    assert.equal(squash(text), STRINGS[key].en, key);
  }
  for (const [attr, data] of [['placeholder', 'ph'], ['title', 'title'], ['label', 'label']]) {
    for (const [tag] of html.matchAll(new RegExp(`<[^>]*data-i18n-${data}="[^"]+"[^>]*>`, 'g'))) {
      const key = tag.match(new RegExp(`data-i18n-${data}="([^"]+)"`))[1];
      const value = tag.match(new RegExp(`\\s${attr}="([^"]*)"`))?.[1];
      assert.equal(value, STRINGS[key].en, `${key} (${attr})`);
    }
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. `expected the panel to be marked up` (no `data-i18n` yet).

- [ ] **Step 3: Update the `<html>` tag and CSS**

Replace `<html lang="en">` with:

```html
<html lang="en" class="i18n-pending">
```

In `<style>`, replace `.watch { border-left: 3px solid var(--accent); }` with:

```css
  .watch { border-inline-start: 3px solid var(--accent); }
```

In the `.pick` rule, replace `text-align: left;` with `text-align: start;`.

Add at the end of the `<style>` block:

```css
  /* Hidden until panel.js has set the language, so a Hebrew panel never
     flashes English first. If panel.js never runs (a module failed to
     load), the English panel appears after a second instead of a blank one. */
  .i18n-pending body { visibility: hidden; animation: cpf-reveal 0s 1s forwards; }
  @keyframes cpf-reveal { to { visibility: visible; } }
  /* Spacing meant for Latin capitals breaks up Hebrew words. */
  :lang(he) label { letter-spacing: 0; }
```

- [ ] **Step 4: Mark up the body**

Replace everything from `<body>` to `</body>` with the block below. The ids and structure are unchanged except for the new language card, the wrapper `<span>`s on mixed text, and these direction attributes:
- `#log` is `dir="ltr"` because it stays English.
- `#thresh` is `dir="ltr"` so `0.35` reads correctly.
- The text inputs are `dir="auto"` so typed Hebrew or English aligns with itself.
- The models path is `dir="ltr"`.

`#reviewTitle` and the pick buttons have no `data-i18n`, because `panel.js` always writes them.

```html
<body>
<header>
  <h1>Class Photo Filter</h1>
  <nav class="tabs" role="tablist">
    <button id="tabSetup" role="tab" aria-selected="false" aria-controls="paneSetup" data-i18n="tabSetup">Setup</button>
    <button id="tabRun" role="tab" aria-selected="true" aria-controls="paneRun" class="on" data-i18n="tabPhotos">Photos</button>
  </nav>
</header>

<main>
  <section class="pane on" id="paneRun">
    <div id="watchList"></div>
    <div id="reviewCard" class="card" hidden>
      <h2 id="reviewTitle">Matches</h2>
      <p class="hint" id="reviewHint"></p>
      <div class="row" style="margin:8px 0">
        <button class="act" id="sendBtn" data-i18n="addToComposer">Add to composer</button>
        <button class="act ghost" id="doneBtn" data-i18n="markSeen">Mark as seen</button>
      </div>
      <div class="grid" id="grid"></div>
    </div>
    <button class="act ghost" id="stopBtn" hidden data-i18n="stopScan">Stop scan</button>
    <div id="log" dir="ltr">idle</div>
  </section>

  <section class="pane" id="paneSetup">
    <div class="card">
      <h2 data-i18n="language">Language</h2>
      <select id="langPref">
        <option value="auto" data-i18n="langAuto">Automatic (follow WhatsApp)</option>
        <option value="en" lang="en" dir="ltr">English</option>
        <option value="he" lang="he" dir="rtl">עברית</option>
      </select>
    </div>

    <div class="card">
      <h2 data-i18n="models">Models</h2>
      <p class="hint"><span data-i18n="modelsHintBefore">Pick these once from</span>
         <code dir="ltr">.insightface\models\buffalo_l\</code><span data-i18n="modelsHintAfter">. They're stored in the extension and never asked for again.</span></p>
      <div id="modelState" class="muted" style="margin:6px 0"></div>
      <label>det_10g.onnx</label><input type="file" id="detFile" accept=".onnx">
      <label>w600k_r50.onnx</label><input type="file" id="recFile" accept=".onnx">
    </div>

    <div class="card">
      <h2 data-i18n="addGroup">Add a group to watch</h2>
      <label data-i18n="watchThisGroup">Watch this group</label>
      <input type="text" id="srcFilter" dir="auto" placeholder="filter by name..." data-i18n-ph="filterByName" style="margin-bottom:4px">
      <select id="srcGroup" size="6"></select>
      <button type="button" class="pick" id="srcPick">nothing selected</button>
      <label data-i18n="sendMatchesTo">Send matches to</label>
      <input type="text" id="dstFilter" dir="auto" placeholder="filter by name..." data-i18n-ph="filterByName" style="margin-bottom:4px">
      <select id="dstGroup" size="6"></select>
      <button type="button" class="pick" id="dstPick">nothing selected</button>
      <label data-i18n="childName">Child's name</label><input type="text" id="childName" dir="auto" placeholder="e.g. Nir" data-i18n-ph="childNameExample">
      <label data-i18n="refPhotos">Reference photos of that child</label>
      <input type="file" id="refFiles" accept="image/*" multiple>
      <label data-i18n="matchThreshold">Match threshold</label><input type="number" id="thresh" dir="ltr" value="0.35" step="0.01" min="0.05" max="0.9">
      <p class="hint" data-i18n="thresholdHint">Start at 0.35. Lower it if the child is usually far from the camera.</p>
      <label class="check"><input type="checkbox" id="autoWatch" checked>
        <span data-i18n="autoWatchLabel">Auto-watch: check new photos in the background and alert me</span></label>
      <div class="row" style="margin-top:10px">
        <button class="act" id="addWatch" disabled data-i18n="saveWatch">Save watch</button>
        <button class="act ghost" id="refreshGroups" data-i18n="reloadGroups">Reload groups</button>
      </div>
    </div>

    <div class="card">
      <h2 data-i18n="savedWatches">Saved watches</h2>
      <div id="setupList"></div>
    </div>
  </section>
</main>

<script type="module" src="panel.js"></script>
</body>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. If the English-matches test fails on a key, fix the HTML text or the dictionary's `en` so they are identical. Whitespace runs count as one space.

- [ ] **Step 6: Commit**

```bash
git add panel.html tests/i18n.test.js
git commit -m "feat: panel.html marked up for translation, RTL-safe CSS, language card"
```

---

### Task 6: `panel.js`: language state, start-up, live switching

After this task the panel switches its static text and direction. Task 7 moves the dynamic text over.

**Files:**
- Modify: `panel.js` (imports at line 1, `idbPut` at lines 65-72, `onChanged` at lines 562-571, start-up IIFE at lines 590-602, plus new functions)

**Interfaces:**
- Consumes: `t`, `resolveLang`, `dirOf` from `lib/i18n.js`; the `panel.html` attributes from Task 5.
- Produces, for Task 7: module-level `lang`, `tt(key, vars)`, and `nm(name)` (escaped and `<bdi>`-wrapped, for `innerHTML`), plus `relang()`, which re-renders everything after a language change.

- [ ] **Step 1: Imports and helpers**

Replace line 1:

```js
import { isAuto } from './lib/auto-state.js';
```

with:

```js
import { isAuto } from './lib/auto-state.js';
import { t, resolveLang, dirOf, isSelfDst } from './lib/i18n.js';

/* ---------- language ---------- */

// Resolved from waLang (background) and uiLangPref (this panel) - never
// stored, so the panel and the background can't disagree. User-facing text
// goes through tt(); log() text stays English.
let lang = 'en';
const tt = (key, vars) => t(lang, key, vars);
```

In `idbPut` (lines 65-72), rename the local `t` to `tx` so it does not shadow the import:

```js
const idbPut = async (k, v) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('m', 'readwrite');
    tx.objectStore('m').put(v, k);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
};
```

Directly after the `esc` definition (around line 120), add:

```js
// Names go into innerHTML through this: escaped, and in <bdi> so a Hebrew
// name inside English text (or the reverse) keeps its own direction.
const nm = (s) => `<bdi>${esc(s)}</bdi>`;
// The self chat is shown by kind, in the UI language, not by a saved name.
const chatLabel = (c) => (c.kind === 'self' ? tt('messageYourself') : c.name);
const dstLabel = (w) => (isSelfDst(w) ? tt('messageYourself') : w.dstName);
```

- [ ] **Step 2: Applying a language**

Add after the `/* ---------- tabs ---------- */` section's `showTab` listeners (just before the start-up IIFE):

```js
/* ---------- applying the language ---------- */

async function resolveUiLang() {
  const { waLang, uiLangPref } = await chrome.storage.local.get(['waLang', 'uiLangPref']);
  $('langPref').value = uiLangPref || 'auto';
  return resolveLang({ pref: uiLangPref, wa: waLang, browser: chrome.i18n.getUILanguage() });
}

// Everything marked up in panel.html, plus elements rendered later with the
// same attributes (the self chat option, the destination list's headings).
function applyStatic() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = tt(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = tt(el.dataset.i18nPh);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = tt(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.label = tt(el.dataset.i18nLabel);
}

// Synchronous part: direction, static text, and the parts of Setup drawn
// from variables (pick buttons, Save's "Still needed" tooltip).
function applyLang(next) {
  lang = next;
  document.documentElement.lang = lang;
  document.documentElement.dir = dirOf(lang);
  applyStatic();
  showPick('src'); showPick('dst');
}

// A live switch: redraw everything with text in it. The open review keeps
// its thumbnails (they're in current.rows), so nothing is downloaded again.
async function relang() {
  const next = await resolveUiLang();
  if (next === lang) return;
  applyLang(next);
  await showModelState();
  await renderSetup();
  await renderWatches();
  if (current && !$('reviewCard').hidden) renderReview();
}

// The panel writes uiLangPref (one writer); onChanged below applies it.
$('langPref').addEventListener('change', () => {
  chrome.storage.local.set({ uiLangPref: $('langPref').value });
});
```

`showPick` already calls `updateSaveState`, so the Save tooltip is redrawn too.

In the `chrome.storage.onChanged` listener, add as the last statement inside it:

```js
  if (area === 'local' && (changes.waLang || changes.uiLangPref)) {
    relang().catch((e) => log('language: ' + e.message));
  }
```

- [ ] **Step 3: Start-up**

In the start-up IIFE, insert before `await showModelState();`:

```js
  // Before anything is drawn: the body stays hidden (i18n-pending) until the
  // language is set. finally, so a failed read shows the English panel
  // rather than a blank one.
  try { applyLang(await resolveUiLang()); }
  catch (e) { log('language: ' + e.message); }
  finally { document.documentElement.classList.remove('i18n-pending'); }
```

- [ ] **Step 4: Check and test**

Run: `npm run check && npm test`
Expected: `ok - manifest 0.13, …` and all tests pass.

- [ ] **Step 5: Quick look in Chrome**

Reload the extension (Alt+Shift+R), refresh WhatsApp Web, and open the panel. In Setup → Language, choose **עברית**. Expected: the tabs, buttons, labels and placeholders switch to Hebrew and the layout mirrors (tabs from the right, the green watch border on the right). The log stays English and left to right. Watch cards are still English until Task 7. Choose **Automatic** again.

- [ ] **Step 6: Commit**

```bash
git add panel.js
git commit -m "feat: panel resolves its language, applies it at start-up and switches live"
```

---

### Task 7: `panel.js`: dynamic text, names, dates and the self chat

**Files:**
- Modify: `panel.js`: `showModelState`, `loadGroups`, `showPick`, `updateSaveState`, the `addWatch` handler, `renderSetup`, `renderWatches`, `review`, `renderReview`.

**Interfaces:**
- Consumes: `lang`, `tt`, `nm`, `chatLabel`, `dstLabel` from Task 6; `STRINGS` keys from Task 2.
- Produces: new watches carry `dstKind: 'self' | 'group' | 'person'`. A review row that could not be loaded has `gone: 'expired'` or the raw error message.

Rule for every edit below: `tt()` output goes into `innerHTML` as is (dictionary text is plain), names go in only through `nm()`, and `title="…"` attributes use `esc(tt(…))`. Leave every `log(…)` string as it is.

- [ ] **Step 1: Setup text**

`showModelState`:

```js
  $('modelState').textContent = have ? tt('modelsStored') : tt('modelsNotSet');
```

`loadGroups`: replace the two `innerHTML` assignments (the `srcGroup` map and the `opt` / `dstGroup` block) with:

```js
  const opt = (x) => `<option value="${x.id}">${esc(x.name)}</option>`;
  $('srcGroup').innerHTML = g.map(opt).join('');
  // The self chat and the headings carry data-i18n*, so applyStatic
  // translates them on a switch without rebuilding the lists (which would
  // lose the filters and scroll position).
  $('dstGroup').innerHTML =
    (self ? `<option value="${self.id}" data-i18n="messageYourself">${esc(tt('messageYourself'))}</option>` : '') +
    `<optgroup label="${esc(tt('groups'))}" data-i18n-label="groups">${g.map(opt).join('')}</optgroup>` +
    `<optgroup label="${esc(tt('directChats'))}" data-i18n-label="directChats">${people.map(opt).join('')}</optgroup>`;
```

`showPick`:

```js
  el.innerHTML = chat
    ? `<span>${nm(chatLabel(chat))}</span>` + (open[which] ? '' : `<span class="chg">${tt('change')}</span>`)
    : tt('nothingSelected');
```

`updateSaveState`:

```js
  const missing = [
    !picked.src && tt('needSrc'),
    !picked.dst && tt('needDst'),
    !$('childName').value.trim() && tt('needName'),
    !$('refFiles').files.length && tt('needRefs'),
  ].filter(Boolean);
  $('addWatch').disabled = saving || missing.length > 0;
  $('addWatch').title = missing.length ? tt('stillNeeded', { items: missing.join(', ') }) : '';
```

- [ ] **Step 2: Save `dstKind` with new watches**

In the `addWatch` handler's `watches.push({ … })`, replace:

```js
      dst: picked.dst.id, dstName: picked.dst.name,
```

with:

```js
      // dstKind lets the self chat show in the UI language (isSelfDst).
      dst: picked.dst.id, dstName: picked.dst.name, dstKind: picked.dst.kind,
```

- [ ] **Step 3: `renderSetup`**

Replace the `$('setupList').innerHTML = …;` statement with:

```js
  $('setupList').innerHTML = watches.length
    ? watches.map((w) => `<div class="row" style="justify-content:space-between;padding:6px 0;
        border-bottom:1px solid var(--line)">
        <span><b>${nm(w.name)}</b> <span class="muted">${tt('arrowFrom')} ${nm(w.srcName)}</span></span>
        <span class="row" style="gap:6px">
          <label class="check inline" title="${esc(tt('autoTitle'))}">
            <input type="checkbox" data-auto="${w.id}" ${isAuto(w) ? 'checked' : ''}>${tt('autoShort')}</label>
          <button class="act ghost" data-reset="${w.id}" style="padding:3px 9px;font-size:11px"
            title="${esc(tt('resetTitle', { days: FIRST_SCAN_DAYS }))}"
            ${w.lastSeen || pending[w.id]?.length ? '' : 'disabled'}>${tt('reset')}</button>
          <button class="act ghost" data-del="${w.id}" style="padding:3px 9px;font-size:11px">${tt('remove')}</button>
        </span>
      </div>`).join('')
    : `<p class="hint">${tt('nothingYet')}</p>`;
```

- [ ] **Step 4: `renderWatches`**

Replace from `if (!watches.length) {` through the `box.innerHTML = …join('');` statement with:

```js
  if (!watches.length) {
    box.innerHTML = `<div class="card"><p class="hint">${tt('noWatches')}</p></div>`;
    return;
  }
  const when = (sec) => new Date(sec * 1000).toLocaleString(lang);
  const route = (w) => `${nm(w.srcName)} ${tt('arrowTo')} ${nm(dstLabel(w))}`;
  const threshold = (w) => tt('thresholdIs', { v: w.threshold });
  box.innerHTML = watches.map((w) => {
    const n = pending[w.id]?.length || 0;
    return isAuto(w) ? `
    <div class="card watch" data-w="${w.id}">
      <div class="row" style="justify-content:space-between">
        <span class="title">${nm(w.name)}</span>
        <span class="pill ${n ? '' : 'none'}">${n ? tt('nWaiting', { n }) : tt('watching')}</span>
      </div>
      <p class="hint" style="margin:6px 0">${[route(w), threshold(w), tt('autoOn'),
        tt('checkedUpTo', { when: autoState[w.id] ? when(autoState[w.id].lastChecked) : tt('notYet') }),
      ].join(' &middot; ')}</p>
      <button class="act" data-review="${w.id}" ${n ? '' : 'disabled'}>${n
        ? tt('reviewN', { n, name: nm(w.name) }) : tt('noMatchesWaiting')}</button>
    </div>` : `
    <div class="card watch" data-w="${w.id}">
      <div class="row" style="justify-content:space-between">
        <span class="title">${nm(w.name)}</span>
        <span class="pill none" data-count="${w.id}">${tt('checking')}</span>
      </div>
      <p class="hint" style="margin:6px 0">${[route(w), threshold(w),
        w.lastSeen ? tt('lastSeen', { when: when(w.lastSeen) }) : tt('lastSeenNever', { days: FIRST_SCAN_DAYS }),
      ].join(' &middot; ')}</p>
      <button class="act" data-scan="${w.id}" disabled>${tt('checkForNew')}</button>
    </div>`;
  }).join('');
```

In the manual-watch loop below it, replace the `if (fresh.length) { … } else { … }` text lines:

```js
      if (fresh.length) {
        pill.textContent = tt('nNew', { n: fresh.length });
        pill.className = 'pill';
        btn.disabled = false;
        btn.innerHTML = tt('findIn', { name: nm(w.name), n: fresh.length });
        btn.addEventListener('click', () => scan(w).catch((e) => log('ERROR: ' + e.message)));
      } else {
        pill.textContent = tt('upToDate');
        btn.textContent = tt('nothingNew');
      }
```

- [ ] **Step 5: `review` and `renderReview`**

In `review`, replace the `catch` block's `rows.push`:

```js
      rows.push({ id: p.id, score: p.score, px: p.px, thumb: null,
        // 'expired' is translated when drawn, so a language switch reaches it.
        gone: /media not found/i.test(e.message) ? 'expired' : e.message });
```

In `renderReview`, replace the `reviewTitle` and `reviewHint` assignments (including the comment between them) with:

```js
  $('reviewTitle').innerHTML = tt('reviewTitle', { n: rows.length, name: nm(watch.name), album: !!current.album });
  $('reviewHint').innerHTML = [
    rows.length ? tt('reviewHint', { dst: nm(dstLabel(watch)) }) : tt('reviewNone'),
    // lastSeen is a single timestamp, so marking a stopped scan as seen also
    // skips the older photos it never reached. Say so before they click.
    skipped ? tt('reviewStopped', { n: skipped }) : '',
  ].filter(Boolean).join(' ');
```

In the grid template, replace `<div class="ph">${esc(r.gone)}</div>` with:

```js
    <div class="thumb gone"><div class="ph">${r.gone === 'expired' ? tt('noLongerAvailable') : esc(r.gone)}</div>
```

Replace the `doneBtn.title` line with:

```js
  $('doneBtn').title = current.reviewed ? tt('alreadyReviewed') : '';
```

- [ ] **Step 6: Nothing user-facing is left untranslated**

Run (Git Bash): `grep -nE "'[A-Z][a-z]+ [a-z]|\`[A-Z][a-z]+ " panel.js | grep -v "log(" | grep -v "Error("`
Expected: no lines that set user-visible text. Lines inside `log(…)`, `throw new Error(…)` and comments are fine. Fix any other hit by routing it through `tt()` with a new key in both languages (in `lib/i18n.js`), then rerun `npm test`.

- [ ] **Step 7: Check and test**

Run: `npm run check && npm test`
Expected: `ok - manifest 0.13, …` and all tests pass.

- [ ] **Step 8: Commit**

```bash
git add panel.js lib/i18n.js
git commit -m "feat: panel's dynamic text, names, dates and self chat follow the UI language"
```

---

### Task 8: Docs, then verification by hand

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the docs and a filled-in verification checklist.

- [ ] **Step 1: AGENTS.md**

Make these edits:

1. In the architecture block, add a line under `background.js`'s "owns:" list: `waLang, badge tooltip/notification language`. Add a new entry after `page.js`:

```
lib/i18n.js              pure: English + Hebrew dictionaries, resolveLang, t()
                         imported by panel.js, background.js, lib/auto-state.js
```

2. In the message-tags paragraph, change the event list to: `` (`ready` with `{ lang }`, `lang`, `newImage`, `openAlbum`, `labelsBroken`) ``.

3. In *Auto-watch state*, after the first paragraph, add:

```markdown
Language: `waLang` (the raw tag WhatsApp reported, or `null`) → background;
`uiLangPref` (`'auto'` | `'en'` | `'he'`) → panel. The resolved language is
never stored; the panel and the background each compute
`resolveLang({ pref, wa, browser: chrome.i18n.getUILanguage() })`, so they
can't disagree.
```

4. Add a new section before *Verifying a change*:

```markdown
## Language

The UI follows WhatsApp Web's language (English or Hebrew; Hebrew is right
to left), with an override in Setup. `chrome.i18n` is not used for UI text:
it answers only in the browser's language, fixed at browser start. It is
used only for the manifest (`_locales/`), which `npm run check` verifies.

- User-facing text goes through `t()` from `lib/i18n.js` (`tt()` in the
  panel). Log text and error messages do not; the log stays English.
- Every key needs `en` and `he`; anything that depends on a number is a
  function, because Hebrew number agreement isn't "add an s". The tests
  enforce both, and that `panel.html`'s English matches the dictionary.
- Hebrew copy is gender-neutral: nouns or infinitives for buttons, "אפשר…"
  for instructions, "הילד/ה" for the child. The owner reviews it.
- Names go into `innerHTML` only through `nm()` (escaped, in `<bdi>`), so a
  Hebrew name in English text keeps its direction. Dictionary entries are
  plain text.
- Layout uses logical properties (`border-inline-start`, `text-align:
  start`) so it mirrors with `dir="rtl"`. Arrows between names come from the
  dictionary, because Unicode doesn't mirror them.
- The self chat is shown by kind (`dstKind`, or `isSelfDst` for watches saved
  before 0.13), never by its saved English name.
```

(The rule "never locate WhatsApp elements by visible text or accessibility labels" is already in AGENTS.md; leave it.)

- [ ] **Step 2: README.md**

Under *What it does*, after item 6, add:

```markdown
7. Speaks English or Hebrew (right to left), following WhatsApp Web's
   language. Setup → Language overrides it.
```

In *Layout*, add `lib/i18n.js        English and Hebrew UI text, language choice (pure, unit-tested)` and `_locales/           manifest name and description per browser language`.

- [ ] **Step 3: Commit the docs**

```bash
git add AGENTS.md README.md
git commit -m "docs: language rules in AGENTS.md and README"
```

- [ ] **Step 4: Verify by hand**

Reload the extension, refresh WhatsApp Web, and check `chrome://extensions` shows **0.13**. Have the panel log open while testing. Then:

1. WhatsApp in Hebrew, Setup → Language on *Automatic*. Close and reopen the panel: it opens in Hebrew, right to left, with no flash of English. The log is English and left to right.
2. With a review open (Photos → Review), switch WhatsApp to English (Settings → Language). The open panel switches to English, and the review stays open with the same thumbnails (the log shows no new `loading … match(es)`).
3. Setup → Language → *English* while WhatsApp is in Hebrew: English. Refresh WhatsApp: still English. Back to *Automatic*: Hebrew.
4. With WhatsApp in Hebrew, get a match (or *Reset* an auto watch with known matches): the notification text is Hebrew, its title is "Class Photo Filter", and hovering the toolbar icon shows the Hebrew tooltip.
5. A watch saved before 0.13 with "Message yourself" as the destination shows "הודעה לעצמי" in its card and in the review hint.
6. Mixed names: a Hebrew group with an English child name, and the reverse. The watch card, Setup list, review title and notification read correctly, and the arrows point from source to destination.
7. Shrink the side panel to its narrowest. Check every Setup card, a watch card in each state (waiting, watching, manual, never seen), the review card with a "כבר לא זמינה" tile if available, and the pick buttons folded and open. Nothing overflows or overlaps.
8. In-chat album labels, with WhatsApp in Hebrew: "בבדיקה" while scanning, counts afterwards, and chips sit on the correct side of your own and others' messages.
9. Temporarily rename `lib/i18n.js`, then reopen the panel: the English panel appears after about a second (not blank), and the panel console shows the import error. Rename the file back.

Record the result of each item in the PR description. Any failure goes back to the owning task.
