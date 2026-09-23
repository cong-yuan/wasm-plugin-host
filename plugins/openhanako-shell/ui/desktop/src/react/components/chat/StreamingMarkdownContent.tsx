import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { LinkOpenContext } from '../../utils/link-open';
import { renderMarkdown } from '../../utils/markdown';
import { MarkdownContent } from './MarkdownContent';
import styles from './Chat.module.css';

interface Props {
  html: string;
  source?: string;
  active?: boolean;
  className?: string;
  linkContext?: LinkOpenContext;
}

function cx(...parts: Array<string | false | null | undefined>): string | undefined {
  const value = parts.filter(Boolean).join(' ');
  return value || undefined;
}

/**
 * Larger holdback = smoother feel: short network gaps stay invisible, and
 * reveal stays a beat behind the raw token pump.
 */
const HOLD_CHARS = 48;
/** Soft fade on the newest graphemes. */
const STREAM_TAIL_FADE = 14;
/** At most this often re-run markdown (ms). Char reveal still ticks every frame. */
const MARKDOWN_MIN_INTERVAL_MS = 48;

/**
 * Gentler adaptive drain — "润": prefer drip; only accelerate when clearly behind.
 */
function charsForBacklog(backlog: number): number {
  if (backlog <= 0) return 0;
  if (backlog <= 12) return 1;
  if (backlog <= 36) return 2;
  if (backlog <= 80) return 3;
  if (backlog <= 160) return 6;
  if (backlog <= 320) return 12;
  if (backlog <= 640) return 22;
  return Math.min(backlog, 40);
}

/**
 * Smooth streaming markdown renderer.
 *
 * Token arrival is bursty. While `active` we:
 * 1. Hold back a larger tail buffer so gaps don't flash as stalls
 * 2. Reveal with rAF at a gentle backlog-scaled rate (润 > 跟手)
 * 3. Throttle markdown re-parse so long replies don't hitch every frame
 */
export const StreamingMarkdownContent = memo(function StreamingMarkdownContent({
  html,
  source,
  active = false,
  className,
  linkContext,
}: Props) {
  const fullSource = source ?? '';
  const [visibleSource, setVisibleSource] = useState(active ? '' : fullSource);
  const [markdownSource, setMarkdownSource] = useState(active ? '' : fullSource);
  const visibleRef = useRef(visibleSource);
  visibleRef.current = visibleSource;
  const fullRef = useRef(fullSource);
  fullRef.current = fullSource;
  const markdownRef = useRef(markdownSource);
  markdownRef.current = markdownSource;
  const lastMdAtRef = useRef(0);

  useEffect(() => {
    if (!active) {
      const full = fullRef.current;
      setVisibleSource(full);
      setMarkdownSource(full);
      return;
    }

    let raf = 0;
    let stopped = false;

    const tick = (now: number) => {
      if (stopped) return;
      const full = fullRef.current;
      let prev = visibleRef.current;
      if (!full.startsWith(prev)) prev = '';

      const targetLen = Math.max(0, full.length - HOLD_CHARS);
      let next = prev;
      if (prev.length < targetLen) {
        const step = charsForBacklog(targetLen - prev.length);
        next = full.slice(0, Math.min(targetLen, prev.length + step));
      } else if (prev.length > targetLen) {
        next = full.slice(0, targetLen);
      }

      if (next !== visibleRef.current) {
        visibleRef.current = next;
        setVisibleSource(next);
      }

      // Markdown is expensive; refresh on an interval, or when we catch the tip.
      const caughtUp = next.length >= targetLen;
      const due = now - lastMdAtRef.current >= MARKDOWN_MIN_INTERVAL_MS;
      if (next !== markdownRef.current && (due || caughtUp)) {
        lastMdAtRef.current = now;
        markdownRef.current = next;
        setMarkdownSource(next);
      }

      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(raf);
    };
  }, [active]);

  useEffect(() => {
    if (!active) {
      setVisibleSource(fullSource);
      setMarkdownSource(fullSource);
    }
  }, [active, fullSource]);

  const displayHtml = useMemo(() => {
    if (!active) return html;
    if (!fullSource) return html;
    if (markdownSource.length >= fullSource.length) return html;
    return renderMarkdown(markdownSource);
  }, [active, html, fullSource, markdownSource]);

  const catchingUp =
    active && !!fullSource && visibleSource.length < Math.max(0, fullSource.length - HOLD_CHARS);

  return (
    <MarkdownContent
      html={displayHtml}
      className={cx(className, active && styles.streamMarkdownBlockEnter)}
      tailFadeCount={active || catchingUp ? STREAM_TAIL_FADE : 0}
      linkContext={linkContext}
    />
  );
});
