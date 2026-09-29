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
// jsdom is a dev-only test dependency. The plugin still ships zero runtime
// dependencies (every asset is an `include_str!` into the `.wasm`). CI installs
// the pinned package-lock with `npm ci`, so this test is part of the main gate.
// Keep the loud local skip only for developers running the file directly
// without installing dev dependencies.
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

// Markup mirrors the current shipped openhanako-shell structure. The resize
// handle is a narrow absolutely-positioned hit strip inside each panel; it must
// never inherit the panel width and swallow normal clicks.
const markup = (c) => `
  <div class="hana-replica">
    <aside class="${c.panelClass}">
      <div class="resize-handle ${c.handleClass}" id="handle"></div>
      <div class="${c.innerClass}" id="inner"></div>
    </aside>
  </div>`;

const CHECKS = [
  {
    pane: 'sidebar',
    panelClass: 'sidebar',
    innerClass: 'sidebar-inner',
    handleClass: 'resize-handle-right',
    handleWidth: '6px',
    innerToken: '--sidebar-width',
  },
  {
    pane: 'preview',
    panelClass: 'preview-panel',
    innerClass: 'preview-panel-inner',
    handleClass: 'resize-handle-left',
    handleWidth: '8px',
    innerToken: null,
  },
  {
    pane: 'rail',
    panelClass: 'jian-sidebar',
    innerClass: 'jian-sidebar-inner',
    handleClass: 'resize-handle-left',
    handleWidth: '8px',
    innerToken: '--jian-sidebar-width',
  },
];

const results = [];
const check = (name, cond, detail) => {
  results.push([name, cond, detail]);
  if (!cond) process.exitCode = 1;
};

for (const c of CHECKS) {
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${css}</style></head><body>${markup(c)}</body></html>`,
    { pretendToBeVisual: true },
  );
  const style = (id) => dom.window.getComputedStyle(dom.window.document.getElementById(id));

  const handle = style('handle');
  check(`[${c.pane}] resize hit strip keeps its narrow width`,
    handle.width === c.handleWidth, `computed width was ${handle.width}`);
  check(`[${c.pane}] resize hit strip is absolutely positioned`,
    handle.position === 'absolute', handle.position);
  check(`[${c.pane}] resize hit strip uses col-resize cursor`,
    handle.cursor === 'col-resize', handle.cursor);

  const iw = style('inner').width;
  if (c.innerToken) {
    check(`[${c.pane}] inner content still sizes from ${c.innerToken}`,
      iw === `var(${c.innerToken})`, `inner width was ${iw}`);
  } else {
    check(`[${c.pane}] inner content keeps automatic width`,
      iw === 'auto', `inner width was ${iw}`);
  }
}

for (const [name, ok, detail] of results) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (!ok && detail ? '  (' + detail + ')' : ''));
}
console.log(process.exitCode ? 'FAILED' : 'OK');
