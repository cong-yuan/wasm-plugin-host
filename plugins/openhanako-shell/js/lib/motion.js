// Motion: HanaAgent's animation vocabulary, as a stylesheet.
//
// Copied from `animations.css` in liliMozi/openhanako (Apache-2.0), which is
// deliberate about naming: every keyframe has exactly one definition and one
// name, so nothing drifts. Keeping that property means a rule here can name the
// motion it wants (`animation: --dw-fade-up`) instead of re-inventing a
// transition inline.
//
// They are installed as a stylesheet rather than inline styles because
// `@keyframes` cannot be set per element — one sheet serves the whole plugin.
return (function () {
  const CSS = `
/* ── Fade ── */
@keyframes dw-fade-in  { from { opacity: 0 } to { opacity: 1 } }
@keyframes dw-fade-out { from { opacity: 1 } to { opacity: 0 } }

/* ── Fade + slide. The distance is a variable so one keyframe covers the
      dropdown (4px), the message (8px) and the panel (10px) cases. ── */
@keyframes dw-fade-up {
  from { opacity: 0; transform: translateY(var(--dw-slide-y, 4px)) }
  to   { opacity: 1; transform: translateY(0) }
}
@keyframes dw-fade-down {
  from { opacity: 1; transform: translateY(0) }
  to   { opacity: 0; transform: translateY(var(--dw-slide-y, 4px)) }
}

/* ── Scale + fade. The "something appeared" motion for menus and popovers. ── */
@keyframes dw-scale-in {
  from { opacity: 0; transform: scale(0.96) translateY(8px) }
  to   { opacity: 1; transform: scale(1) translateY(0) }
}

/* ── Pulse: a breathing dot. Used for "working" indicators; the range is
      configurable so a subtle and an urgent pulse share one keyframe. ── */
@keyframes dw-pulse {
  0%, 100% { opacity: var(--dw-pulse-lo, 0.3) }
  50%      { opacity: var(--dw-pulse-hi, 1) }
}

/* ── Spin ── */
@keyframes dw-spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }

/* ── Accordion expand ── */
@keyframes dw-expand {
  from { max-height: 0; opacity: 0 }
  to   { max-height: 800px; opacity: 1 }
}

/* ── Rise with a clip path, so a confirm bar appears to grow out of the edge
      rather than sliding over the content. ── */
@keyframes dw-rise {
  from { opacity: 0; transform: translateY(24px); clip-path: inset(100% 0 0 0) }
  to   { opacity: 1; transform: translateY(0); clip-path: inset(0 0 0 0) }
}

/* ── Chat stream: the tail of a streaming reply eases in without moving the
      text already on screen (upstream calls it hana-stream-tail-in). ── */
@keyframes dw-stream-tail-in { from { opacity: 0.18 } to { opacity: 1 } }
@keyframes dw-soft-up-in {
  from { opacity: 0; transform: translateY(3px) }
  to   { opacity: 1; transform: translateY(0) }
}

/* ── Typewriter dots, drawn with content so no DOM is needed. ── */
@keyframes dw-dots {
  0%, 100% { content: '.' }
  33%      { content: '..' }
  66%      { content: '...' }
}
`;
  return { CSS };
})();
