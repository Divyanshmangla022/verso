import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { AiAction } from '@verso/shared';
import { aiApi } from '../api';
import { textToNodes } from './textToNodes';
import { Modal, useToast } from './ui';

const ACTION_LABELS: Record<AiAction, string> = {
  rewrite: 'Rewrite',
  shorten: 'Shorten',
  expand: 'Expand',
  grammar: 'Fix grammar',
  tone: 'Change tone',
};

const TONES = ['professional', 'casual', 'friendly', 'formal', 'confident'];

export interface AiSelection {
  action: AiAction;
  text: string;
  from: number;
  to: number;
}

export function AiResultModal({
  editor,
  docId,
  selection,
  readOnly,
  onClose,
}: {
  editor: Editor;
  docId: string;
  selection: AiSelection;
  readOnly: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [tone, setTone] = useState(TONES[0]);
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [engine, setEngine] = useState<string>('');
  const [note, setNote] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const runSeq = useRef(0);

  const run = (selectedTone: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++runSeq.current;
    setOutput('');
    setError('');
    setDone(false);
    setRunning(true);
    void aiApi
      .assist(
        { docId, action: selection.action, text: selection.text, ...(selection.action === 'tone' ? { tone: selectedTone } : {}) },
        {
          onMeta: (m) => {
            if (seq !== runSeq.current) return;
            setEngine(m.engine + (m.model ? ` · ${m.model}` : ''));
            setNote(m.note ?? '');
          },
          onChunk: (text) => {
            if (seq === runSeq.current) setOutput((o) => o + text);
          },
          onDone: () => {
            if (seq === runSeq.current) {
              setDone(true);
              setRunning(false);
            }
          },
          onError: (message) => {
            if (seq === runSeq.current) {
              setError(message);
              setRunning(false);
            }
          },
        },
        controller.signal,
      )
      .finally(() => {
        if (seq === runSeq.current) setRunning(false);
      });
  };

  useEffect(() => {
    run(tone);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replaceSelection = () => {
    const nodes = textToNodes(output.trim());
    editor
      .chain()
      .focus()
      .deleteRange({ from: selection.from, to: selection.to })
      .insertContentAt(selection.from, nodes.length === 1 && nodes[0].content ? nodes[0].content : nodes)
      .run();
    onClose();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      toast.show('Copied to clipboard');
    } catch {
      toast.show('Could not access the clipboard', 'error');
    }
  };

  return (
    <Modal
      title={`AI · ${ACTION_LABELS[selection.action]}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={() => run(tone)} disabled={running}>
            ↻ Regenerate
          </button>
          <button className="btn" onClick={copy} disabled={!done || !output}>
            Copy
          </button>
          <button className="btn primary" onClick={replaceSelection} disabled={!done || !output || readOnly} title={readOnly ? 'You have view-only access' : undefined}>
            Replace selection
          </button>
        </>
      }
    >
      {selection.action === 'tone' && (
        <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="muted">Tone:</span>
          <select
            className="select"
            value={tone}
            onChange={(e) => {
              setTone(e.target.value);
              run(e.target.value);
            }}
          >
            {TONES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="muted" style={{ margin: '0 0 6px' }}>
        Original
      </p>
      <div className="ai-output" style={{ maxHeight: 120, opacity: 0.75 }}>
        {selection.text}
      </div>
      <p className="muted" style={{ margin: '14px 0 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
        Result {engine && <span className="badge ai">✨ {engine}</span>} {running && <span className="spinner sm" />}
      </p>
      <div className="ai-output" aria-live="polite">
        {output || (running ? 'Thinking…' : '')}
      </div>
      {note && <div className="ai-note">{note}</div>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}
