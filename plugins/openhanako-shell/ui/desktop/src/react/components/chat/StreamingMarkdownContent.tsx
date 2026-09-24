import { memo } from 'react';
import type { LinkOpenContext } from '../../utils/link-open';
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
 * StreamBufferManager already batches source and Markdown at 30 Hz. Rendering
 * that authoritative HTML directly avoids a second rAF/typewriter pipeline
 * that hid the last 48 characters and multiplied work for every text segment.
 */
export const StreamingMarkdownContent = memo(function StreamingMarkdownContent({
  html,
  active = false,
  className,
  linkContext,
}: Props) {
  return (
    <MarkdownContent
      html={html}
      className={cx(className, active && styles.streamMarkdownBlockEnter)}
      linkContext={linkContext}
    />
  );
});
