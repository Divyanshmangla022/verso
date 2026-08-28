import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';

/**
 * Formatting toolbar. TipTap v3 does not re-render React on every editor
 * transaction, so active states are derived through useEditorState — it
 * subscribes to transactions and re-renders only when the selected slice changes.
 */
export function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 1 })
        ? 'h1'
        : e.isActive('heading', { level: 2 })
          ? 'h2'
          : e.isActive('heading', { level: 3 })
            ? 'h3'
            : 'p',
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const setBlock = (value: string) => {
    const chain = editor.chain().focus();
    if (value === 'p') chain.setParagraph().run();
    else chain.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <button className="tbtn" title="Undo (⌘Z)" disabled={!state.canUndo} onClick={() => editor.chain().focus().undo().run()}>
        ↺
      </button>
      <button className="tbtn" title="Redo (⌘⇧Z)" disabled={!state.canRedo} onClick={() => editor.chain().focus().redo().run()}>
        ↻
      </button>
      <span className="divider" />
      <select className="block-select" value={state.block} onChange={(e) => setBlock(e.target.value)} title="Text style">
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <span className="divider" />
      <button className={`tbtn ${state.bold ? 'on' : ''}`} title="Bold (⌘B)" onClick={() => editor.chain().focus().toggleBold().run()}>
        <b>B</b>
      </button>
      <button className={`tbtn ${state.italic ? 'on' : ''}`} title="Italic (⌘I)" onClick={() => editor.chain().focus().toggleItalic().run()}>
        <i>I</i>
      </button>
      <button className={`tbtn ${state.underline ? 'on' : ''}`} title="Underline (⌘U)" onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <u>U</u>
      </button>
      <button className={`tbtn ${state.strike ? 'on' : ''}`} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}>
        <s>S</s>
      </button>
      <button className={`tbtn ${state.code ? 'on' : ''}`} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}>
        {'<>'}
      </button>
      <span className="divider" />
      <button className={`tbtn ${state.bulletList ? 'on' : ''}`} title="Bulleted list" onClick={() => editor.chain().focus().toggleBulletList().run()}>
        ≔
      </button>
      <button className={`tbtn ${state.orderedList ? 'on' : ''}`} title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        1.
      </button>
      <button className={`tbtn ${state.blockquote ? 'on' : ''}`} title="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        ❝
      </button>
      <button className={`tbtn ${state.codeBlock ? 'on' : ''}`} title="Code block" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        {'{ }'}
      </button>
      <button className="tbtn" title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        —
      </button>
    </div>
  );
}
