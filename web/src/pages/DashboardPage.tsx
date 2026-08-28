import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DocListResponse, DocSummary } from '@verso/shared';
import { api, ApiRequestError } from '../api';
import { useAuth } from '../auth';
import { initials, Modal, timeAgo, ToastProvider, useToast } from '../components/ui';

export function DashboardPage() {
  return (
    <ToastProvider>
      <DashboardInner />
    </ToastProvider>
  );
}

function DashboardInner() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [docs, setDocs] = useState<DocListResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<DocSummary | null>(null);
  const [deleting, setDeleting] = useState<DocSummary | null>(null);
  const [meta, setMeta] = useState<{ supportedImports: string[]; maxUploadMb: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    api
      .listDocs()
      .then(setDocs)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load documents'));
  }, []);

  useEffect(() => {
    reload();
    api.meta().then(setMeta).catch(() => undefined);
  }, [reload]);

  const createDoc = async () => {
    setBusy(true);
    try {
      const doc = await api.createDoc();
      navigate(`/doc/${doc.id}`);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not create document', 'error');
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const result = await api.importFile(file);
      toast.show(`Imported "${result.title}"`);
      navigate(`/doc/${result.id}`);
    } catch (err) {
      const msg =
        err instanceof ApiRequestError && err.status === 413
          ? `File is too large (limit ${meta?.maxUploadMb ?? 10} MB)`
          : err instanceof Error
            ? err.message
            : 'Import failed';
      toast.show(msg, 'error');
      setBusy(false);
    }
  };

  const acceptTypes = meta?.supportedImports.join(',') ?? '.txt,.md,.docx';

  return (
    <div>
      <header className="topbar">
        <div className="brand" style={{ fontSize: 18 }}>
          <span className="brand-mark">V</span> Verso
        </div>
        <div className="spacer" />
        <div className="userchip">
          <span className="avatar">{initials(user?.name ?? '?')}</span>
          <span>{user?.name}</span>
          <button className="btn ghost sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="dash">
        <div className="dash-actions">
          <button className="btn primary" onClick={createDoc} disabled={busy}>
            + New document
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            ⬆ Import file
          </button>
          <span className="muted">Supported imports: {meta?.supportedImports.join(', ') ?? '.txt, .md, .docx'} (max {meta?.maxUploadMb ?? 10} MB)</span>
          <input
            ref={fileRef}
            type="file"
            accept={acceptTypes}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = '';
            }}
          />
        </div>

        {error && <p className="error-text">{error}</p>}
        {!docs && !error && (
          <div className="page-center" style={{ height: 200 }}>
            <div className="spinner" />
          </div>
        )}

        {docs && (
          <>
            <h2>My documents</h2>
            {docs.owned.length === 0 ? (
              <div className="empty">No documents yet — create one or import a file to get started.</div>
            ) : (
              <div className="doc-grid">
                {docs.owned.map((d) => (
                  <DocCard key={d.id} doc={d} onOpen={() => navigate(`/doc/${d.id}`)} onRename={() => setRenaming(d)} onDelete={() => setDeleting(d)} />
                ))}
              </div>
            )}

            <h2>Shared with me</h2>
            {docs.shared.length === 0 ? (
              <div className="empty">Nothing has been shared with you yet.</div>
            ) : (
              <div className="doc-grid">
                {docs.shared.map((d) => (
                  <DocCard key={d.id} doc={d} onOpen={() => navigate(`/doc/${d.id}`)} />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {renaming && (
        <RenameModal
          doc={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            reload();
          }}
        />
      )}
      {deleting && (
        <Modal
          title="Delete document?"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  try {
                    await api.deleteDoc(deleting.id);
                    toast.show('Document deleted');
                  } catch (err) {
                    toast.show(err instanceof Error ? err.message : 'Delete failed', 'error');
                  }
                  setDeleting(null);
                  reload();
                }}
              >
                Delete permanently
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            “{deleting.title}” and its attachments, shares, and version history will be permanently deleted
            {deleting.sharedWithCount > 0 ? ` for you and ${deleting.sharedWithCount} collaborator${deleting.sharedWithCount > 1 ? 's' : ''}` : ''}.
          </p>
        </Modal>
      )}
    </div>
  );
}

function DocCard({
  doc,
  onOpen,
  onRename,
  onDelete,
}: {
  doc: DocSummary;
  onOpen: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const isOwned = doc.myRole === 'owner';
  return (
    <div
      className="doc-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <div className="title">{doc.title}</div>
        {isOwned && (
          <div className="card-actions" onClick={(e) => e.stopPropagation()}>
            {onRename && (
              <button className="icon-btn" title="Rename" onClick={onRename}>
                ✎
              </button>
            )}
            {onDelete && (
              <button className="icon-btn danger" title="Delete" onClick={onDelete}>
                🗑
              </button>
            )}
          </div>
        )}
      </div>
      <div className="meta">
        <span className={`badge ${doc.myRole}`}>{doc.myRole}</span>
        {!isOwned && <span>by {doc.owner.name}</span>}
        {isOwned && doc.sharedWithCount > 0 && <span>shared with {doc.sharedWithCount}</span>}
        <span>· {timeAgo(doc.updatedAt)}</span>
      </div>
    </div>
  );
}

function RenameModal({ doc, onClose, onRenamed }: { doc: DocSummary; onClose: () => void; onRenamed: () => void }) {
  const [title, setTitle] = useState(doc.title);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.renameDoc(doc.id, title.trim());
      onRenamed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Rename document"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || title.trim().length === 0}>
            Save
          </button>
        </>
      }
    >
      <input
        className="input"
        value={title}
        maxLength={200}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && title.trim()) void save();
        }}
      />
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}
