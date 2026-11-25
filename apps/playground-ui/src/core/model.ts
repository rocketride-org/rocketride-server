// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The Playground's data shapes: what an agent is (its listing and its
 * sources), what each source takes, and the plain-JSON bodies its chat
 * messages carry. Type-only — no runtime imports, so node:test reads every
 * module that uses these without a shell.
 */

// =============================================================================
// AGENT
// =============================================================================

/** A source's kind as the Playground can tell it without the server's declaration. */
export type SourceKind = 'request' | 'onItsOwn';

/** How a request reaches a request source. */
export type SourceEntry = 'data' | 'tool';

/** The lane typed input is sent on, and the MIME type that selects it. */
export type TypedLane = 'questions' | 'text' | 'json';

/** One source of an agent, as the Playground reads it. */
export interface AgentSource {
	/** The source's full address (`developerId.pipelineId.source`). */
	address: string;
	/** The source component's id. */
	nodeId: string;
	/** The author's name for the source, else its node id. */
	name: string;
	/** The catalog title of the source's service (or the node's name when it can't be told). */
	title: string;
	/** The catalog classTypes the source carries. */
	classTypes: string[];
	/** Whether a caller can send to it. */
	kind: SourceKind;
	/** How a request reaches it (request sources only). */
	entry: SourceEntry;
	/** The lanes the source's service declares on `_source`. */
	lanes: string[];
	/** The lane typed input goes on, or null when it takes no typed input. */
	typed: TypedLane | null;
	/** The declared lanes that carry files (`tags`, `image`, `audio`, `video`). */
	fileLanes: string[];
}

/** An agent's listing: what its catalog row says about it. */
export interface AgentListing {
	/** Display name. */
	name: string;
	/** One-line tagline. */
	tagline?: string;
	/** Icon URL. */
	icon?: string;
	/** README URL. */
	readme?: string;
	/** The source a bare address answers on (component id). */
	defaultSource?: string;
	/** The publisher's developer id. */
	publisher?: string;
}

/** A setting a caller may give the agent (the pipeline's public parameter). */
export interface AgentParameter {
	name: string;
	default: unknown;
	type?: string;
	title?: string;
	description?: string;
	enum?: unknown[];
	minimum?: number;
	maximum?: number;
}

/** Everything the Playground knows about one agent. */
export interface AgentInfo {
	/** The pipe address (`developerId.pipelineId`). */
	pipe: string;
	/** The listing (or names worked out from the address when unlisted). */
	listing: AgentListing;
	/** The rung that answered (`spec`, `me`, `team`, `org`, `public`). */
	rung: string;
	/** The registry version that answered, null for a Play run. */
	version: number | null;
	/** The answering team, on the team rung. */
	teamId?: string;
	/** Every source, in the pipeline's order. */
	sources: AgentSource[];
	/** The source this connection talks to. */
	source: AgentSource | null;
	/** The settings a caller may give it. */
	parameters: AgentParameter[];
}

// =============================================================================
// MESSAGE BODIES
// =============================================================================

/** The body kinds the Playground draws inside a chat bubble. */
export const BODY_UPLOAD = 'upload';
export const BODY_ANSWER = 'answer';
export const BODY_REFUSAL = 'refusal';

/** The agent's one-sentence refusal bubble (files it does not take). */
export interface RefusalBodyData {
	text: string;
}

/** One file in the caller's upload bubble. */
export interface UploadFile {
	name: string;
	size: number;
	mime: string;
	/** Bytes written to its pipe so far. */
	sent: number;
	state: 'waiting' | 'uploading' | 'done' | 'failed' | 'refused';
	/** Why it was refused or failed. */
	reason?: string;
}

/** The caller's upload bubble. */
export interface UploadBodyData {
	files: UploadFile[];
}

/** A pipeline close body, as returned (the keys `result_types` names hold the lanes). */
export type ResultBody = Record<string, unknown>;

/** One file's part of the agent's answer. */
export interface AnswerFile {
	name: string;
	state: 'waiting' | 'working' | 'done' | 'failed';
	/** The latest thinking message of its pipe. */
	latest?: string;
	/** Why it failed. */
	error?: string;
	/** Its close body. */
	result?: ResultBody;
}

/** The agent's answer bubble: progress while it runs, results when done. */
export interface AnswerBodyData {
	state: 'running' | 'done' | 'failed' | 'interrupted';
	/** Epoch ms the request started. */
	startedAt: number;
	/** Epoch ms it settled. */
	endedAt?: number;
	/** Every thinking message, oldest first (capped). */
	thinking: string[];
	/** A question's (or tool call's) result. */
	result?: ResultBody;
	/** A question's (or tool call's) error. */
	error?: string;
	/** The error code the server sent, when it sent one. */
	code?: string;
	/** For files: one entry per file, in drop order. */
	files?: AnswerFile[];
}
