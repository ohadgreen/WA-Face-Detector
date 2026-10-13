# Hebrew and right-to-left UI

Date: 2026-10-01 · Status: draft, awaiting owner review · Target version: next minor (0.11 at time of writing)

## Goal

A parent whose WhatsApp Web is in Hebrew gets the extension in Hebrew, laid out
right to left, without configuring anything. English stays the default for
everyone else.

**Success looks like:** with WhatsApp Web set to Hebrew, the side panel, the
toolbar tooltip and the notifications are in Hebrew and read right to left;
switching WhatsApp back to English switches the extension back. A manual
choice in Setup overrides the detection.

## Constraints

- All AGENTS.md hard rules still hold. Language detection reads one value from
  the WhatsApp page; it does not act through WhatsApp (rule 1).
- No build step, no new dependencies. `chrome.i18n` is not used for the UI (see
  *Why not chrome.i18n*); it is used only for the manifest.
- One writer per `chrome.storage` key, as today.
- `page.js` stays the only file that touches WhatsApp internals.

## Decisions made without the owner (please confirm)

These were not stated in the request. Each is a default, and easy to change.

1. **Languages: English and Hebrew only.** Anything else falls back to English.
   The RTL work is generic, so Arabic later would mostly be a new dictionary.
2. **The log stays English and left to right.** It is diagnostic output, and
   the owner reads it when supporting other parents. This includes error
   messages, which only ever appear in the log.
3. **The extension keeps its English name, "Class Photo Filter", in both
   languages** until the owner picks a Hebrew name. The manifest is set up so a
   Hebrew name is a one-line change.
4. **Hebrew copy is gender-neutral.** Buttons use nouns or infinitives
   ("שמירה", "בדיקת תמונות חדשות") rather than imperatives, which in Hebrew must
   be masculine or feminine. This is the common convention in Hebrew software.
5. **The owner reviews the Hebrew text** before release. The implementer drafts
   it; machine-quality Hebrew is not the bar.

## Out of scope

- Languages other than English and Hebrew.
- Translating the log, README, AGENTS.md, or error messages.
- The browser's own text inside native controls: the file pickers' "Choose
  files" / "No file chosen" follow Chrome's UI language and cannot be changed
  from the page.
- Changing how WhatsApp itself is driven. The composer lookup in `pasteToChat`
  already uses `contenteditable` and `data-tab`, not visible text, so it is
  unaffected.

## Why not chrome.i18n

`chrome.i18n.getMessage` always answers in the browser's UI language, fixed at
browser start. A parent with an English Chrome and a Hebrew WhatsApp would get
English. The extension needs to follow WhatsApp and switch while running, so the
UI uses its own dictionary. `chrome.i18n` still translates the manifest (name,
description, command description), which is what the Extensions page and a
store listing show, and those can only follow the browser.

## Architecture

```
page.js (MAIN)            reads WhatsApp's language once ready
   │  evt 'ready' { lang }
relay.js                  unchanged (forwards data already)
   ▼
background.js             writes `waLang`; badge tooltip + notifications via t()
   ·  chrome.storage.local  waLang (background) · uiLangPref (panel)
panel.js                  resolves the language, sets <html lang dir>,
                          fills static labels, renders dynamic text via t(),
                          re-renders when either key changes
lib/i18n.js (NEW, pure)   dictionaries, resolveLang, t, plural helper
```

### Units

**`lib/i18n.js` (new).** Pure module, no `chrome.*` and no DOM, imported by
`panel.js` and `background.js` (both ES modules). Exports:

- `SUPPORTED = ['en', 'he']`
- `normalize(tag)` → `'en' | 'he' | null`. `'he'`, `'he-IL'` and the legacy
  `'iw'` map to `'he'`; any `en-*` maps to `'en'`; anything else is `null`.
- `resolveLang({ pref, wa, browser })` → `'en' | 'he'`. The first of these that
  applies wins: `pref` (unless it is `'auto'` or missing), then `normalize(wa)`,
  then `normalize(browser)`, then `'en'`.
- `dirOf(lang)` → `'rtl' | 'ltr'`.
- `t(lang, key, vars)` → string. Looks up `key` in that language, falling back
  to English, then to the key itself, so a missing string is visible but never
  throws. An entry is either a string with `{name}` placeholders or a function
  `(vars) => string`. Use a function for any text that depends on a number,
  because Hebrew number agreement is not just "add an s" (see below).

Example entries:

```js
notify: {
  en: ({ n, name, group }) => `${n} new photo${n === 1 ? '' : 's'} of ${name} in ${group}`,
  he: ({ n, name, group }) => n === 1
    ? `תמונה חדשה אחת של ${name} ב${group}`
    : `${n} תמונות חדשות של ${name} ב${group}`,
},
```

`notifyText` in `lib/auto-state.js` becomes `notifyText(w, n, lang)` and
delegates to `t(lang, 'notify', …)`; its existing English tests keep passing
with `lang = 'en'`.

**`page.js`.** A new helper `waLanguage()`, called when `ready` resolves, and
its result sent with the existing event: `emit('ready', { lang })`. It reads, in
order:

1. `document.documentElement.lang`, if WhatsApp sets it.
2. WhatsApp's stored language preference in the page's `localStorage`. The
   exact key is found while checking Risk 1 and written into the code with a
   comment.
3. Otherwise it returns `null`, and the panel falls back to the browser
   language.

It returns the raw tag. Normalising it is `lib/i18n.js`'s job.

**`relay.js`.** No change. It already forwards `data` with every event.

**`background.js`.**
- On `ready`, write `waLang` if the value changed, then run catch-up as today.
- `updateBadge` and `announce` read `waLang` and `uiLangPref`, then call
  `resolveLang` with `browser: chrome.i18n.getUILanguage()`, so the tooltip and
  notification text are translated. The notification title stays the extension
  name (Decision 3).
- `alog` lines stay English (Decision 2).

**`panel.js` / `panel.html`.**
- **Static text:** every fixed label, button, hint, placeholder and tooltip in
  `panel.html` gets `data-i18n="key"` (text), `data-i18n-ph="key"`
  (placeholder) or `data-i18n-title="key"` (tooltip). `applyStatic(lang)`
  fills them in. The English in the HTML stays as written, so the file still
  reads naturally.
- **Dynamic text:** every user-facing string in `renderWatches`,
  `renderReview`, `renderSetup`, `showPick`, `updateSaveState` (the "Still
  needed: …" tooltip) and the empty states goes through `t(lang, …)`. Strings
  passed to `log()` do not.
- **Start-up:** read `waLang` and `uiLangPref`, resolve, set
  `document.documentElement.lang` and `.dir`, call `applyStatic`, then render as
  today. To avoid a flash of English before the switch, `panel.html` starts with
  `<html class="i18n-pending">` and CSS hides the body until the class is
  removed. It is removed in a `finally`, so a failed storage read shows the
  English panel rather than a blank one.
- **Live switching:** `storage.onChanged` for `waLang` or `uiLangPref`
  re-resolves. If the language changed, it sets `lang`/`dir`, calls
  `applyStatic`, and re-renders the watch list, the setup list, and the open
  review if there is one. The review keeps its thumbnails (they are in
  `current.rows`), so nothing is downloaded again.
- **Dates:** `toLocaleString(lang)` instead of `toLocaleString()`.
- **Language card (Setup):** a small "Language" card at the top of Setup with
  a select: *Automatic (follow WhatsApp)* / *English* / *עברית*. Each language
  name is written in its own language. The panel writes `uiLangPref`.

### The "Message yourself" chat

Today `page.js` names the self chat `'Message yourself (test)'`. That string is
saved into a watch's `dstName`, so a watch saved in English would keep showing
English after a switch.

- `page.js` keeps returning `kind: 'self'`. Its `name` becomes plain
  `'Message yourself'` (no "(test)", matching the 0.10 change that made it the
  default).
- The panel shows the self chat as `t(lang, 'messageYourself')` wherever it
  appears: the destination list, the folded pick button, and watch cards.
- New watches store `dstKind: 'self' | 'group' | 'person'` from the picked
  chat.
- `isSelfDst(w)` is `w.dstKind === 'self' || /^Message yourself/.test(w.dstName)`.
  The second test covers watches saved before this change, so nothing needs
  migrating.

### Data and state

| Key (`chrome.storage.local`) | Writer | Contents |
|---|---|---|
| `waLang` (new) | background | raw language tag WhatsApp reported at its last `ready`, or `null` |
| `uiLangPref` (new) | panel | `'auto'` (default when missing) \| `'en'` \| `'he'` |
| `watches` (existing) | panel | plus optional `dstKind` on new watches |

The resolved language is never stored. Each context computes it from these two
keys with the same `resolveLang`, so the panel and the background cannot
disagree.

## Right-to-left layout

The panel sets `dir="rtl"` on `<html>` for Hebrew. Most of the layout is flexbox
and grid, which mirror on their own. Explicit fixes:

| Where | Today | Change |
|---|---|---|
| `.watch` | `border-left` | `border-inline-start` |
| `.pick` | `text-align: left` | `text-align: start` |
| watch hint, setup list | `&rarr;` / `&larr;` between names | direction-aware arrow from the dictionary (`arrowTo`, `arrowFrom`), so it points the right way in each language |
| `#log` | inherits direction | `dir="ltr"`, so the English log reads correctly |
| group, child and chat names in templates | bare `${esc(name)}` | wrapped in `<bdi>`, so a Hebrew name inside English text (or the reverse) keeps its own direction. This also fixes mixed-direction text today. |
| threshold `input[type=number]` | — | `dir="ltr"`, so the decimal reads as `0.35` |

Scores and pixel sizes in the review grid are numbers. They read correctly in an
RTL run and need no change.

## Error handling

| Situation | Behaviour |
|---|---|
| WhatsApp exposes no language | `waLang` is `null`; browser language, then English. The Setup override still works. |
| Unknown tag (e.g. `fr`) | Not supported, so it falls through to the browser language, then English. |
| A key is missing in Hebrew | English text is shown; the completeness test (below) stops this reaching a release. |
| Panel open before WhatsApp is ready | Uses the stored `waLang` from last time; switches live when `ready` arrives. |
| Background asleep when the language changes | The next `ready` (a WhatsApp reload) writes `waLang`. |

## Risks to settle first

1. **How WhatsApp exposes its language.** Unverified. First implementation
   step: on a WhatsApp account set to Hebrew, check in the page console whether
   `document.documentElement.lang` / `dir` are set, and which `localStorage`
   key holds the preference. If neither exists, ship with browser-language
   fallback plus the manual override. The rest of the design is unchanged.
2. **Does changing WhatsApp's language reload the page?** Expected yes, which
   re-fires `ready`. If not, `page.js` adds a `MutationObserver` on `<html lang>`
   and emits a `lang` event, which the background handles like the language
   part of `ready`.
3. **Hebrew text length.** Some labels may wrap differently at side-panel
   width. Checked by eye at the narrowest panel width.

## Manifest

- `"default_locale": "en"`.
- `"name"`, `"description"` and the reload command's `"description"` become
  `__MSG_appName__`, `__MSG_appDesc__` and `__MSG_reloadDesc__`.
- `_locales/en/messages.json` and `_locales/he/messages.json`. `appName` is
  "Class Photo Filter" in both until the owner picks a Hebrew name (Decision 3).
- Version: next minor step.

`scripts/check.mjs` additionally confirms that both `messages.json` files parse
and define every `__MSG_*__` the manifest uses.

## Verification

Unit tests in `tests/i18n.test.js`, using Node's built-in runner like the
existing tests:

1. `normalize` and `resolveLang` cover every row of the error-handling table,
   including `iw` and `he-IL`.
2. **Completeness:** every key has an entry for both `en` and `he`, and every
   function entry returns a non-empty string for `n = 0, 1, 2, 11`.
3. `notify` gives the singular and plural forms in both languages.
4. `tests/auto-state.test.js` `notifyText` passes with `lang = 'en'`.

`npm run check` passes, including the new manifest locale check.

By hand:

1. WhatsApp in Hebrew, nothing set in Setup: the panel opens in Hebrew,
   right to left, without a flash of English.
2. Switch WhatsApp to English: the open panel switches without losing an open
   review.
3. Setup override set to English while WhatsApp is in Hebrew: English, and it
   survives a WhatsApp reload.
4. A notification and the toolbar tooltip with WhatsApp in Hebrew.
5. A watch saved before this change with "Message yourself" as the destination
   shows the Hebrew name.
6. Mixed names: a Hebrew group name with an English child name, and the
   reverse, in watch cards, the review title and notifications.
7. Every Setup and Photos state at the narrowest side-panel width.

## Documentation

AGENTS.md:
- New rule: user-facing text goes through `t()`; log text does not.
- New rule: never find WhatsApp elements by their visible text or accessibility
  labels, because those change with WhatsApp's language.
- Add `waLang` and `uiLangPref` to the storage-ownership section.

README: one line saying the extension follows WhatsApp's language (English or
Hebrew), with an override in Setup.

## Findings (Task 1 of the plan, 2026-10-13)

- `<html lang>` / `dir`: English → `"en"` / `"ltr"`, Hebrew → `"he"` / `"rtl"`.
  WhatsApp sets them from its own language setting, so this is the source.
- `localStorage`: no key holds WhatsApp Web's language. `WALangPhonePref` is
  the *phone's* language (`"en-GB"` with WhatsApp Web in Hebrew) and must not
  be used; `WALangPrefDidMismatchWithCookie` is a flag, not a language. The
  `localStorage` fallback is dropped: `waLanguage()` reads `<html lang>` only.
- Changing the language: whether it reloads the page was not recorded. It
  doesn't matter: `page.js` watches `<html lang>` and emits a `lang` event on
  a change, and a reload re-fires `ready`.
