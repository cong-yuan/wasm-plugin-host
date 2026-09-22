/**
 * Studio slot bridge — reports [data-ohk-slot] geometry to the parent shell.
 *
 * The parent (openhanako-shell) mounts studio.renderSlot hosts and positions
 * them over these anchors. Empty hosts stay non-interactive.
 */

export const BRIDGE_SOURCE = 'openhanako-slot-bridge';
export const SHELL_SOURCE = 'openhanako-shell';

export type SlotRect = {
  top: number;
  left: number;
  width: number;
  height: number;
  visible: boolean;
};

export type RectsMessage = {
  source: typeof BRIDGE_SOURCE;
  type: 'rects';
  slots: Record<string, SlotRect>;
};

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function collectSlotRects(root: ParentNode = document): Record<string, SlotRect> {
  const out: Record<string, SlotRect> = {};
  const nodes = root.querySelectorAll<HTMLElement>('[data-ohk-slot]');
  nodes.forEach((el) => {
    const name = el.getAttribute('data-ohk-slot');
    if (!name) return;
    const r = el.getBoundingClientRect();
    out[name] = {
      top: r.top,
      left: r.left,
      width: r.width,
      height: r.height,
      visible: isVisible(el),
    };
  });
  return out;
}

export function postRects(target: Window | null = window.parent): void {
  if (!target || target === window) return;
  const msg: RectsMessage = {
    source: BRIDGE_SOURCE,
    type: 'rects',
    slots: collectSlotRects(),
  };
  try {
    target.postMessage(msg, '*');
  } catch {
    // parent gone
  }
}

/** Start observing layout and posting rects to the parent shell. */
export function startSlotBridge(): () => void {
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      postRects();
    });
  };

  postRects();

  const onMessage = (ev: MessageEvent) => {
    const data = ev.data;
    if (!data || data.source !== SHELL_SOURCE) return;
    if (data.type === 'hello' || data.type === 'request-rects') schedule();
  };
  window.addEventListener('message', onMessage);

  const ro = new ResizeObserver(schedule);
  ro.observe(document.documentElement);

  const mo = new MutationObserver(schedule);
  mo.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-ohk-slot', 'hidden'],
  });

  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);

  // Layout settles after sidebar / jian toggles.
  const iv = window.setInterval(schedule, 1000);

  return () => {
    window.removeEventListener('message', onMessage);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    window.clearInterval(iv);
    ro.disconnect();
    mo.disconnect();
    if (raf) cancelAnimationFrame(raf);
  };
}
