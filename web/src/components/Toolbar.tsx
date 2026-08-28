import type { Editor } from '@tiptap/core';

/** Formatting toolbar. Reads active states straight from the editor each render. */
export function Toolbar({ editor }: { editor: Editor }) {
  const block = editor.isActive('heading', { level: 1 })
    ? 'h1'
    : editor.isActive('heading', { level: 2 })
      ? 'h2'
      : editor.isActive('heading', { level: 3 })
        ? 'h3'
        : 'p';

  const setBlock = (value: string) => {
    const chain = editor.chain().focus();
    if (value === 'p') chain.setParagraph().run();
    else chain.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <button className="tbtn" title="Undo (⌘Z)" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
        ↺
      </button>
      <button className="tbtn" title="Redo (⌘⇧Z)" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
        ↻
      </button>
      <span className="divider" />
      <select className="block-select" value={block} onChange={(e) => setBlock(e.target.value)} title="Text style">
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <span className="divider" />
      <button className={`tbtn ${editor.isActive('bold') ? 'on' : ''}`} title="Bold (⌘B)" onClick={() => editor.chain().focus().toggleBold().run()}>
        <b>B</b>
      </button>
      <button className={`tbtn ${editor.isActive('italic') ? 'on' : ''}`} title="Italic (⌘I)" onClick={() => editor.chain().focus().toggleItalic().run()}>
        <i>I</i>
      </button>
      <button className={`tbtn ${editor.isActive('underline') ? 'on' : ''}`} title="Underline (⌘U)" onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <u>U</u>
      </button>
      <button className={`tbtn ${editor.isActive('strike') ? 'on' : ''}`} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}>
        <s>S</s>
      </button>
      <button className={`tbtn ${editor.isActive('code') ? 'on' : ''}`} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}>
        {'<>'}
      </button>
      <span className="divider" />
      <button className={`tbtn ${editor.isActive('bulletList') ? 'on' : ''}`} title="Bulleted list" onClick={() => editor.chain().focus().toggleBulletList().run()}>
        ≔
      </button>
      <button className={`tbtn ${editor.isActive('orderedList') ? 'on' : ''}`} title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        1.
      </button>
      <button className={`tbtn ${editor.isActive('blockquote') ? 'on' : ''}`} title="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        ❝
      </button>
      <button className={`tbtn ${editor.isActive('codeBlock') ? 'on' : ''}`} title="Code block" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        {'{ }'}
      </button>
      <button className="tbtn" title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        —
      </button>
    </div>
  );
}
