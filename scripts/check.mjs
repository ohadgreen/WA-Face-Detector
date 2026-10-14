// Static checks that stand in for a build: every source file parses, and
// everything manifest.json points at exists. Run: npm run check
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
let bad = 0;

const referenced = [
  m.background.service_worker, m.side_panel.default_path,
  ...m.content_scripts.flatMap((c) => c.js), 'engine.html',
];
for (const f of referenced) {
  if (!existsSync(join(root, f))) { console.log('MISSING', f); bad++; }
}

const sources = ['background.js', 'engine.js', 'page.js', 'panel.js', 'relay.js',
  'lib/face.js', 'lib/auto-state.js', 'lib/album-label.js', 'lib/i18n.js'];
for (const f of sources) {
  if (!existsSync(join(root, f))) continue;
  try { execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' }); }
  catch (e) { console.log('SYNTAX', f, '\n' + e.stderr); bad++; }
}

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

console.log(bad ? `${bad} problem(s)`
  : `ok - manifest ${m.version}, permissions: ${m.permissions.join(', ')}`);
process.exit(bad ? 1 : 0);
