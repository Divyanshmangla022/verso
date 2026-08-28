import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { aiApi } from '../api';
import { textToNodes } from './textToNodes';

interface StreamState {
  output: string;
  running: boolean;
  engine: string;
  note: string;
  error: string;
}

const idle: StreamState = { output: '', running: false, engine: '', note: '', error: '' };

function useAiStream() {
  const [state, setState] = useState<StreamState>(idle);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []); // stop streaming when the panel closes
  const start = (runner: (handlers: Parameters<typeof aiApi.summarize>[1], signal: AbortSignal) => Promise<void>) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ ...idle, running: true });
    void runner(
      {
        onMeta: (m) => setState((s) => ({ ...s, engine: m.engine + (m.model ? ` · ${m.model}` : ''), note: m.note ?? '' })),
        onChunk: (text) => setState((s) => ({ ...s, output: s.output + text })),
        onDone: () => setState((s) => ({ ...s, running: false })),
        onError: (message) => setState((s) => ({ ...s, error: message, running: false })),
      },
      controller.signal,
    );
  };
  return { state, start };
}

export function AiPanel({
  editor,
  docId,
  readOnly,
  onClose,
}: {
  editor: Editor;
  docId: string;
  readOnly: boolean;
  onClose: () => void;
}) {
  const summary = useAiStream();
  const ask = useAiStream();
  const [question, setQuestion] = useState('');

  const insertAtEnd = (text: string) => {
    const end = editor.state.doc.content.size;
    editor.chain().focus().insertContentAt(end, textToNodes(text.trim())).run();
  };

  const askNow = () => {
    if (!question.trim()) return;
    ask.start((handlers, signal) => aiApi.ask({ docId, question: question.trim() }, handlers, signal));
  };

  return (
    <aside className="drawer" aria-label="AI assistant">
      <div className="drawer-head">
        <span>✨ AI assistant</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      <div className="drawer-body">
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>Summarize document</strong>
            {summary.state.engine && <span className="badge ai">✨ {summary.state.engine}</span>}
          </div>
          <button
            className="btn"
            disabled={summary.state.running}
            onClick={() => summary.start((handlers, signal) => aiApi.summarize(docId, handlers, signal))}
          >
            {summary.state.running ? 'Summarizing…' : 'Generate summary'}
          </button>
          {(summary.state.output || summary.state.running) && (
            <div className="ai-output" style={{ marginTop: 10 }} aria-live="polite">
              {summary.state.output || 'Thinking…'}
            </div>
          )}
          {summary.state.note && <div className="ai-note">{summary.state.note}</div>}
          {summary.state.error && <p className="error-text">{summary.state.error}</p>}
          {summary.state.output && !summary.state.running && !readOnly && (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => insertAtEnd('Summary\n\n' + summary.state.output)}>
              Insert into document
            </button>
          )}
        </section>

        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '20px 0' }} />

        <section>
          <strong style={{ fontSize: 14 }}>Ask this document</strong>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              className="input"
              placeholder="e.g. What are the key action items?"
              value={question}
              maxLength={2000}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') askNow();
              }}
            />
            <button className="btn primary" onClick={askNow} disabled={ask.state.running || !question.trim()}>
              Ask
            </button>
          </div>
          {(ask.state.output || ask.state.running) && (
            <div className="ai-output" style={{ marginTop: 10 }} aria-live="polite">
              {ask.state.output || 'Thinking…'}
            </div>
          )}
          {ask.state.note && <div className="ai-note">{ask.state.note}</div>}
          {ask.state.error && <p className="error-text">{ask.state.error}</p>}
        </section>

        <p className="muted" style={{ marginTop: 24 }}>
          Tip: select text in the document to get rewrite, shorten, expand, grammar, and tone actions.
        </p>
      </div>
    </aside>
  );
}
