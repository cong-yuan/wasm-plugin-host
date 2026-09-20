// Static guards over the stylesheet.
//
// These exist because the DOM shim in the other harnesses has **no layout
// engine**: it cannot see that a rule stretched the drag handle across the whole
// column, which is exactly the bug that shipped (`.hn-side > *` matched the
// handle too, turning the entire sidebar into a drag surface so nothing inside
// it could be clicked). A rule is not something the other tests can observe, so
// it is checked by reading the CSS.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'js', 'style.css'), 'utf8');

const checks = [];
const check = (name, cond, detail) => {
  checks.push([name, cond, detail]);
  if (!cond) process.exitCode = 1;
};

// ── 1. The handle must not be caught by a broad sibling rule ────────────────
// `.X > *` (or `.X *`) styles every child, including the absolutely-positioned
// handle. Any such rule that could match a handle in the same element must
// exclude it explicitly, or size the handle with its own selector instead.
const broadRules = [...css.matchAll(/^([^{}]*?(?:>\s*\*|\s\*))\s*\{([^}]*)\}/gms)]
  .map((m) => ({ selector: m[1].trim(), body: m[2] }));

const offenders = broadRules.filter((r) => {
  // Only rules that set a size are dangerous: a cursor rule on `body.resizing *`
  // is fine and intentional.
  const sizes = /(^|[;{\s])(width|height|min-width|min-height|flex|flex-shrink)\s*:/.test(r.body);
  if (!sizes) return false;
  if (r.selector.includes(':not(.hn-resize-handle)')) return false;
  // A rule scoped to a specific child selector is fine; bare `*` is not.
  return true;
});

check('no size-setting `*` rule can swallow the drag handle',
  offenders.length === 0,
  offenders.map((o) => o.selector).join(' | '));

// ── 2. The handle is exactly the line: 3px, absolute, on an accent hover ────
const handle = css.match(/\.hn-resize-handle\s*\{([^}]*)\}/s);
check('the handle has a rule at all', !!handle);
if (handle) {
  check('the handle is 3px wide, not a wide invisible strip',
    /width:\s*3px/.test(handle[1]), handle[1].replace(/\s+/g, ' ').trim());
  check('the handle is absolutely positioned',
    /position:\s*absolute/.test(handle[1]));
  check('the handle has its own visible background (the line)',
    /background:\s*var\(--dw-overlay-medium\)/.test(handle[1]));
}
check('the handle changes colour on hover and while dragging',
  /\.hn-resize-handle:hover,\s*\n?\.hn-resize-handle\.active\s*\{\s*background:\s*var\(--dw-accent\)/.test(css),
  'expected a hover/active accent rule');

// ── 3. Every column that hosts a handle must be a containing block ──────────
// An absolutely-positioned handle anchors to the nearest positioned ancestor.
// If that is not the column, the handle lands somewhere else entirely.
for (const pane of ['sidebar', 'preview', 'rail']) {
  const pos = new RegExp(`\\.hn-col-${pane}[^{]*\\{[^}]*position:\\s*relative`, 's');
  check(`.hn-col-${pane} is a containing block for its handle`, pos.test(css));
}

// ── 4. A collapsed column hides its handle ─────────────────────────────────
// Otherwise a 0-width column keeps a live drag strip eating clicks meant for
// its neighbour.
check('a collapsed column hides its handle',
  /\[data-collapsed\]\s+\.hn-resize-handle\s*\{\s*display:\s*none/.test(css));

// ── 5. The per-column children rule excludes the handle ─────────────────────
for (const [sel, token] of [['.hn-side > *', '--dw-sidebar-width'], ['.hn-rail > *', '--dw-rail-width']]) {
  const rule = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^{]*)\\{([^}]*)\\}`, 's').exec(css);
  if (!rule) continue; // the rule may legitimately be absent
  const matchesHandle = !rule[1].includes(':not(.hn-resize-handle)');
  check(`\`${sel}\` excludes the handle, so it cannot be stretched to the column width`,
    !matchesHandle,
    `selector is \`${sel}${rule[1].trim()}\``);
}

for (const [name, ok, detail] of checks) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (!ok && detail ? '  (' + detail + ')' : ''));
}
console.log(process.exitCode ? 'FAILED' : 'OK');
