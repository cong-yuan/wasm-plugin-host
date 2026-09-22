// Static guards over the openhanako-built stylesheet + host adapter.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css =
  readFileSync(join(ROOT, 'js', 'style.css'), 'utf8') +
  '\n' +
  readFileSync(join(ROOT, 'scripts', 'host-adapter.css'), 'utf8');

const fails = [];
const check = (label, cond, detail) => {
  if (!cond) fails.push(detail ? `${label}  (${detail})` : label);
};

check('style.css is non-trivial', css.length > 50_000, `len=${css.length}`);
check('host adapter scopes .hana-replica', /\.hana-replica\b/.test(css));
check('upstream .app-shell present', /\.app-shell\b/.test(css));
check('titlebar chrome present', /\.titlebar\b/.test(css));
check('sidebar chrome present', /\.sidebar\b/.test(css));
check('jian rail present', /\.jian-sidebar\b/.test(css));
check('preview panel present', /\.preview-panel\b/.test(css));
check('resize-handle rules exist', /\.resize-handle\b/.test(css));
check('sidebar width driven by CSS var', /--sidebar-width/.test(css));
check('jian width driven by CSS var', /--jian-sidebar-width/.test(css));
check('preview width driven by CSS var', /--preview-panel-width/.test(css));
check(
  'warm paper theme tokens present',
  /new-warm-paper|warm-paper|paper-texture|--paper/.test(css),
);

if (fails.length) {
  for (const f of fails) console.log('FAIL', f);
  console.log('FAILED');
  process.exit(1);
}
console.log(`css-guards: ${css.length} chars ok`);
