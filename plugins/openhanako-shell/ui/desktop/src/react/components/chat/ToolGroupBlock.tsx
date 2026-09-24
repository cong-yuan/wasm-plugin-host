/**
 * ToolGroupBlock — 工具调用组，含展开/折叠
 */

import { memo, useEffect, useRef, useState } from 'react';
import styles from './Chat.module.css';
import { extractToolDetail } from '../../utils/message-parser';
import type { ToolDetail } from '../../utils/message-parser';
import { openInternalLink } from '../../utils/link-open';
import { isToolCallHiddenFromProcessUi } from '../../utils/tool-call-visibility';
import { sessionToolTargetName, sessionToolTargetPath } from '../../utils/tool-label';
import { formatElapsed } from '../../utils/format-duration';
import { diffLines, type DiffLine } from '../../utils/line-diff';
import { useStore } from '../../stores';
import { switchSession } from '../../stores/session-actions';
import { LinkContextMenu, type LinkContextMenuState } from '../shared/LinkContextMenu';

import type { ToolCall } from '../../stores/chat-types';

interface Props {
  tools: ToolCall[];
  collapsed: boolean;
  agentName?: string;
}

export const ToolGroupBlock = memo(function ToolGroupBlock({ tools: rawTools }: Props) {
  // Card-backed tools render elsewhere. Remaining calls follow Qoder's
  // one-row-per-tool layout; each row owns its disclosure state.
  const tools = rawTools.filter(t => !isToolCallHiddenFromProcessUi(t));
  if (tools.length === 0) return null;

  return (
    <div className={styles.toolGroup}>
      {tools.map((tool, i) => (
        <ToolIndicator key={tool.id || `${tool.name}-${i}`} tool={tool} />
      ))}
    </div>
  );
});

// ── ToolIndicator ──

function handleDetailClick(e: React.MouseEvent, detail: ToolDetail) {
  e.preventDefault();
  e.stopPropagation();
  if (!detail.href) return;
  void openInternalLink(detail.href, { origin: 'session' });
}

function hasEnumerableKey(value: ToolCall['args']): boolean {
  if (!value) return false;
  for (const _key in value) return true;
  return false;
}

const DETAIL_PREVIEW_LIMIT = 64 * 1024;
const DETAIL_COLLECTION_LIMIT = 200;
const DIFF_EDIT_LIMIT = 20;
const DIFF_ROW_LIMIT = 600;
const DIFF_LINE_PREVIEW_LIMIT = 4 * 1024;
const DIFF_TOOL_NAMES = new Set(['edit', 'apply_patch', 'edit_file', 'resource_edit']);
const TRUNCATED_MARKER = '\n… [truncated]';
const TRUNCATED_LINE_MARKER = '… [truncated]';

type DiffCell = {
  kind: DiffLine['kind'] | 'empty';
  line: number | null;
  text: string;
};

type SideBySideDiffRow = { old: DiffCell; new: DiffCell };
type EditDiffSection = { label: string; rows: SideBySideDiffRow[]; truncated: boolean };

function truncateDiffLine(value: string): string {
  if (value.length <= DIFF_LINE_PREVIEW_LIMIT) return value;
  return value.slice(0, DIFF_LINE_PREVIEW_LIMIT - TRUNCATED_LINE_MARKER.length)
    + TRUNCATED_LINE_MARKER;
}

function sideBySideRows(lines: DiffLine[]): SideBySideDiffRow[] {
  const rows: SideBySideDiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === 'same') {
      const text = truncateDiffLine(lines[i].text);
      rows.push({
        old: { kind: 'same', line: oldLine++, text },
        new: { kind: 'same', line: newLine++, text },
      });
      i += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (i < lines.length && lines[i].kind !== 'same') {
      (lines[i].kind === 'removed' ? removed : added).push(lines[i].text);
      i += 1;
    }
    for (let j = 0; j < Math.max(removed.length, added.length); j += 1) {
      const oldText = removed[j];
      const newText = added[j];
      rows.push({
        old: oldText == null
          ? { kind: 'empty', line: null, text: '' }
          : { kind: 'removed', line: oldLine++, text: truncateDiffLine(oldText) },
        new: newText == null
          ? { kind: 'empty', line: null, text: '' }
          : { kind: 'added', line: newLine++, text: truncateDiffLine(newText) },
      });
    }
  }
  return rows;
}

function buildEditDiffSections(toolName: string, args: ToolCall['args']): EditDiffSection[] {
  if (!args || !DIFF_TOOL_NAMES.has(toolName.toLowerCase())) return [];
  try {
    const candidates = Array.isArray(args.edits) ? args.edits.slice(0, DIFF_EDIT_LIMIT) : [args];
    const defaultPath = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : '';
    const sections: EditDiffSection[] = [];
    let oldBudget = DETAIL_PREVIEW_LIMIT;
    let newBudget = DETAIL_PREVIEW_LIMIT;
    let rowBudget = DIFF_ROW_LIMIT;
    for (let index = 0; index < candidates.length && rowBudget > 0; index += 1) {
      const candidate = candidates[index];
      if (!candidate || typeof candidate !== 'object') continue;
      const edit = candidate as Record<string, unknown>;
      if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') continue;
      const oldText = edit.oldText.slice(0, oldBudget);
      const newText = edit.newText.slice(0, newBudget);
      oldBudget -= oldText.length;
      newBudget -= newText.length;
      const diff = diffLines(oldText, newText);
      if (!diff) continue;
      const allRows = sideBySideRows(diff);
      const rows = allRows.slice(0, rowBudget);
      rowBudget -= rows.length;
      const path = typeof edit.path === 'string' ? edit.path : defaultPath;
      sections.push({
        label: candidates.length > 1 ? `${path || 'edit'} · ${index + 1}` : path,
        rows,
        truncated: oldText.length < edit.oldText.length
          || newText.length < edit.newText.length
          || rows.length < allRows.length
          || (index === candidates.length - 1 && Array.isArray(args.edits) && args.edits.length > DIFF_EDIT_LIMIT),
      });
    }
    return sections;
  } catch {
    return [];
  }
}

function truncatePreview(value: string, limit = DETAIL_PREVIEW_LIMIT): string {
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - TRUNCATED_MARKER.length)) + TRUNCATED_MARKER;
}

interface PreviewBudget {
  entries: number;
  chars: number;
}

function boundedClone(
  value: unknown,
  seen: WeakSet<object>,
  budget: PreviewBudget,
  depth = 0,
): unknown {
  if (typeof value === 'string') {
    const limit = Math.max(0, budget.chars);
    const preview = truncatePreview(value, limit);
    budget.chars = Math.max(0, budget.chars - preview.length);
    return preview;
  }
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= 8) return '[Max depth]';
  seen.add(value);

  const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  for (const rawKey in value as Record<string, unknown>) {
    if (budget.entries <= 0 || budget.chars <= 0) {
      if (Array.isArray(output)) output.push('[truncated]');
      else output['…'] = '[truncated]';
      break;
    }
    budget.entries -= 1;
    const key = truncatePreview(rawKey, Math.min(256, budget.chars));
    budget.chars = Math.max(0, budget.chars - key.length);
    const child = boundedClone(
      (value as Record<string, unknown>)[rawKey],
      seen,
      budget,
      depth + 1,
    );
    if (Array.isArray(output)) output.push(child);
    else output[key] = child;
  }
  return output;
}

function serializeInputPreview(args: ToolCall['args']): string {
  if (!args) return '';
  try {
    const budget = { entries: DETAIL_COLLECTION_LIMIT, chars: DETAIL_PREVIEW_LIMIT - 1024 };
    return truncatePreview(JSON.stringify(boundedClone(args, new WeakSet(), budget), null, 2));
  } catch {
    return '[Unable to display input]';
  }
}

function shortError(value: string): string {
  const limit = 120;
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

const ToolIndicator = memo(function ToolIndicator({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [response, setResponse] = useState('');
  const [editDiffs, setEditDiffs] = useState<EditDiffSection[]>([]);
  const [linkMenu, setLinkMenu] = useState<LinkContextMenuState | null>(null);

  // session 工具指向另一个会话，把它的名字显示出来并支持点过去。两个 selector 各返回
  // 字符串或 null，引用稳定，不会让每个工具行都因为 sessions 变动而重渲染。
  const isSessionTool = tool.name === 'session';
  const sessionTargetName = useStore(s => (isSessionTool ? sessionToolTargetName(s, tool.args) : null));
  const sessionTargetPath = useStore(s => (isSessionTool ? sessionToolTargetPath(s, tool.args) : null));

  const rawDetail = extractToolDetail(tool.name, tool.args);
  const detail = sessionTargetName ? { ...rawDetail, text: sessionTargetName } : rawDetail;
  const detailTitle = detail.title || detail.href;
  const status = tool.status || (tool.done ? (tool.success ? 'succeeded' : 'failed') : 'running');
  const duration = Number.isFinite(tool.startedAt) && Number.isFinite(tool.finishedAt)
    ? formatElapsed(Math.max(0, tool.finishedAt! - tool.startedAt!))
    : '';
  const tag = tool.args?.agentId as string | undefined;
  const hasInput = hasEnumerableKey(tool.args);
  const rawResponse = tool.error || tool.output || '';
  const hasDetails = hasInput || Boolean(rawResponse);
  const errorSummary = tool.error ? shortError(tool.error) : '';
  // Open shell first, then build bounded previews in idle time. Collapsed rows
  // never clone args or slice huge output strings, keeping multi-tool updates cheap.
  const previewCacheRef = useRef<{
    args: ToolCall['args'];
    response: string;
    inputPreview: string;
    responsePreview: string;
    editDiffs: EditDiffSection[];
  } | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const cached = previewCacheRef.current;
    if (cached?.args === tool.args && cached.response === rawResponse) {
      setInput(cached.inputPreview);
      setResponse(cached.responsePreview);
      setEditDiffs(cached.editDiffs);
      return;
    }
    let cancelled = false;
    const load = () => {
      if (cancelled) return;
      const inputPreview = hasInput ? serializeInputPreview(tool.args) : '';
      const responsePreview = truncatePreview(rawResponse);
      const nextEditDiffs = buildEditDiffSections(tool.name, tool.args);
      previewCacheRef.current = {
        args: tool.args,
        response: rawResponse,
        inputPreview,
        responsePreview,
        editDiffs: nextEditDiffs,
      };
      setInput(inputPreview);
      setResponse(responsePreview);
      setEditDiffs(nextEditDiffs);
    };
    const idleId = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(load, { timeout: 150 })
      : null;
    const timerId = idleId == null ? window.setTimeout(load, 0) : null;
    return () => {
      cancelled = true;
      if (idleId != null) window.cancelIdleCallback(idleId);
      if (timerId != null) window.clearTimeout(timerId);
    };
  }, [expanded, hasInput, rawResponse, tool.args]);
  const _t = window.t ?? ((key: string) => key);
  const statusText = _t(`toolGroup.status.${status}`);
  const statusMark = status === 'succeeded' ? '✓' : status === 'failed' ? '✗' : status === 'cancelled' ? '■' : status === 'unknown' ? '!' : '';

  return (
    <div className={styles.toolStep} data-tool={tool.name} data-done={String(tool.done)}>
      <button
        type="button"
        className={styles.toolIndicator}
        aria-expanded={hasDetails ? expanded : undefined}
        onClick={() => hasDetails && setExpanded(value => !value)}
      >
        <span
          className={`${styles.toolStatusIcon} ${status === 'succeeded' ? styles.toolStatusDone : status === 'running' ? styles.toolStatusRunning : status === 'cancelled' ? styles.toolStatusCancelled : styles.toolStatusFailed}`}
          aria-hidden="true"
        >
          {status === 'running' ? <span className={styles.toolSpinner} /> : statusMark}
        </span>
        <span className={styles.toolStatusText}>{statusText}</span>
        <span className={styles.toolDesc}>{tool.name}</span>
        {detail.text && (
          <>
            <span className={styles.toolSeparator}>·</span>
            {sessionTargetPath ? (
              <span
                className={`${styles.toolDetail} ${styles.toolDetailLink}`}
                title={detailTitle || detail.text}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void switchSession(sessionTargetPath);
                }}
              >
                {detail.text}
              </span>
            ) : detail.href ? (
              <span
                className={`${styles.toolDetail} ${styles.toolDetailLink}`}
                title={detailTitle}
                onClick={(e) => handleDetailClick(e, detail)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!detail.href) return;
                  setLinkMenu({
                    href: detail.href,
                    context: { origin: 'session', label: detail.text },
                    position: { x: e.clientX, y: e.clientY },
                  });
                }}
              >
                {detail.text}
              </span>
            ) : (
              <span className={styles.toolDetail} title={detailTitle}>{detail.text}</span>
            )}
          </>
        )}
        {errorSummary && (
          <>
            <span className={styles.toolSeparator}>·</span>
            <span className={`${styles.toolDetail} ${styles.toolDetailError}`} title={errorSummary}>{errorSummary}</span>
          </>
        )}
        {tag && <span className={styles.toolTag}>{tag}</span>}
        {duration && <span className={styles.toolDuration}>{duration}</span>}
      </button>
      {hasDetails && expanded && (
        <div className={styles.toolDetails} data-tool-result-details="true">
          {editDiffs.length > 0 && (
            <>
              <div className={styles.toolDetailsLabel}>Diff</div>
              <div className={styles.toolDiffScroller} data-tool-edit-diff="true">
                {editDiffs.map((section, sectionIndex) => (
                  <div className={styles.toolDiffSection} key={`${section.label}-${sectionIndex}`}>
                    {section.label && <div className={styles.toolDiffPath}>{section.label}</div>}
                    <div className={styles.toolDiffHeader} aria-hidden="true">
                      <span>old</span><span>new</span>
                    </div>
                    {section.rows.map((row, rowIndex) => (
                      <div className={styles.toolDiffRow} key={rowIndex}>
                        <span className={styles.toolDiffLineNumber}>{row.old.line ?? ''}</span>
                        <code
                          className={row.old.kind === 'removed' ? styles.toolDiffRemoved : styles.toolDiffSame}
                          data-diff-kind={row.old.kind}
                          data-diff-side="old"
                        >{row.old.text || ' '}</code>
                        <span className={styles.toolDiffLineNumber}>{row.new.line ?? ''}</span>
                        <code
                          className={row.new.kind === 'added' ? styles.toolDiffAdded : styles.toolDiffSame}
                          data-diff-kind={row.new.kind}
                          data-diff-side="new"
                        >{row.new.text || ' '}</code>
                      </div>
                    ))}
                    {section.truncated && <div className={styles.toolDiffTruncated}>… [truncated]</div>}
                  </div>
                ))}
              </div>
            </>
          )}
          {input && (
            <>
              <div className={styles.toolDetailsLabel}>{_t('toolGroup.input')}</div>
              <div className={styles.toolDetailsScroller}><pre>{input}</pre></div>
            </>
          )}
          {response && (
            <>
              <div className={styles.toolDetailsLabel}>{_t('toolGroup.response')}</div>
              <div className={styles.toolDetailsScroller}>
                <pre className={status === 'failed' ? styles.toolDetailsError : undefined}>{response}</pre>
              </div>
            </>
          )}
        </div>
      )}
      {linkMenu && <LinkContextMenu state={linkMenu} onClose={() => setLinkMenu(null)} />}
    </div>
  );
});
