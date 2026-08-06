// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// FROZEN shell-api contract — ShellApiV0 — never edit by hand
// =============================================================================
// Generated:     2026-08-02T00:53:20.419Z
// Source commit: a24f1e0a04dc27a41c4c454a1854858737f5800c
// Generator:     dts-bundle-generator@9.5.1
// Produced by:   ./builder shell:freeze
// =============================================================================

// ===== BEGIN FROZEN BUNDLE — do not edit =====
import React$1 from 'react';
import { CSSProperties, ReactNode, RefObject } from 'react';
import { Options, Sequelize } from 'sequelize';
declare class DAPException extends Error {
    readonly dapResult: Record<string, unknown>;
    constructor(dapResult: Record<string, unknown>);
}
declare class RocketRideException extends DAPException {
    constructor(dapResult: Record<string, unknown>);
}
declare class ConnectionException extends RocketRideException {
    constructor(dapResult: Record<string, unknown>);
}
interface DocMetadata {
    /** Unique identifier for the source document in the RocketRide system. */
    objectId: string;
    /** Position of this chunk within the document (0, 1, 2, etc.). */
    chunkId: number;
    /** Identifier of the RocketRide node/server where this document is stored. */
    nodeId?: string;
    /** File path or name of the source document. This is what you would see in a file browser. */
    parent?: string;
    /** Permission level identifier that controls who can access this document. */
    permissionId?: number;
    /** True if the source document has been deleted but is still in search results. */
    isDeleted?: boolean;
    /** True if this chunk contains structured table data, False for regular text content. */
    isTable?: boolean;
    /** If isTable is True, this identifies which table within the document this data came from. */
    tableId?: number;
    /** Component ID or signature associated with the document processing. */
    signature?: string;
    /** Allow additional fields for extensibility */
    [key: string]: unknown;
}
interface Doc {
    /** Type identifier of the document. */
    type?: string;
    /** The main text content of this document chunk. */
    page_content?: string;
    /** The AI model used to generate embeddings for this document. */
    embedding_model?: string;
    /** Vector representation for semantic search (usually hidden from end users). */
    embedding?: number[];
    /** Relevance score - higher numbers mean more relevant to your query. */
    score?: number;
    /** Additional score for highlighted or featured content. */
    highlight_score?: number;
    /** Additional contextual information related to this document. */
    context?: string[];
    /** Number of tokens in this document (important for AI processing limits). */
    tokens?: number;
    /** Information about the source file, location, permissions, and chunk details. */
    metadata?: DocMetadata;
}
interface DocFilter {
    /** Combine all chunks from the same table into one result. Useful when you need complete table data rather than individual rows. */
    fullTables?: boolean;
    /** Combine all chunks from the same document into one result. Use this when you need complete document content rather than fragments. */
    fullDocuments?: boolean;
    /** Skip this many results for pagination. Use with limit to page through large result sets. */
    offset?: number;
    /** Maximum number of results to return. Higher numbers give more comprehensive results but slower performance. */
    limit?: number;
    /** Only return chunks with ID >= this value. Used for filtering specific document sections. */
    minChunkId?: number;
    /** Only return chunks with ID <= this value. Used for filtering specific document sections. */
    maxChunkId?: number;
    /** Filter results to documents from a specific RocketRide node/server. Useful in multi-node deployments. */
    nodeId?: string;
    /** Filter to documents from a specific parent file or folder path. */
    parent?: string;
    /** Filter to documents with names matching this pattern. */
    name?: string;
    /** Only return documents the user has these permission levels for. Respects access controls. */
    permissions?: number[];
    /** Include (true) or exclude (false) deleted documents. undefined includes both. */
    isDeleted?: boolean;
    /** Only return documents with these specific object IDs. Useful for targeted queries. */
    objectIds?: string[];
    /** Only return these specific document chunks by ID. */
    chunkIds?: number[];
    /** Filter to only table data (true) or exclude tables (false). undefined includes both. */
    isTable?: boolean;
    /** Only return data from these specific table IDs. */
    tableIds?: number[];
    /** Use AI to rerank results for better relevance. Improves quality but adds processing time. */
    useQuickRank?: boolean;
    /** Use AI to rank groups of related documents. Useful for finding the best document among similar ones. */
    useGroupRank?: boolean;
    /** Number of follow-up questions to generate for AI chat. Helps users explore topics further. */
    followUpQuestions?: number;
    /** Include additional context information with search results. Useful for understanding document relationships. */
    context?: boolean;
}
declare enum QuestionType {
    QUESTION = "question",
    SEMANTIC = "semantic",
    KEYWORD = "keyword",
    GET = "get",
    PROMPT = "prompt"
}
interface QuestionHistory {
    /** Who sent this message ('user', 'system', or 'assistant') */
    role: string;
    /** The actual message content */
    content: string;
}
interface QuestionInstruction {
    /** Brief description of what this instruction is about */
    subtitle: string;
    /** Detailed guidance for the AI */
    instructions: string;
}
interface QuestionExample {
    /** Example question or input */
    given: string;
    /** Example response you want for that input */
    result: string;
}
interface QuestionText {
    /** The actual question text */
    text: string;
    /** AI model used for creating embeddings (if any) */
    embedding_model?: string;
    /** Vector representation of the question (if any) */
    embedding?: number[];
}
declare class Question {
    type: QuestionType;
    filter: DocFilter;
    expectJson: boolean;
    role: string;
    instructions: QuestionInstruction[];
    history: QuestionHistory[];
    examples: QuestionExample[];
    context: string[];
    goals: string[];
    documents: Doc[];
    questions: QuestionText[];
    constructor(options?: {
        type?: QuestionType;
        filter?: DocFilter;
        expectJson?: boolean;
        role?: string;
    });
    /**
     * Add a custom instruction to guide the AI's response.
     */
    addInstruction(title: string, instruction: string): void;
    /**
     * Add an example to show the AI the kind of response you want.
     */
    addExample(given: string, result: string | object | unknown[]): void;
    /**
     * Add context information to help the AI understand your question better.
     */
    addContext(context: string | object | string[] | object[]): void;
    /**
     * Add a conversation history item for multi-turn chat.
     */
    addHistory(item: QuestionHistory): void;
    /**
     * Add a high-level goal or objective for the AI to work towards.
     */
    addGoal(goal: string): void;
    /**
     * Add a question to ask the AI.
     */
    addQuestion(question: string): void;
    /**
     * Add specific documents for the AI to reference.
     */
    addDocuments(documents: Doc | Doc[]): void;
    /**
     * Generate the complete prompt text for the AI (used internally).
     */
    getPrompt(hasPreviousJsonFailed?: boolean): string;
    /**
     * Convert Question to dictionary for serialization.
     */
    toDict(): Record<string, unknown>;
    /**
     * Create Question from dictionary.
     */
    static fromDict(data: Record<string, unknown>): Question;
}
interface ApiKeyRecord {
    /** Unique identifier for the key. */
    id: string;
    /** Human-readable label given to the key at creation time. */
    name: string;
    /** Team this key is scoped to, or null for all teams. */
    teamId: string | null;
    /** Display name of the scoped team, or null. */
    teamName: string | null;
    /** Array of permission strings granted to this key. */
    permissions: string[];
    /** ISO timestamp of when the key was created, or null. */
    createdAt: string | null;
    /** ISO timestamp of when the key expires, or null for no expiry. */
    expiresAt: string | null;
    /** ISO timestamp of when the key was last used, or null if never used. */
    lastUsedAt: string | null;
    /** ISO timestamp of when the key was revoked, or null if still active. */
    revokedAt: string | null;
    /** Whether the key is currently active (not expired and not revoked). */
    active: boolean;
    /** Whether this is an auto-managed session key for reconnect persistence. */
    isSession: boolean;
}
interface OrgDetail {
    /** Unique identifier for the organization. */
    id: string;
    /** Display name of the organization. */
    name: string;
    /** The billing / feature plan the organization is on. */
    plan: string;
    /** Total number of members in the organization. */
    memberCount: number;
    /** Total number of teams within the organization. */
    teamCount: number;
}
interface MemberRecord {
    /** Unique identifier of the user. */
    userId: string;
    /** The user's display name. */
    displayName: string;
    /** The user's email address. */
    email: string;
    /** The user's organization-level role (e.g. "admin" or "member"). */
    role: string;
    /** Membership status (e.g. "active" or "pending"). */
    status: string;
    /** ISO timestamp of when the membership was created, or null. */
    createdAt?: string | null;
    /** Teams the member belongs to (id + display name pairs). */
    teams?: Array<{
        id: string;
        name: string;
    }>;
}
interface TeamRecord {
    /** Unique identifier for the team. */
    id: string;
    /** Display name of the team. */
    name: string;
    /** Optional brand color as a CSS hex string, or null to use the generated avatar color. */
    color: string | null;
    /** Number of members currently in the team. */
    memberCount: number;
}
interface TeamDetail {
    /** Unique identifier for the team. */
    id: string;
    /** Display name of the team. */
    name: string;
    /** Optional brand color as a CSS hex string, or null to use the generated avatar color. */
    color: string | null;
    /** Full list of members belonging to this team. */
    members: TeamMemberRecord[];
}
interface TeamMemberRecord {
    /** Unique identifier of the user. */
    userId: string;
    /** The user's display name. */
    displayName: string;
    /** The user's email address. */
    email: string;
    /** Array of permission strings this user holds within the team. */
    permissions: string[];
    /** ISO timestamp of when the user joined the team, or null. */
    createdAt?: string | null;
}
interface ProfileUpdate {
    /** Display name (nickname). */
    displayName: string;
    /** Preferred login / username. */
    preferredUsername: string;
    /** First / given name. */
    givenName: string;
    /** Last / family name. */
    familyName: string;
    /** Primary email address. */
    email: string;
    /** Phone number in E.164 format. */
    phoneNumber: string;
    /** Locale / language preference. */
    locale: string;
}
interface CreateKeyParams {
    /** Human-readable label for the key. */
    name: string;
    /** Array of permission strings to grant to this key. Empty for full PAT. */
    permissions: string[];
    /** Optional ISO timestamp for key expiration. Omit for no expiry. */
    expiresAt?: string;
    /** Optional team UUID to scope this key to. Omit for all teams. */
    teamId?: string;
}
interface InviteMemberParams {
    /** Email address of the person to invite. */
    email: string;
    /** First / given name of the invitee. */
    givenName: string;
    /** Last / family name of the invitee. */
    familyName: string;
    /** Organization-level role to assign (e.g. "admin" or "member"). */
    role: string;
    /**
     * Optional team assignments to create when the invite is accepted.
     * Each entry specifies a team ID and the permissions to grant.
     */
    teamAssignments?: Array<{
        teamId: string;
        permissions: string[];
    }>;
}
interface TeamMemberParams {
    /** The team to add the member to or update within. */
    teamId: string;
    /** The user ID of the member. */
    userId: string;
    /** Permissions to grant within the team. */
    permissions: string[];
}
interface BillingDetail {
    /** App identifier matching AppManifestEntry.id (e.g. "brandi"). */
    appId: string;
    /** Resolved app display name (e.g. "Pipe Builder"). */
    appName?: string;
    /** Stripe sub_* subscription identifier. */
    stripeSubscriptionId: string;
    /** Stripe price_* for the subscribed plan. */
    stripePriceId: string;
    /** One of: active, trialing, past_due, canceled. */
    status: string;
    /** Human-readable plan name from Stripe price nickname (e.g. "Pro Monthly"), or null. */
    planNickname: string | null;
    /** Price in USD cents for the subscribed plan, or null. */
    unitAmount: number | null;
    /** Billing interval: "month" or "year", or null. */
    billingInterval: string | null;
    /** ISO 8601 datetime when the current billing period started, or null. */
    currentPeriodStart: string | null;
    /** ISO 8601 datetime when the current billing period ends, or null. */
    currentPeriodEnd: string | null;
    /** True when the user has requested cancellation at period end. */
    cancelAtPeriodEnd: boolean;
    /** Credit grants config from Stripe price metadata, or null. */
    credits: {
        initial?: Record<string, number>;
        recurring?: Record<string, number>;
    } | null;
    /** Display templates for credit resource types (e.g. ``{amount} minutes of Audio``), or null. */
    labels: Record<string, string> | null;
}
interface AppPrice {
    /** Internal price UUID. */
    id: string;
    /** App identifier. */
    appId: string;
    /** Stripe price_* identifier. */
    stripePriceId: string;
    /** Human-readable tier label (e.g. "Starter", "Pro", "3,700 tokens"). */
    nickname: string;
    /** Price in smallest currency unit (e.g. cents for USD). */
    amountCents: number;
    /** ISO 4217 currency code. */
    currency: string;
    /** Billing interval: "month", "year", or "one_time". */
    interval: "month" | "year" | "one_time" | "";
    /** Full plan metadata from the app manifest (description, action, order, kind, credits, labels, seats, features, etc.). */
    metadata?: Record<string, any> | null;
    /** Whether the price is active. */
    isActive: boolean;
    /** ISO 8601 creation timestamp. */
    createdAt: string | null;
}
interface CreditBalance {
    /** Net balance per resource type (positive = remaining, negative = overspent). */
    balances: Record<string, number>;
    /** Total credits granted (purchased/credited) per resource. */
    granted: Record<string, number>;
    /** Total credits consumed (debited) per resource. */
    consumed: Record<string, number>;
    /**
     * Human-readable display templates per resource type, from Stripe price metadata.
     * Supports ``{amount}`` substitution (e.g. ``"{amount} minutes of Audio"``).
     * Falls back to the raw resource key when a label is not configured.
     */
    labels: Record<string, string>;
}
interface LedgerTransaction {
    /** Auto-increment row ID. */
    id: number;
    /** Transaction type: purchase, usage, credit, refund, etc. */
    type: string;
    /** Resource type (e.g. cpu_utilization, gpu_memory, tokens). */
    resource: string;
    /** Signed amount: positive for credits, negative for debits. */
    amount: number;
    /** Namespaced idempotency key (e.g. task:abc123:cpu_utilization, stripe:cs_xxx:tokens). */
    idempotencyKey: string;
    /** User who triggered the transaction, or null for system events. */
    userId: string | null;
    /** Resolved display name of the triggering user, or null. */
    userName?: string | null;
    /** Team context, or null. */
    teamId: string | null;
    /** Resolved display name of the team context, or null. */
    teamName?: string | null;
    /** Human-readable context (pipeline name, source, pack_id, etc.). */
    context: Record<string, any> | null;
    /** Line-item detail (e.g. gpu_memory, cpu_utilization). */
    description: string | null;
    /** ISO 8601 creation timestamp. */
    createdAt: string | null;
}
interface TransactionsResult {
    /** Transaction rows for the current page. */
    transactions: LedgerTransaction[];
    /** Total matching rows (for pagination). */
    total: number;
    /** Current page number (1-based). */
    page: number;
    /** Rows per page. */
    pageSize: number;
}
interface UsageRollup {
    /** User or team ID (or '__none__' for unattributed). */
    id: string;
    /** Resolved display name of the user or team, or null when unresolvable. */
    name?: string | null;
    /** Consumption per resource type (absolute values — always positive). */
    credits: Record<string, number>;
}
interface PromoValidation {
    /** Whether the code resolved to an active Stripe promotion code. */
    valid: boolean;
    /** Human-readable failure reason when `valid` is false. */
    reason?: string;
    /** Canonical code string as stored in Stripe. */
    code?: string;
    /** Stripe promo_* identifier (informational — never sent back). */
    promotionCodeId?: string;
    /** Human-readable description, e.g. "25% off for 3 months". */
    description?: string;
    /** Percentage discount (e.g. 25 or 100), if percent-based. */
    percentOff?: number | null;
    /** Fixed discount in cents, if amount-based. */
    amountOffCents?: number | null;
    /** ISO currency for `amountOffCents`. */
    currency?: string | null;
    /** Coupon duration: 'once' | 'repeating' | 'forever'. */
    duration?: string | null;
    /** Months the discount repeats for (duration === 'repeating'). */
    durationInMonths?: number | null;
    /** Credits granted on redemption ({resource: amount}) — grant codes only. */
    creditsGranted?: Record<string, number> | null;
    /** Target app for a grant code (e.g. "rocketride.pipeBuilder"). */
    appId?: string | null;
    /** List price in cents of the plan passed as priceId (if any). */
    amountCents?: number;
    /** First-invoice price in cents after the discount (if priceId given). */
    discountedAmountCents?: number;
}
interface PromoRedemption {
    /** True when the redemption succeeded. */
    redeemed: boolean;
    /** 'subscribed' = new $0 subscription created; 'credits_only' = org was already subscribed. */
    mode: "subscribed" | "credits_only";
    /** App the code targets. */
    appId: string;
    /** Subscription status after redemption (e.g. 'active'). */
    status?: string;
    /** Credits granted ({resource: amount}). */
    credits: Record<string, number>;
}
interface CreditPack {
    /** Terraform key ("small", "medium", "large"). */
    packId: string;
    /** Stripe price_* identifier for the one-off pack. */
    priceId: string;
    /** Cost of the pack in USD cents. */
    usdCents: number;
    /** Credits added to the wallet on successful purchase. */
    credits: number;
    /** Human-readable label, e.g. "55k credits (10% bonus)". */
    nickname: string;
}
interface PipelineInputConnection {
    /** Data lane/channel name (e.g., 'text', 'data', 'image') */
    lane: string;
    /** Source component ID providing the data */
    from: string;
}
interface PipelineControlConnection {
    /** Class type of the invoke channel (e.g., 'llm', 'tool', 'memory') */
    classType: string;
    /** Source component ID providing the invocation */
    from: string;
}
interface PipelineComponent {
    /** Unique identifier for this component within the pipeline */
    id: string;
    /** Component type/provider (e.g., 'webhook', 'response', 'ai_chat') */
    provider: string;
    /** Human-readable component name */
    name?: string;
    /** Component description for documentation */
    description?: string;
    /** Component-specific configuration parameters */
    config: Record<string, unknown>;
    /** UI-specific configuration for visual editors */
    ui?: Record<string, unknown>;
    /** Input connections from other components */
    input?: PipelineInputConnection[];
    /** Invoke (control-flow) connections from other components */
    control?: PipelineControlConnection[];
}
interface PipelineConfig {
    /** Human-readable pipeline name — the registry's pipelineName renders it
        on every deploy surface, and publish requires it. */
    name?: string;
    /** Pipeline description */
    description?: string;
    /** Pipeline version number */
    version?: number;
    /** Array of pipeline components that process data */
    components: PipelineComponent[];
    /** ID of the component that serves as the pipeline entry point */
    source?: string;
    /** Project identifier for organization and permissions */
    project_id?: string;
    /** UI viewport settings for visual editors */
    viewport?: {
        x: number;
        y: number;
        zoom: number;
    };
    /** Editor document revision counter for change tracking (undo/redo, echo detection). */
    docRevision?: number;
    /** Whether the canvas is locked from editing */
    isLocked?: boolean;
    /** Whether node snapping to grid is enabled */
    snapToGrid?: boolean;
    /** Grid size for snapping [x, y] */
    snapGridSize?: [
        number,
        number
    ];
    /** Active editor mode (e.g. 'design', 'status', 'flow') */
    editorMode?: string;
}
interface DeployActor {
    userId?: string;
    display?: string;
    email?: string;
}
interface DeployArtifact {
    version?: number;
    /** sha256 over the exact stored artifact bytes; verified on every load. */
    sha256?: string;
    bytes?: number;
    pipelineName?: string;
    publishedBy?: DeployActor;
    /** Unix timestamp (seconds). */
    publishedAt?: number;
    /** Optional "what changed" note supplied at publish time. */
    comment?: string;
}
interface DeploymentSchedule {
    /** 5-field cron expression. */
    cron?: string;
    /** Paused schedules stay configured (cron/ttl kept) but never fire. */
    paused?: boolean;
    /** Run window in seconds ('fixed window'); null/absent = until finished. */
    ttl?: number | null;
    /** Trace verbosity for this source's deploy runs; null/absent = the
        deploy default (full). */
    traceLevel?: "none" | "metadata" | "summary" | "full" | null;
    /** Full task debug output (--trace=debugOut) for this source. */
    debugOut?: boolean;
    /** Unix timestamp (seconds) of the last scheduler dispatch, or null. */
    lastRunAt?: number | null;
}
interface Deployment {
    teamId?: string;
    projectId?: string;
    /** The registry version this team currently points at. */
    version?: number;
    /** `disabled` is the whole-deployment kill switch — nothing runs. */
    state?: "enabled" | "disabled" | "errored" | "removed";
    pipelineName?: string;
    /** Per-source schedules, keyed by source id. */
    schedules?: Record<string, DeploymentSchedule>;
    createdAt?: number;
    createdBy?: DeployActor;
    updatedAt?: number;
    updatedBy?: DeployActor;
    /** Unix seconds of the latest POINTER MOVE for this team (deploy or
        rollback), computed from the audit trail — unlike `updatedAt`, it is
        NOT bumped by disable/enable or schedule edits. */
    deployedAt?: number;
    /** Registry-joined fields of the pointed-at version. */
    sha256?: string;
    publishedAt?: number;
    publishedBy?: DeployActor;
}
interface DeployHistoryEntry {
    /**
     * Stable append-order key: newest first, never ties. Use as the row
     * identity when rendering.
     */
    seq?: number;
    /** Unix timestamp (seconds). */
    at?: number;
    /** `pause`/`resume` appear only on rows written before the
        enable/disable vocabulary (the trail is immutable). */
    action?: "publish" | "deploy" | "rollback" | "enable" | "disable" | "pause" | "resume" | "errored" | "remove";
    /** `''` on org-wide rows (publish); the team id on pointer changes. */
    teamId?: string;
    version?: number;
    actor?: DeployActor;
}
interface PublishResult {
    artifact?: DeployArtifact;
    /** Present only when `deployTo` was given (one-step publish+deploy). */
    deployment?: Deployment;
}
interface DeployListParams {
    /** 1-based page number. */
    page?: number;
    /** Rows per page (server-clamped). */
    pageSize?: number;
    /** Free-text search over the surface's searchable columns. */
    search?: string;
    /** Column filters; `__gte`/`__lte` suffixes express range bounds. */
    filters?: Record<string, unknown>;
    /** Sorters, most-significant first. */
    sort?: Array<{
        field: string;
        dir: "asc" | "desc";
    }>;
}
interface DeployListEnvelope<T> {
    rows: T[];
    total: number;
    page: number;
    pageSize: number;
}
interface SchedulePreview {
    valid?: boolean;
    /** Human-readable reason when invalid. */
    error?: string;
    /** Unix timestamps (seconds) of the next occurrences. */
    next?: number[];
}
interface LogStreamRef {
    projectId: string;
    source: string;
    /**
     * A team id addresses that team's deploy continuum; omitted = the
     * caller's own dev stream.
     */
    teamId?: string;
}
interface LogChapter {
    /** Run start (epoch seconds). */
    beginTime: number;
    /** First continuum seq of the run. */
    beginSeq: number;
    /** Run end (epoch seconds); null while the run is live. */
    endTime?: number | null;
    /** 'ok' | 'error' | 'cancelled'; null while the run is live. */
    outcome?: string | null;
    /** The run's trace level (null/'none' = tracing off; absent on
        chapters recorded before the stamp existed). */
    traceLevel?: string | null;
}
interface LogActivitySpan {
    /** Segment id — the raw segment fetch / DVR cache key. */
    id?: number;
    /** First continuum seq recorded in this segment. */
    seq?: number;
    startTime?: number | null;
    endTime?: number | null;
    /** A run begins within this span. */
    chapterStart: boolean;
}
interface LogChaptersResult {
    chapters: LogChapter[];
    segments: LogActivitySpan[];
    /** Retained-window start (the horizon), epoch seconds. */
    startTime?: number | null;
    /** Latest activity, epoch seconds. */
    endTime?: number | null;
    /** First seq still retained after ring/age eviction. */
    horizonSeq: number;
    /** True when no run is currently writing the stream. */
    completed: boolean;
}
interface LogReadParams {
    /** Inclusive seq lower bound. */
    fromSeq?: number;
    /** Inclusive seq upper bound. */
    toSeq?: number;
    /** Inclusive eventTime lower bound (epoch seconds). */
    fromTime?: number;
    /** Inclusive eventTime upper bound (epoch seconds); omit for "to now". */
    toTime?: number;
    /** Read up to and including this segment id. */
    toSegment?: number;
    /** Continuation seq from a previous page's `nextSeq`. */
    cursor?: number;
    /** Page limit (server clamps to its maximum). */
    maxEvents?: number;
    /** Page byte limit (server clamps to its maximum). */
    maxBytes?: number;
    /** Server-side event-type filter (e.g. ['output'] for the Log page). */
    types?: string[];
}
interface LogEventBody {
    /** Continuum emission time (epoch seconds, float), stamped at engine ingress. */
    eventTime: number;
    /** Continuum sequence — catalog-seeded, strictly monotonic per stream. */
    logSeq: number;
    [key: string]: unknown;
}
interface LogEvent {
    type: "event";
    event: string;
    body: LogEventBody;
    [key: string]: unknown;
}
interface LogReadResult {
    events: LogEvent[];
    /** Present when paged: pass as `cursor` to continue. */
    nextSeq?: number;
    /** Present when the request reached below the retention horizon. */
    truncatedAtSeq?: number;
}
interface LogDeleteResult {
    deletedSegments: number;
}
type LogPosition = number | "live";
interface LogTraceSummary {
    /**
     * Display id. For fold summaries this is the pipe SLOT (reused across
     * requests); for getTrace results it is the begin seq. Always pass
     * {@link beginSeq} (or a begin event's seq) to `getTrace` — that is the
     * trace's permanent identity.
     */
    id: number | string;
    /** The trace's begin-event continuum seq — its PERMANENT identity. */
    beginSeq?: number;
    /** Document/object name (the trace's display name). */
    doc?: string;
    /** Run start of this trace (epoch seconds). */
    beginTime?: number;
    /** Seconds from begin to close (closed traces only). */
    elapsed?: number;
    /** Number of component calls seen. */
    calls?: number;
    /** True while the trace is still in flight at the position. */
    open: boolean;
    /** Segment ids containing this trace's events (sparse expand list). */
    touched?: number[];
}
interface LogTracesResult {
    /** ALL in-flight traces at the position (bounded by real concurrency). */
    open: LogTraceSummary[];
    /** The most recently completed traces before the position (≤ n). */
    closed: LogTraceSummary[];
}
interface LogTraceDetail {
    summary: LogTraceSummary;
    /** Every event belonging to this trace, seq-ordered, fully reconstructed. */
    events: LogEvent[];
}
interface LogPlayItem {
    /** One reconstructed event, delivered in seq order. */
    event: LogEvent;
}
type LogPlayCallback = (item: LogPlayItem) => void;
interface LogSegmentParams {
    /** Byte offset to continue from (0 = segment start). */
    offset?: number;
    /** Chunk ceiling in bytes (clamped by the server; 0/omitted = server default). */
    maxBytes?: number;
}
interface LogSegmentResult {
    /** Segment id within the stream. */
    segment: number;
    /** Byte offset this chunk starts at. */
    offset: number;
    /** Raw JSONL text — every chunk ends on a line boundary, parse standalone. */
    data: string;
    /** Total segment size in bytes (grows while the segment is active). */
    size: number;
    /** Pass back as `offset` to continue; null when exhausted. */
    nextOffset: number | null;
    /** True when this chunk reached the end of the segment. */
    final: boolean;
}
interface TraceInfo {
    /** File path where the error occurred */
    file: string;
    /** Line number where the error occurred */
    lineno: number;
}
interface DAPMessage {
    /** Message type: request from client, response from server, or event notification */
    type: "request" | "response" | "event";
    /** Unique sequence number for message correlation and ordering */
    seq: number;
    /** Command name for requests (e.g., 'execute', 'terminate', 'rrext_ping') */
    command?: string;
    /** Command arguments and parameters */
    arguments?: Record<string, unknown>;
    /** Response body containing results and data */
    body?: Record<string, unknown>;
    /** Success flag for responses - true if operation succeeded */
    success?: boolean;
    /** Error or status message */
    message?: string;
    /** Sequence number of the request this response corresponds to */
    request_seq?: number;
    /** Event type name for event messages */
    event?: string;
    /** Task or pipeline token for operation context */
    token?: string;
    /** Binary or text data payload */
    data?: Uint8Array | string;
    /** Stack trace information for errors */
    trace?: TraceInfo;
}
interface TransportCallbacks {
    /** Called when debug messages are generated */
    onDebugMessage?: (message: string) => void;
    /** Called when protocol messages are sent/received for debugging */
    onDebugProtocol?: (message: string) => void;
    /** Called when a message is received from the server */
    onReceive?: (message: DAPMessage) => Promise<void>;
    /** Called when connection is established */
    onConnected?: (connectionInfo?: string) => Promise<void>;
    /** Called when connection is lost or closed */
    onDisconnected?: (reason?: string, hasError?: boolean) => Promise<void>;
}
type EventCallback = (event: DAPMessage) => Promise<void>;
type ConnectCallback = (connectionInfo?: string) => Promise<void>;
type DisconnectCallback = (reason?: string, hasError?: boolean) => Promise<void>;
type ConnectErrorCallback = (error: ConnectionException) => void | Promise<void>;
interface RocketRideClientConfig {
    /** API authentication key or token */
    auth?: string;
    /** Server URI (will be converted to WebSocket URI automatically) */
    uri?: string;
    /**
     * Environment variables dictionary for configuration and variable substitution.
     * If not provided, will load from .env file (Node.js only), then fall back to process.env
     */
    env?: Record<string, string>;
    /** Callback for handling real-time events from server */
    onEvent?: EventCallback;
    /** Callback for connection establishment */
    onConnected?: ConnectCallback;
    /** Callback for disconnection events */
    onDisconnected?: DisconnectCallback;
    /** Callback when a connection attempt fails (persist mode: called on each failure while retrying) */
    onConnectError?: ConnectErrorCallback;
    /** Optional function to output a protocol message */
    onProtocolMessage?: (message: string) => void;
    /** Optional function to output a debug message */
    onDebugMessage?: (message: string) => void;
    /**
     * Open a public (unauthenticated) connection.
     * Only ``rrext_public_*`` commands may be sent. The connection is
     * permanently public — call connect() on a separate client to authenticate.
     */
    public?: boolean;
    /** Maintain the connection */
    persist?: boolean;
    /** Default timeout in ms for individual requests. Default: no timeout. */
    requestTimeout?: number;
    /** Max total time in ms to keep retrying connections. Default: undefined (forever). */
    maxRetryTime?: number;
    /** Custom WebSocket path override (default: '/task/service'). Use '/models' for the model server. */
    wsPath?: string;
    /** Client module name for debugging and identification */
    module?: string;
    /** Friendly client name sent during auth (e.g. "VS Code", "Cursor") */
    clientName?: string;
    /** Client version sent during auth (e.g. "0.9.4") */
    clientVersion?: string;
    /**
     * Optional trace callback invoked at the start and end of every `call()`.
     * Use for logging, debugging, or telemetry.
     *
     * @param traceType - 0 = request (before send), 1 = success (response), 2 = error
     * @param payload   - The trace data: command, args, and (for success/error) the result or error message.
     */
    onTrace?: (traceType: TraceType, message: DAPMessage) => void;
}
declare enum TraceType {
    /** Emitted before the DAP request is sent. */
    Request = 0,
    /** Emitted when the DAP request succeeds. */
    Success = 1,
    /** Emitted when the DAP request fails. */
    Error = 2
}
interface TeamInfo {
    /** Unique identifier of the team (UUID or short slug) */
    id: string;
    /** Display name of the team shown in dashboards and logs */
    name: string;
    /**
     * Permission strings granted to this team.
     * Examples: `'task.execute'`, `'task.monitor'`, `'store.read'`.
     */
    permissions: string[];
}
interface OrgInfo {
    /** Unique identifier of the organisation (UUID or short slug) */
    id: string;
    /** Display name of the organisation */
    name: string;
    /**
     * Organisation-level permission strings granted to the authenticated user.
     * These apply across all teams within the organisation.
     */
    permissions: string[];
    /**
     * Teams within this organisation that the user is a member of.
     * Each entry includes team-scoped permissions.
     */
    teams: TeamInfo[];
}
/**
 * Full identity and authorisation payload returned by the server after a
 * successful authentication handshake (`auth` command).
 *
 * The client caches this object and re-emits it whenever the server pushes
 * an `apaext_account` event (e.g. after a plan change). The `userToken`
 * field is used for subsequent reconnects in persist mode.
 */
interface ConnectResult {
    /**
     * Short-lived RocketRide session token (`rr_…`) that can be replayed on
     * reconnect without requiring the original API key or PKCE exchange again.
     */
    userToken: string;
    /** Unique identifier of the authenticated user (UUID) */
    userId: string;
    /** Full display name of the user (e.g. "Jane Smith") */
    displayName: string;
    /** User's given (first) name */
    givenName: string;
    /** User's family (last) name */
    familyName: string;
    /** Username / login handle (not necessarily unique across providers) */
    preferredUsername: string;
    /** Primary email address of the user */
    email: string;
    /** Whether the email address has been verified by the identity provider */
    emailVerified: boolean;
    /** Primary phone number of the user (E.164 format where available) */
    phoneNumber: string;
    /** Whether the phone number has been verified by the identity provider */
    phoneNumberVerified: boolean;
    /** BCP-47 locale tag (e.g. "en-US") representing the user's preferred locale */
    locale: string;
    /**
     * ID of the team that should be used by default for operations that do not
     * explicitly specify a team context.
     */
    defaultTeam: string;
    /**
     * The organisation the authenticated user belongs to, with its own
     * permission set and nested team memberships.  Null when the user
     * has no org membership.
     */
    organization: OrgInfo | null;
    /**
     * Apps on the user's desktop with ``appStatus`` and ``onDesktop``.
     * OSS: all apps with ``appStatus: "free"``, ``onDesktop: true``.
     * SaaS: populated from the ``app_users`` table, enriched with billing info.
     */
    apps: AppManifestEntry[];
    /**
     * Server capability tags describing the account provider in use.
     * OSS servers report `['oss']`; SaaS servers report `['saas']`.
     */
    capabilities: string[];
    /**
     * Version string of the server that handled the auth handshake.
     * Sent by newer servers alongside the identity payload; older servers
     * omit it, hence optional.
     */
    serverVersion?: string;
    /**
     * Platform-level permission strings (e.g. ``['sys.admin']``).
     * Set manually in the database, never via API.
     */
    sysPermissions?: string[];
    /** Credit wallet balance snapshot — resource→balance pairs. */
    credits?: Record<string, unknown>;
    /**
     * True when the user is authenticated but not yet granted full app access.
     * The shell should show a waitlist page instead of the main workspace.
     */
    waitlisted?: boolean;
    /**
     * All org memberships the user has (for the org switcher UI).
     * Only present in profile responses, not in the auth handshake.
     */
    memberships?: OrgInfo[];
    /**
     * The ID of the user's currently active (default) organization.
     * Only present in profile responses.
     */
    defaultOrgId?: string;
}
interface AppManifestEntry {
    /** Unique app identifier (e.g. "rocketride.pipeBuilder"). */
    id: string;
    /** Module Federation remote name (e.g. "rocketride_pipeBuilder"). */
    moduleId: string;
    /** Human-readable app name. */
    name: string;
    /** Short description of the app. */
    description?: string;
    /** URL path to the app's icon (e.g. "/apps/rocket-ui/icon.svg"). */
    icon?: string;
    /** Category tags for filtering (e.g. ["pipelines", "ai"]). */
    categories?: string[];
    /** App-specific setting definitions. */
    settings?: unknown[];
    /** URL to the app's Module Federation remote entry file. */
    entry: string;
    /** App version string (semver). */
    version?: string;
    /** Visibility scope: "public", "org", "team", or "user". */
    ownerType?: string;
    /** Whether the app UI requires authentication to render. Default true. */
    authenticated?: boolean;
    /** Whether to show the header bar when this app is active. Default true. */
    showHeader?: boolean;
    /** Whether to show the status bar when this app is active. Default true. */
    showStatusBar?: boolean;
    /** Whether the app is visible to unauthenticated users. Default true. */
    public?: boolean;
    /** Stripe product ID (SaaS paid apps only). */
    stripeProductId?: string;
    /** Available pricing tiers (SaaS paid apps only). */
    stripePrices?: StripePriceEntry[];
    /** App lifecycle status: 'auth' | 'free' | 'unsubscribed' | 'subscribed' | 'trialing' | 'past_due' | 'canceled'. */
    appStatus?: string;
    /** Whether this app is on the user's desktop. */
    onDesktop?: boolean;
    /** Total seats on the subscription (only for subscribed paid apps). */
    seats?: number;
    /** Seats currently occupied in this org (only for subscribed paid apps). */
    seatsUsed?: number;
    /** Feature flags enabled by the subscribed plan (only for subscribed paid apps). */
    features?: string[];
}
interface StripePriceEntry {
    /** Stripe price ID (price_*). */
    priceId: string;
    /** Human-readable label (e.g. "Monthly"). */
    nickname: string;
    /** Price in smallest currency unit (cents). */
    amountCents: number;
    /** ISO 4217 currency code (e.g. "usd"). */
    currency: string;
    /** Billing interval: "month", "year", or "one_time". */
    interval: string;
}
interface ServerInfoResult {
    /** Server engine version string. */
    version: string;
    /** Capability tags: `['oss']` for open-source, `['saas']` for cloud. */
    capabilities: string[];
    /** Server platform (e.g. `'linux'`, `'win32'`, `'darwin'`). */
    platform?: string;
    /**
     * Public apps visible without authentication.
     *
     * Returned by the pre-auth probe so the shell can render
     * public apps (e.g. landing page) before login.
     */
    apps?: AppManifestEntry[];
}
interface CProfileStatusResponse {
    /** Whether profiling is currently active. */
    active?: boolean;
    /** 'started' or 'error' (from start command). */
    status?: string;
    /** Connection that owns the active session. */
    owner: string | null;
    /** Human-readable session name. */
    session: string | null;
    /** Current runtime in seconds (if active). */
    runtime: number | null;
    /** Unix timestamp when profiling started (from start command). */
    start_time?: number;
    /** Whether a completed report is available (if inactive). */
    has_report?: boolean;
    /** Error message (if status is 'error'). */
    message?: string;
}
interface CProfileStopResponse {
    /** 'completed' or 'error'. */
    status: string;
    /** Session name that was stopped. */
    session?: string;
    /** Total profiling duration in seconds. */
    runtime?: number;
    /** Error message (if status is 'error'). */
    message?: string;
    /** Owner info (on ownership mismatch error). */
    owner?: string;
}
interface CProfileReportResponse {
    /** Full pstats-formatted text report. */
    report: string;
}
interface CProfileTreeNode {
    /** Function name. */
    name: string;
    /** Source filename. */
    file: string;
    /** Source line number. */
    line: number;
    /** Number of calls from the parent context. */
    ncalls: number;
    /** Total time spent in this function (excluding sub-calls). */
    tottime: number;
    /** Cumulative time spent in this function (including sub-calls). */
    cumtime: number;
    /** Child function calls. */
    children: CProfileTreeNode[];
}
interface CProfileReportTreeResponse {
    /** Root node of the call tree (synthetic '<root>' wrapper). */
    tree: CProfileTreeNode | null;
    /** Total cumulative time across all profiled functions. */
    total_time: number;
    /** Total number of function calls recorded. */
    total_calls: number;
    /** Error message if no data is available. */
    error?: string;
}
interface DashboardOverview {
    /** Number of currently active WebSocket connections for this account. */
    totalConnections: number;
    /** Number of tasks currently in the registry for this account. */
    activeTasks: number;
    /** Seconds since server started. */
    serverUptime: number;
}
interface DashboardConnection {
    /** Unique monotonic connection identifier. */
    id: number;
    /** Unix timestamp when connection was established. */
    connectedAt: number;
    /** Unix timestamp of last received message. */
    lastActivity: number;
    /** Total messages received from this client. */
    messagesIn: number;
    /** Total messages sent to this client. */
    messagesOut: number;
    /** Whether the connection has completed auth. */
    authenticated: boolean;
    /** AccountInfo.clientid (account identifier). */
    clientId: string | null;
    /** Stable user identifier resolved server-side from the connection's account (null until the connection authenticates). */
    userId?: string | null;
    /** Human display name of the authenticated user — displayName falling back to email (null when unauthenticated or nameless). */
    userName?: string | null;
    /** Organization id of the authenticated user (null when unauthenticated or without org membership). */
    orgId?: string | null;
    /** Organization display name of the authenticated user (null when unauthenticated or without org membership). */
    orgName?: string | null;
    /** Masked API key (first 4 + last 4 chars). */
    apikey: string;
    /** Client name/version from auth handshake. */
    clientInfo: Record<string, string>;
    /** Active monitor subscriptions with their event flags. */
    monitors: {
        key: string;
        flags: string[];
    }[];
    /** Task display names this connection is monitoring. */
    attachedTasks: string[];
}
interface DashboardTask {
    /** Internal task identifier (token[:8].source). */
    id: string;
    /** Display name (pipeline filename, config name, or source ID). */
    name: string;
    /** Project identifier. */
    projectId: string;
    /** Source component identifier. */
    source: string;
    /** Provider name. */
    provider: string;
    /** 'launch' or 'execute'. */
    launchType: string;
    /** Unix timestamp when task was created. */
    startTime: number;
    /** Runtime duration in seconds. */
    elapsedTime: number;
    /** Whether the task has finished. */
    completed: boolean;
    /** Current status message (running tasks only). */
    status: string | null;
    /** Exit code (completed tasks only). */
    exitCode: number | null;
    /** Unix timestamp of completion (completed tasks only). */
    endTime: number | null;
    /** Number of attached client connections. */
    connections: number;
    /** TASK_STATE enum value. */
    state: number;
    /** Seconds since last activity. */
    idleTime: number;
    /** Time-to-live in seconds (0 = no timeout). */
    ttl: number;
    /** Performance metrics (timers, counters). */
    metrics: Record<string, unknown> | null;
    /** Total items to process. */
    totalCount: number;
    /** Items completed so far. */
    completedCount: number;
    /** Current processing rate (items/sec). */
    rateCount: number;
    /** Current processing rate (bytes/sec). */
    rateSize: number;
}
interface DashboardResponse {
    overview: DashboardOverview;
    connections: DashboardConnection[];
    tasks: DashboardTask[];
}
interface ListSortSpec {
    /** The row key to sort by (e.g. 'startTime', 'connectedAt'). */
    field: string;
    /** Sort direction. */
    dir: "asc" | "desc";
}
interface ListPageRequest {
    /** 1-based page number (default 1). */
    page?: number;
    /** Rows per page (server-clamped 1..100, default 50). */
    page_size?: number;
    /** Free text matched case-insensitively over the command's searchable keys. */
    search?: string;
    /** Sort instructions, most significant first; unknown fields are ignored. */
    sort?: ListSortSpec[];
    /**
     * Flat {key: value} filters. A string value means contains (strings) or
     * coerced equality (booleans/numbers); an array means set membership.
     * Range bounds ride as separate string entries under `${field}__gte` /
     * `${field}__lte` keys (a date-only upper bound is end-of-day inclusive).
     */
    filters?: Record<string, string | string[]>;
}
interface ListPageResponse<TRow> {
    /** The rows of the requested page. */
    rows: TRow[];
    /** Total row count after search/filters, across all pages. */
    total: number;
    /** The (clamped) 1-based page that was returned. */
    page: number;
    /** The (clamped) page size that was applied. */
    pageSize: number;
}
type ListConnectionsResponse = ListPageResponse<DashboardConnection>;
type ListTasksResponse = ListPageResponse<DashboardTask>;
interface DashboardEventBase {
    /** Unix timestamp when the event occurred. */
    timestamp: number;
}
interface DashboardConnectionAdded extends DashboardEventBase {
    action: "connection_added";
    /** Unique monotonic connection identifier. */
    connectionId: number;
    /** Client display name from auth handshake. */
    clientName?: string | null;
    /** Client version from auth handshake. */
    clientVersion?: string | null;
    /** Account identifier. */
    clientId?: string | null;
}
interface DashboardConnectionRemoved extends DashboardEventBase {
    action: "connection_removed";
    /** Unique monotonic connection identifier. */
    connectionId: number;
    /** Client display name from auth handshake. */
    clientName?: string | null;
    /** Client version from auth handshake. */
    clientVersion?: string | null;
}
interface DashboardTaskStarted extends DashboardEventBase {
    action: "task_started";
    /** Task display identifier. */
    taskId: string;
}
interface DashboardTaskStopped extends DashboardEventBase {
    action: "task_stopped";
    /** Task display identifier. */
    taskId: string;
}
interface DashboardTaskRemoved extends DashboardEventBase {
    action: "task_removed";
    /** Task display identifier. */
    taskId: string;
}
interface DashboardTaskError extends DashboardEventBase {
    action: "task_error";
    /** Task display identifier. */
    taskId: string;
    /** Process exit code. */
    exitCode: number;
    /** Exit message from the engine. */
    exitMessage?: string | null;
}
interface DashboardAuthFailed extends DashboardEventBase {
    action: "auth_failed";
    /** Unique monotonic connection identifier. */
    connectionId: number;
    /** Reason the auth was rejected. */
    reason: string;
}
interface DashboardMonitorChanged extends DashboardEventBase {
    action: "monitor_changed";
    /** Unique monotonic connection identifier. */
    connectionId: number;
    /** Client display name from auth handshake. */
    clientName?: string | null;
    /** Client version from auth handshake. */
    clientVersion?: string | null;
    /** The monitor key that changed. */
    key: string;
    /** Whether the monitor was added or removed. */
    change: "subscribed" | "unsubscribed";
}
type DashboardEvent = DashboardConnectionAdded | DashboardConnectionRemoved | DashboardTaskStarted | DashboardTaskStopped | DashboardTaskRemoved | DashboardTaskError | DashboardAuthFailed | DashboardMonitorChanged;
interface PIPELINE_RESULT {
    /** Unique identifier for this processing result (UUID format) */
    name: string;
    /** File path context (typically empty for direct data sends) */
    path: string;
    /** Unique object identifier for tracking processed items (UUID format) */
    objectId: string;
    /**
     * Map of field names to their data type identifiers.
     *
     * The key is the name of a field that exists in this response object.
     * The value indicates what type of data that field contains.
     *
     * Examples:
     * - { "text": "text" } → look for response.text containing string array
     * - { "my_text": "text", "my_answers": "answers" } → look for response.my_text and response.my_answers
     * - { "answers": "answers" } → look for response.answers containing AI-generated responses
     */
    result_types?: Record<string, string>;
    /**
     * Dynamic fields containing processed data based on result_types mapping.
     *
     * Field names and types are determined by the result_types object:
     * - Fields with type "text": string[] (array of text segments)
     * - Fields with type "answers": string[] (AI-generated chat responses)
     * - Other types: depends on pipeline configuration
     *
     * Common field names: "text", "output", "content", "data", "result", "answers"
     */
    [key: string]: any;
}
interface UPLOAD_RESULT {
    /** Upload completion status - 'complete' indicates successful upload and processing */
    action: "open" | "write" | "close" | "complete" | "error";
    /** Original filename as provided during upload */
    filepath: string;
    /** Number of bytes successfully transmitted to the server */
    bytes_sent: number;
    /** Total size of the uploaded file in bytes */
    file_size: number;
    /** Time taken for the upload operation in seconds */
    upload_time: number;
    /**
     * Processing result from the pipeline after successful upload.
     * Contains the same structure as PIPELINE_RESULT with processed content.
     * Only present when action is 'complete' and processing succeeded.
     */
    result?: PIPELINE_RESULT;
    /** Error message if upload or processing failed (when action is 'error') */
    error?: string;
}
interface TaskRunningEntry {
    /** Unique task identifier. */
    id: string;
    /** Display name of the task (e.g. 'Parser1.Chat'). */
    name: string;
    /** Project identifier. */
    projectId: string;
    /** Source component entry point. */
    source: string;
}
interface TaskEventRunning {
    action: "running";
    tasks: TaskRunningEntry[];
}
interface TaskEventBegin {
    action: "begin";
    /** Display name of the task. */
    name: string;
    /** Project identifier. */
    projectId: string;
    /** Source component identifier. */
    source: string;
}
interface TaskEventEnd {
    action: "end";
    /** Display name of the task. */
    name: string;
    /** Project identifier. */
    projectId: string;
    /** Source component identifier. */
    source: string;
}
interface TaskEventRestart {
    action: "restart";
    /** Display name of the task. */
    name: string;
    /** Project identifier. */
    projectId: string;
    /** Source component identifier. */
    source: string;
}
type TaskEvent = TaskEventRunning | TaskEventBegin | TaskEventEnd | TaskEventRestart;
interface ServiceInvokeSlot {
    /** Human-readable description of what this slot expects. */
    description: string;
    /** Minimum number of connections required (0 = optional). */
    min: number;
    /** Maximum number of connections allowed (omitted = unlimited). */
    max?: number;
}
interface ServiceInputLane {
    /** The input lane name. */
    lane: string;
    /** Output lanes this input can produce. */
    output?: Array<{
        lane: string;
    }>;
}
interface ServiceDefinition {
    /** Human-readable display name. */
    title: string;
    /** Protocol URI scheme (e.g. "filesys://", "agent_rocketride://"). */
    protocol: string;
    /** URL prefix used for default URL mapping. */
    prefix: string;
    /** Account plans this driver is available for (null = all plans). */
    plans: string[] | null;
    /** Bitmask of {@link PROTOCOL_CAPS} flags. */
    capabilities: number;
    /** Categorisation tags (e.g. ["source"], ["agent", "tool"]). */
    classType: string[];
    /** Bitmask of supported UI actions (deletion, export, download). */
    actions: number;
    /** Human-readable description of the driver. */
    description?: string;
    /** Lane mapping: input lane name -> array of output lane names. */
    lanes?: Record<string, string[]>;
    /** Structured input/output lane definitions. */
    input?: ServiceInputLane[];
    /** Control-plane invoke slot definitions. */
    invoke?: Record<string, ServiceInvokeSlot>;
    /** Tile/card rendering hint for the pipeline editor. */
    tile?: Record<string, unknown>;
    /** Icon filename or identifier. */
    icon?: string;
    /** External documentation URL. */
    documentation?: string;
    /** Dynamic configuration sections (e.g. "Pipe", "Source", "Global"). */
    [section: string]: unknown;
}
interface ServicesResponse {
    /** Map of logical type name (e.g. "ocr", "filesys") to its definition. */
    services: Record<string, ServiceDefinition>;
}
interface ValidationError {
    /** Human-readable error/warning message. */
    message: string;
    /** Component ID that caused the issue (if applicable). */
    id?: string;
}
interface ValidationResult {
    /** Validation errors — pipeline will not execute with these. */
    errors: ValidationError[];
    /** Validation warnings — pipeline may still execute. */
    warnings: ValidationError[];
    /** Additional fields from the engine response. */
    [key: string]: unknown;
}
interface TASK_STATUS_FLOW {
    /** Total number of concurrent pipeline execution instances */
    totalPipes: number;
    /** Component execution stacks by pipeline instance ID */
    byPipe: Record<number, string[]>;
}
interface TASK_STATUS {
    /** Human-readable task name derived from pipeline source component */
    name: string;
    /** Unique identifier for the project associated with the task */
    project_id: string;
    /** Source component to execute */
    source: string;
    /** Task completion flag - true when task has finished execution */
    completed: boolean;
    /** Current task lifecycle state from TASK_STATE enumeration */
    state: number;
    /** Task start timestamp (Unix time) for duration calculation */
    startTime: number;
    /** Task completion timestamp (Unix time) for duration calculation */
    endTime: number;
    /** Debugger attachment status */
    debuggerAttached: boolean;
    /** Current status message describing task activity and progress */
    status: string;
    /** Warning message history (limited to 50 recent entries) */
    warnings: string[];
    /** Error message history (limited to 50 recent entries) */
    errors: string[];
    /** Name/identifier of the item currently being processed */
    currentObject: string;
    /** Size in bytes of the item currently being processed */
    currentSize: number;
    /** Contextual notes and information for status display */
    notes: (string | Record<string, unknown>)[];
    /** Total size in bytes of all items to be processed */
    totalSize: number;
    /** Total count of all items to be processed */
    totalCount: number;
    /** Total size in bytes of successfully processed items */
    completedSize: number;
    /** Total count of successfully processed items */
    completedCount: number;
    /** Total size in bytes of items that failed processing */
    failedSize: number;
    /** Total count of items that failed processing */
    failedCount: number;
    /** Total size in bytes of extracted/processed text content */
    wordsSize: number;
    /** Total count of words extracted/processed from content */
    wordsCount: number;
    /** Current processing rate in bytes per second (instantaneous) */
    rateSize: number;
    /** Current processing rate in items per second (instantaneous) */
    rateCount: number;
    /** Service operational status - true when ready to process requests */
    serviceUp: boolean;
    /** Process exit code - 0 for success, non-zero for errors */
    exitCode: number;
    /** Exit message providing details about task termination */
    exitMessage: string;
    /** Pipeline component execution flow and visualization data */
    pipeflow: TASK_STATUS_FLOW;
    /** Real-time resource utilization metrics (CPU normalized to 0-100%, memory in MB, GPU memory in MB) */
    metrics: TASK_METRICS;
    /** Cumulative token usage for CPU, memory, GPU (100 tokens = $1.00) */
    tokens: TASK_TOKENS;
    /** Per-component timing accumulated this run (requires tracing). */
    componentStats?: Record<string, TASK_STATUS_COMPONENT_STAT>;
    /** The 10 slowest completions this run, slowest first (requires tracing). */
    slowestDocs?: TASK_STATUS_SLOWEST_DOC[];
    /** Total begin-to-end seconds across all completions this run (requires tracing). */
    completionSeconds?: number;
    /** Total seconds the pipe sat unused between completions this run (requires tracing). */
    idleSeconds?: number;
    /** Longest single unused stretch between completions this run (requires tracing). */
    idleLongestSeconds?: number;
    /** Epoch when the longest unused stretch began (0 while none is recorded). */
    idleLongestAt?: number;
}
interface TASK_STATUS_COMPONENT_STAT {
    /** Completed enter/leave pairs this run. */
    calls: number;
    /** Sum of enter-to-leave seconds. */
    totalSeconds: number;
    /** Longest single call in seconds. */
    maxSeconds: number;
}
interface TASK_STATUS_SLOWEST_DOC {
    /** Object name from the begin event (capped at 200 chars). */
    name: string;
    /** Begin-to-end seconds, rounded to 2 decimals. */
    elapsed: number;
    /** Begin emission time (epoch seconds). */
    beginTime: number;
    /** Begin flow event continuum seq (trace identity). */
    beginSeq?: number | null;
}
interface TASK_TOKENS {
    /** Cumulative CPU utilization tokens charged since monitoring started */
    cpu_utilization: number;
    /** Cumulative CPU memory tokens charged since monitoring started */
    cpu_memory: number;
    /** Cumulative GPU memory tokens charged since monitoring started */
    gpu_memory: number;
    /** Cumulative GPU inference timing tokens charged since monitoring started */
    gpu_inference: number;
    /** Custom node billing counters converted to tokens (counter_name -> tokens) */
    custom: Record<string, number>;
    /** Total cumulative tokens charged (all dimensions) since monitoring started */
    total: number;
}
interface TASK_METRICS {
    /** Current CPU utilization percentage (normalized 0-100%, per-process) */
    cpu_percent: number;
    /** Current CPU memory (RAM) usage in megabytes (per-process) */
    cpu_memory_mb: number;
    /** Current GPU memory (VRAM) usage in megabytes (per-process) */
    gpu_memory_mb: number;
    /** Peak CPU utilization percentage during task execution */
    peak_cpu_percent: number;
    /** Peak CPU memory usage in megabytes during task execution */
    peak_cpu_memory_mb: number;
    /** Peak GPU memory usage in megabytes during task execution */
    peak_gpu_memory_mb: number;
    /** Average CPU utilization percentage over task lifetime */
    avg_cpu_percent: number;
    /** Average CPU memory usage in megabytes over task lifetime */
    avg_cpu_memory_mb: number;
    /** Average GPU memory usage in megabytes over task lifetime */
    avg_gpu_memory_mb: number;
}
declare abstract class TransportBase {
    /**
     * Connection info for the "connected" callback (e.g. URI). Default none.
     */
    getConnectionInfo(): string | undefined;
    /**
     * Bind callback functions to the transport.
     *
     * This must be called before using the transport for communication.
     * The callbacks handle debugging, connection events, and message processing.
     */
    bind(callbacks: TransportCallbacks): void;
    /**
     * Update connection URI. Takes effect on the next connect().
     */
    setUri(_uri: string): void;
    /**
     * Check if the transport is currently connected.
     */
    isConnected(): boolean;
    /**
     * Establish connection to remote endpoint (client-side).
     * @param timeout - Optional connection timeout in milliseconds. Falls back to default when not provided.
     */
    connect(_timeout?: number): Promise<void>;
    /**
     * Accept incoming connection (server-side).
     */
    accept(_connectionInfo: unknown): Promise<void>;
    /**
     * Close connection and cleanup resources.
     */
    abstract disconnect(): Promise<void>;
    /**
     * Send a message over the transport.
     */
    abstract send(message: DAPMessage): Promise<void>;
}
declare class DAPBase {
    /**
     * Creates a new DAPBase instance.
     *
     * Transport may be omitted when it will be created later in the connect path
     * (e.g. RocketRideClient defers transport creation until connect()).
     *
     * @param module - Name of the module for message type identification
     * @param transport - Transport layer for communication (optional; set later via bindTransport)
     * @param config - Client configuration including debug callbacks
     */
    constructor(module: string, transport: TransportBase | undefined, config: RocketRideClientConfig);
    /**
     * Log an error message and throw the provided exception.
     */
    raiseException(exception: Error): never;
    /**
     * Output a general operational message with the instance's message type prefix.
     */
    debugMessage(msg: string): void;
    /**
     * Output a protocol-level debug message for detailed DAP communication tracing.
     */
    debugProtocol(packet: string): void;
    /**
     * Handle incoming DAP events from the transport layer.
     */
    onEvent(_event: DAPMessage): Promise<void>;
    /**
     * Handle transport connection establishment.
     */
    onConnected(_connectionInfo?: string): Promise<void>;
    /**
     * Handle transport disconnection and cleanup.
     */
    onDisconnected(_reason?: string, _hasError?: boolean): Promise<void>;
    /**
     * Handle connection attempt failure.
     */
    onConnectError(_error: Error): Promise<void>;
    /**
     * Handle received messages from the transport layer.
     */
    onReceive(_message: DAPMessage): Promise<void>;
    /**
     * Check if a DAP request indicates failure based on its response fields.
     */
    didFail(request: DAPMessage): boolean;
    /**
     * Extract the web error details from a DAP request message.
     */
    getWebResponse(message: DAPMessage): Record<string, unknown>;
    /**
     * Build a DAP request message following the protocol specification.
     */
    buildRequest(command: string, options?: {
        token?: string;
        arguments?: Record<string, unknown>;
        data?: Uint8Array | string;
    }): DAPMessage;
    /**
     * Build a successful DAP response message for a given request.
     */
    buildResponse(request: DAPMessage, body?: Record<string, unknown>): DAPMessage;
    /**
     * Build a DAP event message to notify clients of state changes.
     */
    buildEvent(event: string, options?: {
        id?: string;
        body?: Record<string, unknown>;
    }): DAPMessage;
    /**
     * Build a DAP error response.
     */
    buildError(request: DAPMessage, message: string): DAPMessage;
    /**
     * Build a DAP exception response with debugging information.
     */
    buildException(request: DAPMessage, error: Error): DAPMessage;
}
declare class DAPClient extends DAPBase {
    /**
     * Creates a DAPClient instance and configures request-timeout and client
     * identity fields from the provided config object.
     *
     * @param module - Logical name for this client instance (used in debug messages)
     * @param transport - Optional pre-built transport; may be provided later via _bindTransport
     * @param config - Client configuration options (timeout, display name/version)
     */
    constructor(module: string, transport: TransportBase | undefined, config?: RocketRideClientConfig);
    /**
     * Handle connection established event.
     *
     * Chains to the parent DAPBase implementation which clears any
     * internal error state and invokes registered connection callbacks.
     *
     * @param connectionInfo - Optional human-readable description of the connection
     */
    onConnected(connectionInfo?: string): Promise<void>;
    /**
     * Handle connection attempt failure.
     *
     * Chains to the parent DAPBase implementation for shared error handling.
     *
     * @param error - The error that caused the connection attempt to fail
     */
    onConnectError(error: Error): Promise<void>;
    /**
     * Handle disconnection event and clean up pending requests.
     *
     * When the connection is lost all outstanding requests are immediately
     * rejected with a "connection lost" error so callers don't wait forever.
     * After cleanup the event is propagated to parent classes.
     *
     * @param reason - Human-readable reason for the disconnection
     * @param hasError - Whether the disconnection was caused by an error condition
     */
    onDisconnected(reason?: string, hasError?: boolean): Promise<void>;
    /**
     * Handle received messages from the transport layer.
     *
     * Routes incoming messages to the appropriate handler based on their type:
     * - `response`: matched to a pending request via `request_seq` and resolved
     * - `event`: forwarded to `onEvent` for user-defined processing
     * - anything else: logged as an unhandled message type
     *
     * @param message - The DAP message received from the server
     */
    onReceive(message: DAPMessage): Promise<void>;
    /**
     * Send a request and wait for the corresponding response.
     *
     * Assigns a unique sequence number to the message, registers a pending
     * promise, starts an optional timeout, transmits the message via the
     * transport, and returns the server's response when it arrives.
     *
     * @param message - The DAP message to send (must have `command` and `type` set)
     * @param timeout - Optional per-request timeout in ms. Overrides the default requestTimeout.
     * @returns Promise that resolves with the server's response DAPMessage
     * @throws Error if the message is malformed, the client is not connected, or the request times out
     */
    request(message: DAPMessage, timeout?: number): Promise<DAPMessage>;
    /**
     * Open the transport (WebSocket) without sending any authentication.
     * Authentication is handled at the RocketRideClient level via login().
     *
     * @param timeout - Optional timeout in ms for the WebSocket handshake.
     * @throws Error if the transport is not configured or the connection times out.
     */
    _dapConnect(timeout?: number): Promise<void>;
    /**
     * Close connection to the DAP server and clean up resources.
     *
     * Delegates to the transport's `disconnect` method which closes the
     * underlying socket and triggers `onDisconnected` via the transport callback.
     */
    disconnect(): Promise<void>;
    /**
     * Check if connected to server.
     *
     * Delegates to the transport's connection state; returns false when no
     * transport is present or the socket is not in the OPEN state.
     */
    isConnected(): boolean;
}
declare class AccountApi {
    /** @param client - The parent RocketRideClient that owns this namespace. */
    constructor(client: RocketRideClient);
    /**
     * Fetches the current user's profile from the server.
     *
     * @returns The user's profile data.
     */
    getProfile(): Promise<ConnectResult>;
    /**
     * Persists updated profile fields.
     *
     * @param fields - The profile fields to update.
     */
    updateProfile(fields: ProfileUpdate): Promise<void>;
    /**
     * Sets the user's preferred default team.
     *
     * @param teamId - The team ID to set as default.
     */
    setDefaultTeam(teamId: string): Promise<void>;
    /**
     * Switches the user's active organization.
     *
     * The server updates the user's default_org_id and resets the default
     * team to the first team in the new org. All connections for this user
     * receive a refreshed AccountInfo via shell:accountUpdate.
     *
     * @param orgId - The org ID to switch to.
     */
    setDefaultOrg(orgId: string): Promise<void>;
    /**
     * Permanently deletes the current user's account.
     */
    deleteAccount(): Promise<void>;
    /**
     * Fetches the organization detail for the given org.
     *
     * @param orgId - Organisation UUID. The server may infer the org if omitted.
     * @returns The organization detail (id, name, plan, memberCount, teamCount).
     */
    getOrg(orgId?: string): Promise<OrgDetail>;
    /**
     * Updates the organization name.
     *
     * @param orgId - Organisation UUID.
     * @param name  - The new organization name.
     */
    updateOrgName(orgId: string, name: string): Promise<void>;
    /**
     * Fetches the list of API keys for the current user.
     *
     * @returns Array of API key records.
     */
    listKeys(): Promise<ApiKeyRecord[]>;
    /**
     * Creates a new API key and returns the raw key string.
     *
     * @param params - Key creation parameters (name, permissions, expiresAt).
     * @returns Object containing the raw key string.
     */
    createKey(params: CreateKeyParams): Promise<{
        key: string;
    }>;
    /**
     * Revokes an API key by its ID.
     *
     * @param keyId - The key to revoke.
     */
    revokeKey(keyId: string): Promise<void>;
    /**
     * Fetches the flat list of organization members.
     *
     * @param orgId - Organisation UUID.
     * @returns Array of member records.
     */
    listMembers(orgId: string): Promise<MemberRecord[]>;
    /**
     * Sends an invitation to a new organization member.
     *
     * @param orgId  - Organisation UUID.
     * @param params - Invitation parameters (email, givenName, familyName, role).
     */
    inviteMember(orgId: string, params: InviteMemberParams): Promise<void>;
    /**
     * Updates an organization member's role.
     *
     * @param orgId  - Organisation UUID.
     * @param userId - The member's user ID.
     * @param role   - The new role string.
     */
    updateMemberRole(orgId: string, userId: string, role: string): Promise<void>;
    /**
     * Removes an organization member.
     *
     * @param orgId  - Organisation UUID.
     * @param userId - The member's user ID.
     */
    removeMember(orgId: string, userId: string): Promise<void>;
    /**
     * Resends the initialization email for a pending org member.
     *
     * @param orgId  - Organisation UUID.
     * @param userId - The pending member's user ID.
     */
    resendInvite(orgId: string, userId: string): Promise<void>;
    /**
     * Fetches the flat list of teams in the organization.
     *
     * @param orgId - Organisation UUID.
     * @returns Array of team summary records.
     */
    listTeams(orgId: string): Promise<TeamRecord[]>;
    /**
     * Fetches full detail (including member list) for a specific team.
     *
     * @param orgId  - Organisation UUID.
     * @param teamId - The team to load.
     * @returns The team detail with nested members.
     */
    getTeamDetail(orgId: string, teamId: string): Promise<TeamDetail>;
    /**
     * Creates a new team.
     *
     * @param orgId - Organisation UUID.
     * @param name  - The team name.
     */
    createTeam(orgId: string, name: string): Promise<void>;
    /**
     * Deletes a team.
     *
     * @param orgId  - Organisation UUID.
     * @param teamId - The team to delete.
     */
    deleteTeam(orgId: string, teamId: string): Promise<void>;
    /**
     * Adds a member to a team with specified permissions.
     *
     * @param orgId  - Organisation UUID.
     * @param params - Parameters (teamId, userId, permissions).
     */
    addTeamMember(orgId: string, params: TeamMemberParams): Promise<void>;
    /**
     * Updates a team member's permissions.
     *
     * @param orgId  - Organisation UUID.
     * @param params - Parameters (teamId, userId, permissions).
     */
    updateTeamMemberPerms(orgId: string, params: TeamMemberParams): Promise<void>;
    /**
     * Removes a member from a team.
     *
     * @param orgId  - Organisation UUID.
     * @param params - Parameters (teamId, userId).
     */
    removeTeamMember(orgId: string, params: {
        teamId: string;
        userId: string;
    }): Promise<void>;
    /**
     * Returns the available ROCKETRIDE_* key names from the merged environment.
     * Does not return values — only key names for use in dropdowns.
     *
     * @returns Array of key names (e.g. ['ROCKETRIDE_ANTHROPIC_KEY', 'ROCKETRIDE_OPENAI_KEY']).
     */
    getEnvironmentKeys(): Promise<string[]>;
    /**
     * Reads the environment dict for a scope (org, team, or user).
     *
     * @param scope   - One of 'org', 'team', 'user'.
     * @param scopeId - For org: orgId. For team: teamId. For user: omit (uses current user).
     * @returns Decrypted key-value dict.
     */
    getEnv(scope: "org" | "team" | "user", scopeId?: string): Promise<Record<string, string>>;
    /**
     * Writes the full environment dict for a scope (org, team, or user).
     * Replaces the entire set of keys at that scope level.
     *
     * @param scope   - One of 'org', 'team', 'user'.
     * @param env     - Full key-value dict to store.
     * @param scopeId - For org: orgId. For team: teamId. For user: omit.
     */
    setEnv(scope: "org" | "team" | "user", env: Record<string, string>, scopeId?: string): Promise<void>;
}
declare class BillingApi {
    /** @param client - The parent RocketRideClient that owns this namespace. */
    constructor(client: RocketRideClient);
    /**
     * Fetches the per-app subscription details for the given org.
     *
     * @param orgId - Organisation UUID whose subscriptions to load.
     * @returns Array of BillingDetail rows (one per subscribed app).
     */
    getDetails(orgId: string): Promise<BillingDetail[]>;
    /**
     * Fetches the active subscription plans (prices) for an app.
     *
     * Plans are returned sorted month-first, year-second, formatted for
     * display in the checkout plan picker. The server resolves the app's
     * Stripe product internally and calls `stripe.Price.list()` so pricing
     * changes in the Stripe dashboard are reflected immediately.
     *
     * @param appId - App identifier (e.g. "rocketride.pipeBuilder").
     * @returns Array of AppPrice rows from the local database.
     */
    getProductPrices(appId: string): Promise<AppPrice[]>;
    /**
     * Creates a Stripe subscription and returns the Stripe Elements client_secret.
     *
     * The returned client_secret is passed to `stripe.confirmPayment()` to
     * complete the checkout without a browser redirect to Stripe.
     *
     * `clientSecret` is `null` when the first invoice is $0 (e.g. a 100%-off
     * promotion code) — the subscription is already active and no payment
     * step is needed.
     *
     * @param orgId         - Organisation UUID to subscribe.
     * @param appId         - App being subscribed (e.g. "brandi").
     * @param priceId       - Stripe price_* identifier for the plan.
     * @param promotionCode - Optional promo code to apply (validated server-side).
     * @returns Object with client_secret (or null), subscription_id, and status.
     */
    createCheckoutSession(orgId: string, appId: string, priceId: string, promotionCode?: string): Promise<{
        clientSecret: string | null;
        subscriptionId: string;
        status: string;
    }>;
    /**
     * Resolves a promo code without side effects.
     *
     * An unknown or expired code returns `{ valid: false, reason }` — it never
     * throws. Pass `priceId` to also get the discounted first-invoice amount
     * for the selected plan.
     *
     * @param orgId   - Organisation UUID (context only — validation is global).
     * @param code    - Customer-facing code string (case-insensitive).
     * @param priceId - Optional plan to compute `discountedAmountCents` against.
     * @returns Promo validation result.
     */
    validatePromoCode(orgId: string, code: string, priceId?: string): Promise<PromoValidation>;
    /**
     * Redeems a credit-grant (hackathon) code for the caller's org.
     *
     * Creates a $0 subscription for the app named in the code's metadata (no
     * payment method required) and grants the metadata-defined credits
     * immediately. If the org is already subscribed to the app, only the
     * credits are granted (`mode: 'credits_only'`). Discount-only codes are
     * rejected — those are applied during checkout instead.
     *
     * Any authenticated org member may redeem; the server derives the org
     * from the caller's own membership.
     *
     * @param orgId - Organisation UUID (context only — server uses the caller's org).
     * @param code  - Customer-facing code string (case-insensitive).
     * @returns Redemption result with mode and granted credits.
     */
    redeemPromoCode(orgId: string, code: string): Promise<PromoRedemption>;
    /**
     * Creates a Stripe Billing Portal session for managing payment methods.
     *
     * @param orgId     - Organisation UUID whose Stripe customer portal to open.
     * @param returnUrl - URL to redirect the user back to after portal interaction.
     * @returns Object with portal URL to redirect the user to.
     */
    createPortalSession(orgId: string, returnUrl: string): Promise<{
        url: string;
    }>;
    /**
     * Schedules an app subscription for cancellation at the end of the current period.
     *
     * The user retains access until the period ends. The webhook handler will
     * update `cancel_at_period_end` in the database asynchronously.
     *
     * @param orgId - Organisation UUID that owns the subscription.
     * @param appId - App to cancel (e.g. "brandi").
     * @returns Object with canceled: true on success.
     */
    cancelSubscription(orgId: string, appId: string): Promise<{
        canceled: boolean;
    }>;
    /**
     * Upgrades (or downgrades) an existing subscription to a different plan.
     *
     * The server swaps the Stripe subscription item to the new price and
     * handles proration automatically. The local database row is updated
     * before the response is returned.
     *
     * @param orgId      - Organisation UUID that owns the subscription.
     * @param appId      - App whose plan is changing (e.g. "rocketride.pipeBuilder").
     * @param newPriceId - Stripe price_* identifier for the target plan.
     * @returns Object with status, new plan details, and subscription ID.
     */
    upgradeSubscription(orgId: string, appId: string, newPriceId: string): Promise<{
        status: string;
        subscriptionId: string;
        newPriceId: string;
        planNickname: string | null;
        unitAmount: number | null;
        billingInterval: string | null;
    }>;
    /**
     * Purchases a top-up pack by charging the customer's card on file.
     *
     * On success, credits are applied to the ledger immediately (no webhook
     * needed). If the card requires 3D Secure, returns a ``clientSecret``
     * for the UI to handle inline.
     *
     * @param orgId   - Organisation UUID.
     * @param priceId - Stripe price_* identifier for the top-up plan.
     * @returns Object with ``status`` ('succeeded' or 'requires_action') and
     *          optionally ``clientSecret`` for 3DS.
     */
    purchaseTopup(orgId: string, priceId: string): Promise<{
        status: string;
        clientSecret?: string;
    }>;
    /**
     * Reads the org's compute credit balance.
     *
     * The balance lives in a Redis-backed wallet on the engine side; this
     * call is cheap and safe to poll (~1 req/s is fine for a live widget).
     *
     * @param orgId - Organisation UUID to query.
     * @returns The credit balance with lifetime stats.
     */
    getCreditBalance(orgId: string): Promise<CreditBalance>;
    /**
     * Loads the purchasable credit packs, sourced from the Stripe catalog
     * that Terraform maintains. Call once on modal mount.
     *
     * @returns Array of credit pack pricing rows.
     */
    listCreditPacks(): Promise<CreditPack[]>;
    /**
     * Fetches paginated transaction detail from the credit ledger.
     *
     * Sort / filters / search follow the platform list-API convention: sorters
     * name camelCase row keys; filter values are a string (type-driven match)
     * or an array (set membership), with `field__gte` / `field__lte` string
     * entries for ranges; search matches case-insensitively across the
     * ledger's string columns. Unknown keys are dropped server-side, and the
     * caller's org/scope restriction always applies first.
     *
     * @param orgId    - Organisation UUID.
     * @param options  - Pagination, scope, and list-convention query options.
     * @returns Paginated transaction result.
     */
    getTransactions(orgId: string, options?: {
        scope?: "org" | "team" | "user";
        scopeId?: string;
        page?: number;
        pageSize?: number;
        since?: string;
        sort?: {
            field: string;
            dir: "asc" | "desc";
        }[];
        filters?: Record<string, string | string[]>;
        search?: string;
    }): Promise<TransactionsResult>;
    /**
     * Fetches distinct values of one ledger column (org-scoped server-side)
     * for the transaction grid's enum checklist filters.
     *
     * @param orgId - Organisation UUID.
     * @param field - camelCase wire key (e.g. 'type', 'resource').
     * @returns Sorted distinct values ([] for unknown/excluded fields).
     */
    getTransactionDistinct(orgId: string, field: string): Promise<(string | number | boolean)[]>;
    /**
     * Fetches per-user consumption rollup for an org.
     *
     * @param orgId - Organisation UUID.
     * @returns Array of usage rollup rows ordered by total consumption descending.
     */
    getUsageByUser(orgId: string): Promise<UsageRollup[]>;
    /**
     * Fetches per-team consumption rollup for an org.
     *
     * @param orgId - Organisation UUID.
     * @returns Array of usage rollup rows ordered by total consumption descending.
     */
    getUsageByTeam(orgId: string): Promise<UsageRollup[]>;
    /**
     * Creates a one-off Stripe Checkout session for a credit pack purchase
     * and returns the redirect URL.
     *
     * The frontend redirects the user to Stripe-hosted checkout; on success
     * Stripe redirects back to the app, and the `checkout.session.completed`
     * webhook increments the wallet server-side.
     *
     * @param orgId     - Organisation UUID that the credits belong to.
     * @param packId    - Pack key returned by {@link listCreditPacks}.
     * @param returnUrl - Where Stripe sends the user after payment.
     * @returns Object with the Stripe checkout URL.
     */
    createCreditCheckout(orgId: string, packId: string, returnUrl: string): Promise<{
        url: string;
    }>;
}
type SequelizeConstructor = new (options?: Options) => Sequelize;
declare enum DatabaseDialect {
    POSTGRES = "postgres",
    MYSQL = "mysql",
    NEO4J = "neo4j"
}
declare class DatabaseApi {
    constructor(client: RocketRideClient);
    /**
     * Execute a raw SQL or Cypher statement against a database pipeline node.
     *
     * Invokes the `execute` tool function on the target database node,
     * bypassing LLM translation and SQL safety checks.
     *
     * @param options.token - Pipeline token for authentication and resource access.
     * @param options.sql - Raw SQL or Cypher statement to execute.
     * @param options.nodeId - Target database node ID.  When empty the call
     *   broadcasts to all tool-lane nodes; the first database node handles it.
     * @param options.sessionId - Optional transaction session ID returned by
     *   `beginTransaction`.  When provided the statement runs within that session.
     * @param options.params - Optional positional parameters bound to the statement
     *   (e.g. `[1, 'foo']` for `$1`, `$2` placeholders).
     * @returns Object with `rows` (array of row objects) and `affected_rows` (number).
     */
    query(options: {
        token: string;
        sql: string;
        nodeId?: string;
        sessionId?: string;
        params?: unknown[];
    }): Promise<{
        rows: Record<string, unknown>[];
        affected_rows: number;
    }>;
    /**
     * Begin a database transaction on a pipeline node.
     *
     * Returns a `session_id` that must be threaded through subsequent
     * `query`, `commit`, and `rollback` calls to keep them within the
     * same transaction.
     *
     * @param options.token - Pipeline token for authentication and resource access.
     * @param options.nodeId - Target database node ID.
     * @returns Object containing the `session_id` string for the new transaction.
     */
    beginTransaction(options: {
        token: string;
        nodeId?: string;
    }): Promise<{
        session_id: string;
    }>;
    /**
     * Commit an open transaction session, making all its changes permanent.
     *
     * @param options.token - Pipeline token for authentication and resource access.
     * @param options.sessionId - Transaction session ID returned by `beginTransaction`.
     * @param options.nodeId - Target database node ID.
     * @returns Object with `ok: true` on success.
     */
    commit(options: {
        token: string;
        sessionId: string;
        nodeId?: string;
    }): Promise<{
        ok: boolean;
    }>;
    /**
     * Roll back an open transaction session, discarding all its changes.
     *
     * @param options.token - Pipeline token for authentication and resource access.
     * @param options.sessionId - Transaction session ID returned by `beginTransaction`.
     * @param options.nodeId - Target database node ID.
     * @returns Object with `ok: true` on success.
     */
    rollback(options: {
        token: string;
        sessionId: string;
        nodeId?: string;
    }): Promise<{
        ok: boolean;
    }>;
    /**
     * Discover the underlying database engine for a pipeline node.
     *
     * Invokes the `dialect` tool function on the target database node.
     *
     * @param options.token - Pipeline token for authentication and resource access.
     * @param options.nodeId - Target database node ID.  When empty the call
     *   broadcasts to all tool-lane nodes; the first database node handles it.
     * @returns The dialect reported by the node.
     * @throws If `token` is empty or the response is not a recognized dialect.
     */
    dialect(options: {
        token: string;
        nodeId?: string;
    }): Promise<DatabaseDialect>;
    /**
     * Build a Sequelize ORM instance that transports its SQL over this RocketRide
     * pipe (via `query`/`beginTransaction`/`commit`/`rollback`) instead of a TCP socket.
     *
     * Passes `this` as the `DatabaseLike` transport — TypeScript confirms structural
     * compatibility at compile time.
     *
     * The `sequelize` package is a peer dependency, not a hard dependency: it pulls
     * in Node built-ins (`util`, `debug`) that cannot be bundled for browser targets.
     * Callers must import `Sequelize` themselves and pass the class in.
     *
     * @param options.Sequelize - The `Sequelize` class (`import { Sequelize } from 'sequelize'`).
     * @param options.token - Pipeline token for authentication.
     * @param options.nodeId - Target database node id (pins transactions to one node).
     * @param options.sequelizeOptions - Extra Sequelize options merged over the defaults.
     * @returns A configured `Sequelize` instance ready for model definition and queries.
     */
    sequelize(options: {
        Sequelize: SequelizeConstructor;
        token: string;
        nodeId?: string;
        sequelizeOptions?: import("sequelize").Options;
    }): import("sequelize").Sequelize;
}
declare class DeployApi {
    /** @param client - The parent RocketRideClient that owns this namespace. */
    constructor(client: RocketRideClient);
    /**
     * Publishes a pipeline as the next immutable registry version.
     *
     * The artifact is sha256-locked: what was published is provably what
     * runs. Publishing alone puts nothing live — point a team at the version
     * with {@link deploy} (or pass `deployTo` to do both in one step, the
     * small-team convenience).
     *
     * @param pipeline - The full pipeline definition to snapshot. `name` is
     *   REQUIRED here (narrowed at compile time, enforced by the server):
     *   artifacts are immutable and pipelineName renders on every deploy
     *   surface — a nameless publish would show as a project GUID forever.
     * @param options - Optional publish options.
     * @param options.comment - "What changed" note kept in the registry.
     * @param options.deployTo - Team id to deploy the new version to
     *   immediately (one-step publish+deploy).
     * @returns The artifact entry, plus the deployment when `deployTo` was given.
     */
    publish(pipeline: PipelineConfig & {
        name: string;
    }, options?: {
        comment?: string;
        deployTo?: string;
    }): Promise<PublishResult>;
    /**
     * Points a team at a published version.
     *
     * Promotion (Staging → Production) and rollback (v3 → v2) are both this
     * call — the team's pointer moves, nothing else changes. The team is
     * always explicit; requires `task.control` on it.
     *
     * @param projectId - The project whose artifact to deploy.
     * @param version - The registry version to point the team at.
     * @param teamId - The target team (the environment).
     * @returns The updated deployment record, registry-joined.
     */
    deploy(projectId: string, version: number, teamId: string): Promise<Deployment>;
    /**
     * Deployments visible to the caller, as the standard list envelope.
     *
     * @param params - Optional team scope + list-API params.
     * @param params.teamId - Restrict to one team; omitted = every team the
     *   caller can monitor.
     * @returns `{rows, total, page, pageSize}` of {@link Deployment} rows.
     */
    list(params?: DeployListParams & {
        teamId?: string;
    }): Promise<DeployListEnvelope<Deployment>>;
    /**
     * One team's deployment of a project, registry-joined.
     *
     * @param projectId - The project.
     * @param teamId - The team whose deployment to fetch.
     * @returns The deployment record (version, state, schedules, actors).
     */
    get(projectId: string, teamId: string): Promise<Deployment>;
    /**
     * The org-registry versions of a project (the version strip), newest
     * first, as the standard list envelope.
     *
     * @param projectId - The project whose registry to read.
     * @param params - Optional list-API params.
     * @returns `{rows, total, page, pageSize}` of {@link DeployArtifact} rows.
     */
    versions(projectId: string, params?: DeployListParams): Promise<DeployListEnvelope<DeployArtifact>>;
    /**
     * Starts one deployed source NOW (manual trigger).
     *
     * The same trusted team dispatch the scheduler uses — the run executes
     * as the team and carries NO human identity; billing attributes to the
     * org and team, and who fired it is recorded only in the deployment's
     * audit history. The deployment must be enabled.
     *
     * @param projectId - The deployed project.
     * @param sourceId - The pipeline source to fire.
     * @param teamId - The team whose deployment to run.
     * @returns The started run's token and the version that ran.
     */
    run(projectId: string, sourceId: string, teamId: string): Promise<{
        token?: string;
        version?: number;
    }>;
    /**
     * Fetches one immutable artifact's pipeline JSON from the registry.
     *
     * sha256-verified server-side on load: what you get is provably what was
     * published. This is the source of truth for read-only rendering of a
     * deployed version — never a local file, never a running task.
     *
     * @param projectId - The project.
     * @param version - The registry version to fetch.
     * @returns The pipeline definition exactly as published.
     */
    artifact(projectId: string, version: number): Promise<PipelineConfig>;
    /**
     * The immutable audit trail of a project, newest first, as the standard
     * list envelope.
     *
     * The trail is unbounded by design (who published what when, who put
     * which version live where) — the server pages it; rows carry `seq`, the
     * stable append-order key, as their identity.
     *
     * @param projectId - The project whose trail to read.
     * @param params - Optional team scope + list-API params (`filters.at__gte`
     *   / `at__lte` take epoch seconds).
     * @param params.teamId - Restrict to one team's pointer changes
     *   (org-wide publish rows always ride along).
     * @returns `{rows, total, page, pageSize}` of {@link DeployHistoryEntry} rows.
     */
    history(projectId: string, params?: DeployListParams & {
        teamId?: string;
    }): Promise<DeployListEnvelope<DeployHistoryEntry>>;
    /**
     * Disables one team's deployment — the kill switch: NOTHING runs
     * (schedules stop firing and manual runs are refused) until it is
     * enabled again.
     *
     * @param projectId - The project.
     * @param teamId - The team whose deployment to disable.
     * @returns The updated deployment record.
     */
    disable(projectId: string, teamId: string): Promise<Deployment>;
    /**
     * Enables one team's disabled deployment.
     *
     * @param projectId - The project.
     * @param teamId - The team whose deployment to enable.
     * @returns The updated deployment record.
     */
    enable(projectId: string, teamId: string): Promise<Deployment>;
    /**
     * Soft-removes one team's deployment.
     *
     * Listings hide it; the audit history and every registry artifact
     * survive forever (the enterprise requirement). Re-deploying any version
     * revives it.
     *
     * @param projectId - The project.
     * @param teamId - The team whose deployment to remove.
     * @returns The final deployment record (state `removed`).
     */
    remove(projectId: string, teamId: string): Promise<Deployment>;
    /**
     * Sets (or clears) one source's schedule on a team deployment.
     *
     * The paused flag is untouched — editing cron/ttl preserves it (a new
     * schedule starts unpaused); {@link pauseSchedule}/{@link resumeSchedule}
     * own it.
     *
     * @param projectId - The project.
     * @param sourceId - The pipeline source the schedule fires.
     * @param schedule - 5-field cron expression; `null` or `'manual'` clears
     *   the schedule.
     * @param teamId - The team whose deployment to schedule.
     * @param options - Optional schedule options.
     * @param options.ttl - Run window in seconds ('fixed window'); omitted
     *   runs each task until the pipeline finishes.
     * @returns The updated deployment record.
     */
    setSchedule(projectId: string, sourceId: string, schedule: string | null, teamId: string, options?: {
        ttl?: number;
    }): Promise<Deployment>;
    /**
     * Sets one source's execution settings (trace level + debug output).
     *
     * These ride every deploy run of the source — scheduled and manual —
     * exactly like the dev-run settings. Editing the schedule never touches
     * them; a source keeps its settings even with no schedule.
     *
     * @param projectId - The project.
     * @param sourceId - The source whose settings to store.
     * @param teamId - The team whose deployment carries them.
     * @param options - The settings.
     * @param options.traceLevel - Trace verbosity; omit/null for the deploy
     *   default (full).
     * @param options.debugOut - Full task debug output (--trace=debugOut).
     * @returns The updated deployment record.
     */
    setSourceConfig(projectId: string, sourceId: string, teamId: string, options?: {
        traceLevel?: "none" | "metadata" | "summary" | "full" | null;
        debugOut?: boolean;
    }): Promise<Deployment>;
    /**
     * Pauses ONE source's schedule — the cron/ttl stay configured, it just
     * stops firing until resumed.
     *
     * @param projectId - The project.
     * @param sourceId - The source whose schedule to pause.
     * @param teamId - The team whose deployment carries the schedule.
     * @returns The updated deployment record.
     */
    pauseSchedule(projectId: string, sourceId: string, teamId: string): Promise<Deployment>;
    /**
     * Resumes a paused source schedule.
     *
     * @param projectId - The project.
     * @param sourceId - The source whose schedule to resume.
     * @param teamId - The team whose deployment carries the schedule.
     * @returns The updated deployment record.
     */
    resumeSchedule(projectId: string, sourceId: string, teamId: string): Promise<Deployment>;
    /**
     * Validates a schedule and returns its next occurrences.
     *
     * THE single cron evaluator: panel validation, "next:" lines, and DVR
     * ghost tracks all render from this — nothing client-side parses cron,
     * so a preview can never disagree with what the scheduler fires.
     *
     * @param schedule - 5-field cron expression (or `'manual'`).
     * @param count - How many upcoming occurrences to return (server-capped).
     * @returns Validity plus the next occurrence timestamps.
     */
    preview(schedule: string, count?: number): Promise<SchedulePreview>;
}
declare class LogEventStream {
    /** @param client - Owning client. @param stream - Identity tuple. */
    constructor(client: RocketRideClient, stream: LogStreamRef);
    /**
     * The stream's chapters (runs) — begin/end/outcome per run.
     *
     * @returns The chapters list (freshly fetched when the cache aged out).
     */
    getChapters(): Promise<LogChaptersResult["chapters"]>;
    /**
     * Position the session. Subsequent `get*()` calls answer as of this
     * position; `play()` continues from it.
     *
     * @param pos - Epoch seconds, or 'live' to pin to now.
     */
    seek(pos: LogPosition): Promise<void>;
    /** The current position (epoch seconds); rides the wall clock when live. */
    position(): number;
    /**
     * The full status snapshot at the position (pipeflow byPipe included).
     *
     * @returns The reconstructed status body, or null before the first status.
     */
    getStatus(): Promise<Record<string, unknown> | null>;
    /**
     * The console exactly as it read at the position (terminal semantics:
     * the keyframe scrollback + everything printed since, last `n` lines).
     *
     * @param n - Number of trailing lines wanted.
     * @returns The last `n` console lines as of the position.
     */
    getConsole(n: number): Promise<string[]>;
    /**
     * Trace state at the position: ALL in-flight traces plus the `n` most
     * recently completed (the sliding recency window).
     *
     * @param n - Closed-window size; must be ≤ 50.
     * @returns Open + recently-closed trace summaries.
     */
    getTraces(n: number): Promise<LogTracesResult>;
    /**
     * One trace's complete event set (its call tree's raw material).
     *
     * IDENTITY CONTRACT: a trace is identified by its BEGIN event's continuum
     * seq — the only key that is unique forever. The flow events' `body.id`
     * is a pipe SLOT, reused across requests, and cannot name a trace.
     * Resolution is deterministic and position-independent: locate the
     * segment containing the seq (the span table carries each segment's
     * first seq), find the begin event, then collect that slot's events
     * forward until its matching `end`, crossing segments and the live tail
     * as needed. Fails when the seq has fallen below the retention horizon,
     * or when no trace-begin event exists at that seq (a recycled slot id
     * or a fold docId is NOT a trace identity).
     *
     * @param traceId - The trace's begin-event continuum seq.
     * @returns Summary + every event of the trace, seq-ordered.
     */
    getTrace(traceId: number): Promise<LogTraceDetail>;
    /**
     * Stream reconstructed events to `cb`, in order, strictly after the seed
     * watermark, paced by `speed`. Auto-pins to live on catching the wall
     * clock; while pinned, delivery follows event arrival.
     *
     * @param pos - Optional position to seek first (number | 'live').
     * @param speed - 0 = as fast as possible; 0.25/1/10 = time-scaled.
     * @param cb - Receives `{ event }` items.
     */
    play(pos: LogPosition | undefined, speed: number, cb: LogPlayCallback): Promise<void>;
    /** Freeze the position (unpins live; a later play resumes from here). */
    pause(): void;
    /**
     * Feed one live event from the host's subscription. While pinned and
     * playing, it is delivered to the callback immediately (arrival paces
     * live delivery); otherwise it is retained for later catch-up.
     *
     * @param msg - A stamped event message from the live feed.
     */
    ingestLive(msg: LogEvent): void;
    /** Dispose the session (stops playback, clears caches). */
    closeEventStream(): void;
}
declare class LogApi {
    /** @param client - The parent RocketRideClient that owns this namespace. */
    constructor(client: RocketRideClient);
    /**
     * Opens a DVR session over one source continuum.
     *
     * The session is the replay/monitoring surface: position-based
     * `seek`/`get*`/`play` over reconstructed events — storage layout
     * (segments, keyframes, deltas) is invisible. Dispose with
     * {@link LogEventStream.closeEventStream} when done.
     *
     * @param stream - Stream identity (projectId + source; teamId = a team deploy continuum).
     * @returns A new, unpositioned session (call `seek()` first).
     */
    openEventStream(stream: LogStreamRef): LogEventStream;
    /**
     * Lists a stream's chapters (tracks) and activity-bar metadata.
     *
     * Everything the timeline needs from one small read: per-run begin/end
     * times + starting seq + outcome, segment activity spans, the stream's
     * retained window, and the retention horizon.
     *
     * @param stream - Stream identity (projectId + source; teamId = a team deploy continuum).
     * @returns Chapters, activity spans, and stream timeline metadata.
     */
    chapters(stream: LogStreamRef): Promise<LogChaptersResult>;
    /**
     * Reads a seq/time range of events from the continuum, paged.
     *
     * Range forms: `fromSeq`/`toSeq`, `fromTime`/`toTime` (omit the upper
     * bound for "to now"), or `fromTime` → `toSegment`. When the response
     * carries `nextSeq`, pass it back as `cursor` to continue; a
     * `truncatedAtSeq` flag means the request reached below the retention
     * horizon.
     *
     * @param stream - Stream identity (projectId + source; teamId = a team deploy continuum).
     * @param params - Range, paging, and filter options.
     * @returns The page of events plus paging/truncation metadata.
     */
    read(stream: LogStreamRef, params?: LogReadParams): Promise<LogReadResult>;
    /**
     * Fetches one segment's raw JSONL bytes, chunked by byte offset.
     *
     * The bulk replay path: the server does no line scanning, filtering, or
     * parsing — it hands over the immutable segment content in
     * whole-line-aligned chunks (each response ends on a newline, so every
     * chunk parses standalone). Repeat with the returned `nextOffset` until
     * `final`. The active segment is served up to its current length; the
     * live subscription covers growth past that. The segment table (ids +
     * time extents) comes from {@link chapters}.
     *
     * @param stream - Stream identity (projectId + source; teamId = a team deploy continuum).
     * @param segment - Segment id within the stream.
     * @param params - Byte offset to continue from + optional chunk ceiling.
     * @returns One raw chunk plus paging metadata.
     */
    segment(stream: LogStreamRef, segment: number, params?: LogSegmentParams): Promise<LogSegmentResult>;
    /**
     * Deletes log data for a stream (destructive).
     *
     * Provide `beforeTime` to drop segments wholly older than the cutoff
     * (chapters trimmed, horizon advanced), or `all: true` to remove the
     * entire stream including its control file.
     *
     * @param stream - Stream identity (projectId + source; teamId = a team deploy continuum).
     * @param options - Cutoff time and/or the delete-all flag.
     * @returns The number of segments deleted.
     */
    delete(stream: LogStreamRef, options: {
        beforeTime?: number;
        all?: boolean;
    }): Promise<LogDeleteResult>;
}
declare class DataPipe {
    /**
     * Creates a new DataPipe instance.
     *
     * @param client - The RocketRideClient instance managing this pipe
     * @param token - Task token for the pipeline receiving the data
     * @param objinfo - Metadata about the object being sent (e.g., filename, size)
     * @param mimeType - MIME type of the data being sent (default: 'application/octet-stream')
     * @param provider - Optional provider name for the data source
     * @param onSSE - Optional async callback invoked for each SSE event emitted by
     *                the pipeline node for this specific pipe
     */
    constructor(client: RocketRideClient, token: string, objinfo?: Record<string, unknown>, mimeType?: string, provider?: string, onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>);
    /**
     * Check if the pipe is currently open for writing.
     *
     * @returns true if the pipe has been opened and not yet closed
     */
    get isOpened(): boolean;
    /**
     * Get the unique ID assigned to this pipe by the server.
     *
     * This ID is assigned when the pipe is opened and is used for subsequent
     * write operations. It remains undefined until open() is called successfully.
     *
     * @returns The server-assigned pipe ID, or undefined if not yet opened
     */
    get pipeId(): number | undefined;
    /**
     * Open the pipe for data transmission.
     *
     * Establishes a data pipe on the server for streaming data to the pipeline.
     * Must be called before any write() operations. The server will assign a
     * unique pipe ID that is used for subsequent operations.
     *
     * @returns This DataPipe instance (for method chaining)
     * @throws Error if the pipe is already opened
     * @throws PipeException if the server rejects the open request
     */
    open(): Promise<DataPipe>;
    /**
     * Write data to the pipe.
     *
     * Sends a chunk of data through the pipe to the server pipeline. Can be called
     * multiple times to stream large datasets. The pipe must be opened first.
     *
     * @param buffer - Data to write, must be a Uint8Array
     * @throws Error if the pipe is not opened or buffer is invalid
     * @throws PipeException if the server reports a write failure
     */
    write(buffer: Uint8Array): Promise<void>;
    /**
     * Close the pipe and get the processing results.
     *
     * Finalizes the data stream and signals the server that no more data will be sent.
     * The server processes any buffered data and returns the final result. After closing,
     * the pipe cannot be reopened or written to again.
     *
     * @returns The processing result from the server, or undefined if already closed
     * @throws PipeException if the server reports a failure while finalizing the pipe
     */
    close(): Promise<PIPELINE_RESULT | undefined>;
    /**
     * Invoke a @tool_function on a pipeline node using this pipe.
     *
     * The call reuses this pipe's existing pipeline instance, avoiding the
     * overhead of borrowing a new one from the pool.
     *
     * @param tool - Name of the @tool_function to invoke
     * @param nodeId - Target node ID.  When empty the call broadcasts to all
     *                 tool-lane nodes; the first node that owns the tool handles it.
     * @param input - Arguments forwarded to the tool function
     * @returns The tool's return value (typically a record/object)
     * @throws Error if the pipe is not open or no node handles the tool
     */
    tool<T = any>(tool: string, nodeId?: string, input?: Record<string, unknown>): Promise<T>;
}
type MonitorKey = {
    token: string;
} | {
    teamId?: string;
    projectId: string;
    source: string;
    pipeId?: number;
};
export declare class RocketRideClient extends DAPClient {
    /** Maps pipe_id → SSE callback for pipe-scoped real-time event dispatch. */
    readonly _ssePipeCallbacks: Map<number, (type: string, data: Record<string, unknown>) => Promise<void>>;
    /**
     * Creates a new RocketRideClient instance.
     *
     * `config.env` is copied as the configured environment map when provided;
     * otherwise Node.js values are copied from `process.env`. The two maps are not merged.
     * `config.uri` overrides `ROCKETRIDE_URI`; `config.auth` supplies the fallback
     * credential used when `login()` receives no credential and the configured environment
     * has no `ROCKETRIDE_APIKEY`.
     *
     * The client does not load `.env` files; load them into `process.env` before construction
     * (for example, start Node with `--env-file=.env`).
     *
     * @param config - Configuration options for the client
     * @param config.auth - Optional initial API key; `login()` can also use
     *   `ROCKETRIDE_APIKEY` from the configured environment
     * @param config.uri - Server URI (default: CONST_DEFAULT_WEB_CLOUD)
     * @param config.env - Environment variables dictionary for configuration and substitution
     * @param config.onEvent - Callback for server events
     * @param config.onConnected - Callback when connection is established
     * @param config.onDisconnected - Callback when connection is lost
     * @param config.persist - Enable automatic reconnection
     * @param config.requestTimeout - Default timeout in ms for individual requests
     * @param config.maxRetryTime - Max total time in ms to keep retrying connections
     * @param config.module - Optional module name for client identification
     *
     * @example
     * ```typescript
     * // Using explicit auth and URI
     * const client = new RocketRideClient({
     *   auth: 'your-api-key',
     *   uri: 'wss://your-server.com',
     *   persist: true,
     *   onEvent: (event) => console.log('Event:', event)
     * });
     *
     * // Using custom env dictionary
     * const client = new RocketRideClient({
     *   env: {
     *     ROCKETRIDE_APIKEY: 'your-api-key',
     *     ROCKETRIDE_URI: 'wss://your-server.com',
     *     ROCKETRIDE_PROJECT_ID: 'my-project'
     *   }
     * });
     * ```
     */
    constructor(config?: RocketRideClientConfig);
    /**
     * Normalize a user-provided URI into a fully-formed HTTP/HTTPS URL.
     *
     * - Bare hostnames (e.g. "localhost", "my-server:5565") get `http://` prepended.
     * - Non-cloud URIs without a port default to 5565.
     *
     * Use this when you need a parseable URL from free-form user input before
     * passing it to the client or doing your own validation.
     */
    static normalizeUri(uri: string): string;
    /**
     * Probe a server for its capabilities without authenticating.
     *
     * Creates a temporary public connection and sends an
     * ``rrext_public_probe`` command. The server responds with version,
     * capabilities, platform, and public apps without requiring credentials.
     *
     * @param uri - Server URI (e.g. ``"localhost:5565"``, ``"https://api.rocketride.ai"``)
     * @param timeout - Optional timeout in ms for the entire operation
     * @returns Server info including version and capability tags
     * @throws Error if the server is unreachable or does not support probes
     *
     * @example
     * ```typescript
     * const info = await RocketRideClient.getServerInfo('localhost:5565');
     * if (info.capabilities.includes('saas')) {
     *   // Show cloud sign-in options
     * }
     * ```
     */
    static getServerInfo(uri: string, timeout?: number): Promise<ServerInfoResult>;
    /**
     * Attach to a RocketRide server (open WebSocket, no auth).
     *
     * If ``uri`` is provided and differs from the current URI, detaches
     * first. If already attached to the same URI, this is a no-op.
     *
     * After attach, public APIs (``rrext_public_*``) are available.
     *
     * @param uri - Server URI override. Updates the stored URI if provided.
     * @param options - Optional timeout for the WebSocket handshake.
     */
    attach(uri?: string, options?: {
        timeout?: number;
    }): Promise<void>;
    /**
     * Detach from the server (close WebSocket, cancel reconnection).
     *
     * Sets ``_desiredState`` to ``'detached'`` so the reconnect engine
     * stops and ``onDisconnected`` does not restart it.
     */
    detach(): Promise<void>;
    /**
     * True when the WebSocket transport is connected (regardless of auth).
     */
    isAttached(): boolean;
    /**
     * Authenticate over an attached transport.
     *
     * If ``uri`` is provided and differs, detaches and re-attaches first.
     * If ``auth`` is provided and differs from the current credential,
     * logs out (best-effort) before logging in with the new credential.
     * If already authenticated with the same credential, this is a no-op.
     *
     * @param credential - API key, rr_ token, or PKCE code object.
     * @param options - Optional URI override and/or timeout.
     * @returns ConnectResult with user identity on success.
     * @throws AuthenticationException when the server rejects authentication. Credential
     * resolution checks the argument, configured environment, and stored client state
     * (initialized by `config.auth` and updated after authentication). The transport stays attached.
     */
    login(credential?: string | {
        code: string;
        verifier: string;
        redirectUri: string;
    }, options?: {
        uri?: string;
        timeout?: number;
    }): Promise<ConnectResult>;
    /**
     * Deauthenticate: sends ``deauth`` to the server, clears client auth state.
     * The transport stays attached — public APIs continue to work.
     */
    logout(): Promise<void>;
    /**
     * True when the auth handshake has succeeded on the current connection.
     */
    isAuthenticated(): boolean;
    /**
     * Check if the client is currently connected to the RocketRide server.
     * Equivalent to ``isAttached()`` — kept for backward compatibility.
     */
    isConnected(): boolean;
    /**
     * Connect to the RocketRide server and authenticate in a single call.
     *
     * Backward-compatible wrapper around ``attach()`` + ``login()``.
     * Sends the credential as the first DAP message and returns the full
     * ConnectResult (user identity + organizations + teams) on success.
     *
     * @param credential - API key / Zitadel access_token / rr_ user token / PKCE code object.
     * @param options - Optional overrides: uri and/or timeout.
     * @throws AuthenticationException when the server rejects authentication. Credential
     * resolution checks the argument, configured environment, and stored client state
     * (initialized by `config.auth` and updated after authentication).
     */
    connect(credential?: string | {
        code: string;
        verifier: string;
        redirectUri: string;
    }, options?: {
        uri?: string;
        timeout?: number;
    }): Promise<ConnectResult>;
    /**
     * Get the ConnectResult from the last successful connect().
     * Returns undefined if not connected or not yet authenticated.
     */
    getAccountInfo(): ConnectResult | undefined;
    /**
     * Returns the ID of the user's organization.
     */
    getOrgId(): string | undefined;
    /**
     * Disconnect from the RocketRide server and stop automatic reconnection.
     * Backward-compatible wrapper around ``logout()`` + ``detach()``.
     */
    disconnect(): Promise<void>;
    /**
     * Update the environment variables used for pipeline substitution.
     *
     * Replaces the client's env dictionary (seeded from `config.env` or, in
     * Node, from `process.env`) with a copy of the given map. {@link use} reads
     * it to build the `ROCKETRIDE_*` substitution env sent with the pipeline.
     * `login()` also consults `ROCKETRIDE_APIKEY` from it when no explicit
     * credential is supplied. Mirrors the Python SDK's `set_env`.
     *
     * @param env - The new environment map; copied, so later caller-side
     *   mutations have no effect.
     */
    setEnv(env: Record<string, string>): void;
    /**
     * Test connectivity to the RocketRide server.
     *
     * Sends a lightweight ping request to the server to verify it's responding
     * and reachable. This is useful for connectivity testing, health checks,
     * and measuring response times.
     */
    ping(token?: string): Promise<void>;
    /**
     * Validate a pipeline configuration.
     *
     * Sends the pipeline to the server for structural validation, checking
     * component compatibility, connection integrity, and the resolved
     * execution chain.
     *
     * Source resolution follows the same logic as {@link use}:
     * 1. Explicit `source` option (if provided)
     * 2. `source` field inside the pipeline config
     * 3. Implied source: the single component whose config.mode is 'Source'
     *
     * @param options.pipeline - Pipeline configuration to validate
     * @param options.source - Optional override for the source component ID
     * @returns Promise resolving to validation result with errors, warnings,
     *          resolved component, and execution chain
     * @throws Error if the server returns a validation error
     *
     * @example
     * ```typescript
     * const result = await client.validate({
     *   pipeline: { components: [...], project_id: '123' },
     *   source: 'webhook_1'
     * });
     * if (result.errors?.length) {
     *   console.log('Validation errors:', result.errors);
     * }
     * ```
     */
    validate(options: {
        pipeline: PipelineConfig | Record<string, unknown>;
        source?: string;
    }): Promise<ValidationResult>;
    /**
     * Start an RocketRide pipeline for processing data.
     *
     * This method loads a pipeline configuration and sends the client's configured
     * `ROCKETRIDE_*` values plus any per-use overrides to the server for substitution.
     *
     * When loading from a file via `filepath`, the client automatically unwraps `.pipe` files
     * that use the `{ "pipeline": { ... } }` wrapper format. If the file contains a top-level
     * `pipeline` key, the inner object is extracted; otherwise the file content is used as-is.
     *
     * When passing a `pipeline` object directly, provide a flat `PipelineConfig` with
     * `components`, `source`, and `project_id` at the top level — do NOT wrap it in
     * `{ pipeline: { ... } }`.
     *
     * @param options - Pipeline execution options
     * @param options.token - Custom token for the pipeline (auto-generated if not provided)
     * @param options.filepath - Path to a `.pipe` or JSON file containing pipeline configuration (Node.js only)
     * @param options.pipeline - Flat PipelineConfig object (alternative to filepath)
     * @param options.source - Override pipeline source
     * @param options.threads - Number of threads for execution (default: 1)
     * @param options.useExisting - Use existing pipeline instance
     * @param options.args - Command line arguments to pass to pipeline
     * @param options.ttl - Time-to-live in seconds for idle pipelines (optional, server default if not provided; use 0 for no timeout)
     * @param options.pipelineTraceLevel - Trace level: 'none' | 'metadata' | 'summary' | 'full'. When set, captures every lane write and invoke call in the response under '_trace'.
     *
     * @returns Promise resolving to an object containing the task token and other metadata
     * @throws Error if neither pipeline nor filepath is provided
     *
     * @example
     * ```typescript
     * // Using a .pipe file (wrapper is automatically unwrapped)
     * const result = await client.use({ filepath: './chat.pipe' });
     *
     * // Using a flat pipeline config object
     * const result = await client.use({
     *   pipeline: { components: [...], source: 'chat_1', project_id: '...' }
     * });
     *
     * // Reuse an existing pipeline
     * const result = await client.use({ filepath: './chat.pipe', useExisting: true });
     * ```
     */
    use(options?: {
        token?: string;
        filepath?: string;
        pipeline?: PipelineConfig;
        source?: string;
        threads?: number;
        useExisting?: boolean;
        args?: string[];
        ttl?: number;
        /** Pipeline trace level. When set, captures every lane write and invoke call in the response under '_trace'. */
        pipelineTraceLevel?: "none" | "metadata" | "summary" | "full";
        /** Optional display name for the task (e.g. shown in dashboard). */
        name?: string;
        /** Unfiltered per-use values merged over the filtered `ROCKETRIDE_*` client environment. */
        env?: Record<string, string>;
    }): Promise<Record<string, unknown> & {
        token: string;
    }>;
    /**
     * Terminate a running pipeline.
     */
    terminate(token: string): Promise<void>;
    /**
     * Restart a running pipeline with a new configuration.
     *
     * Looks up the existing task by project/source, terminates it, and
     * starts a new execution in one server round-trip.
     *
     * @param options.token - Existing task token (optional, resolved server-side if omitted).
     * @param options.projectId - The project identifier.
     * @param options.source - The source component identifier.
     * @param options.pipeline - The pipeline configuration to restart with.
     * @param options.teamId - Address the team's DEPLOY run; omit for your own dev run.
     */
    restart(options: {
        token?: string;
        projectId: string;
        source: string;
        pipeline: Record<string, unknown>;
        teamId?: string;
    }): Promise<void>;
    /**
     * Get the current status of a running pipeline.
     *
     * By default this call is bounded to 15s so callers/tests don't hang forever if the engine
     * stops responding mid-request (especially important in CI). Pass `{ timeout: false }` to
     * restore the previous behavior of using only the client-level request timeout (if any).
     */
    getTaskStatus(token: string, options?: {
        timeout?: number | false;
    }): Promise<TASK_STATUS>;
    /**
     * Resolve a running task's token from its project ID and source component.
     *
     * The token is required for operations like terminate and restart.
     * Returns undefined if no task is currently running for the given project/source.
     *
     * The scope IS the kind: pass teamId to resolve the team's DEPLOYED run;
     * omit it to resolve your own dev run.
     *
     * @param options.projectId - The project identifier.
     * @param options.source - The source component identifier.
     * @param options.teamId - Address the team's DEPLOY run; omit for your own dev run.
     */
    getTaskToken(options: {
        projectId: string;
        source: string;
        teamId?: string;
    }): Promise<string | undefined>;
    /**
     * Returns the unresolved pipeline for a running task.
     *
     * The pipeline is returned exactly as stored — ${ROCKETRIDE_*} placeholders are
     * NOT substituted, so no secrets are included in the response.
     *
     * @param token - Task token returned by {@link getTaskToken}.
     * @returns The unresolved pipeline dict, or undefined if the task is not found.
     */
    getTaskPipeline(token: string): Promise<Record<string, unknown> | undefined>;
    /**
     * Create a data pipe for streaming operations.
     */
    pipe(token: string, objinfo?: Record<string, unknown>, mimeType?: string, provider?: string, onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>): Promise<DataPipe>;
    /**
     * Send data to a running pipeline.
     */
    send(token: string, data: string | Uint8Array, objinfo?: Record<string, unknown>, mimetype?: string, onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>): Promise<PIPELINE_RESULT | undefined>;
    /**
     * Upload multiple files to a pipeline with progress tracking and parallel execution.
     *
     * This method efficiently uploads files in parallel with configurable concurrency control.
     * Each file is streamed through a data pipe, and progress events are emitted through the
     * event system for all subscribers. The order of results matches the input file order.
     *
     * Progress events are sent through the event system as 'apaevt_status_upload' events
     * (matching Python client behavior) rather than through a callback parameter.
     *
     * @param files - Array of file objects with optional metadata and MIME types
     * @param token - Pipeline task token to receive the uploads
     * @param maxConcurrent - Maximum number of concurrent uploads (default: 5)
     *
     * @returns Promise resolving to array of UPLOAD_RESULT objects in the same order as input
     *
     * @example
     * ```typescript
     * // Subscribe to upload events
     * client.on('apaevt_status_upload', (event) => {
     *   console.log(`${event.body.filepath}: ${event.body.bytes_sent}/${event.body.file_size}`);
     * });
     *
     * // Upload files
     * const results = await client.sendFiles(
     *   [
     *     { file: fileObject1 },
     *     { file: fileObject2, mimetype: 'application/json' },
     *     { file: fileObject3, objinfo: { custom: 'metadata' } }
     *   ],
     *   'task-token',
     *   10  // Upload max 10 files concurrently
     * );
     * ```
     */
    sendFiles(files: Array<{
        file: File;
        objinfo?: Record<string, unknown>;
        mimetype?: string;
    }>, token: string): Promise<UPLOAD_RESULT[]>;
    /**
     * Ask a question to RocketRide's AI and get an intelligent response.
     */
    chat(options: {
        token: string;
        question: Question;
        onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>;
    }): Promise<PIPELINE_RESULT>;
    /**
     * Handle incoming events from the RocketRide server.
     */
    onEvent(message: DAPMessage): Promise<void>;
    /**
     * Handle connection attempt failure.
     * Calls the user callback and chains to parent.
     */
    onConnectError(error: Error): Promise<void>;
    /**
     * Handle transport-level connected event.
     *
     * With the attach/login split, this fires when the WebSocket opens
     * (before auth). The ``_internalLogin`` method handles the auth
     * notification separately, so this is intentionally minimal.
     */
    onConnected(connectionInfo: string): Promise<void>;
    /**
     * Handle transport disconnection.
     *
     * Clears transport and auth state, notifies the user callback,
     * then consults ``_desiredState`` to decide whether to reconnect.
     */
    onDisconnected(reason: string, hasError: boolean): Promise<void>;
    /**
     * Subscribe to specific types of events from the server.
     * @deprecated Use {@link addMonitor} / {@link removeMonitor} instead.
     */
    setEvents(token: string, eventTypes: string[], pipeId?: number): Promise<void>;
    /**
     * Add a monitor subscription. If the key already exists, the new types are
     * merged via reference counting and the merged set is sent to the server.
     *
     * @param key - Monitor key: `{ token }` for a running task, or `{ projectId, source }` for a project.
     * @param types - Event types to subscribe to (e.g. `['summary', 'flow']`).
     */
    addMonitor(key: MonitorKey, types: string[]): Promise<void>;
    /**
     * Remove a monitor subscription. Decrements reference counts for the given
     * types. Only unsubscribes a type from the server when its count reaches 0.
     *
     * @param key - Monitor key (must match the key used in addMonitor).
     * @param types - Event types to unsubscribe from.
     */
    removeMonitor(key: MonitorKey, types: string[]): Promise<void>;
    /**
     * Remove all monitor subscriptions from this client.
     *
     * Sends an empty types list for each active monitor key to unsubscribe
     * on the server, then clears the local ref-count map.  Called by the
     * shell when an app unmounts so the next app starts with a clean slate.
     */
    clearAllMonitors(): Promise<void>;
    /**
     * Update this connection's display name on the server.
     *
     * Useful when an app plugin loads and wants the server monitor to show
     * a more descriptive name (e.g. "Cloud Shell-UI — rocketride.pipeBuilder")
     * instead of the generic client name sent at auth time.
     *
     * @param clientName - The new display name for this connection.
     */
    identify(clientName: string): Promise<void>;
    /**
     * Persist a pipeline configuration as a named template in the account store.
     *
     * Templates are stored as JSON files under `.templates/<templateId>.json`.
     * Saving a template with an existing ID overwrites the previous version.
     *
     * @param options.templateId - Unique identifier for the template (no path separators)
     * @param options.pipeline - Pipeline configuration object to save
     * @throws Error if templateId is invalid or pipeline is not a non-empty object
     */
    saveTemplate(options: {
        templateId: string;
        pipeline: Record<string, any>;
    }): Promise<void>;
    /**
     * Retrieve a previously saved pipeline template from the account store.
     *
     * @param options.templateId - Unique identifier of the template to retrieve
     * @returns The pipeline configuration object that was saved
     * @throws Error if the template does not exist or templateId is invalid
     */
    getTemplate(options: {
        templateId: string;
    }): Promise<Record<string, any>>;
    /**
     * Delete a pipeline template from the account store.
     *
     * @param options.templateId - Unique identifier of the template to delete
     * @throws Error if the template does not exist or templateId is invalid
     */
    deleteTemplate(options: {
        templateId: string;
    }): Promise<void>;
    /**
     * List all pipeline templates stored in the account store.
     *
     * Reads the `.templates` directory, parses each `.json` file, and extracts
     * a summary for each template. Files that cannot be parsed are silently
     * skipped so a single corrupt template does not break the entire listing.
     *
     * @returns Array of template summaries sorted in directory-listing order.
     *          Each entry contains the template ID, display name, source components,
     *          and total component count.
     */
    getAllTemplates(): Promise<Array<{
        id: string;
        name: string;
        sources: any[];
        totalComponents: number;
    }>>;
    /**
     * Persist a pipeline execution log to the account store.
     *
     * Logs are stored under `.logs/<projectId>/<source>-<startTime>.log`.
     * The filename is derived from `contents.body.startTime` so logs are
     * naturally sortable by execution start time.
     *
     * @param options.projectId - Project identifier that owns this log
     * @param options.source - Source component identifier the log is associated with
     * @param options.contents - Log payload; must contain `body.startTime`
     * @returns The generated filename (e.g. `"ingest-1714000000000.log"`)
     * @throws Error if any ID is invalid, contents is not an object, or startTime is missing
     */
    saveLog(options: {
        projectId: string;
        source: string;
        contents: Record<string, any>;
    }): Promise<string>;
    /**
     * Retrieve a previously saved pipeline execution log from the account store.
     *
     * @param options.projectId - Project identifier that owns the log
     * @param options.name - Filename of the log (as returned by saveLog)
     * @returns The log payload that was saved
     * @throws Error if the log does not exist or projectId is invalid
     */
    getLog(options: {
        projectId: string;
        name: string;
    }): Promise<Record<string, any>>;
    /**
     * Delete a pipeline execution log from the account store.
     *
     * @param options.projectId - Project identifier that owns the log
     * @param options.name - Filename of the log to delete
     * @throws Error if the log does not exist or projectId is invalid
     */
    deleteLog(options: {
        projectId: string;
        name: string;
    }): Promise<void>;
    /**
     * List pipeline execution logs stored for a project, optionally filtered by source.
     *
     * Results are sorted ascending by `modified` timestamp so the oldest log
     * appears first. The caller can page through or slice the array as needed.
     *
     * @param options.projectId - Project identifier whose logs to list
     * @param options.source - Optional source component filter; when set, only logs
     *                         whose filename starts with `<source>-` are returned
     * @returns Array of log name and optional modified timestamp, sorted oldest-first
     * @throws Error if projectId (or source when provided) is invalid
     */
    listLogs(options: {
        projectId: string;
        source?: string;
    }): Promise<Array<{
        name: string;
        modified?: number;
    }>>;
    /**
     * Open a file handle for reading or writing.
     *
     * @param path - Relative path within the account store
     * @param mode - 'r' for read, 'w' for write (default: 'r')
     * @param offset - Initial byte offset (read mode only)
     * @returns Object with 'handle' (string). Read mode also includes 'size' (number).
     */
    fsOpen(path: string, mode?: "r" | "w"): Promise<{
        handle: string;
        size?: number;
    }>;
    /**
     * Read data from an open read handle.
     *
     * @param handle - Handle ID returned by fsOpen
     * @param offset - Byte offset to read from
     * @param length - Max bytes to read (default 4 MB). Empty Uint8Array indicates EOF.
     * @returns The bytes read
     */
    fsRead(handle: string, offset?: number, length?: number): Promise<Uint8Array>;
    /**
     * Write data to an open write handle.
     *
     * @param handle - Handle ID returned by fsOpen
     * @param data - Raw bytes to write
     * @returns Number of bytes written
     */
    fsWrite(handle: string, data: Uint8Array): Promise<number>;
    /**
     * Close a file handle.
     *
     * @param handle - Handle ID returned by fsOpen
     * @param mode - 'r' or 'w' (must match the mode used in fsOpen)
     */
    fsClose(handle: string, mode: "r" | "w"): Promise<void>;
    /**
     * Delete a file.
     *
     * @param path - Relative path within the account store
     * @throws Error if file does not exist or delete fails
     */
    fsDelete(path: string): Promise<void>;
    /**
     * List immediate children of a directory.
     *
     * @param path - Relative directory path (default: account root)
     * @returns Directory entries with name and type (file or dir)
     */
    fsListDir(path?: string): Promise<{
        entries: Array<{
            name: string;
            type: "file" | "dir";
            size?: number;
            modified?: number;
        }>;
        count: number;
    }>;
    /**
     * Create a directory.
     *
     * @param path - Relative directory path
     */
    fsMkdir(path: string): Promise<void>;
    /**
     * Remove a directory.
     *
     * @param path - Relative directory path
     * @param recursive - If true, delete contents recursively (default: false)
     * @throws Error if directory is not empty (when recursive is false) or delete fails
     */
    fsRmdir(path: string, recursive?: boolean): Promise<void>;
    /**
     * Get file or directory metadata.
     *
     * @param path - Relative path within the account store
     * @returns Metadata including existence, type, size (bytes), and modified epoch timestamp (for files)
     */
    fsStat(path: string): Promise<{
        exists: boolean;
        type?: "file" | "dir";
        size?: number;
        modified?: number;
    }>;
    /**
     * Rename a file or directory.
     *
     * On object stores this is implemented as copy + delete. For directories,
     * all contents are moved recursively.
     *
     * @param oldPath - Current relative path within the account store
     * @param newPath - New relative path within the account store
     * @throws Error if oldPath does not exist or rename fails
     */
    fsRename(oldPath: string, newPath: string): Promise<void>;
    /**
     * Get a direct HTTP URL for accessing a file in the store.
     *
     * For cloud backends (S3, Azure) this returns a presigned/SAS URL.
     * For local filesystem backends this returns a JWT-signed URL pointing
     * at the server's `/task/fetch` endpoint.
     *
     * The returned URL can be used directly as `src` on `<img>`, `<video>`,
     * `<audio>`, and `<iframe>` elements for native browser streaming.
     *
     * @param path - Relative path within the account store
     * @param expiresIn - URL validity in seconds (default 3600)
     * @param downloadName - If set, the URL forces a browser download with this
     *   filename (`Content-Disposition: attachment`). This is the only reliable
     *   way to control the download filename for cross-origin cloud URLs, where
     *   the `<a download>` attribute is ignored. Omit for inline streaming.
     * @returns A direct HTTP(S) URL to the file
     */
    fsGetUrl(path: string, expiresIn?: number, downloadName?: string): Promise<string>;
    /**
     * Batch-read many small files in one round trip.
     *
     * Designed for many-small-file access patterns (the App Builder's
     * lockfile-resolved node_modules view, type manifests) where per-file
     * open/read/close is too chatty. Missing/unreadable files are per-entry
     * results (`ok: false`), never a call failure.
     *
     * @param paths - Store paths to read (max 256 per call; 32 MiB total).
     * @returns One entry per requested path IN ORDER: `{path, ok, data?, error?}`.
     */
    fsReadMany(paths: string[]): Promise<Array<{
        path: string;
        ok: boolean;
        data?: Uint8Array;
        error?: string;
    }>>;
    /**
     * Publish an immutable app version to the org registry.
     *
     * Publishing never activates anything — pin a rung with {@link appDeploy}
     * to make the version live somewhere.
     *
     * @param options.appId - App id (appManifest.id, e.g. 'acme.brandy')
     * @param options.version - Semver label (e.g. '0.5.0')
     * @param options.bundle - The built remoteEntry.js bytes (single-file v1)
     * @param options.message - Commit-style "what changed" note (version card)
     * @param options.moduleId - MF container name (derived when omitted)
     * @param options.name - Display name (defaults to appId)
     * @returns The version-rail entry (registryVersion, appVersion, sha256, ...)
     */
    appPublish(options: {
        appId: string;
        version: string;
        bundle: Uint8Array;
        message?: string;
        moduleId?: string;
        name?: string;
    }): Promise<{
        registryVersion: number;
        appVersion: string;
        sha256: string;
        publishedAt: number;
        author: string;
        message: string;
    }>;
    /**
     * List an app's published versions, newest first (the version rail).
     *
     * @param appId - App id
     * @returns Rail entries; each carries `rungs` naming the rungs pinned to it
     */
    appVersions(appId: string): Promise<Array<{
        registryVersion: number;
        appVersion: string;
        sha256: string;
        publishedAt: number;
        author: string;
        message: string;
        rungs: string[];
    }>>;
    /**
     * Pin a rung to a published version — deploy, promote, and rollback are
     * all this one verb ("repoint, never rebuild").
     *
     * @param appId - App id
     * @param registryVersion - Registry version number from the rail
     * @param target - '@user', '@team/<name-or-id>', or '@org'
     * @returns The updated deployment record and the rung word
     */
    appDeploy(appId: string, registryVersion: number, target: string): Promise<{
        deployment: Record<string, unknown>;
        rung: string;
    }>;
    /**
     * The reverse index: which rungs run which version of an app.
     *
     * @param appId - App id
     * @returns Pin rows ({rung, handle, version, appVersion, state, deployedAt})
     */
    appWhere(appId: string): Promise<Array<{
        rung: string;
        handle: string;
        version: number;
        appVersion: string;
        state: string;
        deployedAt?: number;
    }>>;
    /** Read a file as a UTF-8 string. */
    fsReadString(path: string): Promise<string>;
    /** Write a UTF-8 string to a file. */
    fsWriteString(path: string, text: string): Promise<void>;
    /** Read a JSON file. */
    fsReadJson<T = any>(path: string): Promise<T>;
    /** Write an object as JSON. */
    fsWriteJson(path: string, obj: any): Promise<void>;
    /**
     * Retrieve a server dashboard snapshot.
     *
     * Returns the current state of all connections, tasks, and aggregate
     * metrics from the server. Requires 'task.monitor' permission.
     *
     * @returns DashboardResponse containing overview, connections, and tasks
     */
    getDashboard(): Promise<DashboardResponse>;
    /**
     * Retrieve one page of the caller's active connections (platform list-API
     * convention). Rows carry the same shape as the dashboard's connections
     * list; the default sort is connectedAt ascending (registration order,
     * matching the dashboard) with the monotonic id as tiebreak.
     * Requires 'task.monitor' permission.
     *
     * @param req - Paging, search, sort, and filter arguments (all optional)
     * @returns The standard { rows, total, page, pageSize } envelope
     */
    listConnections(req?: ListPageRequest): Promise<ListConnectionsResponse>;
    /**
     * Retrieve one page of the caller's tasks (platform list-API convention).
     * Rows carry the same shape as the dashboard's tasks list; the default
     * sort is startTime ascending (creation order, matching the dashboard)
     * with the task id as tiebreak. Requires 'task.monitor' permission.
     *
     * @param req - Paging, search, sort, and filter arguments (all optional)
     * @returns The standard { rows, total, page, pageSize } envelope
     */
    listTasks(req?: ListPageRequest): Promise<ListTasksResponse>;
    /**
     * Start a cProfile profiling session on the server process or a pipeline.
     *
     * @param target  - Task token to profile a pipeline subprocess, or
     *                  undefined/null to profile the server process itself.
     * @param session - Optional human-readable session name.
     * @returns Status object with session info and start time.
     */
    cprofileStart(target?: string | null, session?: string): Promise<CProfileStatusResponse>;
    /**
     * Stop the active cProfile profiling session.
     *
     * @param target - Task token if profiling a pipeline, or undefined for server.
     * @returns Result with session name and runtime.
     */
    cprofileStop(target?: string | null): Promise<CProfileStopResponse>;
    /**
     * Get the current cProfile profiling status.
     *
     * @param target - Task token if querying a pipeline, or undefined for server.
     * @returns Status indicating active/inactive, owner, runtime.
     */
    cprofileStatus(target?: string | null): Promise<CProfileStatusResponse>;
    /**
     * Get the full cProfile report from the last completed session.
     *
     * @param target - Task token if querying a pipeline, or undefined for server.
     * @returns Object containing the full pstats text report.
     */
    cprofileReport(target?: string | null): Promise<CProfileReportResponse>;
    /**
     * Get a structured call tree from the last completed profiling session.
     *
     * Returns a hierarchical JSON tree suitable for flame graph, sunburst,
     * and icicle visualisations.  Supports optional depth and minimum
     * percentage pruning parameters.
     *
     * @param target   - Task token if querying a pipeline, or undefined for server.
     * @param maxDepth - Maximum tree depth (default 50).
     * @param minPct   - Minimum cumtime percentage threshold (default 0.1).
     * @returns Object containing the tree root, total_time, and total_calls.
     */
    cprofileReportTree(target?: string | null, maxDepth?: number, minPct?: number, includeSystem?: boolean): Promise<CProfileReportTreeResponse>;
    /**
     * Async disposal support for 'await using' pattern.
     * Equivalent to Python's __aexit__
     */
    [Symbol.asyncDispose](): Promise<void>;
    /**
     * Static factory method for automatic connection management.
     * Equivalent to Python's async with pattern
     */
    static withConnection<T>(config: RocketRideClientConfig, callback: (client: RocketRideClient) => Promise<T>): Promise<T>;
    /**
     * Retrieve all available service definitions from the server.
     *
     * Returns a dictionary containing all service definitions available on
     * the connected RocketRide server. Each service definition includes schemas,
     * UI schemas, and configuration metadata.
     *
     * @returns Promise resolving to object mapping service names to their definitions
     * @throws Error if the request fails or server returns an error
     *
     * @example
     * ```typescript
     * // Get all available services
     * const services = await client.getServices();
     *
     * // List available service names
     * for (const name of Object.keys(services)) {
     *   console.log(`Available service: ${name}`);
     * }
     *
     * // Access a specific service's schema
     * if (services['ocr']) {
     *   console.log('OCR schema:', services['ocr'].schema);
     * }
     * ```
     */
    getServices(): Promise<ServicesResponse>;
    /**
     * Retrieve a specific service definition from the server.
     *
     * Returns the definition for a specific service (connector) by name.
     * The definition includes schemas, UI schemas, and configuration metadata.
     *
     * @param service - Name of the service to retrieve (e.g., 'ocr', 'embed', 'chat')
     * @returns Promise resolving to service definition or undefined if not found
     * @throws Error if the request fails or server returns an error
     *
     * @example
     * ```typescript
     * // Get OCR service definition
     * const ocr = await client.getService('ocr');
     * if (ocr) {
     *   console.log('OCR schema:', ocr.schema);
     *   console.log('OCR UI schema:', ocr.uiSchema);
     * } else {
     *   console.log('OCR service not available');
     * }
     * ```
     */
    getService(service: string): Promise<ServiceDefinition | undefined>;
    /**
     * Get connection information (TypeScript-specific convenience)
     */
    getConnectionInfo(): {
        connected: boolean;
        transport: string;
        uri: string;
    };
    /**
     * Get API key (for debugging/validation)
     */
    getApiKey(): string | undefined;
    /**
     * Lazily-initialised account API namespace.
     *
     * Provides typed methods for managing the authenticated user's profile,
     * API keys, organization, members, and teams.
     *
     * @example
     * ```typescript
     * const profile = await client.account.getProfile();
     * ```
     */
    get account(): AccountApi;
    /**
     * Lazily-initialised billing API namespace.
     *
     * Provides typed methods for managing subscriptions, Stripe checkout
     * sessions, billing portal access, and compute credit wallets.
     *
     * @example
     * ```typescript
     * const details = await client.billing.getDetails(orgId);
     * ```
     */
    get billing(): BillingApi;
    /**
     * Lazily-initialised database API namespace.
     *
     * Provides direct SQL/Cypher execution against database pipelines, bypassing
     * the LLM translation layer that {@link RocketRideClient.chat} uses.
     *
     * @example
     * ```typescript
     * const result = await client.database.query({ token, sql: 'SELECT 1' });
     * ```
     */
    get database(): DatabaseApi;
    /**
     * Lazily-initialised deploy API namespace (teams-as-environments).
     *
     * Publish immutable pipeline versions to the org registry, point teams
     * at them (promotion and rollback alike), schedule sources, and read
     * the audit history.
     *
     * @example
     * ```typescript
     * const { artifact } = await client.deploy.publish(pipeline, { comment: 'v2' });
     * await client.deploy.deploy('proj-1', artifact.version!, 'team-staging');
     * ```
     */
    get deploy(): DeployApi;
    /**
     * Run-log API namespace — chapters, ranged reads, and deletion over the
     * per-task event continuum.
     *
     * @example
     * ```typescript
     * // Own dev stream; add teamId to address a team's deploy continuum.
     * const stream = { projectId: 'proj', source: 'chat_1' };
     * const { chapters } = await client.log.chapters(stream);
     * const { events } = await client.log.read(stream, { fromSeq: chapters[0].beginSeq });
     * ```
     */
    get log(): LogApi;
    /**
     * Sends a DAP command, unwraps the response body, and throws on failure.
     *
     * This is the single public entry point for all typed DAP operations.
     * The {@link AccountApi} and {@link BillingApi} namespaces delegate here.
     *
     * If an `onTrace` callback was provided in the constructor config, it is
     * invoked before the request (TraceType.Request) and after completion
     * (TraceType.Success or TraceType.Error).
     *
     * @param command - DAP command name (e.g. "rrext_account_me").
     * @param args    - Key/value arguments forwarded in the request.
     * @param options - Optional token (for task-scoped calls) and timeout in ms.
     * @returns The `body` field of a successful DAP response.
     * @throws Error if the server signals failure.
     */
    call<T = any>(command: string, args?: Record<string, unknown>, options?: {
        token?: string;
        timeout?: number;
    }): Promise<T>;
    /**
     * Invoke a @tool_function on a pipeline node.
     *
     * Sends a `tool` subcommand through the DAP data connection.  The server
     * borrows a pipeline instance from the pool, dispatches the tool call
     * through the control plane, and returns the result directly — no
     * Question, Answer, or SSE overhead.
     *
     * @param options.token - Pipeline token for authentication and resource access
     * @param options.tool - Name of the @tool_function to invoke (e.g. 'search', 'list', 'execute')
     * @param options.nodeId - Target node ID.  When empty the call broadcasts to all
     *                         tool-lane nodes; the first node that owns the tool handles it.
     * @param options.input - Arguments forwarded to the tool function
     * @param options.timeout - Optional per-request timeout in ms
     * @returns The tool's return value (typically a record/object)
     * @throws Error if the server signals failure or no node handles the requested tool
     */
    tool<T = any>(options: {
        token: string;
        tool: string;
        nodeId?: string;
        input?: Record<string, unknown>;
        timeout?: number;
    }): Promise<T>;
}
interface ShellConnectionState {
    /** The shared RocketRideClient instance, or `null` if not yet initialised. */
    client: RocketRideClient | null;
    /** `true` when the WebSocket is authenticated and connected. */
    isConnected: boolean;
    /** Transient status bar text (e.g. `"Reconnecting\u2026"`), or `null` when clear. */
    statusMessage: string | null;
}
/**
 * React hook that provides connection state from the ConnectionManager singleton.
 *
 * Subscribes to `shell:connected`, `shell:disconnected`, and `shell:statusMessage`
 * events and returns React state that triggers re-renders on changes.
 *
 * No context provider is required — call this hook from any component.
 *
 * @returns The current connection state (`client`, `isConnected`, `statusMessage`).
 *
 * @example
 * ```tsx
 * const { client, isConnected } = useShellConnection();
 * if (!client || !isConnected) return <div>Connecting...</div>;
 * ```
 */
export declare function useShellConnection(): ShellConnectionState;
/**
 * Hook that returns the current authenticated user identity, or null if
 * the shell has not yet completed a successful connectClient() call.
 *
 * Consumers should treat a null return as "not authenticated" and either
 * show a loading state or redirect to login.
 *
 * @returns The ConnectResult from the most recent successful connection, or null.
 */
export declare function useAuthUser(): ConnectResult | null;
/**
 * Hook that returns a logout callback, or null if logout is not applicable.
 *
 * In the current server-driven auth architecture, logout is handled by
 * ShellApp via a full page reload rather than an explicit callback, so
 * this hook always returns null. It exists as a forward-compatible
 * placeholder for future OAuth-based logout flows.
 *
 * @returns Always null in the current implementation.
 */
export declare function useLogout(): (() => void) | null;
/**
 * Props injected by the shell into the app's main `<App />` component.
 *
 * The shell passes connection and identity state so the app can react to
 * auth and connectivity changes without subscribing to the event bus.
 */
export interface ShellAppProps {
    /** Whether the RocketRide WebSocket is currently connected. */
    isConnected: boolean;
    /** Authenticated user identity, or null when not logged in. */
    identity: ConnectResult | null;
}
/**
 * Props injected by the shell into the app's `<Sidebar />` component.
 *
 * The sidebar zone is collapsible; apps should hide or simplify their
 * sidebar content when `collapsed` is true.
 */
export interface ShellSidebarProps {
    /** True when the sidebar is in collapsed (icon-only) mode. */
    collapsed: boolean;
}
/**
 * Persisted preferences for a single app instance.
 *
 * Some fields (`theme`, `sidePanelOpen`) are also written to `global.json` so
 * they survive app switches — see `useWorkspaceState.writeGlobalPrefs`.
 * The index signature allows apps to stash additional preference keys without
 * extending this interface.
 */
export interface WorkspacePrefs {
    /** ID of the currently active view or panel within the app. */
    activeView: string;
    /** ID of the currently active sidebar activity (e.g. 'explorer', 'search'). */
    activeActivity: string | null;
    /** Whether the sidebar zone is expanded. Mirrored to global.json. */
    sidePanelOpen: boolean;
    /** Current theme ID. Mirrored to global.json. */
    theme: string;
    /** Extensible — apps can store additional preference keys. */
    [key: string]: unknown;
}
/**
 * Complete persisted state for one app.
 *
 * Written to `<workspaceDir>/<appId>.workspace.json`.  At runtime each app's
 * slice lives under `WorkspaceState.apps[appId]`.
 *
 * `prefs` holds shell-managed preferences.  `appState` is an opaque blob
 * owned entirely by the app (or the Documents component library) — the shell
 * persists it but never reads its contents.
 */
export interface AppWorkspaceState {
    /** Shell-managed preferences (theme, active view, sidebar state). */
    prefs: WorkspacePrefs;
    /** Opaque app-owned state. Used by the Documents library to persist open docs, editors, groups, etc. */
    appState: Record<string, unknown>;
}
/**
 * Top-level workspace state shape.
 *
 * Only `activeAppId` is stored in `global.json`; individual app data lives in
 * per-app files.  The `apps` map is the in-memory union of all loaded app
 * states during a session.
 */
export interface WorkspaceState {
    version: 3;
    activeAppId: string;
    apps: Record<string, AppWorkspaceState>;
}
/** Value types a setting may hold — mirrors the JSON primitive types. */
export type SettingValue = string | number | boolean;
/**
 * JSON-Schema-style declaration of a single setting.
 *
 * The shape is 100% format-compatible with a property entry in the VSCode
 * extension specification's `contributes.configuration` section, so anyone who
 * has written a VSCode extension already knows how to declare a RocketRide
 * setting.  RocketRide-specific editors are expressed through the JSON-Schema
 * `format` keyword (unknown formats are legal JSON Schema), keeping the
 * structural compatibility intact.
 *
 * The display label is DERIVED from the setting key, VSCode-style:
 * 'rocketride.pipeBuilder.pipelineTraceLevel' renders as
 * "Pipeline Builder: Pipeline Trace Level" — there is no label field.
 * Key casing is therefore label casing (use 'pipelineTTL' for "Pipeline TTL").
 */
export interface SettingSchema {
    /** JSON type of the value. Drives the rendered control. */
    type: "string" | "number" | "integer" | "boolean";
    /**
     * Default value when the user has not set this key.  Defaults live ONLY in
     * the schema — `settings.json` stores deltas and never contains defaults.
     */
    default?: SettingValue;
    /** Plain-text description shown below the setting label. */
    description?: string;
    /** Markdown variant of the description (preferred when both are present). */
    markdownDescription?: string;
    /**
     * Fixed value choices — renders as a dropdown. Typed string[] per the
     * frozen v0 contract; integer/number schemas may carry numeric entries in
     * the manifest JSON at runtime, so render through String() and coerce the
     * selected value back via `type`.
     */
    enum?: Array<string | number>;
    /** Per-choice descriptions aligned with `enum`. */
    enumDescriptions?: string[];
    /** Ordering hint within the section (lower renders first). */
    order?: number;
    /**
     * RocketRide editor extension via the JSON-Schema `format` keyword:
     *
     * - `'rocketride.envkey'`  — the value is the NAME of a server-side
     *   Variable (never the secret itself); renders as a Variable picker.
     * - `'rocketride.service'` — the value is a service id from the cached
     *   service catalog; renders as a service dropdown (see `classType`).
     */
    format?: string;
    /** Service classType filter — only used with format 'rocketride.service'. */
    classType?: string;
    /** Extension keyword: highlight the setting as required when unset. */
    required?: boolean;
    /** Extension keyword: placeholder text for empty string inputs. */
    placeholder?: string;
}
/**
 * An app's settings contribution — the exact shape of the
 * `contributes.configuration` section in the VSCode extension manifest
 * specification.
 *
 * Declared in the app's package.json under
 * `appManifest.contributes.configuration` and delivered to the shell on the
 * manifest's `configuration` field.  Keys are dotted and prefixed with the
 * app id (e.g. 'rocketride.pipeBuilder.pipelineTraceLevel') so they are
 * globally unique and self-identify their owning app.
 */
export interface AppConfiguration {
    /**
     * Section title shown in the settings page nav.  Defaults to the app name.
     * Apps that declare the SAME title are merged into one section (shared
     * settings across a family of apps, e.g. games).
     */
    title?: string;
    /** Setting declarations keyed by full dotted setting key. */
    properties: Record<string, SettingSchema>;
}
/**
 * Lightweight descriptor for an app, available at boot before the app's
 * JavaScript bundle has been loaded.
 *
 * Generated at build time from each app's `package.json` `appManifest` field.
 * The `load` function is the only non-JSON field — it is synthesised at
 * runtime by `bootstrap.tsx` to trigger the dynamic MF import.
 */
interface AppManifestEntry$1 {
    /** Stable unique identifier — matches the AppDescriptor id. */
    id: string;
    /**
     * Module Federation container name.  Derived from id by replacing
     * non-identifier characters with underscores (e.g. 'rocketride.pipeBuilder' → 'rocketride_pipeBuilder').
     * Populated at build time by the registerApp script; not declared in package.json.
     */
    moduleId: string;
    /** Publisher name shown in the app store (e.g. 'Aparavi Software AG'). */
    publisher?: string;
    /** Display name shown in the app switcher. */
    name: string;
    /** Short description shown in the app store. */
    description?: string;
    /** URL to the app's icon (e.g. /apps/rocket-ui/icon.svg). */
    icon?: string;
    /** Markdown description shown on the app detail card. */
    readme?: string;
    /** Categories for filtering/grouping in the app store. */
    categories?: string[];
    /**
     * The app's settings contribution (VSCode `contributes.configuration`
     * shape).  Available at boot from the manifest — the settings registry is
     * flattened from the configurations of all desktop apps.
     */
    configuration?: AppConfiguration;
    /**
     * When false, the app can run without authentication (e.g. home/landing page).
     * Defaults to true — most apps require the user to be logged in.
     */
    authenticated?: boolean;
    /**
     * When false, the shell header (app name/icon bar in the sidebar) is hidden,
     * allowing the app to render its own header. Defaults to true.
     */
    showHeader?: boolean;
    /**
     * When false, the status bar is hidden for this app.
     * Defaults to true — most apps show the status bar.
     */
    showStatusBar?: boolean;
    /** App lifecycle status: auth | free | unsubscribed | subscribed | trialing | past_due | canceled. */
    appStatus?: string;
    /** Whether this app is on the user's desktop. */
    onDesktop?: boolean;
    /**
     * The shell-api contract version this app was built against (stamped into
     * apps.json by the registration step from shell-ui's apiver.ts). The lowest
     * value across all registered apps is the oldest frozen version still in use,
     * which is what can be safely pruned once nothing depends on it.
     */
    shellApiVersion?: number;
    /** Async loader — dynamically imports and returns the full AppDescriptor. */
    load: () => Promise<AppDescriptor>;
}
/**
 * Full descriptor contributed by each app plugin bundle.
 *
 * The shell stores one of these per app in `WorkspaceContext.loadedApps` once
 * the dynamic import triggered by `AppManifestEntry.load()` resolves.
 *
 * The `components` object provides the React components the shell mounts in
 * its screen zones.  The `exports` bag holds additional components that other
 * apps can load via Module Federation for cross-app composition.
 */
export interface AppDescriptor {
    /** Unique stable identifier — used as the workspace file key. */
    id: string;
    /** Display name shown in the app switcher. */
    name: string;
    /** Optional icon shown in the app switcher list. */
    icon?: React$1.ReactNode;
    /** Branding tokens (logo, welcome text) for the app. */
    branding: ShellBrandingConfig;
    /**
     * Component catalog.  The shell mounts well-known components in its
     * screen zones:
     *
     * - `App`     — required, mounted in the client area.
     * - `Sidebar` — optional, mounted in the sidebar zone.  If absent the
     *               sidebar zone is hidden for this app.
     *
     * Any additional components (e.g. `Canvas`, `Toolbar`) are ignored by
     * the shell but available for cross-app loading via `useAppComponent()`.
     */
    components: {
        App: React$1.ComponentType<ShellAppProps>;
        Sidebar?: React$1.ComponentType<ShellSidebarProps>;
        [key: string]: React$1.ComponentType<any> | undefined;
    };
}
/**
 * Branding tokens for a specific app or the login screen.
 *
 * All fields except `appName` are optional React nodes or strings that the
 * shell renders in designated branding slots (sidebar logo, welcome screen,
 * etc.).
 */
export interface ShellBrandingConfig {
    /** App display name used in the sidebar header and tab bar. */
    appName: string;
    /** Logo rendered in the expanded sidebar header. */
    logo?: React$1.ReactNode;
    /** Compact logo rendered in the collapsed sidebar header. */
    logoCollapsed?: React$1.ReactNode;
    /**
     * Theme-aware icon for the sidebar header.
     * The shell picks iconDark on dark palettes, iconLight on light palettes.
     * Falls back to the manifest `icon` SVG, then to a 2-letter monogram.
     */
    iconDark?: React$1.ReactNode;
    /** Light-palette variant of the sidebar header icon. */
    iconLight?: React$1.ReactNode;
    /** Single icon used when iconDark/iconLight are not provided. */
    icon?: React$1.ReactNode;
    /** Logo rendered on the welcome/loading screen. */
    welcomeLogo?: React$1.ReactNode;
    /** Title text on the welcome/loading screen. */
    welcomeTitle?: string;
    /** Subtitle text on the welcome/loading screen. */
    welcomeSubtitle?: string;
}
/**
 * A single theme option shown in the shell's theme picker.
 */
export interface ShellThemeOption {
    /** CSS theme bundle identifier (e.g. 'rocketride-light'). */
    id: string;
    /** Human-readable display name (e.g. 'RocketRide Light'). */
    name: string;
}
/**
 * Theme configuration supplied by the host (cloud) app.
 *
 * `options` populates the theme picker list.  `onThemeChange` is called after
 * the shell updates `prefs.theme` — used for fetching and applying theme CSS.
 */
export interface ShellThemeConfig {
    /** Ordered list of theme choices shown in the theme picker. */
    options: ShellThemeOption[];
    /** Called after shell updates prefs.theme, for fetching/applying theme CSS. */
    onThemeChange?: (themeId: string) => void;
}
/**
 * Account information and logout callback provided by the host shell.
 *
 * The shell uses these to populate the account overlay and wire up the logout
 * button.  All fields are optional to allow partial or deferred availability.
 */
export interface ShellAccountConfig {
    /** Display name of the authenticated user. */
    userName?: string;
    /** Email address of the authenticated user. */
    userEmail?: string;
    /** Callback to trigger the logout flow. */
    onLogout?: () => void;
}
/**
 * All runtime configuration — passed as one flat object from the host (cloud)
 * through ShellConfig into every remote app via useShellApiConfig().
 *
 * All keys are RR_* so they mirror the .env variable names exactly.
 * Remote apps never read process.env directly.
 */
export interface ShellApiConfig {
    /** Base URI for the RocketRide WebSocket server. */
    ROCKETRIDE_URI?: string;
    /** Hard-coded API key for service accounts / dev; bypasses OAuth2 when present. */
    RR_APIKEY?: string;
    /** Stripe publishable key — required for Stripe Elements checkout. */
    RR_STRIPE_PUBLISHABLE_KEY?: string;
    /** Zitadel instance base URL — required for PKCE OAuth login. */
    RR_ZITADEL_URL?: string;
    /** Zitadel application client ID — required for PKCE OAuth login. */
    RR_ZITADEL_CLIENT_ID?: string;
    /** Additional runtime settings loaded from .workspace/settings.json. */
    [key: string]: string | undefined;
}
/**
 * Root configuration object passed to `<ShellApp>` by the cloud host.
 *
 * This is the primary integration point: the host assembles one `ShellConfig`
 * and hands it to the shell.  The shell never imports from the host directly —
 * all host-specific behaviour is injected through this object.
 */
export interface ShellConfig {
    /** App registry — loaded lazily when each app is first activated. */
    apps: AppManifestEntry$1[];
    /** Server capability tags: ['oss'] for open-source, ['saas'] for cloud. */
    capabilities?: string[];
    /** All RR_* runtime config — passed through to remote apps via useShellApiConfig(). */
    apiConfig: ShellApiConfig;
    /** Branding shown on the loading screen before any app is mounted. */
    loginBranding?: {
        appName?: string;
        logo?: React$1.ReactNode;
        welcomeTitle?: string;
        welcomeSubtitle?: string;
    };
    /** Theme picker options and change callback. */
    themeConfig: ShellThemeConfig;
    /** Authenticated user info and logout callback. */
    account: ShellAccountConfig;
    /** Directory for workspace state files. Default: ".workspace". */
    workspaceDir?: string;
    /** Called once on mount before auth — use for initial theme application etc. */
    onInit?: () => void;
}
interface RegistryEntry {
    /** Full dotted setting key (e.g. 'rocketride.pipeBuilder.pipelineTraceLevel'). */
    key: string;
    /** The setting's JSON-Schema-style declaration. */
    schema: SettingSchema;
}
interface RegistrySection {
    /** Stable section id (the first contributing app's id). */
    id: string;
    /** Display title (configuration.title, falling back to the app name). */
    title: string;
    /** Ids of every app contributing to this section. */
    appIds: string[];
    /** Ordered setting entries (schema `order` first, then declaration order). */
    entries: RegistryEntry[];
}
interface SettingsRegistry {
    /** Nav sections in first-contribution order. */
    sections: RegistrySection[];
    /** Every declared schema keyed by full setting key. */
    schemas: Map<string, SettingSchema>;
    /** Default values for every key that declares one. */
    defaults: Record<string, SettingValue>;
}
type ActivityEvent = {
    source: "task";
    body: TaskEvent;
    receivedAt: number;
} | {
    source: "dashboard";
    body: DashboardEvent;
    receivedAt: number;
};
/**
 * Virtual file system interface — the single abstraction for all file I/O.
 *
 * Created by the hosting container and passed as one prop through the
 * entire component stack.  Both Explorer (file tree UI) and the
 * Documents singleton (content lifecycle) use this interface.
 *
 * Implementations:
 *   - RocketVFS:  client.fsListDir / fsReadJson / fsWriteJson / fsRename / fsDelete / fsMkdir
 *   - VSCodeVFS:  postMessage to extension host
 *   - ImageVFS:   REST API calls
 *   - LocalVFS:   browser File System Access API
 */
export interface IVirtualFileSystem {
    /**
     * Lists the contents of a directory.
     *
     * @param dir - Relative directory path ('' for root).
     * @returns Array of entries with name and type.
     */
    list(dir: string): Promise<{
        name: string;
        type: "file" | "dir";
    }[]>;
    /**
     * Reads the content of a file.  Returns the content as-is — the VFS
     * implementation decides the type (object, string, ArrayBuffer, etc.).
     *
     * @param path - Relative file path.
     * @returns The file content (any serializable value).
     */
    read(path: string): Promise<unknown>;
    /**
     * Writes content to a file.  The content type matches what read() returns.
     *
     * @param path    - Relative file path.
     * @param content - The content to write.
     */
    write(path: string, content: unknown): Promise<void>;
    /**
     * Renames a file or directory.
     *
     * @param oldPath - Current relative path.
     * @param newPath - New relative path.
     */
    rename(oldPath: string, newPath: string): Promise<void>;
    /**
     * Deletes a file or directory.
     *
     * @param path - Relative path to delete.
     */
    delete(path: string): Promise<void>;
    /**
     * Creates a directory.
     *
     * @param path - Relative directory path to create.
     */
    mkdir(path: string): Promise<void>;
}
/**
 * A file or directory entry in the document tree.
 *
 * The host builds a flat array of these; Explorer derives the directory
 * hierarchy on the fly via path parsing (S3-style).
 */
interface ExplorerEntry {
    /** Full relative path (e.g. 'ingest/analyze.pipe' or 'photos/vacation'). */
    path: string;
    /** Entry type — 'file' (default) or 'dir'. */
    type?: "file" | "dir";
    /** Optional unique identifier for the document. */
    documentId?: string;
    /**
     * Optional child items displayed under this entry when expanded.
     * For pipeline apps: source components.  For other apps: layers, tracks, etc.
     */
    children?: ExplorerChild[];
}
/**
 * A child item under a document entry.
 */
interface ExplorerChild {
    /** Unique child ID. */
    id: string;
    /** Display name. */
    name: string;
    /** Optional type/category label. */
    provider?: string;
}
/**
 * Status for a single entry or child item.
 */
interface ExplorerStatus {
    /** Whether the entry/child is actively running/processing. */
    running: boolean;
    /** Error messages. */
    errors: string[];
    /** Warning messages. */
    warnings: string[];
}
/**
 * Configuration for the Explorer component.
 *
 * Allows the host to customise labels, file extension handling, and
 * which features are enabled.
 */
interface ExplorerConfig {
    /** Section header title (e.g. "Pipelines", "Photos", "Files"). */
    title: string;
    /** File extensions to filter/display (e.g. ['.pipe']). Null = show all. */
    extensions?: string[] | null;
    /**
     * Custom display name formatter.  Receives the filename (not full path)
     * and returns the display string.  Default strips known extensions.
     *
     * @param filename - The raw filename.
     * @returns The display name.
     */
    displayName?: (filename: string) => string;
    /** Placeholder text for the inline create input. Default: 'file name'. */
    createPlaceholder?: string;
    /** Empty state message. Default: 'No files'. */
    emptyMessage?: string;
    /** Whether to show the "New Folder" action. Default: true. */
    allowFolders?: boolean;
}
interface ExplorerFileAction {
    /** Stable identifier; also used as the React key. */
    id: string;
    /** Menu item label. */
    label: string;
    /** Optional leading icon node. */
    icon?: React$1.ReactNode;
    /** Invoked with the row's file path when the item is chosen. Omit if using children. */
    onSelect?: (path: string) => void;
    /** Submenu items — when present, hovering the item opens a nested menu. May be a static array or a function that receives the file path. */
    children?: ExplorerFileAction[] | ((path: string) => ExplorerFileAction[]);
}
/**
 * Props for the Explorer component.
 */
interface IExplorerProps {
    /**
     * Unused — the Explorer no longer performs file operations itself (hosts
     * provide `entries` and handle actions via callbacks). It stays REQUIRED
     * because the frozen shell contract (shell-api v1 `DocExplorerProps`) pins
     * it that way — loosening it fails `shell:check`. Pass {@link NOOP_VFS};
     * the prop drops out with the next contract version bump.
     */
    vfs: IVirtualFileSystem;
    /** Component configuration (title, extensions, display names). */
    config: ExplorerConfig;
    /** Flat array of entries (host-provided). */
    entries: ExplorerEntry[];
    /** Status per entry/child, keyed by a string identifier. */
    statuses?: Map<string, ExplorerStatus>;
    /** Whether the host is connected (enables/disables action buttons). */
    isConnected: boolean;
    /** Whether child action buttons should be shown (e.g. subscription check). */
    showChildActions?: boolean;
    /** Currently active/open file path (for highlight). */
    activeFilePath?: string;
    /** Called when the user clicks a file entry to open it. */
    onOpenFile: (path: string) => void;
    /**
     * Called for file management operations (rename, delete, create).
     * Optional — when absent, file management UI is hidden (display-only).
     */
    onFileManage?: (action: "rename" | "delete" | "createFolder" | "createFile", path: string, newName?: string) => void;
    /**
     * Called when a child item action button is clicked (e.g. run/stop).
     * Optional — when absent, no action buttons are shown on children.
     */
    onChildAction?: (action: "run" | "stop", filePath: string, childId: string, documentId?: string) => void;
    /**
     * Host-injected extra actions appended to each file row's kebab menu
     * (e.g. Export). Optional — omitted hosts (VS Code) show only rename/delete.
     */
    fileActions?: ExplorerFileAction[];
    /** Called when the user clicks the refresh button. */
    onRefresh: () => void;
    /**
     * Called when a file or directory is dragged and dropped onto a directory.
     * Optional — when absent, internal drag-to-move is disabled.
     */
    onMove?: (sourcePath: string, targetDir: string) => void;
    /**
     * Called when files are dropped from the OS onto the file tree.
     * Optional — when absent, upload-by-drop is disabled.
     *
     * @param files     - The dropped File objects.
     * @param targetDir - The directory path they were dropped onto ('' for root).
     */
    onUpload?: (files: File[], targetDir: string) => void;
}
/**
 * Explorer — a generic file tree panel like VS Code's EXPLORER.
 *
 * Renders a hierarchical file tree from a flat entries array.  Supports
 * inline rename/create, context menus, status indicators, child items
 * with action buttons, and tree/flat view toggle.
 *
 * The component is fully generic — it knows nothing about pipelines,
 * sources, or any app-specific concepts.  The hosting container provides
 * entries, statuses, and callbacks.
 */
declare const Explorer: React$1.FC<IExplorerProps>;
interface CheckoutPlan {
    /** Internal price UUID. */
    id: string;
    /** App identifier. */
    appId: string;
    /** Stripe price_* identifier. Passed to the checkout session creation. */
    stripePriceId: string;
    /** Human-readable tier label (e.g. "Starter", "Pro", "3,700 tokens"). */
    nickname: string;
    /** Price in smallest currency unit (e.g. cents for USD). */
    amountCents: number;
    /** ISO 4217 currency code. */
    currency: string;
    /** Billing interval: "month", "year", or "one_time". */
    interval: "month" | "year" | "one_time" | "";
    /** Full plan metadata from the app manifest (description, action, order, kind, credits, labels, seats, features, etc.). */
    metadata?: Record<string, any> | null;
    /** Whether the price is active. */
    isActive: boolean;
    /** ISO 8601 creation timestamp. */
    createdAt: string | null;
}
interface PromoValidation$1 {
    /** Whether the code resolved to an active Stripe promotion code. */
    valid: boolean;
    /** Human-readable failure reason when `valid` is false. */
    reason?: string;
    /** Canonical code string as stored in Stripe. */
    code?: string;
    /** Human-readable description, e.g. "25% off for 3 months". */
    description?: string;
    /** Percentage discount (e.g. 25 or 100), if percent-based. */
    percentOff?: number | null;
    /** Fixed discount in cents, if amount-based. */
    amountOffCents?: number | null;
    /** ISO currency for `amountOffCents`. */
    currency?: string | null;
    /** Coupon duration: 'once' | 'repeating' | 'forever'. */
    duration?: string | null;
    /** Months the discount repeats for (duration === 'repeating'). */
    durationInMonths?: number | null;
    /** Credits granted on redemption ({resource: amount}) — grant codes only. */
    creditsGranted?: Record<string, number> | null;
    /** Target app for a grant code — presence marks a hackathon/grant code. */
    appId?: string | null;
    /** List price in cents of the plan passed as priceId (if any). */
    amountCents?: number;
    /** First-invoice price in cents after the discount (if priceId given). */
    discountedAmountCents?: number;
}
/**
 * Core connection states shared by all hosts.
 *
 * VSCode extends this with engine-specific states (DOWNLOADING_ENGINE,
 * STARTING_ENGINE, etc.) via its own local enum that includes these values.
 */
export declare enum ConnectionState {
    /** No active connection. */
    DISCONNECTED = "disconnected",
    /** Connecting to WebSocket (after any engine/credential setup). */
    CONNECTING = "connecting",
    /** Successfully connected and authenticated. */
    CONNECTED = "connected",
    /** Connection attempt failed (network, timeout, server error). */
    FAILED = "failed",
    /** Authentication was rejected by the server (bad/expired/revoked key). */
    AUTH_FAILED = "auth-failed"
}
/**
 * The mode of connection — determines credential requirements and server type.
 *
 * - cloud:  RocketRide.ai SaaS (OAuth2 PKCE via Zitadel)
 * - local:  Local engine (VSCode only — no credentials needed)
 * - onprem: Self-hosted server (API key + host URL)
 * - docker: Docker container (auto-derived API key)
 * - service: Service account (auto-derived API key)
 * - oss:    Open-source server mode (optional API key)
 */
export type ConnectionMode = "cloud" | "local" | "onprem" | "docker" | "service" | "oss";
/**
 * Structured connection status for UI display and state tracking.
 *
 * Both hosts produce this object and expose it via getConnectionStatus().
 * UI components consume it for status bars, spinners, retry indicators, etc.
 */
export interface ConnectionStatus {
    /** Current connection state. */
    state: ConnectionState;
    /** How this connection reaches the server. */
    connectionMode: ConnectionMode;
    /** Timestamp of last successful connection. */
    lastConnected?: Date;
    /** Last error message (cleared on successful connect). */
    lastError?: string;
    /** True if we have necessary credentials/config to attempt connection. */
    hasCredentials: boolean;
    /** Current retry attempt number (0 when not retrying). */
    retryAttempt: number;
    /** Maximum retry attempts before giving up. */
    maxRetryAttempts: number;
    /** Detailed progress message (e.g. "Reconnecting...", download %). */
    progressMessage?: string;
}
/**
 * Common interface for authentication providers across all hosts.
 *
 * Both CloudAuthProvider (OAuth2 PKCE) and ApiKeyAuthProvider implement this.
 * The shell and VSCode each have platform-specific implementations, but the
 * contract is identical.
 */
export interface IAuthProvider {
    /** Initiate the sign-in flow (may redirect browser or open external URL). */
    signIn(...args: unknown[]): Promise<void>;
    /** Clear stored credentials and sign out. */
    signOut(): Promise<void>;
    /** Retrieve the stored authentication token, or null/empty if not signed in. */
    getToken(): Promise<string | null>;
    /** Returns true if a valid token is stored. */
    isSignedIn(): Promise<boolean>;
}
interface ShellAppEntry {
    /** Unique app identifier (e.g. 'rocketride.home'). */
    id: string;
    /** Display name. */
    name: string;
    /** Optional description. */
    description?: string;
}
/**
 * Canonical map of all shell event names to their payload shapes.
 *
 * Both shell-ui and VSCode emit and listen to events from this map.
 * Hosts may augment the map with host-specific events via declaration
 * merging, but the core events listed here must be consistent.
 *
 * Events are grouped by concern:
 * - **Connection lifecycle**: connect/disconnect/status
 * - **Server data**: push events, account updates, service catalog
 * - **Auth**: login/logout flows
 * - **UI coordination**: app switching, subscriptions, theme, sidebar
 */
interface ShellConnectionEventMap {
    /** Fired when the WebSocket handshake completes and authentication succeeds. */
    "shell:connected": Record<string, never>;
    /** Fired when the WebSocket closes (cleanly or due to error). */
    "shell:disconnected": {
        reason: string;
        hasError: boolean;
    };
    /**
     * Transient status bar text shown during connection state transitions.
     *
     * Examples: `"Reconnecting..."`, `"Authenticating..."`.
     * Pass `null` to clear the message.
     */
    "shell:statusMessage": {
        message: string | null;
    };
    /**
     * Full connection state machine update.
     *
     * VSCode emits this with the complete `ConnectionStatus` object
     * (state, connectionMode, hasCredentials, retryAttempt, progressMessage, etc.).
     * Cloud-ui may emit a simpler version or omit it entirely.
     *
     * Both shell-ui and VSCode now share the ConnectionStatus type from
     * shared-ui/types/connection.ts.
     */
    "shell:statusChange": ConnectionStatus;
    /** Fired when a connection attempt or operation fails with an error. */
    "shell:error": {
        error: Error | unknown;
    };
    /**
     * Every push event received from the RocketRide server over the WebSocket.
     *
     * Wraps the raw DAP event message so app plugins can subscribe to
     * server-pushed data without needing direct client access.
     */
    "shell:event": {
        event: DAPMessage;
    };
    /**
     * Server-pushed account update (e.g. subscription change, profile edit,
     * environment variable change).
     *
     * Triggered by the `apaext_account` DAP event. The payload is the
     * updated `ConnectResult` containing identity, organizations, teams,
     * envKeys, and subscription status.
     */
    "shell:accountUpdate": ConnectResult;
    /**
     * Emitted when the service catalog is fetched or refreshed.
     *
     * Contains the full services map and an optional error string if
     * the fetch failed.
     */
    "shell:servicesUpdated": {
        services: Record<string, unknown>;
        servicesError?: string;
    };
    /**
     * The app catalog has changed — shell and app-store views should update.
     *
     * Emitted after authentication (ConnectResult includes entitled apps),
     * or when the server pushes an app-publish notification. The `apps` array
     * is the complete replacement set — consumers should discard their
     * previous list entirely.
     *
     * The `apps` array contains server app entries. Typed as a minimal
     * interface to avoid importing shell-ui's AppManifestEntry into shared-ui.
     * Hosts cast to their concrete AppManifestEntry type.
     */
    "shell:appsUpdated": {
        apps: ShellAppEntry[];
    };
    /**
     * Successful authentication — identity is now available.
     *
     * Emitted after `connect()` resolves with valid credentials.
     * The `user` field contains the full `ConnectResult` with identity data.
     */
    "shell:login": {
        user: ConnectResult;
    };
    /** User signed out — identity cleared, client disconnected. */
    "shell:logout": Record<string, never>;
    /**
     * Sign-in request initiated by the UI (e.g. "Get Started" button).
     *
     * Optional `appId` specifies which app to navigate to after auth completes.
     * Optional `register` requests Zitadel's sign-up form instead of sign-in
     * (used by "Get Started" CTAs vs. "Sign In" controls).
     */
    "shell:loginRequest": {
        appId?: string;
        register?: boolean;
    };
    /** Sign-out request initiated by the UI (e.g. "Sign Out" button). */
    "shell:logoutRequest": Record<string, never>;
    /** Switch the active app without going through the workspace dispatch. */
    "shell:switchApp": {
        appId: string;
    };
    /**
     * User clicked "Subscribe" on a paid app in the marketplace.
     *
     * Opens the CheckoutModal. The `app` field is the manifest entry. The
     * optional `plan` preselects a tier and skips the picker — going straight
     * to payment (used by the web pricing page); omit it to show the picker.
     * The optional `promo` carries a discount code already validated on the
     * pricing page, so the skipped-picker checkout still applies the discount.
     */
    "shell:subscribe": {
        app: ShellAppEntry;
        plan?: CheckoutPlan;
        promo?: PromoValidation$1 | null;
    };
    /**
     * User cancelled a subscription for an app from the account/billing UI.
     * Consumers refresh their entitlement view for the given app.
     */
    "shell:unsubscribe": {
        appId: string;
    };
    /** Navigate back to the My Apps launcher screen. */
    "shell:myApps": Record<string, never>;
    /**
     * Request the shell open a built-in overlay (e.g. from a guest app's
     * profile/account menu, which can't render the shell's overlays directly).
     * The `id` selects which overlay to show.
     */
    "shell:openOverlay": {
        id: "account" | "settings" | "environment";
    };
    /** Sidebar is starting to collapse — dependent UI can prepare. */
    "shell:sidebarCollapsing": Record<string, never>;
    /**
     * Theme tokens changed.
     *
     * Contains the full set of CSS custom property key/value pairs
     * for the new theme.
     */
    "shell:themeChange": {
        tokens: Record<string, string>;
    };
    /**
     * A view became the active/focused view in the workspace. Panels that
     * defer measurement or data fetches until visible listen for this to
     * (re)initialize when their tab is activated.
     */
    "shell:viewActivated": {
        viewId: string;
    };
    /**
     * The server-side app manifest changed for this user — a dev overlay was
     * registered/expired or an app version was published/deployed. The server
     * pushes the rebuilt account (shell:accountUpdate) alongside this signal;
     * consumers that maintain their own app caches use `source` to decide
     * whether/how to refresh (e.g. 'dev-overlay', 'publish', 'expiry').
     */
    "shell:manifestRefresh": {
        source: string;
    };
    /**
     * An app's marketplace review status changed (submitted, approved,
     * rejected). Pushed to the developer org's connections so App Builder
     * surfaces update badges and show the decision toast. Optional `notes`
     * carries reviewer notes on rejection.
     */
    "app:statusChanged": {
        appId: string;
        status: string;
        notes?: string;
    };
    /**
     * Files changed under a watched store prefix (app-dev project sources,
     * install-task outputs). Debounced server-side; `paths` is the coalesced
     * set of changed paths under `prefix`. App Builder file views and type
     * caches invalidate on this.
     */
    "store:changed": {
        prefix: string;
        paths: string[];
    };
}
interface IConnectionManager {
    /**
     * Returns the underlying RocketRideClient instance, or `null` if not
     * yet initialized.
     *
     * Typed as `unknown` so the shared package does not depend on the
     * concrete client type. Hosts should cast to `RocketRideClient` in
     * their own code.
     */
    getClient(): unknown | null;
    /** Returns `true` if the WebSocket is authenticated and connected. */
    isConnected(): boolean;
    /**
     * Returns the cached `ConnectResult` from the most recent successful
     * authentication, or `null` if never connected.
     *
     * Contains identity, organizations, teams, envKeys, subscription status.
     */
    getAccountInfo(): unknown | null;
    /**
     * Returns the cached service catalog.
     *
     * If the cache is empty and the client is connected, implementations
     * should trigger a lazy background fetch and emit `shell:servicesUpdated`
     * when the result arrives.
     */
    getCachedServices(): {
        services: Record<string, unknown>;
        servicesError?: string;
    };
    /**
     * Fetches the service catalog from the server and updates the cache.
     *
     * Deduplicates concurrent calls.  Emits `shell:servicesUpdated` on
     * completion (success or failure).
     */
    refreshServices(): Promise<void>;
    /**
     * Initiates a connection to the RocketRide server.
     *
     * @param credential - Optional authentication credential. Shape varies
     *   by host (token string, PKCE exchange object, etc.).
     */
    connect(credential?: unknown): Promise<unknown>;
    /**
     * Gracefully disconnects from the RocketRide server.
     *
     * Safe to call when already disconnected.
     */
    disconnect(): Promise<void>;
    /**
     * Registers a handler for a typed shell event.
     *
     * @param event   - The event name from `ShellConnectionEventMap`.
     * @param handler - Callback invoked when the event fires.
     * @returns An unsubscribe function — call it to remove the handler.
     */
    /**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:connected', handler: (payload: ShellConnectionEventMap['shell:connected']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:disconnected', handler: (payload: ShellConnectionEventMap['shell:disconnected']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:statusMessage', handler: (payload: ShellConnectionEventMap['shell:statusMessage']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:statusChange', handler: (payload: ShellConnectionEventMap['shell:statusChange']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:error', handler: (payload: ShellConnectionEventMap['shell:error']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:event', handler: (payload: ShellConnectionEventMap['shell:event']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:accountUpdate', handler: (payload: ShellConnectionEventMap['shell:accountUpdate']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:servicesUpdated', handler: (payload: ShellConnectionEventMap['shell:servicesUpdated']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:appsUpdated', handler: (payload: ShellConnectionEventMap['shell:appsUpdated']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:login', handler: (payload: ShellConnectionEventMap['shell:login']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:logout', handler: (payload: ShellConnectionEventMap['shell:logout']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:loginRequest', handler: (payload: ShellConnectionEventMap['shell:loginRequest']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:logoutRequest', handler: (payload: ShellConnectionEventMap['shell:logoutRequest']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:switchApp', handler: (payload: ShellConnectionEventMap['shell:switchApp']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:subscribe', handler: (payload: ShellConnectionEventMap['shell:subscribe']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:unsubscribe', handler: (payload: ShellConnectionEventMap['shell:unsubscribe']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:myApps', handler: (payload: ShellConnectionEventMap['shell:myApps']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:openOverlay', handler: (payload: ShellConnectionEventMap['shell:openOverlay']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:sidebarCollapsing', handler: (payload: ShellConnectionEventMap['shell:sidebarCollapsing']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:themeChange', handler: (payload: ShellConnectionEventMap['shell:themeChange']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:viewActivated', handler: (payload: ShellConnectionEventMap['shell:viewActivated']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'shell:manifestRefresh', handler: (payload: ShellConnectionEventMap['shell:manifestRefresh']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'app:statusChanged', handler: (payload: ShellConnectionEventMap['app:statusChanged']) => void): () => void;
/**
 * Registers a handler for a typed shell event.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function — call it to remove the handler.
 */
on(event: 'store:changed', handler: (payload: ShellConnectionEventMap['store:changed']) => void): () => void;
    /**
     * Emits a typed shell event, dispatching to all registered handlers.
     *
     * Public so that any code (sidebar, home app, plugins) can fire UI
     * coordination events through the connection manager.
     *
     * @param event   - The event name from `ShellConnectionEventMap`.
     * @param payload - The payload matching the event's type.
     */
    /**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:connected', payload: ShellConnectionEventMap['shell:connected']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:disconnected', payload: ShellConnectionEventMap['shell:disconnected']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:statusMessage', payload: ShellConnectionEventMap['shell:statusMessage']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:statusChange', payload: ShellConnectionEventMap['shell:statusChange']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:error', payload: ShellConnectionEventMap['shell:error']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:event', payload: ShellConnectionEventMap['shell:event']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:accountUpdate', payload: ShellConnectionEventMap['shell:accountUpdate']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:servicesUpdated', payload: ShellConnectionEventMap['shell:servicesUpdated']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:appsUpdated', payload: ShellConnectionEventMap['shell:appsUpdated']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:login', payload: ShellConnectionEventMap['shell:login']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:logout', payload: ShellConnectionEventMap['shell:logout']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:loginRequest', payload: ShellConnectionEventMap['shell:loginRequest']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:logoutRequest', payload: ShellConnectionEventMap['shell:logoutRequest']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:switchApp', payload: ShellConnectionEventMap['shell:switchApp']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:subscribe', payload: ShellConnectionEventMap['shell:subscribe']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:unsubscribe', payload: ShellConnectionEventMap['shell:unsubscribe']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:myApps', payload: ShellConnectionEventMap['shell:myApps']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:openOverlay', payload: ShellConnectionEventMap['shell:openOverlay']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:sidebarCollapsing', payload: ShellConnectionEventMap['shell:sidebarCollapsing']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:themeChange', payload: ShellConnectionEventMap['shell:themeChange']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:viewActivated', payload: ShellConnectionEventMap['shell:viewActivated']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:manifestRefresh', payload: ShellConnectionEventMap['shell:manifestRefresh']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'app:statusChanged', payload: ShellConnectionEventMap['app:statusChanged']): void;
/**
 * Emits a typed shell event, dispatching to all registered handlers.
 *
 * Public so that any code (sidebar, home app, plugins) can fire UI
 * coordination events through the connection manager.
 *
 * @param event   - The event name from `ShellConnectionEventMap`.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'store:changed', payload: ShellConnectionEventMap['store:changed']): void;
}
export declare function useClickOutside(ref: React$1.RefObject<HTMLElement | null>, onClose: () => void): void;
export declare function useFixedPopupPosition(triggerRef: React$1.RefObject<HTMLElement | null>, isOpen: boolean, placement?: "below" | "above"): {
    top: number;
    left: number;
} | null;
export declare const PopupRow: React$1.FC<{
    children: React$1.ReactNode;
    onClick?: (e: React$1.MouseEvent<HTMLDivElement>) => void;
}>;
/** One selectable entry in a view's sub-view menu. */
export interface ViewMenuEntry {
    /** Stable identifier for the entry; passed back through `onSelect`. */
    id: string;
    /** Human-readable label shown in both renderers. */
    label: string;
    /** Neutral count badge, e.g. Tokens 48. */
    count?: number;
    /** 'error' renders the count badge in --rr-color-error. */
    severity?: "error";
    /**
     * Optional icon shown when a SidebarMenu is collapsed to its icon rail
     * (design-owner decision: collapsed sidebars show icon-only entries).
     * Entries without an icon fall back to a first-letter glyph.
     */
    icon?: React$1.ReactNode;
    /**
     * When true, the entry renders muted and is not selectable — used by
     * SidebarMenu; ignored by TabControl.
     */
    disabled?: boolean;
    /**
     * Child entries, making this entry an expandable SECTION in SidebarMenu
     * (one level deep — children never declare children of their own). A
     * section row does not navigate: clicking it expands its children and
     * collapses any other open section (accordion — at most ONE section is
     * open at a time, decision 2026-07-18). While the sidebar is collapsed
     * to the icon rail, sections flatten: their children render as icon
     * squares directly. Ignored by TabControl and DetailPanel tabs.
     */
    children?: ViewMenuEntry[];
}
/** The entry list consumed by TabControl and SidebarMenu. */
export interface ViewMenu {
    /** Ordered list of selectable sub-view entries. */
    entries: ViewMenuEntry[];
}
/** The shared preferences accessor: read one key, write one key. */
export interface IPrefsApi {
    /** Current value for `key`, or `undefined` if unset. Caller narrows the type. */
    getPref: (key: string) => unknown;
    /** Persist `value` under `key` (shallow-merged into the prefs bag). */
    setPref: (key: string, value: unknown) => void;
}
/**
 * Provides the app's prefs accessor to every shared-ui component beneath it.
 * Mount ONCE near the app root with a value backed by the host's prefs store.
 *
 * @param props.value - The `{ getPref, setPref }` implementation for this host.
 * @param props.children - The subtree that may read prefs via {@link usePrefs}.
 * @returns The provider element.
 */
export declare function PrefsProvider({ value, children }: {
    value: IPrefsApi;
    children: React$1.ReactNode;
}): React$1.ReactElement;
/**
 * Reads the ambient prefs accessor. Returns a no-op accessor when no provider is
 * mounted, so callers never need to null-check.
 *
 * @returns The `{ getPref, setPref }` accessor.
 */
export declare function usePrefs(): IPrefsApi;
/**
 * The full public API surface of the workspace context — consumed by any
 * component or hook that calls `useWorkspace()`.
 */
export interface IWorkspaceContext {
    /** True once the initial workspace load from disk has completed. */
    loaded: boolean;
    /** True once pre-auth default state has been seeded (before disk load). */
    seeded: boolean;
    /** True while the active app's descriptor is being dynamically loaded. */
    appLoading: boolean;
    /** The active app's preferences. */
    prefs: WorkspacePrefs;
    /** Opaque app-owned state (used by Documents library). */
    appState: Record<string, unknown>;
    /** Update the opaque app-owned state via a functional updater. */
    updateAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
    /** ID of the currently active app. */
    activeAppId: string;
    /** Lightweight manifest entries for all apps — always available, no bundle load needed. */
    appManifest: AppManifestEntry$1[];
    /** Fully loaded AppDescriptors, keyed by appId — populated lazily on first activation. */
    loadedApps: Record<string, AppDescriptor>;
    /** Triggers a lazy load of an app's descriptor if not already loaded. */
    loadApp: (appId: string) => void;
    /** Per-app descriptor load-failure messages, keyed by appId. Absent ⇒ no error. */
    appLoadErrors: Record<string, string>;
    /**
     * Clears the recorded load error for an app and re-attempts its descriptor
     * load. Resolves true when the re-attempt succeeded.
     */
    retryApp: (appId: string) => Promise<boolean>;
    /**
     * Evicts an app's cached descriptor so its next activation loads fresh.
     * When the app is currently active, the reload happens immediately — the
     * fresh descriptor's new component identities force a full remount (no
     * state preservation; that is the intended semantic). Used by the dev
     * hooks (local app injection) and by entry-URL change reconciliation.
     */
    invalidateApp: (appId: string) => void;
    /**
     * Set when a switch-to-app failed to load while another app stayed on
     * screen — surfaced by the shell as a modal over the current app.
     * Null when no failure is pending.
     */
    loadFailure: {
        appId: string;
        name: string;
    } | null;
    /** Dismisses the pending load-failure modal. */
    dismissLoadFailure: () => void;
    /**
     * EFFECTIVE settings — every declared default overlaid with the user's
     * stored overrides, keyed by dotted appId-prefixed key
     * (e.g. 'rocketride.models.serverHost').  Each value keeps its declared JSON
     * type (string | number | boolean).  Reading a setting is a plain lookup —
     * the default-merge already happened here.
     */
    settings: Record<string, SettingValue>;
    /**
     * RAW overrides as stored in settings.json (deltas only).  A key present
     * here means "modified from default" — this is what the settings page's
     * modified indicator and reset action read.
     */
    settingsOverrides: Record<string, SettingValue>;
    /** Flattened declarations from all desktop apps' configurations. */
    settingsRegistry: SettingsRegistry;
    /**
     * Persist a single setting value.  Writing a value equal to the schema
     * default DELETES the override (deltas-only storage); passing `undefined`
     * resets the key to its default explicitly.
     */
    updateSetting: (key: string, value: SettingValue | undefined) => void;
    /** Update the active app's workspace preferences. */
    updatePrefs: (patch: Partial<WorkspacePrefs>) => void;
    /** Available theme options (id + display name). */
    themeOptions: {
        id: string;
        name: string;
    }[];
    /** Switch the active theme (updates prefs and applies CSS). */
    setTheme: (themeId: string) => void;
    /** @deprecated Use `updatePrefs` for prefs, `ConnectionManager.getInstance().emit('shell:switchApp')` for app switches. */
    dispatch: (action: {
        type: string;
        [key: string]: unknown;
    }) => void;
    /** Emit a named event to all subscribers. Does NOT mutate workspace state. */
    /** Emit a named event to all subscribers. Does NOT mutate workspace state. */
emit: ((event: 'shell:connected', payload: ShellConnectionEventMap['shell:connected']) => void) & ((event: 'shell:disconnected', payload: ShellConnectionEventMap['shell:disconnected']) => void) & ((event: 'shell:statusMessage', payload: ShellConnectionEventMap['shell:statusMessage']) => void) & ((event: 'shell:statusChange', payload: ShellConnectionEventMap['shell:statusChange']) => void) & ((event: 'shell:error', payload: ShellConnectionEventMap['shell:error']) => void) & ((event: 'shell:event', payload: ShellConnectionEventMap['shell:event']) => void) & ((event: 'shell:accountUpdate', payload: ShellConnectionEventMap['shell:accountUpdate']) => void) & ((event: 'shell:servicesUpdated', payload: ShellConnectionEventMap['shell:servicesUpdated']) => void) & ((event: 'shell:appsUpdated', payload: ShellConnectionEventMap['shell:appsUpdated']) => void) & ((event: 'shell:login', payload: ShellConnectionEventMap['shell:login']) => void) & ((event: 'shell:logout', payload: ShellConnectionEventMap['shell:logout']) => void) & ((event: 'shell:loginRequest', payload: ShellConnectionEventMap['shell:loginRequest']) => void) & ((event: 'shell:logoutRequest', payload: ShellConnectionEventMap['shell:logoutRequest']) => void) & ((event: 'shell:switchApp', payload: ShellConnectionEventMap['shell:switchApp']) => void) & ((event: 'shell:subscribe', payload: ShellConnectionEventMap['shell:subscribe']) => void) & ((event: 'shell:unsubscribe', payload: ShellConnectionEventMap['shell:unsubscribe']) => void) & ((event: 'shell:myApps', payload: ShellConnectionEventMap['shell:myApps']) => void) & ((event: 'shell:openOverlay', payload: ShellConnectionEventMap['shell:openOverlay']) => void) & ((event: 'shell:sidebarCollapsing', payload: ShellConnectionEventMap['shell:sidebarCollapsing']) => void) & ((event: 'shell:themeChange', payload: ShellConnectionEventMap['shell:themeChange']) => void) & ((event: 'shell:viewActivated', payload: ShellConnectionEventMap['shell:viewActivated']) => void) & ((event: 'shell:manifestRefresh', payload: ShellConnectionEventMap['shell:manifestRefresh']) => void) & ((event: 'app:statusChanged', payload: ShellConnectionEventMap['app:statusChanged']) => void) & ((event: 'store:changed', payload: ShellConnectionEventMap['store:changed']) => void);
    /** Subscribe to a named event. Returns an unsubscribe function. */
    /** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:connected', handler: (payload: ShellConnectionEventMap['shell:connected']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:disconnected', handler: (payload: ShellConnectionEventMap['shell:disconnected']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:statusMessage', handler: (payload: ShellConnectionEventMap['shell:statusMessage']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:statusChange', handler: (payload: ShellConnectionEventMap['shell:statusChange']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:error', handler: (payload: ShellConnectionEventMap['shell:error']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:event', handler: (payload: ShellConnectionEventMap['shell:event']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:accountUpdate', handler: (payload: ShellConnectionEventMap['shell:accountUpdate']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:servicesUpdated', handler: (payload: ShellConnectionEventMap['shell:servicesUpdated']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:appsUpdated', handler: (payload: ShellConnectionEventMap['shell:appsUpdated']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:login', handler: (payload: ShellConnectionEventMap['shell:login']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:logout', handler: (payload: ShellConnectionEventMap['shell:logout']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:loginRequest', handler: (payload: ShellConnectionEventMap['shell:loginRequest']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:logoutRequest', handler: (payload: ShellConnectionEventMap['shell:logoutRequest']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:switchApp', handler: (payload: ShellConnectionEventMap['shell:switchApp']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:subscribe', handler: (payload: ShellConnectionEventMap['shell:subscribe']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:unsubscribe', handler: (payload: ShellConnectionEventMap['shell:unsubscribe']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:myApps', handler: (payload: ShellConnectionEventMap['shell:myApps']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:openOverlay', handler: (payload: ShellConnectionEventMap['shell:openOverlay']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:sidebarCollapsing', handler: (payload: ShellConnectionEventMap['shell:sidebarCollapsing']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:themeChange', handler: (payload: ShellConnectionEventMap['shell:themeChange']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:viewActivated', handler: (payload: ShellConnectionEventMap['shell:viewActivated']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'shell:manifestRefresh', handler: (payload: ShellConnectionEventMap['shell:manifestRefresh']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'app:statusChanged', handler: (payload: ShellConnectionEventMap['app:statusChanged']) => void): () => void;
/** Subscribe to a named event. Returns an unsubscribe function. */
on(event: 'store:changed', handler: (payload: ShellConnectionEventMap['store:changed']) => void): () => void;
    /** Open-set overload — the event set grows; see IConnectionManager.on (shared). */
    on(event: string, handler: (payload: unknown) => void): () => void;
}
/**
 * Props for {@link WorkspaceProvider}.
 *
 * The connection (client + isConnected) is deliberately NOT a prop: the
 * provider reads it from {@link useShellConnection} like every other shell
 * component. Threading the client through props would put the SDK client in
 * an input (contravariant) position on the frozen shell-api surface, where
 * every additive SDK member would read as a breaking change.
 */
export interface IWorkspaceProviderProps {
    /** Array of lightweight app manifest entries. */
    apps: AppManifestEntry$1[];
    /** Directory for workspace persistence files (default ".workspace"). */
    workspaceDir?: string;
    /** Optional app to activate on initial load (overrides saved state). */
    startupAppId?: string;
    /** React subtree that will receive the context. */
    children: React$1.ReactNode;
    /** Fallback app when no saved state / startup override exists. */
    defaultAppId?: string;
    /** Selectable UI themes surfaced in the settings page. */
    themeOptions?: {
        id: string;
        name: string;
    }[];
    /** Notifies the host bootstrap when the user switches theme. */
    onThemeChange?: (themeId: string) => void;
}
/**
 * Provides workspace state, lazy app descriptor loading, and the shell event
 * bus to the entire React tree beneath it. Sources the RocketRide client and
 * connection state from the ConnectionManager singleton via
 * {@link useShellConnection} (provider-less; re-renders on connect events).
 *
 * @param props - See {@link IWorkspaceProviderProps}.
 */
export declare const WorkspaceProvider: React$1.FC<IWorkspaceProviderProps>;
/**
 * Returns the `IWorkspaceContext` from the nearest `WorkspaceProvider` ancestor.
 *
 * Throws an informative error if called outside the provider tree, which makes
 * misconfigured component hierarchies immediately obvious during development.
 *
 * @returns The current workspace context value.
 */
export declare function useWorkspace(): IWorkspaceContext;
/**
 * Returns the RocketRideClient if connected, or null if not.
 *
 * Replaces the common defensive pattern:
 * ```ts
 * const client = getClient();
 * if (!client || !client.isConnected()) return;
 * ```
 *
 * The returned client is guaranteed to be connected when non-null.
 * Re-renders when connection state changes.
 *
 * @returns The connected RocketRideClient, or null.
 *
 * @example
 * ```tsx
 * const client = useClient();
 * if (!client) return <div>Not connected</div>;
 * const data = await client.getDashboard();
 * ```
 */
export declare function useClient(): RocketRideClient | null;
/**
 * Subscribe to a typed shell event with automatic cleanup on unmount.
 *
 * Replaces the common pattern of manually calling `cm.on()` in a useEffect
 * and returning the unsubscribe function. The handler is stable — it always
 * calls the latest version without needing it in the dependency array.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 *
 * @example
 * ```tsx
 * useShellEvent('shell:event', ({ event }) => {
 *     console.log('Server pushed:', event);
 * });
 * ```
 */
export declare function useShellEvent<K extends keyof ShellConnectionEventMap>(event: K, handler: (payload: ShellConnectionEventMap[K]) => void): void;
type AppStatus = "auth" | "free" | "unsubscribed" | "subscribed" | "trialing" | "past_due" | "canceled";
/**
 * Returns the user's desktop apps from ``ConnectResult.apps``.
 *
 * Single source of truth for which apps are on the desktop and their
 * subscription status. Data arrives with the auth handshake and is
 * pushed live via ``apaext_account`` events.
 */
export declare function useSubscriptions(): {
    desktopApps: AppManifestEntry[];
    /** Quick lookup: is this appId on the desktop? */
    isOnDesktop: (appId: string) => boolean;
    /** Quick lookup: what's this app's appStatus? */
    getStatus: (appId: string) => AppStatus | undefined;
};
interface IUsePollingOptions {
    /**
     * Connection gate for the interval.
     * - 'shell' (default): poll only while the shell's global connection is up —
     *   right for anything fetched through the shell's RocketRide client.
     * - 'none': poll unconditionally — for apps that talk to their own sockets
     *   (e.g. models-ui's model-server telemetry, which runs unauthenticated
     *   and must keep ticking while the shell is disconnected).
     */
    gate?: "shell" | "none";
}
export declare function usePolling(fetcher: () => void | Promise<void>, interval: number, options?: IUsePollingOptions): void;
/** Data returned by the useDashboardData hook. */
export interface DashboardData {
    /** Latest dashboard snapshot, or null if not yet loaded. */
    data: DashboardResponse | null;
    /** Activity events (newest first). */
    events: ActivityEvent[];
    /** Last fetch failure (e.g. a permission denial), or null when healthy. */
    error: string | null;
    /** Trigger a manual refresh. */
    refresh: () => void;
}
/**
 * Shared hook that provides server dashboard data and activity events.
 *
 * Uses a module-level singleton: the first consumer starts polling, the last
 * one to unmount stops it. Data persists across view switches.
 *
 * @returns Dashboard data, events, and a manual refresh callback.
 */
export declare function useDashboardData(): DashboardData;
/**
 * Returns the current ConnectionStatus with automatic re-renders on changes.
 *
 * Subscribes to `shell:statusChange` events and returns the full
 * ConnectionStatus object (state, connectionMode, retryAttempt, etc.).
 *
 * @returns The current ConnectionStatus.
 *
 * @example
 * ```tsx
 * const status = useConnectionStatus();
 * if (status.state === ConnectionState.AUTH_FAILED) {
 *     return <div>Authentication failed: {status.lastError}</div>;
 * }
 * if (status.retryAttempt > 0) {
 *     return <div>Reconnecting... (attempt {status.retryAttempt})</div>;
 * }
 * ```
 */
export declare function useConnectionStatus(): ConnectionStatus;
/** Access host-provided API config from any component under Shell. */
export declare function useShellApiConfig(): ShellApiConfig;
/**
 * Sets up the full shell ↔ iframe postMessage bridge for a single iframe element.
 *
 * This hook must be called once per iframe component.  It installs three things:
 *
 * 1. An inbound `MessageEvent` listener on `window` that handles messages
 *    originating from the iframe (`view:ready`, `shell:logout`, `shell:openTab`).
 *
 * 2. Subscriptions to the `connectionManager` singleton that forward shell-wide events
 *    (`shell:themeChange`, `shell:connected`, `shell:disconnected`, `shell:login`,
 *    `shell:logout`, `shell:event`, `shell:viewActivated`) to the iframe as typed
 *    `postMessage` calls — but only after the iframe has signalled `view:ready`.
 *
 * 3. A stable `sendInit` callback that assembles and posts the `shell:init`
 *    bootstrap message (theme tokens, auth user, connection state, API config).
 *
 * All subscriptions are cleaned up when the component unmounts.
 *
 * @param iframeRef - A ref pointing to the `<iframe>` DOM element to bridge.
 */
export declare function useIframeBridge(iframeRef: React$1.RefObject<HTMLIFrameElement>): void;
/**
 * Loads a React component from another app's component catalog.
 *
 * If the target app's descriptor hasn't been loaded yet, triggers a lazy
 * load automatically.  Returns `null` while loading, then the component
 * once the descriptor is available.
 *
 * @param appId         - The appId of the target app (e.g. 'rocketride.pipeBuilder').
 * @param componentName - The key in that app's `components` object (e.g. 'SpecialChart').
 * @returns The React component, or null if not yet loaded / not found.
 *
 * @example
 * ```tsx
 * const Chart = useAppComponent('rocketride.otherApp', 'SpecialChart');
 * if (!Chart) return <div>Loading...</div>;
 * return <Chart data={myData} />;
 * ```
 */
export declare function useAppComponent(appId: string, componentName: string): React$1.ComponentType<any> | null;
/**
 * Declare the shell sidebar content for the calling view.
 *
 * Opt-in: an app that never calls this keeps its legacy `components.Sidebar`
 * behavior. Passing a node mounts it inside the sidebar's scrolling slot; passing
 * `null` (or unmounting) withdraws it. When no app supplies sidebar content and
 * the app has no legacy sidebar, the shell renders no sidebar and the client area
 * spans full width.
 *
 * Collapse contract: the node stays mounted while the sidebar is collapsed to
 * its icon rail. Components inside it read shared-ui's `useSidebarCollapsed()`
 * and choose their collapsed form (SidebarMenu iconifies; free-form content
 * typically returns null).
 *
 * @param content - The sidebar node to mount, or null to declare nothing.
 */
export declare function useSidebarContent(content: React$1.ReactNode | null): void;
/**
 * Returns the shared RocketRideClient instance, or `null` if not yet initialised.
 *
 * Convenience wrapper for call sites that need the client outside of a
 * React component. Prefer `ConnectionManager.getInstance().getClient()` for
 * new code.
 */
export declare function getClient(): RocketRideClient | null;
/**
 * Options for ConnectionManager.initialize().
 */
export interface InitOptions {
    /** WebSocket / HTTP base URI. Defaults to window.location.origin. */
    uri?: string;
    /** Human-readable client name sent to the server. */
    clientName?: string;
    /** Arbitrary environment metadata forwarded during handshake. */
    env?: Record<string, unknown>;
    /** Server connection mode (determines auth strategy). */
    connectionMode?: ConnectionMode;
    /**
     * Auth provider for OAuth sign-in and callback handling.
     * When set, ConnectionManager delegates all OAuth operations to it
     * instead of managing PKCE flows internally.
     */
    authProvider?: IAuthProvider;
    /** @deprecated Use ``authProvider`` instead. Zitadel OAuth2 authority URL. */
    zitadelUrl?: string;
    /** @deprecated Use ``authProvider`` instead. Zitadel OAuth2 client ID. */
    zitadelClientId?: string;
}
/**
 * A single entry in the debug event log.
 */
export interface DebugLogEntry {
    /** ISO 8601 timestamp when the event was emitted. */
    timestamp: string;
    /** The event name (e.g. 'shell:login'). */
    event: string;
    /** The raw payload passed to emit. */
    payload: unknown;
}
type WildcardHandler = (event: string, payload: unknown) => void;
/**
 * Centralized connection manager for shell-ui.
 *
 * Owns a single persistent RocketRideClient (created at initialize(), lives
 * for the page lifetime). The SDK's persist mode handles reconnection
 * automatically.
 *
 * Delegates connection backend to RemoteManager (mirrors VSCode's BaseManager
 * pattern). Auth is handled externally by CloudAuthProvider/ApiKeyAuthProvider.
 *
 * @example
 * ```ts
 * import { ConnectionManager } from 'shell-ui';
 *
 * const cm = ConnectionManager.getInstance();
 * cm.on('shell:event', ({ event }) => console.log('Server pushed:', event));
 * cm.emit('shell:switchApp', { appId: 'rocketride.home' });
 * ```
 */
export declare class ConnectionManager implements IConnectionManager {
    /** Returns the singleton ConnectionManager instance. */
    static getInstance(): ConnectionManager;
    /**
     * Initialize the ConnectionManager with server URI and create the
     * RocketRideClient.
     *
     * Idempotent — calling multiple times is safe (subsequent calls are no-ops).
     * Must be called before connect().
     *
     * @param options - Client and connection configuration.
     */
    initialize(options?: InitOptions): void;
    /**
     * Alias for initialize() — preserves the old API.
     */
    init(options?: InitOptions): void;
    /**
     * Redirect the browser to the OAuth provider for authorization.
     *
     * Delegates to the auth provider's ``signIn()`` method. Falls back to
     * the legacy PKCE flow if no auth provider is configured.
     *
     * @param register - Retained for compatibility; no longer changes the
     *                   destination. All flows land on Zitadel's login page
     *                   (prompt=login), which offers a Register link.
     */
    startOAuth(register?: boolean): Promise<void>;
    /**
     * Run the one-time auth bootstrap sequence.
     *
     * Reads auth state and takes the appropriate action:
     * - ?code= in URL → exchange PKCE code → connect
     * - stored token → reconnect
     * - nothing → show shell unauthenticated
     *
     * @param config - Optional config for theme restore and app resolution.
     * @returns The connect result and resolved app ID, or null.
     */
    bootstrap(config?: {
        apps?: Array<{
            id: string;
        }>;
        workspaceDir?: string;
        onThemeChange?: (theme: string) => void;
    }): Promise<{
        result: ConnectResult;
        appId: string;
    } | null>;
    /**
     * Connect to the server using the provided credential.
     *
     * Deduplicates concurrent calls — if a connect is already in flight,
     * returns the same promise (same pattern as VSCode's connectPromise).
     *
     * @param credential - Token string or PKCE exchange object.
     * @returns The ConnectResult on success, or null if deduplicated.
     */
    connect(credential?: unknown): Promise<ConnectResult | null>;
    /**
     * Disconnect from the server gracefully.
     * Safe to call when already disconnected.
     */
    disconnect(): Promise<void>;
    /**
     * Disconnect and reconnect.
     */
    reconnect(): Promise<void>;
    /**
     * Logout: clear auth state, disconnect, and emit shell:logout.
     */
    logout(): Promise<void>;
    /**
     * Clean up all resources. Called on page unload.
     */
    dispose(): Promise<void>;
    /** Returns the RocketRideClient instance, or null if not initialized. */
    getClient(): RocketRideClient | null;
    /** Returns true if the WebSocket is authenticated and connected. */
    isConnected(): boolean;
    /** Returns true if a connection attempt is in progress. */
    isConnecting(): boolean;
    /** Returns true if disconnected (not connecting or connected). */
    isDisconnected(): boolean;
    /** Returns true if we have credentials to attempt connection. */
    hasCredentials(): boolean;
    /** Returns a copy of the current connection status. */
    getConnectionStatus(): ConnectionStatus;
    /** Returns the cached ConnectResult from the most recent successful connect. */
    getAccountInfo(): ConnectResult | undefined;
    /** Returns the resolved server HTTP URL. */
    getHttpUrl(): string;
    /** Persist a user token to sessionStorage. */
    saveToken(token: string): void;
    /** Load token from sessionStorage. Returns empty string if unavailable. */
    loadToken(): string;
    /** Clear the persisted token. */
    clearToken(): void;
    /** Update the hasCredentials flag based on token availability. */
    updateCredentialsStatus(): void;
    /** Read session-locked app ID from sessionStorage. */
    getSessionAppId(): string;
    /** Save session-locked app ID to sessionStorage. */
    setSessionAppId(id: string): void;
    /** Read the pending app ID (set before OAuth redirect). */
    getPendingAppId(): string;
    /** Clear the pending app ID. Called when an OAuth round-trip is abandoned
     *  (user pressed Back from Zitadel) so the stale target can't re-seed the
     *  auth gate on the next load and bounce them straight back to login. */
    clearPendingAppId(): void;
    /** Save pending app ID (for retrieval after OAuth callback). */
    setPendingAppId(id: string): void;
    /**
     * Returns the cached service catalog, triggering a lazy fetch on first access.
     */
    getCachedServices(): {
        services: Record<string, unknown>;
        servicesError?: string;
    };
    /**
     * Fetches the service catalog from the server and updates the cache.
     * Deduplicates concurrent calls.
     */
    refreshServices(): Promise<void>;
    /**
     * Emit a typed shell event, dispatching to all registered handlers.
     * Also pushes to the debug log for the ALT+D panel.
     *
     * @param event   - The event name from ShellConnectionEventMap.
     * @param payload - The payload matching the event's type.
     */
    /**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:connected', payload: ShellConnectionEventMap['shell:connected']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:disconnected', payload: ShellConnectionEventMap['shell:disconnected']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:statusMessage', payload: ShellConnectionEventMap['shell:statusMessage']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:statusChange', payload: ShellConnectionEventMap['shell:statusChange']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:error', payload: ShellConnectionEventMap['shell:error']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:event', payload: ShellConnectionEventMap['shell:event']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:accountUpdate', payload: ShellConnectionEventMap['shell:accountUpdate']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:servicesUpdated', payload: ShellConnectionEventMap['shell:servicesUpdated']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:appsUpdated', payload: ShellConnectionEventMap['shell:appsUpdated']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:login', payload: ShellConnectionEventMap['shell:login']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:logout', payload: ShellConnectionEventMap['shell:logout']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:loginRequest', payload: ShellConnectionEventMap['shell:loginRequest']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:logoutRequest', payload: ShellConnectionEventMap['shell:logoutRequest']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:switchApp', payload: ShellConnectionEventMap['shell:switchApp']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:subscribe', payload: ShellConnectionEventMap['shell:subscribe']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:unsubscribe', payload: ShellConnectionEventMap['shell:unsubscribe']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:myApps', payload: ShellConnectionEventMap['shell:myApps']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:openOverlay', payload: ShellConnectionEventMap['shell:openOverlay']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:sidebarCollapsing', payload: ShellConnectionEventMap['shell:sidebarCollapsing']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:themeChange', payload: ShellConnectionEventMap['shell:themeChange']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:viewActivated', payload: ShellConnectionEventMap['shell:viewActivated']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'shell:manifestRefresh', payload: ShellConnectionEventMap['shell:manifestRefresh']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'app:statusChanged', payload: ShellConnectionEventMap['app:statusChanged']): void;
/**
 * Emit a typed shell event, dispatching to all registered handlers.
 * Also pushes to the debug log for the ALT+D panel.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param payload - The payload matching the event's type.
 */
emit(event: 'store:changed', payload: ShellConnectionEventMap['store:changed']): void;
    /**
     * Register a typed handler for a shell event.
     *
     * @param event   - The event name from ShellConnectionEventMap.
     * @param handler - Callback invoked when the event fires.
     * @returns An unsubscribe function.
     */
    /**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:connected', handler: (payload: ShellConnectionEventMap['shell:connected']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:disconnected', handler: (payload: ShellConnectionEventMap['shell:disconnected']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:statusMessage', handler: (payload: ShellConnectionEventMap['shell:statusMessage']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:statusChange', handler: (payload: ShellConnectionEventMap['shell:statusChange']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:error', handler: (payload: ShellConnectionEventMap['shell:error']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:event', handler: (payload: ShellConnectionEventMap['shell:event']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:accountUpdate', handler: (payload: ShellConnectionEventMap['shell:accountUpdate']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:servicesUpdated', handler: (payload: ShellConnectionEventMap['shell:servicesUpdated']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:appsUpdated', handler: (payload: ShellConnectionEventMap['shell:appsUpdated']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:login', handler: (payload: ShellConnectionEventMap['shell:login']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:logout', handler: (payload: ShellConnectionEventMap['shell:logout']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:loginRequest', handler: (payload: ShellConnectionEventMap['shell:loginRequest']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:logoutRequest', handler: (payload: ShellConnectionEventMap['shell:logoutRequest']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:switchApp', handler: (payload: ShellConnectionEventMap['shell:switchApp']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:subscribe', handler: (payload: ShellConnectionEventMap['shell:subscribe']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:unsubscribe', handler: (payload: ShellConnectionEventMap['shell:unsubscribe']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:myApps', handler: (payload: ShellConnectionEventMap['shell:myApps']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:openOverlay', handler: (payload: ShellConnectionEventMap['shell:openOverlay']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:sidebarCollapsing', handler: (payload: ShellConnectionEventMap['shell:sidebarCollapsing']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:themeChange', handler: (payload: ShellConnectionEventMap['shell:themeChange']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:viewActivated', handler: (payload: ShellConnectionEventMap['shell:viewActivated']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'shell:manifestRefresh', handler: (payload: ShellConnectionEventMap['shell:manifestRefresh']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'app:statusChanged', handler: (payload: ShellConnectionEventMap['app:statusChanged']) => void): () => void;
/**
 * Register a typed handler for a shell event.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 * @returns An unsubscribe function.
 */
on(event: 'store:changed', handler: (payload: ShellConnectionEventMap['store:changed']) => void): () => void;
    /**
     * Register a wildcard listener called for every emitted event.
     * Used by the debug panel to display all events in real time.
     *
     * @param handler - Callback receiving the event name and payload.
     * @returns An unsubscribe function.
     */
    onAny(handler: WildcardHandler): () => void;
    /** Returns a snapshot of the debug log (newest last). */
    getDebugLog(): DebugLogEntry[];
    /** Clears all entries from the debug log. */
    clearDebugLog(): void;
}
export declare class CloudAuthProvider implements IAuthProvider {
    /** Returns the singleton CloudAuthProvider instance. */
    static getInstance(): CloudAuthProvider;
    /**
     * Initialize with Zitadel configuration.
     * Must be called before signIn().
     *
     * @param config - Zitadel OAuth2 configuration.
     */
    initialize(config: {
        zitadelUrl: string;
        clientId: string;
    }): void;
    /**
     * Clean up resources.
     */
    dispose(): void;
    /**
     * Initiate OAuth2 PKCE sign-in by redirecting to Zitadel.
     *
     * Generates a PKCE challenge, stores the verifier in sessionStorage
     * (survives the redirect), and navigates the browser to Zitadel's
     * authorize endpoint.
     *
     * @param appId - Optional app ID to activate after sign-in completes.
     * @param register - Retained for compatibility; no longer changes the
     *                   destination. All flows land on Zitadel's login page,
     *                   which offers a Register link for new users.
     */
    signIn(appId?: string, register?: boolean): Promise<void>;
    /**
     * Handle the OAuth callback after Zitadel redirects back with ?code=.
     *
     * Retrieves the stored PKCE verifier and returns the exchange payload
     * that should be passed to ConnectionManager.connect().
     *
     * @param code - The authorization code from the URL.
     * @returns The PKCE exchange object for client.connect(), or null if
     *          the verifier is missing (stale/expired session).
     */
    handleCallback(code: string): {
        code: string;
        verifier: string;
        redirectUri: string;
    } | null;
    /**
     * Store an authentication token.
     *
     * @param token - The token string to persist.
     */
    storeToken(token: string): Promise<void>;
    /**
     * Retrieve the stored authentication token.
     *
     * @returns The token string, or null if not stored.
     */
    getToken(): Promise<string | null>;
    /**
     * Returns true if a token is stored (user has signed in before).
     */
    isSignedIn(): Promise<boolean>;
    /**
     * Clear stored credentials and sign out.
     */
    signOut(): Promise<void>;
}
export declare class ApiKeyAuthProvider implements IAuthProvider {
    /** Returns the singleton ApiKeyAuthProvider instance. */
    static getInstance(): ApiKeyAuthProvider;
    /**
     * Sign in with an API key.
     *
     * Stores the key in sessionStorage for the current session. An empty string
     * is valid (some OSS servers allow unauthenticated access).
     *
     * @param apiKey - The API key to store.
     */
    signIn(apiKey?: string): Promise<void>;
    /**
     * Retrieve the stored API key.
     *
     * @returns The API key string, or null if not stored.
     */
    getToken(): Promise<string | null>;
    /**
     * Returns true if a token is stored.
     * Note: empty string counts as "signed in" for OSS mode (open access).
     */
    isSignedIn(): Promise<boolean>;
    /**
     * Clear stored API key.
     */
    signOut(): Promise<void>;
}
/**
 * A single open document. One per URI. Content held in memory.
 * Only disposed when no editors reference it and it is clean.
 */
interface Document$1 {
    /** Unique file path / identifier. */
    uri: string;
    /** In-memory content — any serializable value, stored and returned as-is. */
    content: unknown;
    /** True if the document has unsaved changes. */
    dirty: boolean;
    /** Monotonically increasing version counter, bumped on every content change. */
    version: number;
    /** Number of editors currently viewing this document. */
    editorCount: number;
    /** True if the document has never been saved to disk. */
    isNew: boolean;
    /**
     * True for documents that are not backed by the VFS (e.g. monitor, webview).
     * Static documents skip VFS read/write and are never marked dirty.
     */
    static?: boolean;
}
/**
 * An editor — a view onto a Document. Each editor has independent viewport
 * state so the same document can be viewed at different scroll positions in
 * different editor groups.
 */
export interface Editor {
    /** Unique editor instance ID. */
    id: string;
    /** URI of the document this editor views. */
    documentUri: string;
    /** Scroll position (pixels from top). */
    scrollTop: number;
    /** Scroll position (pixels from left). */
    scrollLeft: number;
    /** Cursor line number (1-based). */
    cursorLine: number;
    /** Cursor column number (1-based). */
    cursorColumn: number;
    /** Display label for the tab (derived from URI by default). */
    label: string;
    /** Per-editor view state (active tab, viewport, flow mode). Opaque to Documents — the app casts at the boundary. */
    viewState?: Record<string, unknown>;
}
/** Split orientation for layout containers. */
export type SplitOrientation = "horizontal" | "vertical";
/**
 * An editor group — a pane container that holds an ordered list of editors.
 */
export interface EditorGroup {
    /** Unique group ID. */
    id: string;
    /** Ordered list of editor IDs in this group. */
    editorIds: string[];
    /** Index of the currently active editor in this group. */
    activeEditorIndex: number;
}
/**
 * A leaf node in the layout tree — contains a single editor group.
 */
export interface LayoutLeaf {
    readonly type: "leaf";
    /** Unique node ID (same as the EditorGroup ID it wraps). */
    id: string;
    /** ID of the EditorGroup rendered in this leaf. */
    groupId: string;
}
/**
 * A split container node in the layout tree — has exactly two children
 * split in a direction.
 */
export interface LayoutSplit {
    readonly type: "split";
    /** Unique node ID (auto-generated). */
    id: string;
    /** Direction: 'horizontal' = children side-by-side, 'vertical' = stacked. */
    orientation: SplitOrientation;
    /** Exactly two child nodes. */
    children: [
        LayoutNode,
        LayoutNode
    ];
    /** Pixel sizes from the last allotment onChange, or undefined for equal split. */
    sizes?: [
        number,
        number
    ];
}
/** A node in the layout tree — either a leaf (editor group) or a split container. */
export type LayoutNode = LayoutLeaf | LayoutSplit;
type Public<T> = {
    [K in keyof T]: T[K];
};
/** Complete documents model state. */
export interface DocumentsState {
    /** All open documents keyed by URI. */
    documents: Record<string, Document$1>;
    /** All editor instances keyed by editor ID. */
    editors: Record<string, Editor>;
    /** All editor groups keyed by group ID. */
    groups: Record<string, EditorGroup>;
    /** Root of the recursive layout tree. */
    rootNode: LayoutNode;
    /** ID of the currently focused group. */
    activeGroupId: string;
}
/**
 * Optional binding to the shell's workspace persistence.
 *
 * When provided, Documents automatically restores state on creation and
 * debounce-saves state on every change.  When omitted, Documents works
 * purely in-memory.
 *
 * @example
 * ```typescript
 * const { appState, updateAppState } = useWorkspace();
 * const docs = new Documents(vfs, { appState, updateAppState });
 * ```
 */
export interface WorkspaceBinding {
    /** The current opaque app state from WorkspaceContext. */
    appState: Record<string, unknown>;
    /** Functional updater to write back to workspace appState. */
    updateAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
}
/**
 * VS Code-style document model.
 *
 * Create an instance in your app, pass it to your components.  The shell
 * never sees this — it's entirely app-owned.
 *
 * ```typescript
 * const docs = new Documents(vfs);
 * docs.openDocument('myfile.pipe');
 *
 * // In a React component:
 * const state = docs.useStore();
 * ```
 */
export declare class Documents {
    /**
     * Creates a new Documents instance.
     *
     * @param vfs       - Virtual file system for reading/writing document content.
     * @param workspace - Optional workspace binding for automatic persistence.
     *                    When provided, state is restored from appState on creation
     *                    and debounce-saved back on every change.
     */
    constructor(vfs?: IVirtualFileSystem | null, workspace?: WorkspaceBinding);
    /**
     * Returns the current state snapshot without subscribing.
     *
     * @returns The current DocumentsState.
     */
    getState(): DocumentsState;
    /**
     * Returns a single document by URI, or undefined.
     *
     * @param uri - The document URI.
     * @returns The Document or undefined.
     */
    getDocument(uri: string): Document$1 | undefined;
    /**
     * Register a listener that fires on every state change.
     *
     * @param listener - Callback invoked after each state update.
     * @returns An unsubscribe function.
     */
    subscribe(listener: () => void): () => void;
    /**
     * React hook that subscribes to this Documents instance.
     * Uses `useSyncExternalStore` for tear-free reads.
     *
     * @returns The current DocumentsState. Re-renders on any state change.
     */
    useStore(): DocumentsState;
    /**
     * Opens a document by URI. If already open, activates the existing editor.
     * If not, reads from disk via VFS.
     *
     * @param uri     - File path to open.
     * @param groupId - Target editor group (defaults to active group).
     */
    openDocument(uri: string, groupId?: string): Promise<void>;
    /**
     * Opens a static document — one not backed by the VFS.
     *
     * Static documents (e.g. monitor, webview) have a fixed URI and label,
     * skip VFS read/write, and are never marked dirty.  If an editor for
     * the URI already exists in any group, it is focused instead of creating
     * a duplicate.
     *
     * @param uri     - Unique identifier for the document (e.g. "monitor", "webview:https://...").
     * @param label   - Display label for the tab.
     * @param content - Optional content payload (opaque to Documents).
     * @param groupId - Target editor group (defaults to active group).
     */
    openStaticDocument(uri: string, label: string, content?: unknown, groupId?: string): void;
    /**
     * Creates a new untitled document with optional initial content.
     *
     * @param groupId        - Target editor group (defaults to active group).
     * @param initialContent - Optional initial content (any serializable value).
     * @returns The URI assigned to the new document.
     */
    createDocument(groupId?: string, initialContent?: unknown): string;
    /**
     * Closes an editor. Disposes the document if this was the last editor
     * referencing a clean document.  If the group becomes empty and is not
     * the root leaf, the group is auto-collapsed from the layout tree.
     *
     * @param editorId - The editor to close.
     */
    closeEditor(editorId: string): void;
    /**
     * Force-remove a document and all its editors from state, regardless of
     * dirty status. Used when the backing file has been deleted from disk —
     * any unsaved content is discarded.
     *
     * @param uri - The document URI to discard.
     */
    discardDocument(uri: string): void;
    /**
     * Updates the in-memory content of a document and marks it dirty.
     * No-op if content hasn't changed (prevents infinite render loops).
     *
     * @param uri     - The document URI.
     * @param content - The new content (any serializable value).
     */
    updateContent(uri: string, content: unknown): void;
    /**
     * Saves a document's content to disk via VFS and marks it clean.
     *
     * @param uri - The document URI to save.
     */
    saveDocument(uri: string): Promise<void>;
    /**
     * Re-reads a document from disk via VFS and replaces in-memory content.
     * Marks the document as clean.
     *
     * @param uri - The document URI to revert.
     */
    revertDocument(uri: string): Promise<void>;
    /**
     * Splits an editor group, creating a new empty group beside it in the
     * layout tree.  The original leaf is replaced by a LayoutSplit containing
     * the original leaf and a new leaf.
     *
     * @param groupId     - The group to split.
     * @param orientation - Split direction ('horizontal' = side-by-side, 'vertical' = stacked).
     * @returns The new group's ID.
     */
    splitGroup(groupId: string, orientation: SplitOrientation): string;
    /**
     * Splits a group and opens the same document as the active editor in the
     * new pane.  If the source group has no active editor, creates an empty split.
     * This mimics VS Code's split behavior where the current document appears
     * in both the original and new pane.
     *
     * @param groupId     - The group to split.
     * @param orientation - Split direction ('horizontal' = side-by-side, 'vertical' = stacked).
     * @returns The new group's ID.
     */
    splitGroupWithDocument(groupId: string, orientation: SplitOrientation): string;
    /**
     * Moves an editor from its current group to a different group.
     *
     * @param editorId      - The editor to move.
     * @param targetGroupId - The destination group.
     */
    moveEditor(editorId: string, targetGroupId: string): void;
    /**
     * Closes all editors in a group and removes it from the layout tree.
     * If the group has a parent split, the parent is replaced by the sibling.
     * If this was the last group (root leaf), a new empty default group is created.
     *
     * @param groupId - The group to close.
     */
    closeGroup(groupId: string): void;
    /**
     * Updates the remembered pixel sizes on a layout split node.
     * Called by the layout component after an allotment resize.
     *
     * @param splitNodeId - The split node whose sizes changed.
     * @param sizes       - The new pixel sizes for the two children.
     */
    updateSplitSizes(splitNodeId: string, sizes: [
        number,
        number
    ]): void;
    /**
     * Sets the active editor within a group.
     *
     * @param groupId     - The group containing the editor.
     * @param editorIndex - The index of the editor to activate.
     */
    setActiveEditor(groupId: string, editorIndex: number): void;
    /**
     * Sets the active (focused) group.
     *
     * @param groupId - The group to focus.
     */
    setActiveGroup(groupId: string): void;
    /**
     * Updates the viewport state of an editor (scroll position, cursor).
     *
     * @param editorId - The editor to update.
     * @param patch    - Partial editor fields to merge.
     */
    updateEditorViewport(editorId: string, patch: Partial<Pick<Editor, "scrollTop" | "scrollLeft" | "cursorLine" | "cursorColumn">>): void;
    /**
     * Updates the opaque view state of an editor (active tab, viewport, etc.).
     * The Documents model treats viewState as opaque — the app is responsible
     * for casting to/from its own ViewState type at the boundary.
     *
     * @param editorId  - The editor to update.
     * @param viewState - The new view state to store.
     */
    updateEditorViewState(editorId: string, viewState: Record<string, unknown>): void;
    /**
     * Destroys this instance — clears state and listeners.
     */
    destroy(): void;
}
/**
 * Props for the DocTabs component.
 */
export interface DocTabsProps {
    /** The Documents instance to read state from and dispatch actions to. */
    docs: Public<Documents>;
    /** The editor group whose tabs should be rendered. */
    groupId: string;
    /** Whether this group is the currently focused group. */
    isActive?: boolean;
    /** Whether this group can be closed (false when it's the only group). */
    canClose?: boolean;
    /** Optional callback when a tab's close button triggers a dirty document prompt. */
    onDirtyClose?: (editorId: string, documentUri: string) => void;
    /** Optional callback to split this group in a given direction. */
    onSplit?: (groupId: string, orientation: SplitOrientation) => void;
    /** Optional callback to close (remove) this entire group. */
    onCloseGroup?: (groupId: string) => void;
}
/**
 * Tab bar UI for a single editor group.
 *
 * Renders one tab per editor in the group. Tabs show the editor label, a
 * dirty indicator dot for unsaved documents, and a close button on hover.
 *
 * @param props.groupId    - ID of the EditorGroup to render tabs for.
 * @param props.onDirtyClose - Optional callback for dirty-close confirmation.
 */
export declare const DocTabs: React$1.FC<DocTabsProps>;
/**
 * Props for the DocSplitLayout component.
 */
export interface DocSplitLayoutProps {
    /** The Documents instance to read layout state from. */
    docs: Public<Documents>;
    /** Render function for each leaf pane — receives groupId, returns JSX. */
    renderPane: (groupId: string) => React$1.ReactNode;
}
/**
 * Recursive split layout renderer.
 *
 * Reads the layout tree from the Documents instance and renders nested
 * allotment split panes.  Each leaf calls the app's renderPane callback.
 *
 * @param props.docs       - The Documents instance.
 * @param props.renderPane - Callback that renders the content of a leaf pane.
 */
export declare const DocSplitLayout: React$1.FC<DocSplitLayoutProps>;
/**
 * Props for the top-level Shell component.
 */
export interface ShellProps {
    /** Full shell configuration assembled by the host (bootstrap.tsx). */
    config: ShellConfig;
}
/**
 * Top-level Shell component — auth bootstrap + provider composition.
 *
 * On mount, initialises the ConnectionManager and runs the auth bootstrap
 * sequence. Once auth resolves, renders the ShellLayout with providers.
 *
 * @param props.config - The complete ShellConfig assembled by the host.
 */
export declare const Shell: React$1.FC<ShellProps>;
interface IconProps {
    size?: number;
    color?: string;
    className?: string;
    style?: React$1.CSSProperties;
}
type IconComponent = React$1.FC<IconProps>;
export declare const BxPlus: IconComponent;
export declare const BxNote: IconComponent;
export declare const BxLockOpen: IconComponent;
export declare const BxPurchaseTag: IconComponent;
export declare const BxListUl: IconComponent;
export declare const BxFolderOpen: IconComponent;
export declare const BxHome: IconComponent;
export declare const BxChevronRight: IconComponent;
export declare const BxCog: IconComponent;
export declare const BxUser: IconComponent;
export declare const BxGridAlt: IconComponent;
export declare const BxDesktop: IconComponent;
export declare const BxRocket: IconComponent;
export declare const BxComponent: IconComponent;
export declare const BxPlay: IconComponent;
export declare const BxStop: IconComponent;
export declare const BxEditAlt: IconComponent;
export declare const BxTrash: IconComponent;
/**
 * Props for the Sidebar component.
 */
export interface SidebarProps {
    /** Theme picker configuration. */
    themeConfig: ShellThemeConfig;
    /** Account info and logout callback. */
    account: ShellAccountConfig;
    /** When true, the app switcher submenu in the footer is hidden. */
    hideAppSwitcher?: boolean;
    /** Callback to open a shell overlay (account, settings, environment). */
    onOverlay: (overlay: "account" | "settings" | "environment") => void;
    /**
     * Server-probed edition flag (the 'saas' capability from the bootstrap
     * probe). Gates SaaS-only footer items — the Account overlay has no
     * backend on OSS/local servers, so the item is hidden there. NOTE: the
     * connection mode is NOT a valid signal here (it defaults to 'cloud'
     * regardless of the server edition).
     */
    isSaas?: boolean;
}
/**
 * Props for the NavButton component.
 */
export interface NavButtonProps {
    /** Icon component to render. */
    icon: IconComponent;
    /** Text label shown when the sidebar is expanded. */
    label: string;
    /** Whether this button represents the currently active item. */
    isActive?: boolean;
    /** Whether the sidebar is in collapsed mode. */
    collapsed: boolean;
    /** Optional override for the icon colour. */
    iconColor?: string;
    /** Click handler. */
    onClick?: () => void;
    /** Tooltip override. Falls back to `label` if not provided. */
    title?: string;
}
/**
 * A single navigation button in the sidebar.
 *
 * Renders as an icon-only button when the sidebar is collapsed, or as an
 * icon-plus-label row when expanded.
 */
export declare const NavButton: React$1.FC<NavButtonProps>;
/**
 * Collapsible, resizable sidebar that renders the active app's sidebar
 * component and a footer with theme picker, account/billing nav, app
 * switcher, and logout.
 *
 * @param props - Sidebar configuration and callbacks.
 */
export declare const Sidebar: React$1.FC<SidebarProps>;
interface BottomPanelProps {
    onClose: () => void;
}
export declare const BottomPanel: React$1.FC<BottomPanelProps>;
/**
 * Debug trace panel that displays a live scrolling log of all shell events.
 *
 * The panel passively listens to the connectionManager wildcard handler and appends
 * new entries in real time.  It also captures iframe postMessage traffic via
 * a window `message` event listener.
 *
 * Features:
 * - Live auto-scrolling (locks to bottom unless user scrolls up)
 * - Text filter to narrow events by name
 * - Clear button to reset the log
 *
 * @param props.onClose - Callback to hide the debug panel (ALT+D toggle).
 */
export declare const DebugPanel: React$1.FC<{
    onClose: () => void;
}>;
export interface ConfirmDialogProps {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    secondaryLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
    onSecondary?: () => void;
}
export declare const ConfirmDialog: React$1.FC<ConfirmDialogProps>;
/**
 * Cloud-UI AccountView wrapper.
 *
 * Fetches account data via DAP commands (`rrext_account_*`) and delegates
 * all rendering to the shared-ui AccountView. Listens for `shell:accountUpdate`
 * bus events to keep the profile in sync with server-pushed updates.
 */
export declare const AccountProvider: React$1.FC;
/**
 * Shell-owned settings overlay, VSCode-style, rendered entirely from the
 * settings registry.
 *
 * Two view modes: with no search text only the nav-selected app's section
 * renders; typing a search switches to a cross-app results view spanning
 * every section.  All edits apply immediately (deltas-only persistence).
 */
export declare const SettingsProvider: React$1.FC;
/**
 * Sent by the shell to an iframe immediately after the iframe posts `view:ready`.
 *
 * Bootstraps the iframe's initial state: current CSS theme tokens, the
 * authenticated user (or null), the WebSocket connection status, and all
 * runtime API config values (RR_* keys).
 */
export interface ShellInitMsg {
    type: "shell:init";
    theme: Record<string, string>;
    user: ConnectResult | null;
    isConnected: boolean;
    apiConfig: Record<string, string | undefined>;
}
interface ShellThemeChangeMsg {
    type: "shell:themeChange";
    tokens: Record<string, string>;
}
interface ShellConnectionChangeMsg {
    type: "shell:connectionChange";
    isConnected: boolean;
}
interface ShellLoginMsg {
    type: "shell:login";
    user: ConnectResult;
}
interface ShellLogoutMsg {
    type: "shell:logout";
}
interface ServerEventMsg {
    type: "shell:event";
    event: unknown;
}
interface ShellViewActivatedMsg {
    type: "shell:viewActivated";
    viewId: string;
}
/**
 * Discriminated union of every message the shell can post to an iframe.
 *
 * `useIframeBridge` constructs and sends these via `contentWindow.postMessage`.
 * Iframe apps receive them in their own `window.addEventListener('message', ...)` handler.
 */
export type ShellToIframeMsg = ShellInitMsg | ShellThemeChangeMsg | ShellConnectionChangeMsg | ShellLoginMsg | ShellLogoutMsg | ServerEventMsg | ShellViewActivatedMsg;
interface ViewReadyMsg {
    type: "view:ready";
}
interface ViewInitializedMsg {
    type: "view:initialized";
}
interface IframeShellLogoutMsg {
    type: "shell:logout";
}
interface IframeOpenTabMsg {
    type: "shell:openTab";
    viewType: string;
    label: string;
}
/**
 * Discriminated union of every message an iframe can post to the parent shell.
 *
 * `useIframeBridge` filters incoming `MessageEvent`s to those from the managed
 * iframe and discriminates on `msg.type` to route each message.
 */
export type IframeToShellMsg = ViewReadyMsg | ViewInitializedMsg | IframeShellLogoutMsg | IframeOpenTabMsg;
/**
 * The curated set of value symbols shell-ui exposes to remote apps.
 *
 * Per the design-owner decision this covers shell-ui's ENTIRE value export
 * surface. The object is frozen at build time so its type — `ShellApiShape` —
 * becomes the versioned contract enforced against shell-ui's own compilation.
 */
export declare const shellApi: {
    readonly useShellConnection: typeof useShellConnection;
    readonly useAuthUser: typeof useAuthUser;
    readonly useLogout: typeof useLogout;
    readonly useWorkspace: typeof useWorkspace;
    readonly useClient: typeof useClient;
    readonly useShellEvent: typeof useShellEvent;
    readonly useIframeBridge: typeof useIframeBridge;
    readonly useSubscriptions: typeof useSubscriptions;
    readonly usePolling: typeof usePolling;
    readonly useDashboardData: typeof useDashboardData;
    readonly useConnectionStatus: typeof useConnectionStatus;
    readonly useShellApiConfig: typeof useShellApiConfig;
    readonly useAppComponent: typeof useAppComponent;
    readonly useSidebarContent: typeof useSidebarContent;
    readonly useClickOutside: typeof useClickOutside;
    readonly useFixedPopupPosition: typeof useFixedPopupPosition;
    readonly usePrefs: typeof usePrefs;
    readonly getClient: typeof getClient;
    readonly ConnectionManager: typeof ConnectionManager;
    readonly ConnectionState: typeof ConnectionState;
    readonly CloudAuthProvider: typeof CloudAuthProvider;
    readonly ApiKeyAuthProvider: typeof ApiKeyAuthProvider;
    readonly WorkspaceProvider: import("react").FC<IWorkspaceProviderProps>;
    readonly PrefsProvider: typeof PrefsProvider;
    readonly Documents: typeof Documents;
    readonly DocTabs: import("react").FC<DocTabsProps>;
    readonly DocSplitLayout: import("react").FC<DocSplitLayoutProps>;
    readonly DocExplorer: import("react").FC<IExplorerProps>;
    readonly Shell: import("react").FC<ShellProps>;
    readonly Sidebar: import("react").FC<SidebarProps>;
    readonly BottomPanel: import("react").FC<BottomPanelProps>;
    readonly DebugPanel: import("react").FC<{
        onClose: () => void;
    }>;
    readonly NavButton: import("react").FC<NavButtonProps>;
    readonly ConfirmDialog: import("react").FC<ConfirmDialogProps>;
    readonly PopupRow: import("react").FC<{
        children: React$1.ReactNode;
        onClick?: (e: React$1.MouseEvent<HTMLDivElement>) => void;
    }>;
    readonly AccountProvider: import("react").FC<{}>;
    readonly SettingsProvider: import("react").FC<{}>;
    readonly BxPlus: IconComponent;
    readonly BxEditAlt: IconComponent;
    readonly BxTrash: IconComponent;
    readonly BxDesktop: IconComponent;
    readonly BxGridAlt: IconComponent;
    readonly BxCog: IconComponent;
    readonly BxListUl: IconComponent;
    readonly BxStop: IconComponent;
    readonly BxPlay: IconComponent;
    readonly BxHome: IconComponent;
    readonly BxNote: IconComponent;
    readonly BxComponent: IconComponent;
    readonly BxUser: IconComponent;
    readonly BxRocket: IconComponent;
    readonly BxLockOpen: IconComponent;
    readonly BxPurchaseTag: IconComponent;
    readonly BxChevronRight: IconComponent;
    readonly BxFolderOpen: IconComponent;
};
/**
 * The compile-time shape of the shell API surface.
 *
 * This is the type frozen by `./builder shell:freeze` into `ShellApiVN`. Any
 * change that removes or narrows a member breaks conformance against a frozen
 * version and fails `tsc --noEmit`.
 */
export type ShellApiShape = typeof shellApi;
/**
 * Returns the curated shell API surface.
 *
 * Apps call this (via shell-ui's public export) to obtain every shell-provided
 * hook, helper, class, component, and icon through one typed object rather than
 * importing each symbol individually.
 *
 * @returns The frozen `shellApi` object.
 */
export declare function getShellApi(): ShellApiShape;
export { AppManifestEntry$1 as AppManifestEntry, ConnectResult as AuthUser, Document$1 as Document, Explorer as DocExplorer, ExplorerChild as DocEntryChild, ExplorerConfig as DocExplorerConfig, ExplorerEntry as DocEntry, ExplorerStatus as DocEntryStatus, IExplorerProps as DocExplorerProps, ShellConnectionEventMap as ShellEventMap, };
export {};
// ===== END FROZEN BUNDLE =====
export type ShellApiV0 = ShellApiShape;
