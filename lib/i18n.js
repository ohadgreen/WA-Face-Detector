/* UI text in English and Hebrew, and which language to show. Pure: no
   chrome.* and no DOM, so it is unit-tested in Node (tests/i18n.test.js)
   and shared by panel.js, background.js and lib/auto-state.js.

   Not chrome.i18n for the text itself: it can't hold plurals as functions
   (Hebrew number agreement). The language is still the browser's, read once
   from chrome.i18n.getUILanguage(); chrome.i18n also fills the manifest
   (_locales/).

   Entries are plain text (no < or &): panel.js puts them into innerHTML,
   with names passed in already escaped and wrapped in <bdi>. Hebrew copy is
   gender-neutral - nouns and infinitives, never imperatives, and "הילד/ה".
   Anything that depends on a number is a function, because Hebrew number
   agreement is not "add an s". The log and error messages stay English and
   never come through here. */

export const SUPPORTED = ['en', 'he'];

/** Raw tag (the browser's) → a supported language or null.
    'iw' is the legacy code for Hebrew that some systems still report. */
export function normalize(tag) {
  if (typeof tag !== 'string') return null;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  if (base === 'he' || base === 'iw') return 'he';
  if (base === 'en') return 'en';
  return null;
}

/** The browser's UI language if supported, else English. There is no
    in-panel override and WhatsApp's own language is not consulted. */
export function resolveLang({ browser } = {}) {
  return normalize(browser) || 'en';
}

export const dirOf = (lang) => (lang === 'he' ? 'rtl' : 'ltr');

// Not translated until the owner picks a Hebrew name (spec, Decision 3).
const APP = 'Spot My Kid';

const s = (n, one, many) => (n === 1 ? one : many);

export const STRINGS = {
  // ---- panel.html (data-i18n*) - the English must match the HTML exactly
  addToComposer: { en: 'Add to composer', he: 'הוספה לתיבת ההודעה' },
  markSeen: { en: 'Mark as seen', he: 'סימון כנצפה' },
  stopScan: { en: 'Stop scan', he: 'עצירת הסריקה' },
  addWatch: { en: '+ Add watch', he: '+ הוספת מעקב' },
  showLog: { en: 'Show log', he: 'הצגת היומן' },
  hideLog: { en: 'Hide log', he: 'הסתרת היומן' },
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
  nothingSelected: { en: 'nothing selected', he: 'לא נבחר דבר' },
  change: { en: 'change', he: 'שינוי' },
  stillNeeded: { en: 'Still needed: {items}', he: 'חסר עדיין: {items}' },
  needSrc: { en: 'group to watch', he: 'קבוצה למעקב' },
  needDst: { en: 'where to send matches', he: 'לאן לשלוח את ההתאמות' },
  needName: { en: "child's name", he: 'שם הילד/ה' },
  needRefs: { en: 'reference photos', he: 'תמונות ייחוס' },
  nothingYet: {
    en: 'No watches yet. Tap + to add one.',
    he: 'עדיין אין מעקבים. אפשר להוסיף מעקב בלחיצה על +.',
  },
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
    en: `${APP} - models missing, run npm run models`,
    he: `${APP} - המודלים חסרים, יש להריץ npm run models`,
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
    so in dstKind. Watches saved before 0.14 only have the English name
    page.js gave it ("Message yourself (test)" at the time), which is why
    nothing needs migrating. */
export const isSelfDst = (w) =>
  w.dstKind === 'self' || /^Message yourself/.test(w.dstName || '');
