/**
 * 统一历史管理弹窗：左/文件列表（含已删除分组）、中/版本时间线、右/diff 与还原。
 * 所有入口（preview 悬浮按钮、文件树右键）都只是 openFileHistoryModal 的调用方，表面唯一。
 *
 * diff 语义："当前内容 → 选中快照"，即还原后会发生什么：added 行是还原将写回的内容，
 * removed 行是将被替换的当前内容。当前内容读不到（已删除/远端 mount）时降级为与上一版本
 * 比对，再不行展示快照全文（不做假 diff）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Overlay } from '../../ui';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import {
  fetchHistoryFiles, fetchHistoryVersions, fetchHistorySnapshot, restoreHistorySnapshot,
  FileHistoryRestoreConflictError,
  type FileHistoryFileEntry, type FileHistoryVersionEntry, type FileHistoryExpectedVersion,
} from '../../utils/file-history-api';
import { diffLines, type DiffLine } from '../../utils/line-diff';
import { refreshOpenPreviewDocumentsForFilePath } from '../../utils/preview-document-refresh';
import styles from './FileHistoryModal.module.css';

export function FileHistoryModal() {
  const { t } = useI18n();
  const modal = useStore(s => s.fileHistoryModal);
  const close = useStore(s => s.closeFileHistoryModal);
  const agentId = useStore(s => s.currentAgentId);
  const nativeRoot = useStore(s => s.deskWorkspaceNativeRoot || s.deskBasePath);

  const [files, setFiles] = useState<FileHistoryFileEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [versions, setVersions] = useState<FileHistoryVersionEntry[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [snapshotText, setSnapshotText] = useState<string | null>(null);
  const [currentText, setCurrentText] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<FileHistoryExpectedVersion | null>(null);
  const restoreInFlight = useRef(false);
  const restoreEpoch = useRef(0);
  useEffect(() => () => { restoreEpoch.current += 1; }, [modal.open, agentId, selectedPath]);

  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'restoring' | 'restored' | 'error' | 'conflict'>('idle');

  // 打开时装载文件列表 + 应用预选
  useEffect(() => {
    let cancelled = false;
    setFiles([]);
    setSelectedPath(null);
    setVersions([]);
    setSelectedVersion(null);
    setSnapshotText(null);
    setCurrentText(null);
    setCurrentVersion(null);
    if (!modal.open || !agentId) return;
    setStatus('loading');
    fetchHistoryFiles(agentId)
      .then(list => {
        if (cancelled) return;
        setFiles(list);
        setStatus('idle');
        setSelectedPath(modal.preselectRelPath && list.some(f => f.relPath === modal.preselectRelPath)
          ? modal.preselectRelPath : null);
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [modal.open, modal.preselectRelPath, agentId]);

  // 选中文件 → 装载版本
  useEffect(() => {
    let cancelled = false;
    setVersions([]);
    setSelectedVersion(null);
    setSnapshotText(null);
    setCurrentText(null);
    setCurrentVersion(null);
    if (!modal.open || !agentId || !selectedPath) return;
    fetchHistoryVersions(agentId, selectedPath)
      .then(list => {
        if (cancelled) return;
        setVersions(list);
        setSelectedVersion(list[0]?.id ?? null);
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [modal.open, agentId, selectedPath]);

  // 选中版本 → 装载快照与当前内容
  useEffect(() => {
    let cancelled = false;
    setSnapshotText(null);
    setCurrentText(null);
    setCurrentVersion(null);
    setSnapshotLoading(false);
    if (!modal.open || !agentId || !selectedPath || selectedVersion == null) return;
    setSnapshotLoading(true);
    (async () => {
      try {
        const snapshot = await fetchHistorySnapshot(agentId, selectedVersion);
        if (cancelled) return;
        if (snapshot.relPath !== selectedPath) {
          throw new Error('Snapshot does not belong to the selected file');
        }
        setSnapshotText(snapshot.content);
        let current: string | null = null;
        if (nativeRoot) {
          const abs = `${nativeRoot.replace(/\/+$/, '')}/${selectedPath}`;
          const snap = await window.platform?.readFileSnapshot?.(abs).catch(() => null);
          current = snap?.content ?? null;
          const version = snap?.version;
          if (!cancelled && version && typeof version === 'object'
            && ('mtimeMs' in version || 'sha256' in version)) {
            setCurrentVersion(version as FileHistoryExpectedVersion);
          }
        }
        if (current == null) {
          const idx = versions.findIndex(v => v.id === selectedVersion);
          const prev = versions[idx + 1];
          if (prev) {
            const prevSnap = await fetchHistorySnapshot(agentId, prev.id).catch(() => null);
            current = prevSnap?.content ?? null;
          }
        }
        if (!cancelled) setCurrentText(current);
      } catch {
        if (!cancelled) setStatus('error');
      } finally {
        if (!cancelled) setSnapshotLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [modal.open, agentId, selectedVersion, selectedPath, nativeRoot, versions]);

  const diff: DiffLine[] | null = useMemo(() => {
    if (snapshotText == null) return null;
    if (currentText == null) return snapshotText.split('\n').map(text => ({ kind: 'same' as const, text }));
    return diffLines(currentText, snapshotText);
  }, [snapshotText, currentText]);

  const handleRestore = useCallback(async () => {
    if (!modal.open || !agentId || selectedVersion == null || !selectedPath
      || snapshotLoading || snapshotText == null || status === 'restoring' || restoreInFlight.current) return;
    if (!window.confirm(t('fileHistory.restoreConfirm'))) return;
    restoreInFlight.current = true;
    const epoch = restoreEpoch.current;
    const isCurrent = () => epoch === restoreEpoch.current
      && useStore.getState().fileHistoryModal.open
      && useStore.getState().currentAgentId === agentId;
    setStatus('restoring');
    try {
      const result = await restoreHistorySnapshot(agentId, selectedVersion, currentVersion ?? undefined);
      if (result.relPath !== selectedPath) throw new Error('Unexpected restored file path');
      if (!isCurrent()) return;
      setStatus('restored');
      // The just-restored file is now the selected snapshot. Clear the obsolete
      // before-restore diff and refresh open previews using the existing
      // version-aware file pipeline.
      setCurrentText(snapshotText);
      if (nativeRoot) {
        const restoredPath = `${nativeRoot.replace(/\/+$/, '')}/${selectedPath}`;
        void refreshOpenPreviewDocumentsForFilePath(restoredPath).catch(err => {
          console.warn('[FileHistory] restored preview refresh failed:', err);
        });
      }
      // Failure to refresh the timeline must not misreport a successful file write.
      try {
        const list = await fetchHistoryVersions(agentId, selectedPath);
        if (isCurrent()) setVersions(list);
      } catch (err) {
        console.warn('[FileHistory] post-restore history refresh failed:', err);
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof FileHistoryRestoreConflictError) {
        // Another writer changed the file after we previewed it. Refresh the
        // comparison and version token but NEVER automatically retry the write.
        setStatus('conflict');
        setCurrentVersion(null);
        setCurrentText(null);
        if (nativeRoot) {
          const filePath = `${nativeRoot.replace(/\/+$/, '')}/${selectedPath}`;
          try {
            const latest = await window.platform?.readFileSnapshot?.(filePath);
            if (isCurrent() && latest) {
              setCurrentText(latest.content ?? null);
              const version = latest.version;
              if (version && typeof version === 'object'
                && ('mtimeMs' in version || 'sha256' in version)) {
                setCurrentVersion(version as FileHistoryExpectedVersion);
              }
            }
          } catch {
            // Without a new version token, retry stays disabled.
          }
        }
      } else {
        setStatus('error');
      }
    } finally {
      restoreInFlight.current = false;
    }
  }, [modal.open, agentId, selectedVersion, selectedPath, snapshotLoading, snapshotText, status, t, nativeRoot, currentVersion]);

  const visibleFiles = files.filter(f => !filter || f.relPath.includes(filter));
  const activeFiles = visibleFiles.filter(f => f.deletedAt == null);
  const deletedFiles = visibleFiles.filter(f => f.deletedAt != null);

  return (
    <Overlay scope="inline" open={modal.open} onClose={close} backdrop="blur" className={styles.modal} disableContainerAnimation>
      <div className={styles.header}>
        <h2 className={styles.title}>{t('fileHistory.title')}</h2>
        <button className={styles.closeBtn} onClick={close} aria-label="Close">×</button>
      </div>
      <div className={styles.body}>
        <aside className={styles.fileList}>
          <input
            className={styles.search}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={t('fileHistory.searchPlaceholder')}
          />
          {activeFiles.map(f => (
            <button key={f.relPath} type="button"
              className={`${styles.fileRow}${selectedPath === f.relPath ? ` ${styles.fileRowActive}` : ''}`}
              disabled={status === 'restoring'}
              onClick={() => { setSelectedPath(f.relPath); setStatus('idle'); }}>
              {f.relPath}
            </button>
          ))}
          {deletedFiles.length > 0 && (
            <div className={styles.deletedGroup}>
              <div className={styles.groupLabel}>{t('fileHistory.deletedGroup')}</div>
              {deletedFiles.map(f => (
                <button key={f.relPath} type="button"
                  className={`${styles.fileRow} ${styles.fileRowDeleted}${selectedPath === f.relPath ? ` ${styles.fileRowActive}` : ''}`}
                  disabled={status === 'restoring'}
              onClick={() => { setSelectedPath(f.relPath); setStatus('idle'); }}>
                  {f.relPath}
                </button>
              ))}
            </div>
          )}
          {files.length === 0 && status !== 'loading' && (
            <div className={styles.empty}>{t('fileHistory.empty')}</div>
          )}
        </aside>
        <section className={styles.timeline}>
          {versions.map(v => (
            <button key={v.id} type="button" data-testid={`fh-version-${v.id}`}
              className={`${styles.versionRow}${selectedVersion === v.id ? ` ${styles.versionRowActive}` : ''}`}
              disabled={status === 'restoring'}
              onClick={() => { setSelectedVersion(v.id); setStatus('idle'); }}>
              <span className={styles.versionTime}>{new Date(v.capturedAt).toLocaleString()}</span>
              <span className={styles.versionOrigin}>{t(`fileHistory.origin.${v.origin}`)}</span>
            </button>
          ))}
          {selectedPath && versions.length === 0 && (
            <div className={styles.empty}>{t('fileHistory.noVersions')}</div>
          )}
        </section>
        <section className={styles.diffPane}>
          {diff ? (
            <pre className={styles.diff}>
              {diff.map((line, i) => (
                <div key={i} className={
                  line.kind === 'added' ? styles.lineAdded
                    : line.kind === 'removed' ? styles.lineRemoved
                      : styles.lineSame
                }>{line.text || ' '}</div>
              ))}
            </pre>
          ) : snapshotText != null ? (
            <pre className={styles.diff}>{snapshotText}</pre>
          ) : (
            <div className={styles.empty}>{t('fileHistory.selectVersion')}</div>
          )}
          <div className={styles.actions}>
            {status === 'restored' && <span className={styles.restoredNote}>{t('fileHistory.restoreDone')}</span>}
            {status === 'error' && <span className={styles.errorNote}>{t('fileHistory.error')}</span>}
            {status === 'conflict' && <span className={styles.errorNote}>{t('fileHistory.restoreConflict')}</span>}
            <button type="button" data-testid="fh-restore" className={styles.restoreBtn}
              disabled={selectedVersion == null || snapshotLoading || snapshotText == null || status === 'restoring' || (status === 'conflict' && currentVersion == null)}
              onClick={handleRestore}>
              {t('fileHistory.restore')}
            </button>
          </div>
        </section>
      </div>
    </Overlay>
  );
}
