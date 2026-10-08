import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../hooks/use-i18n';
import { Overlay } from '../ui';
import {
  listArchivedSessions,
  restoreSession,
  restoreSessions,
  deleteArchivedSession,
  deleteArchivedSessions,
  cleanupArchivedSessions,
  showSidebarToast,
  type ArchivedSession,
} from '../stores/session-actions';
import styles from './ArchivedSessionsModal.module.css';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatAgo(iso: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400_000);
  if (days < 1) return t('time.today');
  if (days === 1) return t('time.yesterday');
  return t('session.archived.daysAgo', { days });
}

interface Props {
  open: boolean;
  onClose: () => void;
  zIndex?: number;
}

export function ArchivedSessionsModal({ open, onClose, zIndex = 1000 }: Props) {
  const { t } = useI18n();
  const [list, setList] = useState<ArchivedSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setList(await listArchivedSessions());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const totalSize = list.reduce((s, x) => s + x.sizeBytes, 0);
  const selectedItems = list.filter(item => selectedPaths.has(item.path));
  const selectedCount = selectedItems.length;
  const allSelected = list.length > 0 && selectedCount === list.length;

  const toggleSelected = (path: string, checked: boolean) => {
    setSelectedPaths(current => {
      const next = new Set(current);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  };
  const clearSelection = () => setSelectedPaths(new Set());
  const selectAll = () => setSelectedPaths(new Set(list.map(item => item.path)));

  const handleBulkRestore = async () => {
    if (selectedCount === 0) return;
    if (!window.confirm(t('session.archived.restoreBulkConfirm', { count: selectedCount }))) return;
    const result = await restoreSessions(selectedItems);
    if (result.conflicts > 0) showSidebarToast(t('session.archived.restoreConflict'));
    else if (result.failed > 0) showSidebarToast(t('session.archived.restoreFailed'));
    clearSelection();
    await refresh();
  };

  const handleBulkDelete = async () => {
    if (selectedCount === 0) return;
    if (!window.confirm(t('session.archived.deleteBulkConfirm', { count: selectedCount }))) return;
    const result = await deleteArchivedSessions(selectedItems);
    if (result.failed > 0) showSidebarToast(t('session.archived.deleteFailed'));
    clearSelection();
    await refresh();
  };

  const handleRestore = async (item: ArchivedSession) => {
    if (!window.confirm(t('session.archived.restoreConfirm'))) return;
    const r = await restoreSession(item);
    if (r.status === 'conflict') {
      showSidebarToast(t('session.archived.restoreConflict'));
      return;
    }
    if (r.status === 'error') {
      showSidebarToast(t('session.archived.restoreFailed'));
      return;
    }
    await refresh();
  };

  const handleDelete = async (item: ArchivedSession) => {
    if (!window.confirm(t('session.archived.deleteConfirm'))) return;
    const ok = await deleteArchivedSession(item);
    if (ok) await refresh();
    else showSidebarToast(t('session.archived.deleteFailed'));
  };

  const handleCleanup = async (days: 30 | 90) => {
    const toDelete = list.filter(
      (x) => Date.now() - new Date(x.archivedAt).getTime() > days * 86400_000,
    );
    if (toDelete.length === 0) {
      showSidebarToast(t('session.archived.cleanupNoMatch'));
      return;
    }
    const size = toDelete.reduce((s, x) => s + x.sizeBytes, 0);
    const msg = t('session.archived.cleanupConfirm', {
      count: toDelete.length,
      size: formatBytes(size),
    });
    if (!window.confirm(msg)) return;
    const { deleted } = await cleanupArchivedSessions(days);
    showSidebarToast(t('session.archived.cleanupDone', { count: deleted }));
    await refresh();
  };

  return (
    <Overlay
      scope="inline"
      open={open}
      onClose={onClose}
      backdrop="blur"
      zIndex={zIndex}
      className={styles.modal}
      disableContainerAnimation
    >
        <div className={styles.header}>
          <h2 className={styles.title}>{t('session.archived.title')}</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className={styles.content}>
          <div className={styles.summaryCard}>
            <span className={styles.summaryText}>
              {t('session.archived.stats', {
                count: list.length,
                size: formatBytes(totalSize),
              })}
            </span>
            <div className={styles.cleanupBtns}>
              <button onClick={() => handleCleanup(30)}>
                {t('session.archived.cleanup30')}
              </button>
              <button onClick={() => handleCleanup(90)}>
                {t('session.archived.cleanup90')}
              </button>
            </div>
            {selectedCount > 0 && (
              <div className={styles.bulkBtns} role="toolbar" aria-label={t('session.archived.bulkToolbar')}>
                <span className={styles.bulkCount}>{t('session.archived.bulkSelected', { count: selectedCount })}</span>
                <button onClick={allSelected ? clearSelection : selectAll}>
                  {allSelected ? t('session.archived.clearSelection') : t('session.archived.selectAll')}
                </button>
                <button onClick={() => { void handleBulkRestore(); }}>
                  {t('session.archived.restore')}
                </button>
                <button className={styles.bulkDanger} onClick={() => { void handleBulkDelete(); }}>
                  {t('session.archived.deleteForever')}
                </button>
              </div>
            )}
          </div>

          <div className={styles.listCard}>
            <div className={styles.list}>
              {loading ? (
                <div className={styles.loading}>{t('common.loading')}</div>
              ) : list.length === 0 ? (
                <div className={styles.empty}>{t('session.archived.empty')}</div>
              ) : (
                list.map((item) => (
                  <div key={item.path} className={`${styles.row}${selectedPaths.has(item.path) ? ` ${styles.rowSelected}` : ''}`}>
                    <label className={styles.rowCheck}>
                      <input
                        type="checkbox"
                        checked={selectedPaths.has(item.path)}
                        onChange={(event) => toggleSelected(item.path, event.target.checked)}
                        aria-label={item.title || t('session.untitled')}
                      />
                    </label>
                    <div className={styles.rowMain}>
                      <div className={styles.rowTitle}>
                        {item.title || t('session.untitled')}
                      </div>
                      <div className={styles.rowMeta}>
                        {item.agentName} · {formatAgo(item.archivedAt, t)} ·{' '}
                        {formatBytes(item.sizeBytes)}
                      </div>
                    </div>
                    <div className={styles.rowActions}>
                      <button
                        title={t('session.archived.restore')}
                        onClick={() => handleRestore(item)}
                      >
                        {t('session.archived.restore')}
                      </button>
                      <button
                        title={t('session.archived.deleteForever')}
                        onClick={() => handleDelete(item)}
                      >
                        {t('session.archived.deleteForever')}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
    </Overlay>
  );
}
