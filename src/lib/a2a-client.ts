import type { AgentConfig } from './config.ts';
import {
  A2A_MEDIA_TYPE,
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  type A2aAgentCard,
  type A2aSendMessageRequest,
  type A2aSendMessageResponse,
  type A2aStreamResponse,
  type A2aTask,
  type A2aTaskState,
} from './a2a-types.ts';

export class A2aClientError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ListTasksOptions {
  readonly contextId?: string;
  readonly status?: A2aTaskState;
  readonly statusTimestampAfter?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Thin client over the Channels A2A HTTP+JSON binding for one resident agent. */
export class A2aClient {
  constructor(
    private readonly agent: AgentConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  get baseUrl(): string {
    return this.agent.a2a.url.replace(/\/+$/, '');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { accept: A2A_MEDIA_TYPE, 'a2a-version': A2A_PROTOCOL_VERSION, ...extra };
    if (this.agent.a2a.token) headers.authorization = `Bearer ${this.agent.a2a.token}`;
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers((init.headers as Record<string, string>) ?? {}),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        let reason = 'HTTP_ERROR';
        let message = text || response.statusText;
        try {
          const body = JSON.parse(text) as { message?: string; details?: { reason?: string }[] };
          message = body.message ?? message;
          reason = body.details?.[0]?.reason ?? reason;
        } catch {
          /* non-JSON error body */
        }
        throw new A2aClientError(response.status, reason, `${this.agent.id}: ${message}`);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  card(): Promise<A2aAgentCard> {
    return this.request<A2aAgentCard>(AGENT_CARD_PATH);
  }

  async listTasks(options: ListTasksOptions = {}): Promise<A2aTask[]> {
    const params = new URLSearchParams();
    if (options.contextId) params.set('contextId', options.contextId);
    if (options.status) params.set('status', options.status);
    if (options.statusTimestampAfter) params.set('statusTimestampAfter', options.statusTimestampAfter);
    const query = params.size > 0 ? `?${params}` : '';
    const body = await this.request<{ tasks?: A2aTask[] }>(`/tasks${query}`);
    return body.tasks ?? [];
  }

  getTask(id: string): Promise<A2aTask> {
    return this.request<A2aTask>(`/tasks/${encodeURIComponent(id)}`);
  }

  cancelTask(id: string): Promise<A2aTask> {
    return this.request<A2aTask>(`/tasks/${encodeURIComponent(id)}:cancel`, { method: 'POST', body: '{}', headers: { 'content-type': A2A_MEDIA_TYPE } });
  }

  sendMessage(request: A2aSendMessageRequest): Promise<A2aSendMessageResponse> {
    return this.request<A2aSendMessageResponse>('/message:send', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'content-type': A2A_MEDIA_TYPE },
    });
  }

  /**
   * Open the task's SSE subscription and yield decoded frames until the stream
   * closes or the signal aborts. The bearer token stays server-side.
   */
  async *subscribe(id: string, signal?: AbortSignal): AsyncGenerator<A2aStreamResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/tasks/${encodeURIComponent(id)}:subscribe`, {
      headers: this.headers({ accept: 'text/event-stream' }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new A2aClientError(response.status, 'SUBSCRIBE_FAILED', `${this.agent.id}: subscribe returned ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (data) yield JSON.parse(data) as A2aStreamResponse;
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export const clientFor = (agent: AgentConfig, fetchImpl?: typeof fetch): A2aClient => new A2aClient(agent, fetchImpl);
