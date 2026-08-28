import { useState, type FormEvent } from 'react';
import type { ShareEntry, ShareRole } from '@verso/shared';
import { api } from '../api';
import { initials, Modal, useToast } from './ui';

export function ShareDialog({
  docId,
  docTitle,
  shares,
  onChanged,
  onClose,
}: {
  docId: string;
  docTitle: string;
  shares: ShareEntry[];
  onChanged: (shares: ShareEntry[]) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ShareRole>('editor');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const grant = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const entry = await api.grantShare(docId, email.trim(), role);
      const next = [...shares.filter((s) => s.user.id !== entry.user.id), entry];
      onChanged(next);
      setEmail('');
      toast.show(`Shared with ${entry.user.name} as ${entry.role}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not share');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (userId: string, targetEmail: string, newRole: ShareRole) => {
    try {
      const entry = await api.grantShare(docId, targetEmail, newRole);
      onChanged([...shares.filter((s) => s.user.id !== userId), entry]);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not update role', 'error');
    }
  };

  const revoke = async (userId: string, name: string) => {
    try {
      await api.revokeShare(docId, userId);
      onChanged(shares.filter((s) => s.user.id !== userId));
      toast.show(`Removed ${name}`);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not revoke access', 'error');
    }
  };

  return (
    <Modal title={`Share “${docTitle}”`} onClose={onClose}>
      <form onSubmit={grant} style={{ display: 'flex', gap: 8 }}>
        <input
          className="input"
          type="email"
          required
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as ShareRole)} aria-label="Role">
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </select>
        <button className="btn primary" disabled={busy || !email.trim()}>
          Share
        </button>
      </form>
      <p className="muted" style={{ margin: '8px 0 0' }}>
        Editors can change content; viewers can only read. The person must already have a Verso account.
      </p>
      {error && <p className="error-text">{error}</p>}

      <div style={{ marginTop: 18 }}>
        {shares.length === 0 ? (
          <p className="muted">Not shared with anyone yet.</p>
        ) : (
          [...shares]
            .sort((a, b) => a.user.name.localeCompare(b.user.name))
            .map((s) => (
              <div key={s.user.id} className="share-row">
                <span className="avatar">{initials(s.user.name)}</span>
                <div className="info">
                  <div className="n">{s.user.name}</div>
                  <div className="e">{s.user.email}</div>
                </div>
                <select
                  className="select"
                  value={s.role}
                  onChange={(e) => void changeRole(s.user.id, s.user.email, e.target.value as ShareRole)}
                  aria-label={`Role for ${s.user.name}`}
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button className="icon-btn danger" title="Remove access" onClick={() => void revoke(s.user.id, s.user.name)}>
                  ✕
                </button>
              </div>
            ))
        )}
      </div>
    </Modal>
  );
}
