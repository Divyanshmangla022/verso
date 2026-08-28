import type { AiAction } from '@verso/shared';
import { config } from '../config.ts';

export interface AiRun {
  engine: 'gemini' | 'heuristic';
  model?: string;
  /** Shown by the UI when the fallback engine cannot fully perform an action. */
  note?: string;
  stream: AsyncIterable<string>;
}

interface AssistInput {
  action: AiAction;
  text: string;
  tone?: string;
  docTitle: string;
}

// ---------------------------------------------------------------------------
// Gemini engine (used when GEMINI_API_KEY is configured)
// ---------------------------------------------------------------------------

type GenAiModule = typeof import('@google/genai');
let genaiModule: GenAiModule | null | undefined;

async function loadGenAi(): Promise<GenAiModule | null> {
  if (genaiModule !== undefined) return genaiModule;
  try {
    genaiModule = await import('@google/genai');
  } catch {
    genaiModule = null; // optional dependency not installed
  }
  return genaiModule;
}

export async function geminiAvailable(): Promise<boolean> {
  return Boolean(config.geminiApiKey) && (await loadGenAi()) !== null;
}

async function* geminiStream(systemInstruction: string, prompt: string): AsyncIterable<string> {
  const mod = await loadGenAi();
  if (!mod) throw new Error('@google/genai is not installed');
  const client = new mod.GoogleGenAI({ apiKey: config.geminiApiKey });
  const stream = await client.models.generateContentStream({
    model: config.geminiModel,
    contents: prompt,
    config: {
      systemInstruction,
      temperature: 0.4,
    },
  });
  for await (const chunk of stream) {
    const text = chunk.text;
    if (text) yield text;
  }
}

const ASSIST_SYSTEM = [
  'You are the writing assistant inside Verso, a collaborative document editor.',
  'You are given a passage selected by the user from their document, and one instruction.',
  'Return ONLY the transformed passage as plain text (no markdown fences, no preamble,',
  'no explanations). Preserve the meaning and factual content unless asked otherwise.',
  'Match the original language of the passage.',
].join(' ');

function assistPrompt(input: AssistInput): string {
  const instruction: Record<AiAction, string> = {
    rewrite: 'Rewrite this passage to be clearer and better written.',
    shorten: 'Rewrite this passage to be significantly more concise while keeping every key point.',
    expand: 'Expand this passage with more detail and better flow, staying faithful to its intent.',
    grammar: 'Fix grammar, spelling, and punctuation. Change nothing else.',
    tone: `Rewrite this passage in a ${input.tone ?? 'professional'} tone.`,
  };
  return [
    `Document title: ${input.docTitle}`,
    `Instruction: ${instruction[input.action]}`,
    'Passage:',
    '"""',
    input.text,
    '"""',
  ].join('\n');
}

const SUMMARY_SYSTEM = [
  'You summarize documents for the Verso editor. Produce a tight summary in plain text:',
  'one short overview sentence, then 3-6 bullet points starting with "- ".',
  'Use only information present in the document. Match the document language.',
].join(' ');

const ASK_SYSTEM = [
  'You answer questions about a single document in the Verso editor.',
  'Answer ONLY from the document content provided. If the document does not contain',
  'the answer, say so plainly. Be concise. Plain text only.',
].join(' ');

// ---------------------------------------------------------------------------
// Heuristic engine (no API key needed — honest, rule-based best effort)
// ---------------------------------------------------------------------------

async function* once(text: string): AsyncIterable<string> {
  yield text;
}

const HEURISTIC_NOTE = 'Running in heuristic mode — set GEMINI_API_KEY on the server for full AI quality.';

function cleanupGrammar(text: string): string {
  let out = text.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:!?])/g, '$1');
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (_m, prefix: string, letter: string) => prefix + letter.toUpperCase());
  out = out.replace(/\bi\b/g, 'I');
  return out.trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function heuristicAssist(input: AssistInput): AiRun {
  const { action, text } = input;
  let result: string;
  switch (action) {
    case 'grammar':
    case 'rewrite':
    case 'tone':
      result = cleanupGrammar(text);
      break;
    case 'shorten': {
      const sentences = splitSentences(text);
      const keep = Math.max(1, Math.ceil(sentences.length * 0.5));
      result = sentences.slice(0, keep).join(' ');
      break;
    }
    case 'expand':
      result = cleanupGrammar(text); // cannot invent content without a model
      break;
  }
  return { engine: 'heuristic', note: HEURISTIC_NOTE, stream: once(result) };
}

function heuristicSummary(docText: string): AiRun {
  const paragraphs = docText.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
  const bullets = paragraphs
    .slice(0, 6)
    .map((p) => '- ' + (splitSentences(p)[0] ?? p).slice(0, 220));
  const summary = bullets.length > 0 ? `Key points (extractive):\n${bullets.join('\n')}` : 'This document is empty.';
  return { engine: 'heuristic', note: HEURISTIC_NOTE, stream: once(summary) };
}

function heuristicAsk(docText: string, question: string): AiRun {
  const terms = question
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const paragraphs = docText.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
  const scored = paragraphs
    .map((p) => {
      const lower = p.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
      return { p, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const answer =
    scored.length > 0
      ? 'Most relevant passages from the document:\n\n' + scored.map((s) => '- ' + s.p.slice(0, 300)).join('\n\n')
      : 'I could not find anything in this document related to that question.';
  return { engine: 'heuristic', note: HEURISTIC_NOTE, stream: once(answer) };
}

// ---------------------------------------------------------------------------
// Public API — picks the engine per call so a key added at runtime takes effect
// ---------------------------------------------------------------------------

function clip(text: string): string {
  return text.length > config.aiContextCharLimit ? text.slice(0, config.aiContextCharLimit) + '\n[truncated]' : text;
}

export async function runAssist(input: AssistInput): Promise<AiRun> {
  if (await geminiAvailable()) {
    return {
      engine: 'gemini',
      model: config.geminiModel,
      stream: geminiStream(ASSIST_SYSTEM, assistPrompt({ ...input, text: clip(input.text) })),
    };
  }
  return heuristicAssist(input);
}

export async function runSummarize(docTitle: string, docText: string): Promise<AiRun> {
  if (await geminiAvailable()) {
    const prompt = `Document title: ${docTitle}\n\nDocument content:\n"""\n${clip(docText)}\n"""`;
    return { engine: 'gemini', model: config.geminiModel, stream: geminiStream(SUMMARY_SYSTEM, prompt) };
  }
  return heuristicSummary(docText);
}

export async function runAsk(docTitle: string, docText: string, question: string): Promise<AiRun> {
  if (await geminiAvailable()) {
    const prompt = `Document title: ${docTitle}\n\nDocument content:\n"""\n${clip(docText)}\n"""\n\nQuestion: ${question}`;
    return { engine: 'gemini', model: config.geminiModel, stream: geminiStream(ASK_SYSTEM, prompt) };
  }
  return heuristicAsk(docText, question);
}
