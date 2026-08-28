import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { EditorContent, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import type { AiAction, DocDetail, PMNode } from '@verso/shared';
import { api, ApiRequestError } from '../api';
import { useAuth } from '../auth';
import { AiResultModal, type AiSelection } from '../components/AiResultModal';
import { AiPanel } from '../components/AiPanel';
import { AttachmentsPanel } from '../components/AttachmentsPanel';
import { HistoryDrawer } from '../components/HistoryDrawer';
import { ShareDialog } from '../components/ShareDialog';
import { Toolbar } from '../components/Toolbar';
import { initials, ToastProvider, useToast } from '../components/ui';

/**
 * Save state machine:
 *  saved    — editor content matches the server
 *  dirty    — local changes await the debounced autosave
 *  saving   — a PUT is in flight
 *  error    — transient failure; dirty is preserved and a retry is scheduled
 *  conflict — server moved past baseVersion; autosave halts, banner offers reload;
 *             local edits stay in the editor (and keep the unload warning) until then
 *  denied   — access was revoked mid-session; editor flips to read-only
 */
type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'denied';
type Panel = 'ai' | 'attachments' | 'history' | null;

const AUTOSAVE_DEBOUNCE_MS = 900;

export function EditorPage() {
  return (
    <ToastProvider>
      <EditorInner />
    </ToastProvider>
  );
}

function EditorInner() {
  const { id = '' } = useParams();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [currentVersion, setCurrentVersion] = useState(0);
  const [panel, setPanel] = useState<Panel>(null);
  const [showShare, setShowShare] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [aiSelection, setAiSelection] = useState<AiSelection | null>(null);
  const [title, setTitle] = useState('');
  const [maxUploadMb, setMaxUploadMb] = useState(10);

  const versionRef = useRef(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const haltedRef = useRef(false); // true in conflict/denied: no more autosaves
  const modalOpenRef = useRef(false);
  modalOpenRef.current = showShare || aiSelection !== null || showExport;

  const readOnly = doc ? doc.myRole === 'viewer' || saveState === 'denied' : true;
  const isOwner = doc?.myRole === 'owner';

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({ placeholder: 'Start writing, or select text for AI actions…' }),
    ],
    editable: false,
    onUpdate: () => {
      // Always track dirtiness (so the unload warning stays honest), but only
      // schedule autosaves while the machine is allowed to save.
      dirtyRef.current = true;
      if (haltedRef.current) return;
      setSaveState((s) => (s === 'saving' ? s : 'dirty'));
      scheduleSave();
    },
  });

  // ---- load ----
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setLoadError('');
    api
      .getDoc(id)
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setTitle(d.title);
        versionRef.current = d.version;
        setCurrentVersion(d.version);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to open document');
      });
    api.meta().then((m) => setMaxUploadMb(m.maxUploadMb)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Push loaded content into the editor once both exist.
  useEffect(() => {
    if (!editor || !doc) return;
    haltedRef.current = false;
    editor.commands.setContent(doc.content as never, { emitUpdate: false });
    editor.setEditable(doc.myRole !== 'viewer');
    dirtyRef.current = false;
    setSaveState('saved');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, doc?.id]);

  // ---- autosave ----
  const saveNow = useCallback((): Promise<void> => {
    if (!editor || haltedRef.current || !dirtyRef.current) return savingRef.current ?? Promise.resolve();
    if (savingRef.current) return savingRef.current; // one flight at a time; finally() reschedules
    dirtyRef.current = false;
    setSaveState('saving');
    const content = editor.getJSON() as PMNode;
    const flight = (async () => {
      try {
        const result = await api.saveContent(id, content, versionRef.current);
        versionRef.current = result.version;
        setCurrentVersion(result.version);
        setSaveState(dirtyRef.current ? 'dirty' : 'saved');
      } catch (err) {
        dirtyRef.current = true; // whatever happened, this content is not on the server
        if (err instanceof ApiRequestError && err.status === 409) {
          haltedRef.current = true;
          setSaveState('conflict');
        } else if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) {
          haltedRef.current = true;
          setSaveState('denied');
          editor.setEditable(false);
        } else {
          setSaveState('error');
          scheduleSave(); // transient: retry
        }
      } finally {
        savingRef.current = null;
        if (dirtyRef.current && !haltedRef.current) scheduleSave();
      }
    })();
    savingRef.current = flight;
    return flight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, id]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void saveNow(), AUTOSAVE_DEBOUNCE_MS);
  }, [saveNow]);

  // Flush on Cmd/Ctrl+S and when the tab is hidden.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow();
      }
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') void saveNow();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [saveNow]);

  // Warn before closing while any local change is not on the server.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || savingRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // ---- title rename ----
  const commitTitle = async () => {
    if (!doc || readOnly) return;
    const next = title.trim();
    if (!next || next === doc.title) {
      setTitle(doc.title);
      return;
    }
    try {
      await api.renameDoc(doc.id, next);
      setDoc({ ...doc, title: next });
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Rename failed', 'error');
      setTitle(doc.title);
    }
  };

  const reloadLatest = async () => {
    try {
      const d = await api.getDoc(id);
      setDoc(d);
      setTitle(d.title);
      versionRef.current = d.version;
      setCurrentVersion(d.version);
      haltedRef.current = false;
      dirtyRef.current = false;
      if (editor) {
        editor.commands.setContent(d.content as never, { emitUpdate: false });
        editor.setEditable(d.myRole !== 'viewer');
      }
      setSaveState('saved');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Reload failed', 'error');
    }
  };

  // ---- version restore (flushes pending work first so nothing is silently lost) ----
  const restoreVersion = async (version: number): Promise<boolean> => {
    if (!editor) return false;
    if (timerRef.current) clearTimeout(timerRef.current);
    await saveNow(); // flush local edits; sets conflict/denied on failure
    if (haltedRef.current) {
      toast.show('Resolve the banner above before restoring', 'error');
      return false;
    }
    try {
      const result = await api.restoreVersion(id, version);
      versionRef.current = result.version;
      setCurrentVersion(result.version);
      dirtyRef.current = false;
      editor.commands.setContent(result.content as never, { emitUpdate: false });
      setSaveState('saved');
      toast.show(`Restored version ${version}`);
      return true;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        haltedRef.current = true;
        setSaveState('conflict');
      } else {
        toast.show(err instanceof Error ? err.message : 'Restore failed', 'error');
      }
      return false;
    }
  };

  const openAi = (action: AiAction) => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n\n', '\n').trim();
    if (!text) {
      toast.show('Select some text first');
      return;
    }
    setAiSelection({ action, text, from, to });
  };

  if (loadError) {
    return (
      <div className="page-center" style={{ flexDirection: 'column', gap: 14 }}>
        <p className="error-text" style={{ fontSize: 15 }}>{loadError}</p>
        <Link to="/" className="btn">← Back to documents</Link>
      </div>
    );
  }
  if (!doc || !editor) {
    return (
      <div className="page-center">
        <div className="spinner" />
      </div>
    );
  }

  const statusLabel: Record<SaveState, string> = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes…',
    saving: 'Saving…',
    error: 'Save failed — retrying',
    conflict: 'Version conflict',
    denied: 'Access changed',
  };

  return (
    <div className="editor-shell">
      <header className="topbar">
        <button className="btn ghost sm" onClick={() => navigate('/')} title="Back to documents">
          ←
        </button>
        <input
          className="title-input"
          value={title}
          disabled={readOnly}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setTitle(doc.title);
          }}
          aria-label="Document title"
        />
        <span className={`badge ${doc.myRole}`}>{doc.myRole}</span>
        {!readOnly && <span className={`save-status ${saveState === 'conflict' || saveState === 'error' || saveState === 'denied' ? 'error' : ''}`}>{statusLabel[saveState]}</span>}
        <div className="spacer" />
        {isOwner && (
          <button className="btn sm" onClick={() => setShowShare(true)}>
            Share{doc.sharedWith && doc.sharedWith.length > 0 ? ` (${doc.sharedWith.length})` : ''}
          </button>
        )}
        <div style={{ position: 'relative' }}>
          <button className="btn ghost sm" onClick={() => setShowExport((v) => !v)}>
            Export ▾
          </button>
          {showExport && (
            <div
              style={{
                position: 'absolute', right: 0, top: '110%', background: 'var(--surface)',
                border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-lg)',
                padding: 4, zIndex: 80, display: 'flex', flexDirection: 'column', minWidth: 150,
              }}
            >
              <button className="btn ghost sm" onClick={() => { setShowExport(false); void api.exportDoc(doc.id, 'md', doc.title).catch(() => toast.show('Export failed', 'error')); }}>
                Markdown (.md)
              </button>
              <button className="btn ghost sm" onClick={() => { setShowExport(false); void api.exportDoc(doc.id, 'txt', doc.title).catch(() => toast.show('Export failed', 'error')); }}>
                Plain text (.txt)
              </button>
            </div>
          )}
        </div>
        <button className={`btn ghost sm ${panel === 'attachments' ? 'on' : ''}`} title="Attachments" onClick={() => setPanel((p) => (p === 'attachments' ? null : 'attachments'))}>
          📎
        </button>
        <button className={`btn ghost sm ${panel === 'history' ? 'on' : ''}`} title="Version history" onClick={() => setPanel((p) => (p === 'history' ? null : 'history'))}>
          🕘
        </button>
        <button className={`btn sm ${panel === 'ai' ? 'primary' : ''}`} title="AI assistant" onClick={() => setPanel((p) => (p === 'ai' ? null : 'ai'))}>
          ✨ AI
        </button>
        <span className="avatar" title={`${user?.name} — click to sign out`} style={{ cursor: 'pointer' }} onClick={logout}>
          {initials(user?.name ?? '?')}
        </span>
      </header>

      {saveState === 'conflict' && (
        <div className="conflict-banner">
          This document was changed elsewhere. Your latest edits are only in this view — copy anything important, then
          <button className="btn sm" onClick={() => void reloadLatest()}>
            Load latest version
          </button>
        </div>
      )}
      {saveState === 'denied' && (
        <div className="conflict-banner">
          Your access to this document changed — it is now read-only here. Copy any unsaved work before leaving.
        </div>
      )}
      {doc.myRole === 'viewer' && (
        <div className="readonly-banner">
          You have view-only access to this document. Ask {doc.owner.name} for editor access to make changes.
        </div>
      )}

      {!readOnly && <Toolbar editor={editor} />}

      <div className="editor-main">
        <div className="editor-scroll" onClick={(e) => { if (e.target === e.currentTarget) editor.commands.focus(); }}>
          <div className="sheet">
            <EditorContent editor={editor} />
          </div>
        </div>

        {panel === 'ai' && <AiPanel editor={editor} docId={doc.id} readOnly={readOnly} onClose={() => setPanel(null)} />}
        {panel === 'attachments' && (
          <AttachmentsPanel docId={doc.id} canEdit={!readOnly} maxUploadMb={maxUploadMb} onClose={() => setPanel(null)} />
        )}
        {panel === 'history' && (
          <HistoryDrawer
            docId={doc.id}
            currentVersion={currentVersion}
            canEdit={!readOnly}
            onClose={() => setPanel(null)}
            onRestore={restoreVersion}
          />
        )}
      </div>

      <BubbleMenu
        editor={editor}
        options={{ placement: 'top', offset: 10 }}
        shouldShow={({ editor: ed }) => {
          if (modalOpenRef.current) return false;
          const { from, to } = ed.state.selection;
          return to - from > 1 && ed.state.doc.textBetween(from, to).trim().length > 0;
        }}
      >
        <div className="bubble">
          {!readOnly && (
            <>
              <button title="Bold" onClick={() => editor.chain().focus().toggleBold().run()}>
                <b>B</b>
              </button>
              <button title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}>
                <i>I</i>
              </button>
              <button title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()}>
                <u>U</u>
              </button>
              <span className="divider" />
            </>
          )}
          <span className="ai-label">✨ AI</span>
          <button onClick={() => openAi('rewrite')}>Rewrite</button>
          <button onClick={() => openAi('shorten')}>Shorten</button>
          <button onClick={() => openAi('expand')}>Expand</button>
          <button onClick={() => openAi('grammar')}>Grammar</button>
          <button onClick={() => openAi('tone')}>Tone</button>
        </div>
      </BubbleMenu>

      {showShare && isOwner && (
        <ShareDialog
          docId={doc.id}
          docTitle={doc.title}
          shares={doc.sharedWith ?? []}
          onChanged={(sharedWith) => setDoc({ ...doc, sharedWith })}
          onClose={() => setShowShare(false)}
        />
      )}
      {aiSelection && (
        <AiResultModal
          editor={editor}
          docId={doc.id}
          selection={aiSelection}
          readOnly={readOnly}
          onClose={() => setAiSelection(null)}
        />
      )}
      {showExport && <div style={{ position: 'fixed', inset: 0, zIndex: 70 }} onClick={() => setShowExport(false)} />}
    </div>
  );
}
