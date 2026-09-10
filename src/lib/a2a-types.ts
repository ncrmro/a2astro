/**
 * Minimal A2A v1 (HTTP+JSON, ProtoJSON names) types, mirroring
 * ai-outfitter/channels `extensions/a2a/types.ts`.
 */
export const A2A_PROTOCOL_VERSION = '1.0' as const;
export const A2A_MEDIA_TYPE = 'application/a2a+json' as const;
export const A2A_EXTENSIONS_HEADER = 'a2a-extensions' as const;
export const AGENT_CARD_PATH = '/.well-known/agent-card.json' as const;
export const OUTFITTER_TASK_EXTENSION_URI =
  'https://github.com/ai-outfitter/channels/a2a-extensions/outfitter-task/v1' as const;
export const ELICITATION_EXTENSION_URI =
  'https://github.com/ai-outfitter/channels/a2a-extensions/elicitation/v1' as const;
export const ELICITATION_EXTENSION_KEY = 'elicitation/v1' as const;
/** Metadata key a2astro writes on messages it sends and reads back from tasks. */
export const A2ASTRO_METADATA_KEY = 'a2astro/v1' as const;
/** Metadata key of the outfitter-task/v1 A2A extension payload. */
export const OUTFITTER_TASK_METADATA_KEY = 'outfitter-task/v1' as const;

export const TASK_STATES = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
] as const;
export type A2aTaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: readonly A2aTaskState[] = [
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
];
export const INTERRUPTED_TASK_STATES: readonly A2aTaskState[] = ['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'];
export const isTerminal = (state: A2aTaskState): boolean => TERMINAL_TASK_STATES.includes(state);
export const isSettled = (state: A2aTaskState): boolean => isTerminal(state) || INTERRUPTED_TASK_STATES.includes(state);

export type A2aRole = 'ROLE_UNSPECIFIED' | 'ROLE_USER' | 'ROLE_AGENT';

export interface A2aPart {
  readonly text?: string;
  readonly raw?: string;
  readonly url?: string;
  readonly data?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly filename?: string;
  readonly mediaType?: string;
}

export interface A2aMessage {
  readonly messageId: string;
  readonly contextId?: string;
  readonly taskId?: string;
  readonly role: A2aRole;
  readonly parts: readonly A2aPart[];
  readonly metadata?: Record<string, unknown>;
  readonly extensions?: readonly string[];
  readonly referenceTaskIds?: readonly string[];
}

export interface A2aArtifact {
  readonly artifactId: string;
  readonly name?: string;
  readonly description?: string;
  readonly parts: readonly A2aPart[];
  readonly metadata?: Record<string, unknown>;
  readonly extensions?: readonly string[];
}

export interface A2aTaskStatus {
  readonly state: A2aTaskState;
  readonly message?: A2aMessage;
  readonly timestamp?: string;
}

export interface A2aTask {
  readonly id: string;
  readonly contextId: string;
  readonly status: A2aTaskStatus;
  readonly artifacts?: readonly A2aArtifact[];
  readonly history?: readonly A2aMessage[];
  readonly metadata?: Record<string, unknown>;
}

export interface A2aSendMessageRequest {
  readonly tenant?: string;
  readonly message: A2aMessage;
  readonly configuration?: { readonly returnImmediately?: boolean; readonly historyLength?: number };
  readonly metadata?: Record<string, unknown>;
}

export type A2aSendMessageResponse = { readonly task: A2aTask } | { readonly message: A2aMessage };

export interface A2aTaskStatusUpdateEvent {
  readonly taskId: string;
  readonly contextId: string;
  readonly status: A2aTaskStatus;
  readonly metadata?: Record<string, unknown>;
}

export interface A2aTaskArtifactUpdateEvent {
  readonly taskId: string;
  readonly contextId: string;
  readonly artifact: A2aArtifact;
  readonly append?: boolean;
  readonly lastChunk?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export type A2aStreamResponse =
  | { readonly task: A2aTask }
  | { readonly message: A2aMessage }
  | { readonly statusUpdate: A2aTaskStatusUpdateEvent }
  | { readonly artifactUpdate: A2aTaskArtifactUpdateEvent };

export interface A2aAgentCard {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly supportedInterfaces?: readonly { readonly url: string; readonly protocolBinding: string; readonly protocolVersion: string }[];
  readonly capabilities?: {
    readonly streaming?: boolean;
    readonly pushNotifications?: boolean;
    readonly extensions?: readonly { readonly uri: string; readonly description?: string; readonly required?: boolean }[];
  };
  readonly skills?: readonly unknown[];
}

/** Metadata a2astro attaches to the messages it sends and expects agents to echo/extend. */
export interface A2astroMetadata {
  readonly jobId?: string;
  readonly runId?: string;
  /** Workflow slug the task executes. */
  readonly workflow?: string;
  /** Workflow node id the agent is on (status/artifact updates) or finished (artifacts). */
  readonly node?: string;
  /** Node outcome for the node named above. */
  readonly nodeState?: 'working' | 'done' | 'failed' | 'skipped';
  /** Set on messages sent from the chat surface, so a task renders as a chat turn. */
  readonly chat?: boolean;
  /** When a2astro sent the message; orders turns within a conversation. */
  readonly sentAt?: string;
}

export interface OutfitterTaskMetadata {
  readonly output?: string;
  readonly type?: string;
  readonly value?: Record<string, unknown>;
  readonly ticketRunId?: string;
  readonly idempotency?: {
    readonly messageId?: string;
    readonly scope?: string;
  };
}

export interface ElicitationProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean';
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly enumNames?: readonly string[];
  readonly default?: string | number | boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly format?: 'email' | 'uri' | 'date' | 'date-time';
}

export interface ElicitationSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ElicitationProperty>>;
  readonly required?: readonly string[];
}

export interface ElicitationRequest {
  readonly message: string;
  readonly requestedSchema: ElicitationSchema;
}

export type ElicitationResponse =
  | { readonly action: 'accept'; readonly content: Readonly<Record<string, string | number | boolean>> }
  | { readonly action: 'decline' | 'cancel' };

export const readA2astroMetadata = (metadata: Record<string, unknown> | undefined): A2astroMetadata | undefined => {
  const value = metadata?.[A2ASTRO_METADATA_KEY];
  return typeof value === 'object' && value !== null ? (value as A2astroMetadata) : undefined;
};

export const readOutfitterTaskMetadata = (
  metadata: Record<string, unknown> | undefined,
): OutfitterTaskMetadata | undefined => {
  const value = metadata?.[OUTFITTER_TASK_METADATA_KEY];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as OutfitterTaskMetadata) : undefined;
};

/** Whether an artifact represents a recorded outfitter workflow output. */
export const isOutputArtifact = (artifact: A2aArtifact): boolean => {
  const metadata = readOutfitterTaskMetadata(artifact.metadata);
  return typeof metadata?.output === 'string' && metadata.output.length > 0;
};

/** Short state label for the UI: "working", "input required", … */
export const stateLabel = (state: A2aTaskState): string => state.replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, ' ');

/** Coarse color class for a task state. */
export const stateTone = (state: A2aTaskState): 'idle' | 'active' | 'ok' | 'bad' | 'wait' => {
  switch (state) {
    case 'TASK_STATE_WORKING':
      return 'active';
    case 'TASK_STATE_COMPLETED':
      return 'ok';
    case 'TASK_STATE_FAILED':
    case 'TASK_STATE_REJECTED':
    case 'TASK_STATE_CANCELED':
      return 'bad';
    case 'TASK_STATE_INPUT_REQUIRED':
    case 'TASK_STATE_AUTH_REQUIRED':
      return 'wait';
    default:
      return 'idle';
  }
};

export const textOf = (parts: readonly A2aPart[] | undefined): string =>
  (parts ?? [])
    .map((p) => (typeof p.text === 'string' ? p.text : p.url ? `[${p.filename ?? p.url}]` : p.data !== undefined ? JSON.stringify(p.data) : ''))
    .filter(Boolean)
    .join('\n');
