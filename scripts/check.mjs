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
  'lib/face.js', 'lib/auto-state.js', 'lib/album-label.js'];
for (const f of sources) {
  if (!existsSync(join(root, f))) continue;
  try { execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' }); }
  catch (e) { console.log('SYNTAX', f, '\n' + e.stderr); bad++; }
}

console.log(bad ? `${bad} problem(s)`
  : `ok - manifest ${m.version}, permissions: ${m.permissions.join(', ')}`);
process.exit(bad ? 1 : 0);
