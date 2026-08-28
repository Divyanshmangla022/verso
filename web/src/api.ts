import type {
  AiAskRequest,
  AiAssistRequest,
  AiStreamEvent,
  AttachmentMeta,
  AuthResponse,
  DocDetail,
  DocListResponse,
  PMNode,
  SaveContentResponse,
  ShareEntry,
  ShareRole,
  VersionMeta,
} from '@verso/shared';

const TOKEN_KEY = 'verso.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — session-only auth */
  }
}

export class ApiRequestError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiRequestError(0, 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get('Content-Type')?.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiRequestError(res.status, message, (body as { details?: unknown } | null)?.details);
  }
  return body as T;
}

// ---- auth ----
export const api = {
  login: (email: string, password: string) =>
    request<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, name: string, password: string) =>
    request<AuthResponse>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name, password }) }),
  me: () => request<{ user: AuthResponse['user'] }>('/api/auth/me'),
  meta: () =>
    request<{ supportedImports: string[]; maxUploadMb: number; ai: { enabled: boolean; engine: string } }>('/api/meta'),

  // ---- documents ----
  listDocs: () => request<DocListResponse>('/api/docs'),
  createDoc: (title?: string) =>
    request<DocDetail>('/api/docs', { method: 'POST', body: JSON.stringify(title ? { title } : {}) }),
  getDoc: (id: string) => request<DocDetail>(`/api/docs/${id}`),
  renameDoc: (id: string, title: string) =>
    request<{ title: string; updatedAt: string }>(`/api/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  saveContent: (id: string, content: PMNode, baseVersion: number) =>
    request<SaveContentResponse>(`/api/docs/${id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content, baseVersion }),
    }),
  deleteDoc: (id: string) => request<void>(`/api/docs/${id}`, { method: 'DELETE' }),

  // ---- versions ----
  listVersions: (id: string) => request<VersionMeta[]>(`/api/docs/${id}/versions`),
  getVersion: (id: string, version: number) =>
    request<{ version: number; title: string; content: PMNode; createdAt: string }>(`/api/docs/${id}/versions/${version}`),
  restoreVersion: (id: string, version: number) =>
    request<SaveContentResponse & { content: PMNode }>(`/api/docs/${id}/versions/${version}/restore`, { method: 'POST' }),

  // ---- sharing ----
  grantShare: (id: string, email: string, role: ShareRole) =>
    request<ShareEntry>(`/api/docs/${id}/shares`, { method: 'POST', body: JSON.stringify({ email, role }) }),
  revokeShare: (id: string, userId: string) => request<void>(`/api/docs/${id}/shares/${userId}`, { method: 'DELETE' }),

  // ---- files ----
  importFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ id: string; title: string; importedFrom: string }>('/api/docs/import', {
      method: 'POST',
      body: form,
    });
  },
  uploadAttachment: (docId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<AttachmentMeta>(`/api/docs/${docId}/attachments`, { method: 'POST', body: form });
  },
  listAttachments: (docId: string) => request<AttachmentMeta[]>(`/api/docs/${docId}/attachments`),
  deleteAttachment: (docId: string, fileId: string) =>
    request<void>(`/api/docs/${docId}/attachments/${fileId}`, { method: 'DELETE' }),
  downloadAttachment: async (docId: string, fileId: string, name: string) => {
    const token = getToken();
    const res = await fetch(`/api/docs/${docId}/attachments/${fileId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiRequestError(res.status, 'Download failed');
    const blob = await res.blob();
    triggerDownload(blob, name);
  },
  exportDoc: async (docId: string, format: 'md' | 'txt', title: string) => {
    const token = getToken();
    const res = await fetch(`/api/docs/${docId}/export?format=${format}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiRequestError(res.status, 'Export failed');
    const blob = await res.blob();
    triggerDownload(blob, `${title || 'document'}.${format}`);
  },
};

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- AI streaming (SSE over POST) ----
export interface AiStreamHandlers {
  onMeta?: (meta: Extract<AiStreamEvent, { type: 'meta' }>) => void;
  onChunk: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

async function streamSse(path: string, body: unknown, handlers: AiStreamHandlers, signal?: AbortSignal): Promise<void> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    handlers.onError?.('Cannot reach the server.');
    return;
  }
  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => null);
    handlers.onError?.((json as { error?: string } | null)?.error ?? `AI request failed (${res.status})`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        if (!data) continue;
        let event: AiStreamEvent;
        try {
          event = JSON.parse(data) as AiStreamEvent;
        } catch {
          continue;
        }
        if (event.type === 'meta') handlers.onMeta?.(event);
        else if (event.type === 'chunk') handlers.onChunk(event.text);
        else if (event.type === 'done') handlers.onDone?.();
        else if (event.type === 'error') handlers.onError?.(event.message);
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') handlers.onError?.('The AI stream was interrupted.');
  }
}

export const aiApi = {
  assist: (body: AiAssistRequest, handlers: AiStreamHandlers, signal?: AbortSignal) =>
    streamSse('/api/ai/assist', body, handlers, signal),
  summarize: (docId: string, handlers: AiStreamHandlers, signal?: AbortSignal) =>
    streamSse('/api/ai/summarize', { docId }, handlers, signal),
  ask: (body: AiAskRequest, handlers: AiStreamHandlers, signal?: AbortSignal) =>
    streamSse('/api/ai/ask', body, handlers, signal),
};
