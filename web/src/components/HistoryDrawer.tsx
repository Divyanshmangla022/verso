import { useCallback, useEffect, useState } from 'react';
import type { VersionMeta } from '@verso/shared';
import { api } from '../api';
import { timeAgo, useToast } from './ui';

export function HistoryDrawer({
  docId,
  currentVersion,
  canEdit,
  onRestored,
  onClose,
}: {
  docId: string;
  currentVersion: number;
  canEdit: boolean;
  onRestored: (content: unknown, version: number) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [list, setList] = useState<VersionMeta[] | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  const reload = useCallback(() => {
    api
      .listVersions(docId)
      .then(setList)
      .catch(() => setList([]));
  }, [docId]);

  useEffect(reload, [reload, currentVersion]);

  const restore = async (version: number) => {
    setRestoring(version);
    try {
      const result = await api.restoreVersion(docId, version);
      onRestored(result.content, result.version);
      toast.show(`Restored version ${version}`);
      reload();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Restore failed', 'error');
    } finally {
      setRestoring(null);
    }
  };

  return (
    <aside className="drawer" aria-label="Version history">
      <div className="drawer-head">
        <span>🕘 Version history</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      <div className="drawer-body">
        <div className="version-row" style={{ background: 'var(--accent-soft)', borderRadius: 8, padding: '10px 10px' }}>
          <div className="who">
            <strong>v{currentVersion}</strong> <span className="badge owner">current</span>
          </div>
        </div>
        {list === null ? (
          <div className="spinner" style={{ marginTop: 14 }} />
        ) : list.length === 0 ? (
          <p className="muted" style={{ marginTop: 14 }}>
            No earlier versions yet. A snapshot is kept every time the document is saved.
          </p>
        ) : (
          list.map((v) => (
            <div key={v.version} className="version-row">
              <div className="who">
                <div>
                  <strong>v{v.version}</strong> · {v.wordCount} words
                </div>
                <div className="when">
                  {v.savedBy ? `${v.savedBy.name} · ` : ''}
                  {timeAgo(v.createdAt)}
                </div>
              </div>
              {canEdit && (
                <button className="btn sm" disabled={restoring !== null} onClick={() => void restore(v.version)}>
                  {restoring === v.version ? 'Restoring…' : 'Restore'}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
