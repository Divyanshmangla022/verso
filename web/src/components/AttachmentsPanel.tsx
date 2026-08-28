import { useEffect, useRef, useState } from 'react';
import type { AttachmentMeta } from '@verso/shared';
import { api, ApiRequestError } from '../api';
import { formatBytes, timeAgo, useToast } from './ui';

export function AttachmentsPanel({
  docId,
  canEdit,
  maxUploadMb,
  onClose,
}: {
  docId: string;
  canEdit: boolean;
  maxUploadMb: number;
  onClose: () => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<AttachmentMeta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listAttachments(docId)
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const meta = await api.uploadAttachment(docId, file);
      setItems((list) => [meta, ...(list ?? [])]);
      toast.show(`Attached ${meta.name}`);
    } catch (err) {
      const msg =
        err instanceof ApiRequestError && err.status === 413
          ? `File is too large (limit ${maxUploadMb} MB)`
          : err instanceof Error
            ? err.message
            : 'Upload failed';
      toast.show(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: AttachmentMeta) => {
    try {
      await api.deleteAttachment(docId, a.id);
      setItems((list) => (list ?? []).filter((x) => x.id !== a.id));
      toast.show('Attachment deleted');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  return (
    <aside className="drawer" aria-label="Attachments">
      <div className="drawer-head">
        <span>📎 Attachments</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      <div className="drawer-body">
        {canEdit && (
          <>
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? 'Uploading...' : '⬆ Attach a file'}
            </button>
            <p className="muted" style={{ margin: '6px 0 14px' }}>
              Any file type, up to {maxUploadMb} MB.
            </p>
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = '';
              }}
            />
          </>
        )}
        {items === null ? (
          <div className="spinner" />
        ) : items.length === 0 ? (
          <p className="muted">No attachments on this document.</p>
        ) : (
          items.map((a) => (
            <div key={a.id} className="attach-row">
              <span
                className="name"
                title={`Download ${a.name}`}
                onClick={() => void api.downloadAttachment(docId, a.id, a.name).catch(() => toast.show('Download failed', 'error'))}
              >
                {a.name}
              </span>
              <span className="size">
                {formatBytes(a.size)} · {timeAgo(a.createdAt)}
              </span>
              {canEdit && (
                <button className="icon-btn danger" title="Delete attachment" onClick={() => void remove(a)}>
                  ✕
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
