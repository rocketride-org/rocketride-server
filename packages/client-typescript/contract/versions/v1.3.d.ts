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
// FROZEN rocketride SDK contract — floor v1.3 — never edit by hand
// =============================================================================
// Floor key:     1.3 (MAJOR.MINOR of packages/client-typescript/package.json)
// Source commit: 1f2091d93e3bba827d7f884119f4c5ef02c7837d
// Generator:     dts-bundle-generator@9.5.1
// Produced by:   ./builder client-typescript:freeze
//
// Mutable ONLY while 1.3 is the in-progress package version: re-running
// client-typescript:freeze REPLACES this floor. Once the package version
// moves past it, this file is immutable — the append-only contract floor
// for every release of this minor.
// =============================================================================

// ===== BEGIN FROZEN BUNDLE — do not edit =====
import { Options, Sequelize } from 'sequelize';
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Base exception class for Debug Adapter Protocol (DAP) errors.
 *
 * This exception wraps DAP error responses to provide structured access to
 * error information including file locations, line numbers, and other
 * contextual data returned by RocketRide servers.
 */
export declare class DAPException extends Error {
    readonly dapResult: Record<string, unknown>;
    constructor(dapResult: Record<string, unknown>);
}
/**
 * Base exception for all RocketRide operations.
 *
 * This is the root exception class for all RocketRide-specific errors.
 * Catch this exception type to handle any error that originates from
 * RocketRide operations while still having access to detailed error context.
 */
export declare class RocketRideException extends DAPException {
    constructor(dapResult: Record<string, unknown>);
}
/**
 * Exception raised for connection-related issues.
 *
 * Raised when there are problems connecting to RocketRide servers,
 * maintaining connections, or when connections are lost unexpectedly.
 */
export declare class ConnectionException extends RocketRideException {
    constructor(dapResult: Record<string, unknown>);
}
/**
 * Exception raised when authentication fails (bad API key or credentials).
 */
export declare class AuthenticationException extends ConnectionException {
    constructor(dapResult: Record<string, unknown>);
}
/**
 * Terminal reason for a public login or connect attempt cancelled by later
 * user intent: replacement credentials (`superseded`), `logout`, or `detach`
 * (`detached`).
 */
export type LoginAttemptCancellationReason = "superseded" | "logout" | "detached";
/**
 * Raised when a public `login()` or `connect()` attempt is cancelled by newer
 * user intent. Callers may inspect `reason` to distinguish replacement,
 * logout, and detachment from transport or server failures.
 *
 * This deliberately extends Error directly: cancellation is control flow, not a
 * RocketRide server or protocol failure.
 */
export declare class LoginAttemptCancelledError extends Error {
    readonly reason: LoginAttemptCancellationReason;
    constructor(reason: LoginAttemptCancellationReason);
}
/**
 * Exception raised for data pipe operations.
 *
 * Raised when there are problems with data pipes used for sending
 * data to pipelines, uploading files, or streaming operations.
 */
export declare class PipeException extends RocketRideException {
    constructor(dapResult: Record<string, unknown>);
}
/**
 * Exception raised for pipeline execution issues.
 *
 * Raised when there are problems starting, running, or managing
 * RocketRide pipelines and processing tasks.
 */
export declare class ExecutionException extends RocketRideException {
    constructor(dapResult: Record<string, unknown>);
}
/**
 * Exception raised for input validation failures.
 *
 * Raised when input data, configurations, or parameters don't meet
 * the requirements for RocketRide operations.
 */
export declare class ValidationException extends RocketRideException {
    constructor(dapResult: Record<string, unknown>);
}
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Contains information about where a document chunk came from and its properties.
 *
 * Every document returned from RocketRide operations includes metadata that tells you
 * about the source file, the chunk's position within that file, permissions,
 * and whether it's table data or regular text.
 */
export interface DocMetadata {
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
export declare class DocMetadataHelper {
    /**
     * Convert metadata to a dictionary for serialization or storage.
     */
    static toDict(metadata: DocMetadata): Record<string, unknown>;
    /**
     * Create default metadata for a document processing instance.
     */
    static defaultMetadata(pInstance: {
        instance: {
            currentObject: {
                objectId: string;
                path: string;
                permissionId: number;
                componentId: string;
            };
        };
        IEndpoint: {
            endpoint: {
                jobConfig: Record<string, unknown>;
            };
        };
    }): DocMetadata;
}
/**
 * Represents a document returned from RocketRide operations like search, AI chat, or data processing.
 *
 * Documents contain the actual content text, relevance scoring, embeddings for semantic search,
 * and metadata about the source file and location.
 */
export interface Doc {
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
export declare class DocHelper {
    /**
     * Create a readable string representation showing the key identifiers and relevance score.
     */
    static toString(doc: Doc): string;
    /**
     * Convert this document to a dictionary for serialization or storage.
     */
    static toDict(doc: Doc): Record<string, unknown>;
    /**
     * Create a Document from a dictionary (reverse of toDict).
     */
    static fromDict(data: Record<string, unknown>): Doc;
    /**
     * Create a new document with default values.
     */
    static create(content: string, metadata?: Partial<DocMetadata>): Doc;
}
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Controls how RocketRide searches, processes, and returns documents in your queries.
 *
 * Use DocFilter to customize search behavior, pagination, content grouping,
 * and AI processing options. This gives you fine-grained control over what
 * documents are returned and how they're processed.
 */
export interface DocFilter {
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
export declare class DocFilterHelper {
    /**
     * Create a default DocFilter with sensible defaults.
     */
    static createDefault(): DocFilter;
    /**
     * Create a DocFilter for paginated table results.
     */
    static forTables(limit?: number, offset?: number): DocFilter;
    /**
     * Create a DocFilter for complete documents.
     */
    static forFullDocuments(limit?: number): DocFilter;
    /**
     * Create a DocFilter with AI enhancements enabled.
     */
    static withAIEnhancements(): DocFilter;
    /**
     * Validate that a DocFilter has reasonable values.
     */
    static validate(filter: DocFilter): string[];
    /**
     * Convert DocFilter to dictionary for serialization.
     */
    static toDict(filter: DocFilter): Record<string, unknown>;
    /**
     * Create DocFilter from dictionary.
     */
    static fromDict(data: Record<string, unknown>): DocFilter;
}
/**
 * Groups related document chunks that come from the same source file.
 *
 * When you search RocketRide and multiple chunks are found from the same document,
 * they can be organized into DocGroups for easier processing. This helps you
 * understand which content comes from which files and work with complete documents
 * rather than scattered fragments.
 */
export interface DocGroup {
    /** Overall relevance score for this entire document/file. Higher scores indicate the file is more relevant to your query. */
    score: number;
    /** Unique identifier for this document object in the RocketRide system. */
    objectId: string;
    /** File path or name of the source document. This is typically the filename you would recognize. */
    parent: string;
    /** List of all document chunks from this file that matched your query. */
    documents: Doc[];
}
export declare class DocGroupHelper {
    /**
     * Create a readable string representation showing the filename and relevance score.
     */
    static toString(group: DocGroup): string;
    /**
     * Create a new DocGroup.
     */
    static create(objectId: string, parent: string, documents?: Doc[], score?: number): DocGroup;
    /**
     * Add a document to the group and update the score.
     */
    static addDocument(group: DocGroup, doc: Doc): DocGroup;
    /**
     * Get the total content from all documents in the group.
     */
    static getFullContent(group: DocGroup): string;
    /**
     * Get the highest scoring document in the group.
     */
    static getBestDocument(group: DocGroup): Doc | undefined;
    /**
     * Sort documents in the group by score (highest first) or chunk ID.
     */
    static sortDocuments(group: DocGroup, sortBy?: "score" | "chunkId"): DocGroup;
    /**
     * Filter documents in the group by score threshold.
     */
    static filterByScore(group: DocGroup, minScore: number): DocGroup;
    /**
     * Get document count in the group.
     */
    static getDocumentCount(group: DocGroup): number;
    /**
     * Get total tokens count for all documents in the group.
     */
    static getTotalTokens(group: DocGroup): number;
    /**
     * Get average score of documents in the group.
     */
    static getAverageScore(group: DocGroup): number;
    /**
     * Check if group contains table data.
     */
    static hasTableData(group: DocGroup): boolean;
    /**
     * Get only table documents from the group.
     */
    static getTableDocuments(group: DocGroup): Doc[];
    /**
     * Get only text documents from the group.
     */
    static getTextDocuments(group: DocGroup): Doc[];
    /**
     * Convert DocGroup to dictionary for serialization.
     */
    static toDict(group: DocGroup): Record<string, unknown>;
    /**
     * Create DocGroup from dictionary.
     */
    static fromDict(data: Record<string, unknown>): DocGroup;
    /**
     * Merge multiple DocGroups from the same source document.
     */
    static merge(groups: DocGroup[]): DocGroup | undefined;
    /**
     * Split a DocGroup into smaller groups by chunk ranges.
     */
    static splitByChunkRange(group: DocGroup, chunkSize: number): DocGroup[];
}
/**
 * Defines different types of questions and queries you can ask.
 */
export declare const QuestionType: {
	readonly QUESTION: "question";
	readonly SEMANTIC: "semantic";
	readonly KEYWORD: "keyword";
	readonly GET: "get";
	readonly PROMPT: "prompt";
};
export type QuestionType = string;
/**
 * Represents a single message in a chat conversation history.
 */
export interface QuestionHistory {
    /** Who sent this message ('user', 'system', or 'assistant') */
    role: string;
    /** The actual message content */
    content: string;
}
/**
 * Provides specific instructions to guide the AI's response.
 */
export interface QuestionInstruction {
    /** Brief description of what this instruction is about */
    subtitle: string;
    /** Detailed guidance for the AI */
    instructions: string;
}
/**
 * Shows the AI an example of the kind of response you want.
 */
export interface QuestionExample {
    /** Example question or input */
    given: string;
    /** Example response you want for that input */
    result: string;
}
/**
 * Represents a single question with optional AI embeddings.
 */
export interface QuestionText {
    /** The actual question text */
    text: string;
    /** AI model used for creating embeddings (if any) */
    embedding_model?: string;
    /** Vector representation of the question (if any) */
    embedding?: number[];
}
/**
 * Handles AI responses from RocketRide chat operations.
 */
export declare class Answer {
    constructor(expectJson?: boolean);
    /**
     * Extract Python code from AI response.
     */
    static parsePython(value: string): string;
    /**
     * Set the AI response value (used internally by the system).
     */
    setAnswer(value: string | object | unknown[]): void;
    /**
     * Get the response as plain text.
     */
    getText(): string;
    /**
     * Get the response as structured JSON data.
     */
    getJson(): unknown;
    /**
     * Check if this answer contains JSON data.
     */
    isJson(): boolean;
}
/**
 * Main class for asking questions to RocketRide's AI system.
 */
export declare class Question {
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
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Account type definitions for the RocketRide TypeScript SDK.
 *
 * Data shapes for user profiles, API keys, organizations, teams, and members.
 * These mirror the server's DAP response shapes without importing any
 * platform-specific modules.
 */
/** A single API key record returned from the server. */
export interface ApiKeyRecord {
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
/** Summary information about the current user's organization. */
export interface OrgDetail {
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
/** A single organization member record returned from the server. */
export interface MemberRecord {
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
/** Summary of a team, used in the teams list view. */
export interface TeamRecord {
    /** Unique identifier for the team. */
    id: string;
    /** Display name of the team. */
    name: string;
    /** Optional brand color as a CSS hex string, or null to use the generated avatar color. */
    color: string | null;
    /** Number of members currently in the team. */
    memberCount: number;
}
/** Full detail for a single team including its member list. */
export interface TeamDetail {
    /** Unique identifier for the team. */
    id: string;
    /** Display name of the team. */
    name: string;
    /** Optional brand color as a CSS hex string, or null to use the generated avatar color. */
    color: string | null;
    /** Full list of members belonging to this team. */
    members: TeamMemberRecord[];
}
/** A member record scoped to a specific team, including that team's permissions. */
export interface TeamMemberRecord {
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
/**
 * Union type for the five navigable sections within AccountView.
 * Controls which tab panel is active and which data is fetched.
 */
export type AccountSection = "profile" | "billing" | "api-keys" | "organization" | "teams" | "members";
/**
 * The set of mutable profile fields submitted when saving profile edits.
 * All fields are strings; an empty string means no change.
 */
export interface ProfileUpdate {
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
/** Parameters for creating a new API key. */
export interface CreateKeyParams {
    /** Human-readable label for the key. */
    name: string;
    /** Array of permission strings to grant to this key. Empty for full PAT. */
    permissions: string[];
    /** Optional ISO timestamp for key expiration. Omit for no expiry. */
    expiresAt?: string;
    /** Optional team UUID to scope this key to. Omit for all teams. */
    teamId?: string;
}
/** Parameters for inviting a new member to an organization. */
export interface InviteMemberParams {
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
/** Parameters for adding or updating a team member. */
export interface TeamMemberParams {
    /** The team to add the member to or update within. */
    teamId: string;
    /** The user ID of the member. */
    userId: string;
    /** Permissions to grant within the team. */
    permissions: string[];
}
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Billing type definitions for the RocketRide TypeScript SDK.
 *
 * Data shapes for subscription management, compute credits, and Stripe
 * integration. These mirror the server's DAP response shapes without
 * importing any platform-specific modules.
 */
/**
 * Per-app subscription detail row returned by the `rrext_account_billing`
 * `list` subcommand. One row per subscribed app.
 */
export interface BillingDetail {
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
/**
 * Alternative click action for a plan card. Plans without an action
 * proceed to Stripe checkout. Plans with an action navigate the user
 * elsewhere (e.g. GitHub repo for free tier, mailto for enterprise).
 */
export interface PlanAction {
    /** ``link`` opens a URL, ``mailto`` opens email compose. */
    type: "link" | "mailto";
    /** Target URL (for ``link``) or email address (for ``mailto``). */
    url: string;
    /** Optional email subject line (only for ``mailto``). */
    subject?: string;
    /** Button label shown on the card (e.g. "Get started", "Contact us"). */
    label: string;
}
/**
 * App pricing tier row from the ``app_prices`` table.
 * Returned by the ``prices`` subcommand. Used in the checkout plan picker.
 */
export interface AppPrice {
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
/** @deprecated Use {@link AppPrice} instead. */
export type StripePlan = AppPrice;
/**
 * Net credit balance for an organisation, grouped by resource.
 * Returned by the `credits_balance` subcommand.
 *
 * Balance is computed from ``SUM(amount) GROUP BY resource`` on the credit
 * ledger.  Positive = net credit remaining, negative = overspent.
 */
export interface CreditBalance {
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
/**
 * A single ledger transaction row returned by the `transactions` subcommand.
 */
export interface LedgerTransaction {
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
/**
 * Paginated result from the `transactions` subcommand.
 */
export interface TransactionsResult {
    /** Transaction rows for the current page. */
    transactions: LedgerTransaction[];
    /** Total matching rows (for pagination). */
    total: number;
    /** Current page number (1-based). */
    page: number;
    /** Rows per page. */
    pageSize: number;
}
/**
 * Per-user or per-team consumption rollup row returned by usage_by_user / usage_by_team.
 */
export interface UsageRollup {
    /** User or team ID (or '__none__' for unattributed). */
    id: string;
    /** Resolved display name of the user or team, or null when unresolvable. */
    name?: string | null;
    /** Consumption per resource type (absolute values — always positive). */
    credits: Record<string, number>;
}
/**
 * Result of resolving a promo code via `promo_validate`.
 *
 * `valid: false` carries a human-readable `reason`. A grant/hackathon code
 * is recognisable by `appId` + `creditsGranted`; a discount-only code has
 * neither and applies to whichever plan is selected at checkout.
 */
export interface PromoValidation {
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
/**
 * Result of redeeming a credit-grant code via `promo_redeem`.
 */
export interface PromoRedemption {
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
/**
 * Per-pack pricing row for the credit top-up modal.
 * Mirrors the output of the Terraform `credit_packs` map so operators
 * can add/edit packs without a frontend deploy.
 */
export interface CreditPack {
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
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Data flow connection between pipeline components.
 */
export interface PipelineInputConnection {
    /** Data lane/channel name (e.g., 'text', 'data', 'image') */
    lane: string;
    /** Source component ID providing the data */
    from: string;
}
/**
 * Invoke (control-flow) connection from one component to another.
 */
export interface PipelineControlConnection {
    /** Class type of the invoke channel (e.g., 'llm', 'tool', 'memory') */
    classType: string;
    /** Source component ID providing the invocation */
    from: string;
}
/**
 * Pipeline component that processes data.
 *
 * Each component has a unique ID, a provider type that determines its behavior,
 * and provider-specific configuration. Components receive data through input
 * connections from other components.
 */
export interface PipelineComponent {
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
/**
 * Pipeline configuration for RocketRide data processing workflows.
 *
 * Defines a complete pipeline with components, data flow connections,
 * and execution parameters. Pipelines process data through a series
 * of connected components that transform, analyze, or route information.
 */
export interface PipelineConfig {
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
/** Denormalized audit identity — survives account deletion. */
export interface DeployActor {
    userId?: string;
    display?: string;
    email?: string;
}
/** One immutable registry version of a project's pipeline. */
export interface DeployArtifact {
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
/** Per-source schedule on a team deployment. */
export interface DeploymentSchedule {
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
/** One team's deployment of a project, joined with registry info. */
export interface Deployment {
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
/** One immutable audit-trail row (who did what, where, when). */
export interface DeployHistoryEntry {
    /**
     * Stable append-order key: newest first, never ties. Use as the row
     * identity when rendering.
     */
    seq?: number;
    /** Unix timestamp (seconds). */
    at?: number;
    /** `pause`/`resume` appear only on rows written before the
        enable/disable vocabulary (the trail is immutable). NOTE: app rails
        additionally carry the review vocabulary (`request`/`approved`/
        `rejected`/`withdrawn`/`failed`) and the human `reply` row at runtime —
        the union names the pipe-rail actions only and stays as the frozen
        v1.3 floor wrote it (widening a returned union would break floor
        assignability); compare raw strings for the app-rail extras. */
    action?: "publish" | "deploy" | "rollback" | "enable" | "disable" | "pause" | "resume" | "errored" | "remove";
    /** `''` on org-wide rows (publish); the team id on pointer changes. */
    teamId?: string;
    version?: number;
    actor?: DeployActor;
    /** Row payload — self-describing by contract (rows render without a
        second lookup). `reply` rows carry the review-thread message and its
        side. App audience rows (publish binds, removed/disabled/enabled)
        carry the audience WITH its server-dereferenced display facts
        (`name`, `handle`), plus `previousVersion` when a publish repointed
        an existing binding. A `publish` row without an audience is the
        registry write (the DEPLOY) and rides the deploy `comment`; review
        transitions carry both endpoints (`from`/`to`). */
    data?: {
        side?: "admin" | "developer";
        message?: string;
        audience?: {
            type?: string;
            id?: string;
            name?: string;
            handle?: string;
        };
        previousVersion?: number;
        comment?: string;
        from?: string;
        to?: string;
    } | null;
}
/** Body of `deploy.add()` — the generic rail door. */
export interface PublishResult {
    artifact?: DeployArtifact;
    /** Present only when `deployTo` was given (one-step add+deploy; pipes only). */
    deployment?: Deployment;
}
/** The standard list-API request arguments (page/search/filter/sort). */
export interface DeployListParams {
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
/** The standard list envelope. */
export interface DeployListEnvelope<T> {
    rows: T[];
    total: number;
    page: number;
    pageSize: number;
}
/** Body of `deploy.preview()` — THE single cron evaluator. */
export interface SchedulePreview {
    valid?: boolean;
    /** Human-readable reason when invalid. */
    error?: string;
    /** Unix timestamps (seconds) of the next occurrences. */
    next?: number[];
}
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Run-log type definitions for the RocketRide TypeScript SDK.
 *
 * A task's run log is ONE continuous JSONL event stream per identity;
 * individual runs are chapters (tracks) inside it. Streams are addressed by
 * the plain identity pair (`projectId` + `source`) plus the SCOPE — never by
 * token. `teamId` present addresses that team's DEPLOY continuum (deploy
 * runs execute as the team and log into its tree — teammates with monitor
 * rights can watch/replay). Absent, the optional `runKind` selects the
 * caller's OWN continuum: the dev stream (default) or the caller's PERSONAL
 * (@me) deploy stream — deploy-kind but user-owned, the one case
 * teamId-presence cannot express.
 */
/**
 * The two run kinds. Stamped on event bodies for client-side filtering,
 * and usable as the teamless-scope selector on LogStreamRef (the @me case).
 */
export type LogRunKind = "dev" | "deploy";
/** Identity addressing one run-log stream. */
export interface LogStreamRef {
    projectId: string;
    source: string;
    /**
     * A team id addresses that team's deploy continuum; omitted = the
     * caller's own stream (see runKind).
     */
    teamId?: string;
    /**
     * Teamless-scope selector: omitted/'dev' = the caller's dev stream;
     * 'deploy' = the caller's personal (@me) deploy stream. Ignored when
     * teamId is set (a team scope is always the deploy continuum).
     */
    runKind?: LogRunKind;
}
/** One chapter (track) — a run inside the continuum. */
export interface LogChapter {
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
/** One activity span (segment time range) for the activity bar. */
export interface LogActivitySpan {
    /** Segment id — the raw segment fetch / DVR cache key. */
    id?: number;
    /** First continuum seq recorded in this segment. */
    seq?: number;
    startTime?: number | null;
    endTime?: number | null;
    /** A run begins within this span. */
    chapterStart: boolean;
}
/** Response of `client.log.chapters()` — the whole timeline in one read. */
export interface LogChaptersResult {
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
/** Range/paging options for `client.log.read()`. */
export interface LogReadParams {
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
/**
 * The body of a stamped task event — the COMPLETE task-scoped record.
 *
 * The continuum stamps live here, beside the project_id/source identity the
 * server stamps at its forward choke point. The DAP envelope around this
 * body is pure protocol (its `seq` is per-connection bookkeeping,
 * meaningless to the continuum) and carries nothing of ours.
 */
export interface LogEventBody {
    /** Continuum emission time (epoch seconds, float), stamped at engine ingress. */
    eventTime: number;
    /** Continuum sequence — catalog-seeded, strictly monotonic per stream. */
    logSeq: number;
    [key: string]: unknown;
}
/**
 * One logged event — a stamped DAP event message line.
 *
 * There is ONE representation of the stamps: the body. Legacy v2 segments
 * (which carried the stamps at the header) are canonicalized into the body
 * at decode (see log-codec normalizeStamps), so consumers never read a
 * top-level stamp.
 */
export interface LogEvent {
    type: "event";
    event: string;
    body: LogEventBody;
    [key: string]: unknown;
}
/** Response of `client.log.read()`. */
export interface LogReadResult {
    events: LogEvent[];
    /** Present when paged: pass as `cursor` to continue. */
    nextSeq?: number;
    /** Present when the request reached below the retention horizon. */
    truncatedAtSeq?: number;
}
/** Response of `client.log.delete()`. */
export interface LogDeleteResult {
    deletedSegments: number;
}
/** A position on the continuum: epoch seconds, or 'live' (pinned to now). */
export type LogPosition = number | "live";
/** One trace (document) summary at the session position. */
export interface LogTraceSummary {
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
/** Response of `LogEventStream.getTraces()` — state at the position. */
export interface LogTracesResult {
    /** ALL in-flight traces at the position (bounded by real concurrency). */
    open: LogTraceSummary[];
    /** The most recently completed traces before the position (≤ n). */
    closed: LogTraceSummary[];
}
/** Response of `LogEventStream.getTrace()` — one trace's full event set. */
export interface LogTraceDetail {
    summary: LogTraceSummary;
    /** Every event belonging to this trace, seq-ordered, fully reconstructed. */
    events: LogEvent[];
}
/** Items delivered to the `play()` callback. */
export interface LogPlayItem {
    /** One reconstructed event, delivered in seq order. */
    event: LogEvent;
}
/** The `play()` callback. */
export type LogPlayCallback = (item: LogPlayItem) => void;
/** Options for `client.log.segment()`. */
export interface LogSegmentParams {
    /** Byte offset to continue from (0 = segment start). */
    offset?: number;
    /** Chunk ceiling in bytes (clamped by the server; 0/omitted = server default). */
    maxBytes?: number;
}
/**
 * Response of `client.log.segment()` — one whole-line-aligned chunk of a
 * segment's raw JSONL. Repeat with `nextOffset` until `final`.
 */
export interface LogSegmentResult {
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
/**
 * Stack trace information for errors.
 *
 * Carries source-location metadata returned by the server when a server-side
 * error includes a traceback, enabling developers to pinpoint the failure
 * inside pipeline node code.
 */
export interface TraceInfo {
    /** File path where the error occurred */
    file: string;
    /** Line number where the error occurred */
    lineno: number;
}
/**
 * A single DAP (Debug Adapter Protocol) message exchanged between the client
 * and the RocketRide server.
 *
 * All communication on the WebSocket uses this envelope. The `type` field
 * discriminates between the three roles a message can play:
 * - `request`  — client → server command invocation
 * - `response` — server → client result for a prior request
 * - `event`    — server → client unsolicited notification
 */
export interface DAPMessage {
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
/**
 * Callback functions for transport layer events and debugging.
 *
 * These callbacks provide hooks for monitoring transport activity,
 * debugging protocol messages, and handling connection lifecycle events.
 */
export interface TransportCallbacks {
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
/**
 * Connection configuration for establishing server connections.
 */
export interface ConnectionInfo {
    /** Server URI (WebSocket endpoint) */
    uri: string;
    /** Authentication token or API key */
    auth?: string;
}
/**
 * Callback function for handling real-time events from the server.
 *
 * Events include pipeline status updates, processing progress,
 * error notifications, and system alerts.
 */
export type EventCallback = (event: DAPMessage) => Promise<void>;
/**
 * Callback function for connection establishment events.
 *
 * Invoked once the WebSocket is open AND the server has confirmed the
 * authentication handshake. `connectionInfo` is an optional human-readable
 * string describing the remote endpoint.
 */
export type ConnectCallback = (connectionInfo?: string) => Promise<void>;
/**
 * Callback function for disconnection events.
 *
 * Invoked whenever the connection closes, whether gracefully or due to an
 * error. `reason` is a human-readable description and `hasError` is true
 * when the closure was caused by an error rather than a clean shutdown.
 */
export type DisconnectCallback = (reason?: string, hasError?: boolean) => Promise<void>;
/**
 * Callback when a connection attempt fails (e.g. auth or pipeline not ready).
 * Used in persist mode to inform the UI while the client keeps retrying.
 *
 * The callback receives a `ConnectionException` (rather than a generic Error)
 * so the caller can inspect structured error details such as status codes
 * returned by the server.
 */
export type ConnectErrorCallback = (error: ConnectionException) => void | Promise<void>;
/**
 * Configuration options for creating an RocketRideClient instance.
 *
 * Provides connection settings, authentication, and event handling
 * configuration for establishing and managing server connections.
 */
export interface RocketRideClientConfig {
    /** API authentication key or token */
    auth?: string;
    /** Server URI (will be converted to WebSocket URI automatically) */
    uri?: string;
    /**
     * Environment variables dictionary for configuration and variable substitution.
     * If provided, it is copied and used instead of process.env. If omitted in
     * Node.js, string values are copied from process.env. The SDK does not load .env files.
     */
    env?: Record<string, string>;
    /** Called for events owned by the current transport epoch; stale async event publication is suppressed. */
    onEvent?: EventCallback;
    /** Called once after an accepted authentication and best-effort monitor restoration completes. */
    onConnected?: ConnectCallback;
    /** Called at most once for an accepted generation that previously published onConnected. */
    onDisconnected?: DisconnectCallback;
    /** Called for each accepted automatic reconnect failure; foreground methods reject their own promises. */
    onConnectError?: ConnectErrorCallback;
    /** Optional function to output a credential-redacted protocol message. */
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
    /**
     * @deprecated Accepted for backward compatibility but currently ignored;
     * persistent retry continues until stopped.
     */
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
     * Credential-bearing fields are redacted from the callback copy. Use for
     * logging, debugging, or telemetry.
     *
     * @param traceType - 0 = request (before send), 1 = success (response), 2 = error
     * @param payload   - The trace data: command, args, and (for success/error) the result or error message.
     */
    onTrace?: (traceType: TraceType, message: DAPMessage) => void;
}
/** Discriminator for the three trace event types. */
export declare const TraceType: {
	readonly Request: 0;
	readonly Success: 1;
	readonly Error: 2;
};
export type TraceType = number;
/**
 * Describes a team within an organisation that the authenticated user belongs to.
 *
 * Teams are the finest-grained unit of access control. Each team carries a set
 * of permission strings that govern which server operations are available to
 * members of that team.
 */
export interface TeamInfo {
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
/**
 * Describes the organisation the authenticated user belongs to.
 *
 * Organisations group users and teams for billing and access management.
 * Each user belongs to exactly one organisation, which carries its own
 * permission set at the organisation level plus a list of contained teams.
 */
export interface OrgInfo {
    /** Unique identifier of the organisation (UUID or short slug) */
    id: string;
    /** Display name of the organisation */
    name: string;
    /**
     * Public developer slug — the organisation's app publisher identity, the
     * first segment of app linkage names ('<developerId>.<appName>').
     * Null/absent until the organisation registers as a marketplace developer
     * (and always absent on OSS servers).
     */
    developerId?: string | null;
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
export interface ConnectResult {
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
     * ID of the user's development team. It carries NO authorization meaning:
     * it is the billing and environment-layer context for dev runs and for
     * `@me` publishes. Team-scoped operations always name their team
     * explicitly — there is no default-team fallback.
     */
    devTeam: string;
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
/**
 * A single app entry in the server-provided manifest.
 *
 * Same shape as the build-time apps.json entries, extended with
 * optional pricing and visibility metadata for SaaS deployments.
 */
export interface AppManifestEntry {
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
    /**
     * URL to the app's Module Federation remote entry file — present ONLY
     * for dev-overlay entries (a localhost dev server is not constructible
     * from a number). Published versions carry `registryVersion` instead and
     * clients construct `/apps/<appId>/v<N>/remoteEntry.js` themselves.
     */
    entry?: string;
    /** Registry version number the entry resolves to (the scope-walk winner). */
    registryVersion?: number;
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
/**
 * A Stripe pricing tier for a paid app.
 */
export interface StripePriceEntry {
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
/**
 * Server metadata returned by the pre-auth info probe.
 *
 * Obtained via {@link RocketRideClient.getServerInfo} which sends an
 * `rrext_public_probe` command on a public connection. The server
 * responds without requiring credentials.
 */
export interface ServerInfoResult {
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
    /**
     * Stripe publishable key (`pk_*`) configured on this server.
     *
     * Lets clients initialise Stripe Elements with the key matching the
     * server's Stripe account (test vs live) instead of a build-time value.
     * Absent on servers without billing (OSS).
     */
    stripePublishableKey?: string;
    /**
     * The server's public addresses, RESOLVED to absolute URLs.
     *
     * `getServerInfo` substitutes the server's `'origin'` sentinel ("the
     * address you probed me at") with the probed URI before returning, and
     * manufactures the block when probing a pre-endpoints server — so
     * consumers ALWAYS receive both keys as absolute URLs and never branch
     * on presence. `api` is where clients open the WebSocket; `ui` is the
     * environment's public web address (browser links, OAuth returns).
     * They differ only on split deployments (e.g. CDN-served UI).
     */
    endpoints: {
        /** Absolute URL clients connect the DAP WebSocket to. */
        api: string;
        /** Absolute URL of the environment's web UI. */
        ui: string;
    };
}
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Type definitions for cProfile process profiling DAP commands.
 *
 * These types correspond to the responses from rrext_cprofile_* commands
 * returned by CProfileManager on the server.
 */
/** Response from rrext_cprofile_status and rrext_cprofile_start. */
export interface CProfileStatusResponse {
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
/** Response from rrext_cprofile_stop. */
export interface CProfileStopResponse {
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
/** Response from rrext_cprofile_report. */
export interface CProfileReportResponse {
    /** Full pstats-formatted text report. */
    report: string;
}
/** A single node in the hierarchical call tree returned by rrext_cprofile_report_tree. */
export interface CProfileTreeNode {
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
/** Response from rrext_cprofile_report_tree. */
export interface CProfileReportTreeResponse {
    /** Root node of the call tree (synthetic '<root>' wrapper). */
    tree: CProfileTreeNode | null;
    /** Total cumulative time across all profiled functions. */
    total_time: number;
    /** Total number of function calls recorded. */
    total_calls: number;
    /** Error message if no data is available. */
    error?: string;
}
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Dashboard Types for RocketRide Server Monitor.
 *
 * Type definitions for the rrext_dashboard DAP command response and
 * server-level dashboard push events (apaevt_dashboard).
 */
/** Server-level aggregate metrics (scoped to the caller's account). */
export interface DashboardOverview {
    /** Number of currently active WebSocket connections for this account. */
    totalConnections: number;
    /** Number of tasks currently in the registry for this account. */
    activeTasks: number;
    /** Seconds since server started. */
    serverUptime: number;
}
/** Details for a single active WebSocket connection. */
export interface DashboardConnection {
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
/** Details for a single managed task. */
export interface DashboardTask {
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
/** Complete response from the rrext_dashboard command. */
export interface DashboardResponse {
    overview: DashboardOverview;
    connections: DashboardConnection[];
    tasks: DashboardTask[];
}
/** One sort instruction for a list command: a row key and a direction. */
export interface ListSortSpec {
    /** The row key to sort by (e.g. 'startTime', 'connectedAt'). */
    field: string;
    /** Sort direction. */
    dir: "asc" | "desc";
}
/**
 * Request arguments shared by the rrext_list_* commands (platform list-API
 * convention). Field names are the wire argument names — page_size stays
 * snake_case so a grid fetcher forwards {page, page_size, sort, filters,
 * search} verbatim.
 */
export interface ListPageRequest {
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
/** Standard list envelope returned by the rrext_list_* commands. */
export interface ListPageResponse<TRow> {
    /** The rows of the requested page. */
    rows: TRow[];
    /** Total row count after search/filters, across all pages. */
    total: number;
    /** The (clamped) 1-based page that was returned. */
    page: number;
    /** The (clamped) page size that was applied. */
    pageSize: number;
}
/** Response from the rrext_list_connections command. */
export type ListConnectionsResponse = ListPageResponse<DashboardConnection>;
/** Response from the rrext_list_tasks command. */
export type ListTasksResponse = ListPageResponse<DashboardTask>;
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
/** Discriminated union of all dashboard activity events. */
export type DashboardEvent = DashboardConnectionAdded | DashboardConnectionRemoved | DashboardTaskStarted | DashboardTaskStopped | DashboardTaskRemoved | DashboardTaskError | DashboardAuthFailed | DashboardMonitorChanged;
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Response structures from RocketRide pipeline data processing operations.
 *
 * These interfaces represent the different types of responses returned when data
 * is sent through pipelines, depending on the processing method and MIME type handling.
 */
/**
 * Pipeline response structure with optional processing information.
 *
 * This is returned from all pipeline operations. When data is sent without
 * MIME type specification, only basic fields are present. When MIME type
 * is specified and processing occurs, additional result_types and dynamic
 * fields are included.
 */
export interface PIPELINE_RESULT {
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
/**
 * File upload result structure with processing outcome and metadata.
 *
 * This represents the complete result of a file upload operation, including
 * upload statistics, processing results, and any error information.
 */
export interface UPLOAD_RESULT {
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
/**
 * Event type enumeration for sophisticated client subscription and event routing.
 *
 * This enumeration defines event categories used for intelligent event filtering
 * and routing in multi-client environments. It enables clients to subscribe
 * to specific types of events based on their needs and capabilities, reducing
 * network traffic and improving system performance.
 *
 * Event Categories:
 * ----------------
 * NONE: Unsubscribe from all events (cleanup and disconnection)
 * ALL: Subscribe to all events regardless of category (comprehensive monitoring)
 * DEBUGGER: Debug-specific events for debugging protocol communication
 * DETAIL: Real-time processing events requiring immediate client attention
 * SUMMARY: Periodic status summaries suitable for dashboard monitoring
 * OUTPUT: Standard output and logging messages
 * FLOW: Pipeline flow events - component execution tracking
 * TASK: Task lifecycle events - start, stop, state changes
 *
 * Subscription Strategies:
 * -----------------------
 * NONE: Used during client disconnection to stop all event delivery
 *       and perform cleanup of monitoring subscriptions.
 *
 * ALL: Comprehensive monitoring for administrative clients that need
 *      complete visibility into task execution and debugging activities.
 *
 * DEBUGGER: Debug protocol events including breakpoint hits, variable
 *           changes, stack traces, and debugging session management.
 *
 * DETAIL: Real-time processing events including object processing updates,
 *         error/warning messages, metrics updates, and immediate status
 *         changes requiring client response or display updates.
 *
 * SUMMARY: Periodic status summaries sent at CONST_STATUS_UPDATE_FREQ
 *          intervals containing complete task status, suitable for
 *          monitoring dashboards and periodic client updates.
 *
 * OUTPUT: Standard output and logging messages from task execution.
 *
 * FLOW: Pipeline flow events tracking component execution, data flow
 *       between pipeline stages, and processing pipeline status.
 *
 * TASK: Task lifecycle events including task start, stop, pause, resume,
 *       and state changes for task management interfaces.
 *
 * Network Optimization:
 * --------------------
 * Event filtering reduces network traffic by sending only relevant events
 * to interested clients. SUMMARY subscriptions receive consolidated status
 * updates rather than individual processing events, significantly reducing
 * bandwidth usage for monitoring applications.
 *
 * Multi-Client Support:
 * --------------------
 * Different clients can subscribe to different event types simultaneously:
 * - Debugging clients: DEBUGGER + DETAIL for comprehensive debugging
 * - Monitoring dashboards: SUMMARY for efficient status tracking
 * - Administrative tools: ALL for complete system visibility
 * - Log viewers: OUTPUT for message monitoring
 * - Pipeline managers: FLOW + TASK for execution tracking
 *
 * @example
 * ```typescript
 * // Subscribe to debugging and detail events
 * const subscription = EVENT_TYPE.DEBUGGER | EVENT_TYPE.DETAIL;
 *
 * // Check if client wants specific events
 * if (clientSubscription & EVENT_TYPE.SUMMARY) {
 *     sendSummaryUpdate(client, taskStatus);
 * }
 * ```
 */
export declare const EVENT_TYPE: {
	readonly NONE: 0;
	readonly DEBUGGER: 1;
	readonly DETAIL: 2;
	readonly SUMMARY: 4;
	readonly OUTPUT: 8;
	readonly FLOW: 16;
	readonly TASK: 32;
	readonly SSE: 64;
	readonly DASHBOARD: 128;
	readonly BILLING: 256;
	readonly DEPLOY: 512;
	readonly ALL: 1023;
};
export type EVENT_TYPE = number;
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
/** Discriminated union of all apaevt_task event body shapes. */
export type TaskEvent = TaskEventRunning | TaskEventBegin | TaskEventEnd | TaskEventRestart;
/**
 * DAP event for pipeline flow tracking — component execution and data flow visualization.
 *
 * Sent during pipeline execution to track data flowing through components.
 * Each event represents a pipeline operation (begin, enter, leave, end) on
 * a specific pipe within the pipeline.
 *
 * Client Subscriptions:
 * - FLOW: Pipeline execution tracking
 * - ALL: Comprehensive monitoring
 */
export interface TaskEventFlow {
    /** Pipe index within the pipeline. */
    id: number;
    /** Operation type. */
    op: "begin" | "enter" | "leave" | "end";
    /** Component names in the current pipe's execution path. */
    pipes: string[];
    /** Trace data — lane, input/output data, result, error. */
    trace: {
        lane?: string;
        data?: Record<string, unknown>;
        result?: string;
        error?: string;
    };
    /**
     * Final pipeline result — populated on op === 'end' when trace level >= summary.
     * Contains result_types mapping plus dynamic fields (text, answers, documents, etc.).
     */
    result?: PIPELINE_RESULT;
    /** Project identifier. */
    project_id: string;
    /** Source component identifier (e.g. "chat_1"). */
    source: string;
}
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * JSON Schema / UI schema pair for a single configuration section of a
 * service driver (e.g. "Pipe", "Source", "Global").
 */
export interface ServiceSection {
    /** JSON Schema describing the section's configurable properties. */
    schema: Record<string, unknown>;
    /** UI schema hints for rendering the section in the pipeline editor. */
    ui: Record<string, unknown>;
}
/**
 * Invoke slot descriptor for a service that supports control-plane invoke.
 * Each key in the invoke map names a slot (e.g. 'llm', 'tool', 'memory').
 */
export interface ServiceInvokeSlot {
    /** Human-readable description of what this slot expects. */
    description: string;
    /** Minimum number of connections required (0 = optional). */
    min: number;
    /** Maximum number of connections allowed (omitted = unlimited). */
    max?: number;
}
/**
 * Describes one input lane and its possible output lanes.
 */
export interface ServiceInputLane {
    /** The input lane name. */
    lane: string;
    /** Output lanes this input can produce. */
    output?: Array<{
        lane: string;
    }>;
}
/**
 * A service SUMMARY as returned per-entry by the bulk `rrext_services`
 * call: the display fields a client needs to render the canvas / node
 * palette. The node's icon is referenced by id into the response's
 * deduplicated {@link ServicesResponse.icons} table. Configuration
 * schema is NOT included — fetch the full {@link ServiceDefinition} via
 * `getService()` when the user opens the configure panel.
 *
 * @example
 * ```typescript
 * const { services } = await client.getServices();
 * const ocr = services['ocr'];
 * console.log(ocr.title, ocr.classType);
 * ```
 */
export interface ServiceSummary {
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
    /**
     * Opaque id into the response's deduplicated {@link ServicesResponse.icons}
     * table. Absent when the node ships no icon (or the file is unreadable)
     * — clients render their built-in unknown icon. Ids are stable only
     * within one response; never persist them across reloads.
     */
    icon?: string;
    /** External documentation URL. */
    documentation?: string;
}
/**
 * A FULL service definition, returned by the single-service
 * `rrext_services` call (`getService()`). Extends the summary with the
 * dynamic configuration section keys (e.g. "Pipe", "Source", "Global")
 * that each hold a {@link ServiceSection} with `schema` and `ui`.
 */
export interface ServiceDefinition extends ServiceSummary {
    /** Dynamic configuration sections (e.g. "Pipe", "Source", "Global"). */
    [section: string]: unknown;
}
/**
 * Response from `getServices()`: a map of logical type names to their
 * service summaries, the deduplicated icon table, and a version field.
 */
export interface ServicesResponse {
    /** Map of logical type name (e.g. "ocr", "filesys") to its summary. */
    services: Record<string, ServiceSummary>;
    /**
     * Deduplicated icon table: icon id -> raw SVG text. Many nodes share
     * byte-identical icons, so each distinct SVG appears once and services
     * reference it via their `icon` id. Sanitize before injecting into the
     * DOM.
     */
    icons?: Record<string, string>;
    /** Engine services version. */
    version?: number;
}
/**
 * A single validation error or warning from pipeline validation.
 */
export interface ValidationError {
    /** Human-readable error/warning message. */
    message: string;
    /** Component ID that caused the issue (if applicable). */
    id?: string;
}
/**
 * Result of a pipeline validation via `validate()`.
 *
 * The engine validates structure — required fields and component
 * references. The result contains any errors and warnings found.
 */
export interface ValidationResult {
    /** Validation errors — pipeline will not execute with these. */
    errors: ValidationError[];
    /** Validation warnings — pipeline may still execute. */
    warnings: ValidationError[];
    /** Additional fields from the engine response. */
    [key: string]: unknown;
}
/**
 * Protocol capability flags for service drivers.
 *
 * Each flag is a single bit in a uint32 bitmask describing what a service
 * driver supports. Values are returned by the engine in the `capabilities`
 * field of a service definition and can be tested with bitwise AND.
 *
 * @example
 * ```typescript
 * const services = await client.getServices();
 * const svc = services.services['my_driver'];
 * if (svc.capabilities & PROTOCOL_CAPS.GPU) {
 *   console.log('Driver requires a GPU');
 * }
 * ```
 */
export declare const PROTOCOL_CAPS: {
	readonly NONE: 0;
	readonly SECURITY: 1;
	readonly FILESYSTEM: 2;
	readonly SUBSTREAM: 4;
	readonly NETWORK: 8;
	readonly DATANET: 16;
	readonly SYNC: 32;
	readonly INTERNAL: 64;
	readonly CATALOG: 128;
	readonly NOMONITOR: 256;
	readonly NOINCLUDE: 512;
	readonly INVOKE: 1024;
	readonly REMOTING: 2048;
	readonly GPU: 4096;
	readonly NOSAAS: 8192;
	readonly FOCUS: 16384;
	readonly DEPRECATED: 32768;
	readonly EXPERIMENTAL: 65536;
};
export type PROTOCOL_CAPS = number;
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Task Management Types: Comprehensive Status Tracking and Event Management System.
 *
 * This module defines the complete type system for sophisticated task lifecycle management,
 * real-time status monitoring, and event-driven communication in distributed computational
 * pipeline systems. It provides structured data models for tracking complex task execution
 * states, processing statistics, error management, and pipeline flow visualization.
 */
/**
 * Task lifecycle state enumeration for comprehensive state management.
 *
 * This enumeration defines all possible states in the task execution lifecycle,
 * providing clear state transitions and enabling proper resource management,
 * error handling, and client notification. Each state represents a distinct
 * phase with specific characteristics and available operations.
 *
 * Lifecycle Phases:
 * ----------------
 * NONE: Initial state before any resources are allocated or configuration
 *       is processed. Tasks in this state can be safely discarded without
 *       cleanup operations.
 *
 * STARTING: Resource allocation and initial setup phase. Ports are allocated,
 *           temporary files created, and subprocess preparation occurs.
 *
 * INITIALIZING: Subprocess has been created and is performing pipeline
 *               initialization. Service interfaces are being established.
 *
 * RUNNING: Task is operational and processing requests. All interfaces
 *          are available and the pipeline is actively executing.
 *
 * STOPPING: Graceful shutdown initiated. Subprocess is being terminated
 *           and resources are being cleaned up.
 *
 * COMPLETED: Task finished successfully. All resources cleaned up and
 *            final status available for client queries.
 *
 * CANCELLED: Task was terminated before completion. Resources cleaned up
 *            and termination reason available in status.
 *
 * State Transitions:
 * -----------------
 * Normal execution flow:
 * NONE → STARTING → INITIALIZING → RUNNING → STOPPING → COMPLETED
 *
 * Cancellation flow:
 * Any state → STOPPING → CANCELLED
 *
 * Error handling:
 * Any state → STOPPING → COMPLETED (with error exit code)
 *
 * Resource Management:
 * -------------------
 * - NONE/COMPLETED/CANCELLED: No active resources requiring cleanup
 * - STARTING/INITIALIZING/RUNNING: Active resources requiring cleanup
 * - STOPPING: Cleanup in progress, resources being deallocated
 *
 * Client Operations:
 * -----------------
 * - NONE: Configuration and launch operations available
 * - STARTING/INITIALIZING: Status monitoring available
 * - RUNNING: Full debugging and data processing operations available
 * - STOPPING: Limited status monitoring, operations being rejected
 * - COMPLETED/CANCELLED: Status queries only, task cleanup may be initiated
 *
 * Wait Operations:
 * ---------------
 * Clients can wait for specific state transitions using wait_for_running()
 * and similar methods. State transitions trigger event notifications to
 * all subscribed monitoring clients.
 */
export declare const TASK_STATE: {
	readonly NONE: 0;
	readonly STARTING: 1;
	readonly INITIALIZING: 2;
	readonly RUNNING: 3;
	readonly STOPPING: 4;
	readonly COMPLETED: 5;
	readonly CANCELLED: 6;
};
export type TASK_STATE = number;
/**
 * Pipeline component execution flow tracking and visualization model.
 *
 * This model provides detailed tracking of pipeline component execution flow,
 * enabling real-time visualization of which components are currently executing
 * in each pipeline instance. It supports complex pipeline architectures with
 * multiple concurrent execution paths and nested component hierarchies.
 *
 * Flow Tracking Features:
 * ----------------------
 * - Multi-pipeline execution tracking with per-instance component stacks
 * - Real-time component entry/exit monitoring for performance analysis
 * - Visual pipeline flow representation for debugging and monitoring
 * - Component execution depth tracking for nested pipeline architectures
 * - Concurrent execution visibility across multiple pipeline instances
 *
 * Data Structure:
 * --------------
 * totalPipes: Total number of concurrent pipeline execution instances
 * byPipe: Dictionary mapping pipeline instance IDs to component execution stacks
 *
 * Component Stack Behavior:
 * ------------------------
 * Each pipeline instance maintains a stack of currently executing components:
 * - Component entry pushes component name onto the stack
 * - Component exit pops component name from the stack
 * - Stack depth indicates nesting level of component execution
 * - Empty stack indicates pipeline instance is idle or completed
 *
 * Visualization Applications:
 * --------------------------
 * - Real-time pipeline execution diagrams showing active components
 * - Performance analysis identifying bottlenecks and execution patterns
 * - Debugging support for component-level execution tracing
 * - Monitoring dashboards displaying pipeline health and activity
 *
 * Concurrent Execution Support:
 * ----------------------------
 * Multiple pipeline instances can execute simultaneously, each maintaining
 * independent component execution stacks. This enables complex parallel
 * processing scenarios with full visibility into each execution path.
 *
 * Example Flow Tracking:
 * ---------------------
 * Pipeline 0: ['source', 'transform', 'filter'] - Currently in filter component
 * Pipeline 1: ['source', 'transform']           - Currently in transform component
 * Pipeline 2: []                                - Idle or completed
 */
export interface TASK_STATUS_FLOW {
    /** Total number of concurrent pipeline execution instances */
    totalPipes: number;
    /** Component execution stacks by pipeline instance ID */
    byPipe: Record<number, string[]>;
}
/**
 * Comprehensive task status model with real-time processing statistics and metrics.
 *
 * This model provides complete task execution status including processing statistics,
 * error tracking, performance metrics, resource usage, and operational state.
 * It serves as the central status repository for task monitoring, client updates,
 * and administrative dashboards.
 *
 * Status Categories:
 * -----------------
 * - Job Information: Basic task identification and lifecycle status
 * - Processing Statistics: Counts, sizes, rates, and completion metrics
 * - Error Management: Error and warning tracking with message history
 * - Resource Monitoring: Service health and operational state
 * - Performance Metrics: Processing rates and resource utilization
 * - Pipeline Tracking: Component execution flow and pipeline visualization
 *
 * Real-Time Updates:
 * -----------------
 * Status is updated in real-time as the task processes data and progresses
 * through its lifecycle. Updates are broadcast to subscribed clients based
 * on their EVENT_TYPE subscriptions, enabling responsive monitoring and
 * debugging interfaces.
 *
 * Buffer Management:
 * -----------------
 * Error and warning lists maintain recent message history with automatic
 * buffer limits to prevent memory growth in long-running tasks. Trace
 * buffers preserve debugging information while controlling resource usage.
 *
 * Metrics Integration:
 * -------------------
 * Processing statistics and performance metrics are continuously updated
 * to provide real-time visibility into task performance, throughput,
 * and resource utilization patterns.
 *
 * Client Integration:
 * ------------------
 * Status information is serialized and broadcast to monitoring clients,
 * debugging interfaces, and administrative dashboards. Different client
 * types receive filtered status updates based on their subscription preferences.
 */
export interface TASK_STATUS {
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
/**
 * Per-component timing accumulated by the supervisor for one run.
 *
 * Correlation happens by PIPE (concurrent completions run the same component
 * on different pipes); aggregation rolls up by component. Seconds are rounded
 * to 2 decimals at accumulation.
 */
export interface TASK_STATUS_COMPONENT_STAT {
    /** Completed enter/leave pairs this run. */
    calls: number;
    /** Sum of enter-to-leave seconds. */
    totalSeconds: number;
    /** Longest single call in seconds. */
    maxSeconds: number;
}
/**
 * One of the run's slowest completions (server-tracked top list).
 *
 * beginSeq is the completion's begin flow event's continuum seq — the
 * permanent trace identity getTrace resolves. beginTime is carried
 * explicitly: catalog-seeded seqs do not encode time.
 */
export interface TASK_STATUS_SLOWEST_DOC {
    /** Object name from the begin event (capped at 200 chars). */
    name: string;
    /** Begin-to-end seconds, rounded to 2 decimals. */
    elapsed: number;
    /** Begin emission time (epoch seconds). */
    beginTime: number;
    /** Begin flow event continuum seq (trace identity). */
    beginSeq?: number | null;
}
/**
 * Task token usage tracking (user-facing billing).
 *
 * Behavior:
 *   - Values are CUMULATIVE from when monitoring starts
 *   - Updated in real-time every 250ms as metrics are sampled
 *   - Preserved when monitoring stops (frozen at final values)
 *   - RESET to 0.0 when start_monitoring() is called for a new session
 */
export interface TASK_TOKENS {
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
/**
 * Task resource utilization metrics.
 *
 * User-facing metrics for monitoring CPU, memory, and GPU usage.
 * CPU percentages are normalized to 0-100% range across all platforms.
 */
export interface TASK_METRICS {
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
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * SDK version — automatically synced from package.json during build.
 */
export declare const SDK_VERSION: string;
/**
 * Default protocol for connections when none is specified.
 */
export declare const CONST_DEFAULT_WEB_PROTOCOL: string;
/**
 * Default hostname for local RocketRide instances.
 */
export declare const CONST_DEFAULT_WEB_HOST: string;
/**
 * Default server port for self-hosted / local RocketRide instances.
 * Applied when no port is specified in the URI.
 */
export declare const CONST_DEFAULT_WEB_PORT: string;
/**
 * Default local RocketRide service endpoint URL.
 */
export declare const CONST_DEFAULT_WEB_LOCAL: string;
/**
 * Default cloud RocketRide service endpoint URL.
 * Used when no custom URI is provided in the client configuration.
 */
export declare const CONST_DEFAULT_WEB_CLOUD: string;
/**
 * @deprecated Use CONST_DEFAULT_WEB_CLOUD instead.
 */
export declare const CONST_DEFAULT_SERVICE: string;
/**
 * WebSocket connection timeout in seconds.
 * If no communication occurs within this period, the connection may be considered stale.
 */
export declare const CONST_SOCKET_TIMEOUT: number;
/**
 * WebSocket ping interval in seconds.
 * Ping frames are sent at this interval to detect dead connections.
 */
export declare const CONST_WS_PING_INTERVAL: number;
/**
 * WebSocket ping timeout in seconds.
 * If no pong response is received within this period after a ping,
 * the connection is considered dead and will be closed.
 */
export declare const CONST_WS_PING_TIMEOUT: number;
/**
 * Default store directory for project pipeline files.
 * Use this constant instead of hardcoding '.projects'.
 */
export declare const PROJECT_DIR: string;
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
     * Update the connection URI. Concrete transports may invalidate an active
     * connection immediately so callbacks from the previous URI cannot publish.
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
     * Sets the user's DEV team — the team dev-mode runs bill to and whose environment layer applies.
     *
     * @param teamId - The team ID to set as default.
     */
    setDevTeam(teamId: string): Promise<void>;
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
/**
 * Constructor shape of the `Sequelize` class, injected by the caller so the
 * RocketRide client never statically (runtime) imports the `sequelize`
 * package. `sequelize` transitively pulls in Node built-ins (`util`, `debug`)
 * that cannot be bundled for browser targets (dropper-ui, chat-ui, etc.).
 * Callers pass their own `import { Sequelize } from 'sequelize'` through.
 */
export type SequelizeConstructor = new (options?: Options) => Sequelize;
/** Options for {@link createSequelize}. */
export interface CreateSequelizeOptions {
    /** The `Sequelize` class, injected by the caller (`import { Sequelize } from 'sequelize'`). */
    Sequelize: SequelizeConstructor;
    /** A `DatabaseLike` instance (e.g. `client.database`) to forward SQL through. */
    db: DatabaseLike;
    /** Pipeline token for authentication and resource access. */
    token: string;
    /** Optional target database node ID; pins connections to a specific node. */
    nodeId?: string;
    /** Extra Sequelize options merged over the defaults. */
    sequelizeOptions?: Options;
}
/**
 * Build a Sequelize v6 instance whose Postgres dialect transports SQL over
 * a RocketRide `DatabaseLike` (e.g. `client.database`) instead of a TCP socket.
 *
 * Internally wires `makePgShim` as `dialectModule` so Sequelize never opens a
 * real pg connection — all queries, transactions, and parameter binding are
 * forwarded through the RocketRide pipeline protocol.
 *
 * @param opts - See {@link CreateSequelizeOptions}.
 * @returns A fully configured `Sequelize` instance ready for model definition and queries.
 *
 * @example
 * ```ts
 * import { Sequelize } from 'sequelize';
 * const sq = createSequelize({ Sequelize, db: client.database, token: myToken, nodeId: 'myDb' });
 * const User = sq.define('User', { name: DataTypes.STRING }, { tableName: 'users', timestamps: false });
 * const users = await User.findAll();
 * ```
 */
export declare function createSequelize(opts: CreateSequelizeOptions): Sequelize;
/**
 * Structural interface satisfied by `DatabaseApi` (and test doubles) for the
 * Sequelize pg-compatible shim.  Only the four methods the shim needs are
 * required, so the interface remains stable across future `DatabaseApi`
 * additions without forcing shim changes.
 */
export interface DatabaseLike {
    /** Execute a raw SQL statement. */
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
    /** Begin a database transaction. */
    beginTransaction(options: {
        token: string;
        nodeId?: string;
    }): Promise<{
        session_id: string;
    }>;
    /** Commit an open transaction. */
    commit(options: {
        token: string;
        sessionId: string;
        nodeId?: string;
    }): Promise<{
        ok: boolean;
    }>;
    /** Roll back an open transaction. */
    rollback(options: {
        token: string;
        sessionId: string;
        nodeId?: string;
    }): Promise<{
        ok: boolean;
    }>;
}
/**
 * Underlying database engine a pipeline is connected to.
 *
 * Returned by `client.database.dialect(...)` so applications can branch on
 * dialect-specific behavior (e.g. SQL syntax differences, type coercion) and
 * detect when they're talking to a graph DB instead of a relational one.
 */
export declare const DatabaseDialect: {
	readonly POSTGRES: "postgres";
	readonly MYSQL: "mysql";
	readonly NEO4J: "neo4j";
};
export type DatabaseDialect = string;
/**
 * Direct database-query namespace on RocketRideClient.
 *
 * Accessed via `client.database` — not instantiated directly. Statements
 * submitted through this namespace bypass the LLM translation layer and
 * safety checks, so the caller is responsible for the SQL/Cypher they pass.
 */
export declare class DatabaseApi {
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
interface AppVerifyCheck {
    /** Stable check id (e.g. 'manifest', 'id', 'include', 'pack-size'). */
    id: string;
    /** Whether the check passed. */
    ok: boolean;
    /** Human-readable outcome, actionable on failure. */
    note: string;
}
interface AppVerifyReport {
    /** True when every check passed. */
    ok: boolean;
    /** Every check that ran, in order. */
    checks: AppVerifyCheck[];
    /** Files the pack would carry (0 when selection failed). */
    fileCount: number;
    /** Uncompressed bytes the pack would carry. */
    uncompressedBytes: number;
}
interface CreatedApp {
    /** The full app id (`<developerId>.<slug>`). */
    appId: string;
    /** Workspace-relative POSIX path of the created folder. */
    folder: string;
    /** Project-relative paths of the files written. */
    files: string[];
    /** Which server-matched packages were vendored this pass. */
    vendored: {
        shell: boolean;
        client: boolean;
    };
    /** Whether the workspace `pnpm install` ran and succeeded. */
    installed: boolean;
}
declare class DeployApi {
    /** @param client - The parent RocketRideClient that owns this namespace. */
    constructor(client: RocketRideClient);
    /**
     * Deploys an object to the server as the next immutable registry version.
     *
     * The ONE generic rail door for every kind — DEPLOY in the settled
     * vocabulary means "copy code to the server"; binding it to an audience
     * is the separate publish step ({@link deploy} for pipe teams; the app
     * publish verbs for apps). The artifact is sha256-locked: what was
     * deployed is provably what runs.
     *
     * Kind dispatch:
     * - `kind: 'pipe'` (default) — pass `pipeline` (the full definition;
     *   `name` REQUIRED: it renders on every deploy surface forever).
     * - `kind: 'app'` — pass `data` (ONE zip of the app's SOURCE — the server
     *   owns the build and never trusts client-produced binaries). Two
     *   layouts: package.json + src at the zip root (legacy), or
     *   workspace-relative with `metadata.appRoot` naming the app folder so
     *   `appManifest.include` extras ride at their real workspace paths. The
     *   server retains the zip and unpacks it at receipt; the app deployment
     *   is born state 'private' (internally publishable — an @me/@team binding
     *   may serve it; the developer submits it for review to reach the public
     *   store).
     *
     * @param options.kind - 'pipe' (default) | 'app'.
     * @param options.pipeline - The pipeline definition (kind 'pipe').
     * @param options.data - The source zip bytes (kind 'app').
     * @param options.metadata - Optional metadata blob (e.g. projectId
     *   provenance, appRoot for workspace-relative app zips).
     * @param options.comment - "What changed" note kept in the registry.
     * @param options.deployTo - Team id to deploy the new version to
     *   immediately (one-step add+deploy; pipes only).
     * @returns The artifact entry, plus the deployment when `deployTo` was given.
     */
    add(options: {
        kind?: "pipe" | "app" | "node";
        pipeline?: PipelineConfig & {
            name: string;
        };
        data?: Uint8Array;
        metadata?: Record<string, unknown>;
        comment?: string;
        deployTo?: string;
    }): Promise<PublishResult>;
    /**
     * Packs an app folder's source and deploys it as the next immutable
     * registry version — the ONE call behind the App Builder's Deploy
     * button, the CLI's `app deploy`, and CI scripts (Node.js only).
     *
     * Verify → pack → send: the pack applies the canonical rules
     * (workspace-rooted zip layout, `appManifest.include` honored,
     * hierarchical gitignore filtering with the hard baseline
     * node_modules/dist/.git, symlink containment, 50MB zipped / 512MB
     * uncompressed caps) and every step can narrate through `onProgress`.
     * Deploying never activates anything — bind an audience with
     * `publishApp` afterwards. Run `verifyApp` first for a no-side-effect
     * precheck of the same rules.
     *
     * @param appRoot - The app folder: absolute, or relative to
     *   `options.workspaceRoot`.
     * @param options.workspaceRoot - The workspace the zip is rooted at and
     *   that `appManifest.include` entries resolve against
     *   (default: `process.cwd()`).
     * @param options.comment - "What changed" note kept in the registry.
     * @param options.metadata - Extra metadata merged over the packed
     *   defaults (e.g. projectId provenance); `appRoot` is always set from
     *   the pack.
     * @param options.onProgress - Receives one line per pack step (include
     *   checks, per-file adds, totals) for hosts that surface progress.
     * @returns The artifact entry for the new version.
     */
    addApp(appRoot: string, options?: {
        workspaceRoot?: string;
        comment?: string;
        metadata?: Record<string, unknown>;
        onProgress?: (line: string) => void;
    }): Promise<PublishResult>;
    /**
     * Scaffolds a new app in the workspace — the programmatic twin of the
     * App Builder's New App wizard, rendering the identical templates
     * (Node.js only). Writes `./apps/<slug>`, ensures the pnpm workspace
     * file and ignore hygiene, vendors the connected server's shell +
     * client packages, and runs the workspace install. Scaffolding only —
     * nothing is deployed; the normal lifecycle (edit → `verifyApp` →
     * `addApp` → `publishApp`) follows.
     *
     * @param slug - The app-name slug (lowercase; digits/-/_ after the
     *   first character). The id becomes `<developerId>.<slug>`.
     * @param options - Template, display name, developer id (default
     *   'local'), frame options, install toggle, `onProgress`, and
     *   `workspaceRoot` (default `process.cwd()`). The server base URL for
     *   vendoring defaults to this client's own connection.
     * @returns The created app's identity and a report of what ran.
     */
    createApp(slug: string, options?: {
        workspaceRoot?: string;
        template?: "Blank" | "Dashboard";
        displayName?: string;
        developerId?: string;
        sidebar?: boolean;
        statusFooter?: boolean;
        docTabs?: boolean;
        install?: boolean;
        serverBaseUrl?: string;
        onProgress?: (line: string) => void;
    }): Promise<CreatedApp>;
    /**
     * Pre-checks everything `addApp` needs, WITHOUT deploying (Node.js
     * only, purely local — no server call). Verifies the manifest shape and
     * id grammar, declared icon/README assets, `appManifest.include`
     * entries, and a pack dry run against the size caps. Server-side
     * concerns (the build, store review) are out of scope — the Package
     * tab's readiness and the review ladder cover those.
     *
     * @param appRoot - The app folder: absolute, or relative to
     *   `options.workspaceRoot`.
     * @param options.workspaceRoot - The workspace the pack would be rooted
     *   at (default: `process.cwd()`).
     * @returns The structured report — `ok` plus every check with an
     *   actionable note.
     */
    verifyApp(appRoot: string, options?: {
        workspaceRoot?: string;
    }): Promise<AppVerifyReport>;
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
     * @param params.teamId - Restrict to one team; omitted = the visibility
     *   model: the caller's member teams plus their own personal space, and
     *   the whole org for an org admin.
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
/**
 * A stateful DVR session over one source continuum.
 *
 * Create via {@link LogApi.openEventStream}; dispose with
 * {@link closeEventStream}.
 */
export declare class LogEventStream {
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
/**
 * Streaming data pipe for sending large datasets to RocketRide pipelines.
 *
 * DataPipe provides a stream-like interface for uploading data to an RocketRide
 * pipeline. It handles the low-level protocol details of opening, writing to,
 * and closing data pipes on the server.
 *
 * Usage pattern:
 * 1. Create pipe using client.pipe()
 * 2. Call open() to establish the pipe
 * 3. Call write() multiple times with data chunks
 * 4. Call close() to finalize and get results
 *
 * @example
 * ```typescript
 * const pipe = await client.pipe(token, { filename: 'data.json' }, 'application/json');
 * await pipe.open();
 * await pipe.write(new TextEncoder().encode('{"data": "value"}'));
 * const result = await pipe.close();
 * ```
 */
export declare class DataPipe {
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
/**
 * Main RocketRide client for connecting to RocketRide servers and services.
 *
 * This client provides a comprehensive API for interacting with RocketRide services,
 * including connection management, pipeline execution, data operations, AI chat,
 * event handling, and server connectivity testing.
 *
 * Key features:
 * - Single shared WebSocket connection for all operations
 * - Connection management (connect/disconnect) with optional persistence
 * - Automatic reconnection when persist mode is enabled
 * - Pipeline execution (use, terminate, getTaskStatus)
 * - Data operations (send, sendFiles, pipe)
 * - AI chat functionality (chat)
 * - Event handling (setEvents, event callbacks)
 * - Server connectivity testing (ping)
 * - Full TypeScript type safety
 */
/**
 * Identifies a monitor subscription key.
 *
 * - `{ token }` — monitors a specific running task by its session token.
 * - `{ projectId, source }` — monitors the CALLER's own dev run of the
 *   project/source (the server binds the connection's user identity).
 * - `{ teamId, projectId, source }` — monitors the team's DEPLOYED run.
 * - `{ runKind: 'deploy', projectId, source }` — monitors the CALLER's own
 *   PERSONAL (@me) deploy run: deploy-kind but user-owned, the one case
 *   teamId-presence cannot express.
 *
 * teamId present always addresses the team's deploy continuum (runKind is
 * ignored there); absent, the optional runKind selects between your dev
 * run (default) and your personal deploy run.
 */
export type MonitorKey = {
    token: string;
} | {
    teamId?: string;
    projectId: string;
    source: string;
    pipeId?: number;
    runKind?: "dev" | "deploy";
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
     * @param config.maxRetryTime - Accepted for backward compatibility but currently ignored
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
     * Resolve a probe's `endpoints` block against the URI that was probed.
     *
     * The wire value for each key is an absolute URL or the literal
     * `'origin'` — the server's way of saying "wherever you reached me"
     * (a server behind a proxy cannot know its public name). Absent keys
     * and a missing block (pre-endpoints servers) mean `'origin'` too, so
     * the ONE conditional in the whole scheme lives here and callers get a
     * complete `{ api, ui }` of absolute URLs unconditionally.
     *
     * @param endpoints - The raw `endpoints` value from the probe body, if any.
     * @param probedUri - The URI `getServerInfo` attached to.
     * @returns Both keys resolved to absolute URLs.
     */
    static resolveEndpoints(endpoints: Partial<ServerInfoResult["endpoints"]> | undefined, probedUri: string): ServerInfoResult["endpoints"];
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
     * required fields and component references.
     *
     * Source resolution follows the same logic as {@link use}:
     * 1. Explicit `source` option (if provided)
     * 2. `source` field inside the pipeline config
     * 3. Implied source: the single component whose config.mode is 'Source'
     *
     * @param options.pipeline - Pipeline configuration to validate
     * @param options.source - Optional override for the source component ID
     * @returns Promise resolving to validation result with errors, warnings,
     *          and resolved component
     * @throws Error if the server returns a validation error
     *
     * @example
     * ```typescript
     * const result = await client.validate({
     *   pipeline: { components: [...], project_id: '123' },
     *   source: 'webhook_1'
     * });
     * if (result.errors.length) {
     *   console.log('Validation errors:', result.errors);
     * }
     * ```
     *
     * `errors` and `warnings` are ALWAYS arrays — a clean pipeline returns
     * them empty, never absent.
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
     * List the caller's active tasks.
     *
     * Returns the tasks visible to the authenticated user (running and
     * recently completed pipeline executions), as reported by the server.
     * Each row includes the task token plus display fields such as name,
     * state, and timing; the exact field set is server-defined.
     *
     * Mirrors the Python SDK's `get_tasks`.
     */
    getTasks(): Promise<Array<Record<string, unknown>>>;
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
    }>, token: string, maxConcurrent?: number): Promise<UPLOAD_RESULT[]>;
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
     * List an app's deployed versions, newest first (the version rail).
     *
     * Answered by role: the developer org sees its FULL rail (published or
     * not); other callers see only the versions serving on rows visible to
     * them. Each entry carries its deployment `state`, its build lifecycle
     * (`buildStatus` — 'ok' = servable bytes exist — plus the `buildPhase`
     * it reached and `buildEndedAt`), and the `rungs` naming the audiences
     * serving it. No error text rides the rail: build detail is served on
     * demand by the build-log verb.
     *
     * @param appId - App id
     * @returns Rail entries, newest first
     */
    listDeployments(appId: string): Promise<Array<{
        registryVersion: number;
        appVersion: string;
        sha256: string;
        publishedAt: number;
        author: string;
        message: string;
        state: string;
        buildStatus: string;
        buildPhase: string;
        buildEndedAt?: number | null;
        rungs: string[];
    }>>;
    /**
     * Submit a deployed version for store review — flips the DEPLOYMENT's own
     * state 'private' -> 'submit' (it enters the sys.admin review queue). The
     * review state lives on the deployment, not a binding. Developer-org and
     * developer-namespace gated.
     *
     * @param appId - App id
     * @param registryVersion - Registry version number from the rail
     * @returns The refreshed rail entry ({registryVersion, state, ...})
     */
    submitApp(appId: string, registryVersion: number): Promise<{
        artifact: Record<string, unknown>;
    }>;
    /**
     * Withdraw a pending review — the developer's own cancel: flips the
     * DEPLOYMENT 'submit' -> 'private' (leaves the admin queue, back to
     * draft; history records 'withdrawn'). Only a version in 'submit'
     * withdraws. Developer-org and developer-namespace gated, like submit.
     *
     * @param appId - App id
     * @param registryVersion - Registry version number from the rail
     * @returns The refreshed rail entry ({registryVersion, state, ...})
     */
    withdrawApp(appId: string, registryVersion: number): Promise<{
        artifact: Record<string, unknown>;
    }>;
    /**
     * Append a developer message to the app's review thread — the developer
     * half of the reviewer conversation. The message rides the app's
     * deployment history as a 'reply' row (side 'developer'), the same
     * stream `deploy.history()` reads and the store reviewer writes to.
     * Developer-org and developer-namespace gated, like submit.
     *
     * @param appId - App id
     * @param message - The message text (server caps the length)
     * @param registryVersion - Optional registry version the message refers to
     * @returns `{replied: true, appId}`
     */
    replyApp(appId: string, message: string, registryVersion?: number): Promise<{
        replied: boolean;
        appId: string;
    }>;
    /**
     * Read one version's durable server build log — the full phase-by-phase
     * output the build worker writes beside the version's artifacts (no
     * error text rides the rail rows or the DB). Long logs serve their tail;
     * '' means no log exists for the version. Developer-org gated.
     *
     * @param appId - App id
     * @param registryVersion - Registry version number from the rail
     * @returns `{appId, version, log}`
     */
    buildLog(appId: string, registryVersion: number): Promise<{
        appId: string;
        version: number;
        log: string;
    }>;
    /**
     * Bind a deployment to an audience — first publish, update, promote, and
     * rollback are all this one verb ("repoint, never rebuild"). The binding
     * is a pure pointer; '@public' requires the deployment be 'ready'
     * (approved), '@me'/'@team' accept any non-'failed' deployment.
     *
     * @param appId - App id
     * @param registryVersion - Registry version number from the rail
     * @param target - '@me', '@team/<name-or-id>', or '@public' ('@user' = legacy alias)
     * @returns The binding row ({audience, version, state, artifactState, ...})
     */
    publishApp(appId: string, registryVersion: number, target: string): Promise<{
        publish: Record<string, unknown>;
    }>;
    /**
     * Remove an audience binding — the app stops serving to that audience.
     * SOFT: the registry versions and the audit history survive; publishing
     * to the audience again revives it.
     *
     * @param appId - App id
     * @param target - '@me', '@team/<name-or-id>', or '@public' ('@user' = legacy alias)
     * @returns The final binding row (state 'removed')
     */
    removeAppPublish(appId: string, target: string): Promise<{
        publish: Record<string, unknown>;
    }>;
    /**
     * Disable an audience binding — serving stops, but the row STAYS in the
     * where-live listing marked disabled (a visible off switch), unlike
     * remove which hides it. Publishing any version to the rung re-enables
     * the binding.
     *
     * @param appId - App id
     * @param target - '@me', '@team/<name-or-id>', or '@public' ('@user' = legacy alias)
     * @returns The binding row (state 'disabled')
     */
    disableAppPublish(appId: string, target: string): Promise<{
        publish: Record<string, unknown>;
    }>;
    /**
     * The reverse index: which audiences serve which version of an app.
     *
     * @param appId - App id
     * @returns Pin rows ({rung, handle, version, appVersion, state, deployedAt})
     */
    whereApp(appId: string): Promise<Array<{
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
     * Retrieve all service summaries from the server.
     *
     * Returns the server's cached service catalog: one SUMMARY per service
     * with the display fields (title, classType, lanes, ...) plus a
     * deduplicated icon table (`icons`) that each summary's `icon` id
     * points into. Configuration schema is not included — call
     * {@link getService} when the user opens the configure panel.
     *
     * @returns Promise resolving to `{ services, icons, version }` where
     *          services maps service names to their summaries
     * @throws Error if the request fails or server returns an error
     *
     * @example
     * ```typescript
     * // Get all available services
     * const { services, icons } = await client.getServices();
     *
     * // List available service names
     * for (const name of Object.keys(services)) {
     *   console.log(`Available service: ${name}`);
     * }
     *
     * // Render a node's icon
     * const iconId = services['ocr']?.icon;
     * if (iconId && icons?.[iconId]) {
     *   renderSvg(icons[iconId]);
     * }
     * ```
     */
    getServices(): Promise<ServicesResponse>;
    /**
     * Retrieve a specific service's FULL definition from the server.
     *
     * Returns the complete definition for one service (connector) by name:
     * the summary fields plus the dynamic configuration sections (schema +
     * UI schema per section) the configure panel needs.
     *
     * @param service - Name of the service to retrieve (e.g., 'ocr', 'embed', 'chat')
     * @returns Promise resolving to the service definition
     * @throws Error if the request fails or server returns an error — an
     *         unknown service name is an error, not an undefined result
     *
     * @example
     * ```typescript
     * // Get OCR service definition (config sections included)
     * const ocr = await client.getService('ocr');
     * console.log('OCR sections:', Object.keys(ocr));
     * ```
     */
    getService(service: string): Promise<ServiceDefinition>;
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
     * Deploy immutable versions of any kind onto the org registry (the one
     * rail door), point teams at them (promotion and rollback alike),
     * schedule sources, and read the audit history.
     *
     * @example
     * ```typescript
     * const { artifact } = await client.deploy.add({ pipeline, comment: 'v2' });
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
export {};
// ===== END FROZEN BUNDLE =====
