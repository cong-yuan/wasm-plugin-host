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

/** Graphemes per frame while catching up to the latest streamed source. */
const CHARS_PER_TICK = 3;
/** ~60fps typewriter cadence. */
const TICK_MS = 16;
/** Fade the newest graphemes at the stream tip. */
const STREAM_TAIL_FADE = 10;

/**
 * Typewriter-aware markdown renderer.
 *
 * Upstream may deliver large transcript jumps; while `active` we reveal
 * `source` gradually and re-render markdown from the visible prefix so the
 * bubble feels like a real stream instead of a one-shot dump.
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
  const visibleRef = useRef(visibleSource);
  visibleRef.current = visibleSource;

  useEffect(() => {
    if (!active) {
      setVisibleSource(fullSource);
      return;
    }

    // If the upstream rewound / replaced the text, restart the reveal.
    if (!fullSource.startsWith(visibleRef.current)) {
      setVisibleSource('');
    }

    if (visibleRef.current.length >= fullSource.length) {
      setVisibleSource(fullSource);
      return;
    }

    const timer = window.setInterval(() => {
      setVisibleSource((prev) => {
        if (!fullSource.startsWith(prev)) return fullSource.slice(0, CHARS_PER_TICK);
        if (prev.length >= fullSource.length) return fullSource;
        return fullSource.slice(0, Math.min(fullSource.length, prev.length + CHARS_PER_TICK));
      });
    }, TICK_MS);

    return () => window.clearInterval(timer);
  }, [fullSource, active]);

  const displayHtml = useMemo(() => {
    if (!active) return html;
    if (!fullSource) return html;
    if (visibleSource.length >= fullSource.length) return html;
    return renderMarkdown(visibleSource);
  }, [active, html, fullSource, visibleSource]);

  const catchingUp = active && !!fullSource && visibleSource.length < fullSource.length;

  return (
    <MarkdownContent
      html={displayHtml}
      className={cx(className, active && styles.streamMarkdownBlockEnter)}
      tailFadeCount={active || catchingUp ? STREAM_TAIL_FADE : 0}
      linkContext={linkContext}
    />
  );
});
