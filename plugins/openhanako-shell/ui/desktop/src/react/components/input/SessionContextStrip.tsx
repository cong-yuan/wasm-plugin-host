import { memo, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import type { PermissionMode } from './PlanModeButton';
import styles from './InputArea.module.css';

function basenamePath(path: string | null | undefined): string {
  if (!path) return '';
  const cleaned = path.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

function permissionModeLabelKey(mode: PermissionMode) {
  if (mode === 'auto') return 'input.autoMode';
  if (mode === 'read_only') return 'input.readOnlyMode';
  if (mode === 'ask') return 'input.askMode';
  return 'input.operateMode';
}

/**
 * Qoder-like strip under the composer: project name · mode · git branch.
 */
export const SessionContextStrip = memo(function SessionContextStrip() {
  const { t } = useI18n();
  const selectedFolder = useStore(s => s.selectedFolder);
  const selectedWorkspaceLabel = useStore(s => s.selectedWorkspaceLabel);
  const deskWorkspaceLabel = useStore(s => s.deskWorkspaceLabel);
  const permissionMode = useStore(s => s.sessionPermissionMode) as PermissionMode;
  const currentSessionPath = useStore(s => s.currentSessionPath);

  const projectLabel = useMemo(() => {
    return (
      selectedWorkspaceLabel
      || deskWorkspaceLabel
      || basenamePath(selectedFolder)
      || '未选择项目'
    );
  }, [selectedWorkspaceLabel, deskWorkspaceLabel, selectedFolder]);

  const modeLabel = t(permissionModeLabelKey(permissionMode)) || String(permissionMode);

  const [branch, setBranch] = useState<string>('—');

  useEffect(() => {
    let cancelled = false;
    const cwd = selectedFolder?.trim();
    if (!cwd) {
      setBranch('—');
      return;
    }
    (async () => {
      try {
        const res = await hanaFetch(
          `/api/workspace/git-status?cwd=${encodeURIComponent(cwd)}`,
          { throwOnHttpError: false },
        );
        if (!res.ok) {
          if (!cancelled) setBranch('—');
          return;
        }
        const data = await res.json().catch(() => null) as { branch?: string; currentBranch?: string } | null;
        const name = data?.branch || data?.currentBranch || '';
        if (!cancelled) setBranch(name.trim() || '—');
      } catch {
        if (!cancelled) setBranch('—');
      }
    })();
    return () => { cancelled = true; };
  }, [selectedFolder, currentSessionPath]);

  return (
    <div className={styles['session-context-strip']} data-session-context-strip="">
      <span className={styles['session-context-item']} title={selectedFolder || projectLabel}>
        <span className={styles['session-context-key']}>项目</span>
        <span className={styles['session-context-value']}>{projectLabel}</span>
      </span>
      <span className={styles['session-context-sep']} aria-hidden="true">·</span>
      <span className={styles['session-context-item']} title={modeLabel}>
        <span className={styles['session-context-key']}>模式</span>
        <span className={styles['session-context-value']}>{modeLabel}</span>
      </span>
      <span className={styles['session-context-sep']} aria-hidden="true">·</span>
      <span className={styles['session-context-item']} title={branch}>
        <span className={styles['session-context-key']}>分支</span>
        <span className={styles['session-context-value']}>{branch}</span>
      </span>
    </div>
  );
});
