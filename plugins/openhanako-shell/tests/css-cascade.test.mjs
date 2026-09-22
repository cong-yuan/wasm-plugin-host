// Deep check: run the real stylesheet through a real cascade, and assert the
// drag handle keeps its own geometry.
//
// Why this exists alongside `css-guards.test.mjs`: those guards read the CSS as
// text and catch one *shape* of mistake (a broad child selector). This one runs
// the actual cascade, so it catches any rule that wins over the handle —
// a later rule, a more specific selector, a `!important`, a shorthand that
// resets `width`. The bug that motivated it (`.hn-side > *` stretching the 3px
// handle to the full column width, making the whole sidebar draggable and
// swallowing every click inside it) is invisible to a DOM shim with no layout
// engine, and invisible to the eye until someone tries to click a row.
//
// jsdom is a **dev-only, optional** dependency: this plugin ships zero runtime
// dependencies (every asset is an `include_str!` into the `.wasm`), and forcing
// an install step on `npm test` would be a worse trade than skipping here. So
// this file skips — **loudly** — when jsdom is absent. A silent skip would read
// as "checked and fine", which is the failure mode this whole file exists to
// avoid.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'js', 'style.css'), 'utf8');

let JSDOM;
try {
  ({ JSDOM } = createRequire(import.meta.url)('jsdom'));
} catch {
  console.log('SKIP css-cascade.test.mjs — jsdom is not installed.');
  console.log('     run `npm install jsdom` in plugins/openhanako-shell to enable this check.');
  console.log('     (the zero-dependency checks in css-guards.test.mjs still ran)');
  process.exit(0);
}

// Markup mirrors the shipped structure exactly — the handle is the column's
// child, not a sibling of it, which is what made the bug possible.
const markup = (pane, cls, handleCls, resize) => `
  <div class="hn-shell">
    <div class="hn-col-${pane}" data-pane="${pane}">
      <aside class="${cls}">
        <div class="hn-resize-handle ${handleCls}" data-resize="${resize}" id="handle"></div>
        <div class="${cls}-header" id="inner"></div>
      </aside>
    </div>
  </div>`;

const CHECKS = [
  // `innerToken` is the width the inner content should end up with. The sidebar
  // and rail size their children explicitly (so the content keeps its width
  // while the column animates to zero); the preview instead sizes *itself* and
  // lets flex stretch the children, so their computed width is `auto`. Asserting
  // one rule for all three would encode a rule the design does not have.
  { pane: 'sidebar', cls: 'hn-side', handleCls: 'hn-resize-right', resize: 'sidebar', innerToken: '--dw-sidebar-width' },
  { pane: 'preview', cls: 'hn-preview', handleCls: 'hn-resize-left', resize: 'preview', innerToken: null },
  { pane: 'rail', cls: 'hn-rail', handleCls: 'hn-resize-left', resize: 'rail', innerToken: '--dw-rail-width' },
];

const results = [];
const check = (name, cond, detail) => {
  results.push([name, cond, detail]);
  if (!cond) process.exitCode = 1;
};

for (const c of CHECKS) {
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${css}</style></head><body>${markup(c.pane, c.cls, c.handleCls, c.resize)}</body></html>`,
    { pretendToBeVisual: true },
  );
  const style = (id) => dom.window.getComputedStyle(dom.window.document.getElementById(id));

  // The whole point: the handle is 3px, not the column's width. `getComputedStyle`
  // returns the *declared* value for `var()`, so an unresolved token shows up as
  // the literal string `var(--dw-sidebar-width)` — which is exactly what the bug
  // looked like, and is why comparing against `3px` catches it.
  const hw = style('handle').width;
  check(`[${c.pane}] the handle is 3px, not the column width`,
    hw === '3px', `computed width was ${hw}`);

  check(`[${c.pane}] the handle is absolutely positioned`,
    style('handle').position === 'absolute', style('handle').position);

  check(`[${c.pane}] the handle is a grab strip, not a click target`,
    style('handle').cursor === 'col-resize', style('handle').cursor);

  // The inner content must not have been broken by the fix. Where the design
  // sizes it explicitly, it must still resolve to that token; where it relies on
  // the parent (preview), it must not have picked up a stray width.
  if (c.innerToken) {
    const iw = style('inner').width;
    check(`[${c.pane}] inner content still sizes from ${c.innerToken}`,
      iw === `var(${c.innerToken})`, `inner width was ${iw}`);
  } else {
    const iw = style('inner').width;
    check(`[${c.pane}] inner content is not stretched by a child rule`,
      iw === 'auto', `inner width was ${iw}`);
  }
}

for (const [name, ok, detail] of results) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (!ok && detail ? '  (' + detail + ')' : ''));
}
console.log(process.exitCode ? 'FAILED' : 'OK');
