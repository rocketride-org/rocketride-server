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
// FROZEN shell-api contract — ShellApiV1 — never edit by hand
// =============================================================================
// Generated:     2026-08-11T16:10:32.191Z
// Source commit: 3beffb869acb736ee14028210daed05a0f47b8c1
// Generator:     dts-bundle-generator@9.5.1
// Produced by:   ./builder shell:freeze
// =============================================================================

// ===== BEGIN FROZEN BUNDLE — do not edit =====
import React$1 from 'react';
import { CSSProperties, InputHTMLAttributes, ReactElement, ReactNode, Ref, RefObject } from 'react';
import { Options, Sequelize } from 'sequelize';
import { CellComponent, ColumnDefinition, Options as Options$1, Tabulator } from 'tabulator-tables';
export declare const commonStyles: {
    card: React$1.CSSProperties;
    cardHeader: React$1.CSSProperties;
    cardBody: React$1.CSSProperties;
    cardFlat: React$1.CSSProperties;
    section: React$1.CSSProperties;
    sectionHeader: React$1.CSSProperties;
    sectionHeaderLabel: React$1.CSSProperties;
    buttonPrimary: React$1.CSSProperties;
    buttonDanger: React$1.CSSProperties;
    buttonDangerOutline: React$1.CSSProperties;
    buttonSecondary: React$1.CSSProperties;
    buttonSmall: React$1.CSSProperties;
    buttonPrimarySmall: React$1.CSSProperties;
    buttonSecondarySmall: React$1.CSSProperties;
    buttonDangerSmall: React$1.CSSProperties;
    buttonDisabled: React$1.CSSProperties;
    cardHeaderButton: React$1.CSSProperties;
    cardBodyButton: React$1.CSSProperties;
    toggleButton: (active: boolean) => React$1.CSSProperties;
    toggleGroup: React$1.CSSProperties;
    splitHeader: React$1.CSSProperties;
    tabContent: React$1.CSSProperties;
    viewPadding: React$1.CSSProperties;
    columnFill: React$1.CSSProperties;
    headerBar: React$1.CSSProperties;
    divider: React$1.CSSProperties;
    empty: React$1.CSSProperties;
    textMuted: React$1.CSSProperties;
    textEllipsis: React$1.CSSProperties;
    fontMono: React$1.CSSProperties;
    labelUppercase: React$1.CSSProperties;
    overlay: React$1.CSSProperties;
    modalOverlay: React$1.CSSProperties;
    dialog: React$1.CSSProperties;
    modalDialog: React$1.CSSProperties;
    modalHeader: React$1.CSSProperties;
    modalBody: React$1.CSSProperties;
    modalFooter: React$1.CSSProperties;
    popupMenu: React$1.CSSProperties;
    menuRow: React$1.CSSProperties;
    inputField: React$1.CSSProperties;
    listRow: (active: boolean) => React$1.CSSProperties;
    emptyState: React$1.CSSProperties;
    iconBox: React$1.CSSProperties;
    badge: React$1.CSSProperties;
    tableHeader: React$1.CSSProperties;
    tableCell: React$1.CSSProperties;
    indicatorBase: React$1.CSSProperties;
    indicatorSuccess: React$1.CSSProperties;
    indicatorInfo: React$1.CSSProperties;
    indicatorWarning: React$1.CSSProperties;
    indicatorError: React$1.CSSProperties;
    indicatorMuted: React$1.CSSProperties;
};
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
export declare enum QuestionType {
    QUESTION = "question",
    SEMANTIC = "semantic",
    KEYWORD = "keyword",
    GET = "get",
    PROMPT = "prompt"
}
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
        enable/disable vocabulary (the trail is immutable). */
    action?: "publish" | "deploy" | "rollback" | "enable" | "disable" | "pause" | "resume" | "errored" | "remove";
    /** `''` on org-wide rows (publish); the team id on pointer changes. */
    teamId?: string;
    version?: number;
    actor?: DeployActor;
}
/** Body of `deploy.publish()`. */
export interface PublishResult {
    artifact?: DeployArtifact;
    /** Present only when `deployTo` was given (one-step publish+deploy). */
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
 * token. THE SCOPE IS THE KIND: `teamId` present addresses that team's
 * DEPLOY continuum (deploy runs execute as the team and log into its tree —
 * teammates with monitor rights can watch/replay); absent addresses the
 * caller's own DEV stream. There is no run-kind wire argument.
 */
/**
 * The two run kinds. Not part of stream addressing (the scope decides) —
 * still stamped on event bodies for client-side filtering.
 */
export type LogRunKind = "dev" | "deploy";
/** Identity addressing one run-log stream. */
export interface LogStreamRef {
    projectId: string;
    source: string;
    /**
     * A team id addresses that team's deploy continuum; omitted = the
     * caller's own dev stream.
     */
    teamId?: string;
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
export declare enum TraceType {
    /** Emitted before the DAP request is sent. */
    Request = 0,
    /** Emitted when the DAP request succeeds. */
    Success = 1,
    /** Emitted when the DAP request fails. */
    Error = 2
}
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
 * `auth` request with `infoOnly: true`. The server responds without
 * requiring credentials.
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
export declare enum EVENT_TYPE {
    /** No events - unsubscribe from all event types */
    NONE = 0,
    /** Debug protocol events - DAP and debugging-specific events like breakpoints, stack traces */
    DEBUGGER = 1,// Binary: 000001
    /** Real-time processing events - immediate updates for live monitoring */
    DETAIL = 2,// Binary: 000010
    /** Periodic status summaries - dashboard monitoring with reduced frequency */
    SUMMARY = 4,// Binary: 000100
    /** Standard output and logging messages from task execution */
    OUTPUT = 8,// Binary: 001000
    /** Pipeline flow events - component execution tracking and data flow visualization */
    FLOW = 16,// Binary: 010000
    /** Task lifecycle events - start, stop, state changes, and task management */
    TASK = 32,
    /** Real-time node-to-UI messages emitted via monitorSSE() during pipeline execution */
    SSE = 64,
    /** Server-level events - connection added/removed, for admin dashboards */
    DASHBOARD = 128,
    /** Billing ledger events - credit/debit updates, scoped by org */
    BILLING = 256,
    /** Deployment change events - pointer/state/schedule/run mutations, scoped by org */
    DEPLOY = 512,
    /** Convenience combination - ALL events except NONE for comprehensive monitoring */
    ALL = 1023
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
export declare enum PROTOCOL_CAPS {
    /** No capabilities */
    NONE = 0,
    /** Supports the file permissions interface */
    SECURITY = 1,
    /** Is a filesystem interface */
    FILESYSTEM = 2,
    /** Supports the substream interface */
    SUBSTREAM = 4,
    /** Uses a network interface */
    NETWORK = 8,
    /** Uses datanet or streamnet interfaces */
    DATANET = 16,
    /** Uses delta queries to track changes */
    SYNC = 32,
    /** Internal — will not be returned in services.json */
    INTERNAL = 64,
    /** Supports data catalog operations */
    CATALOG = 128,
    /** Do not monitor for excessive failures */
    NOMONITOR = 256,
    /** Source endpoint does not use include */
    NOINCLUDE = 512,
    /** Driver supports the invoke function */
    INVOKE = 1024,
    /** Driver supports remoting execution */
    REMOTING = 2048,
    /** Driver requires a GPU */
    GPU = 4096,
    /** Driver is not SaaS compatible */
    NOSAAS = 8192,
    /** Focus on this driver */
    FOCUS = 16384,
    /** Driver is deprecated */
    DEPRECATED = 32768,
    /** Driver is experimental */
    EXPERIMENTAL = 65536
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
export declare enum TASK_STATE {
    /** Initial state - no resources allocated */
    NONE = 0,
    /** Resource allocation and subprocess preparation */
    STARTING = 1,
    /** Subprocess initialization and service startup */
    INITIALIZING = 2,
    /** Operational state - processing requests */
    RUNNING = 3,
    /** Graceful shutdown and resource cleanup in progress */
    STOPPING = 4,
    /** Successful completion - resources cleaned up */
    COMPLETED = 5,
    /** Terminated before completion - resources cleaned up */
    CANCELLED = 6
}
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
export declare const SDK_VERSION = "1.3.0";
/**
 * Default protocol for connections when none is specified.
 */
export declare const CONST_DEFAULT_WEB_PROTOCOL = "http://";
/**
 * Default hostname for local RocketRide instances.
 */
export declare const CONST_DEFAULT_WEB_HOST = "localhost";
/**
 * Default server port for self-hosted / local RocketRide instances.
 * Applied when no port is specified in the URI.
 */
export declare const CONST_DEFAULT_WEB_PORT = "5565";
/**
 * Default local RocketRide service endpoint URL.
 */
export declare const CONST_DEFAULT_WEB_LOCAL = "http://localhost:5565";
/**
 * Default cloud RocketRide service endpoint URL.
 * Used when no custom URI is provided in the client configuration.
 */
export declare const CONST_DEFAULT_WEB_CLOUD = "https://api.rocketride.ai";
/**
 * @deprecated Use CONST_DEFAULT_WEB_CLOUD instead.
 */
export declare const CONST_DEFAULT_SERVICE = "https://api.rocketride.ai";
/**
 * WebSocket connection timeout in seconds.
 * If no communication occurs within this period, the connection may be considered stale.
 */
export declare const CONST_SOCKET_TIMEOUT = 180;
/**
 * WebSocket ping interval in seconds.
 * Ping frames are sent at this interval to detect dead connections.
 */
export declare const CONST_WS_PING_INTERVAL = 15;
/**
 * WebSocket ping timeout in seconds.
 * If no pong response is received within this period after a ping,
 * the connection is considered dead and will be closed.
 */
export declare const CONST_WS_PING_TIMEOUT = 60;
/**
 * Default store directory for project pipeline files.
 * Use this constant instead of hardcoding '.projects'.
 */
export declare const PROJECT_DIR = ".projects";
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
export declare enum DatabaseDialect {
    POSTGRES = "postgres",
    MYSQL = "mysql",
    NEO4J = "neo4j"
}
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
 *
 * The scope IS the kind: teamId present addresses the deploy continuum,
 * absent addresses your dev run — there is no run-kind argument.
 */
export type MonitorKey = {
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
    /** App lifecycle status: auth | free | unsubscribed | subscribed | trialing | past_due | canceled. */
    appStatus?: string;
    /** Whether this app is on the user's desktop. */
    onDesktop?: boolean;
    /**
     * The shell-api contract version this app was built against (stamped into
     * apps.json by the registration step from shell's apiver.ts). The lowest
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
     * The app's ONE mount point, rendered raw in the client area. The app
     * composes its own layout inside with `<AppLayout>` (one column, sidebar,
     * status bar — declared as props from the app's single tree).
     */
    app: React$1.ComponentType<ShellAppProps>;
    /**
     * Optional cross-app component catalog. Never mounted by the shell —
     * entries are loadable by other apps via `useAppComponent()`.
     */
    components?: {
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
    /** Connection attempt failed due to a server error. */
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
    /**
     * Discriminates AUTH_FAILED origins so recovery UI can phrase the message:
     * 'oauth-callback' — the IdP returned an error on the OAuth callback;
     * 'session' — an existing session was rejected or expired.
     */
    errorKind?: "oauth-callback" | "session";
    /**
     * Most recent unrecovered failure, latched across later transitions.
     * Persist-mode reconnect attempts report CONNECTING and a post-failure
     * anonymous connect reports CONNECTED — recovery UI reads this field so
     * the failure stays visible until it is actually resolved. Network
     * failures clear on reconnection; auth failures clear on re-auth.
     */
    lastFailure?: {
        /**
         * 'network' — transport failure, retryable, credentials intact;
         * 'auth' — credentials rejected/expired. Carried here (not as a new
         * ConnectionState member) because the enum is frozen by the versioned
         * shell-api contract; the state stays FAILED / AUTH_FAILED.
         */
        kind: "network" | "auth";
        lastError?: string;
        /** Distinguishes an aborted OAuth callback from an expired session. */
        errorKind?: "oauth-callback" | "session";
    };
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
/**
 * Checkout module type definitions.
 *
 * Shapes for the plan picker and checkout flow. These mirror the server's
 * DAP response shapes from the `rrext_account_billing` `prices` subcommand.
 */
/**
 * Defines an alternative click action for a plan card.
 *
 * Plans without an action proceed to Stripe checkout as normal.
 * Plans with an action navigate the user elsewhere instead (e.g. a
 * GitHub repo for a free/OSS tier, or a mailto for enterprise sales).
 */
export interface PlanAction {
    /** Action type: ``link`` opens a URL, ``mailto`` opens an email compose. */
    type: "link" | "mailto";
    /** Target URL (for ``link``) or email address (for ``mailto``). */
    url: string;
    /** Optional email subject line (only used when type is ``mailto``). */
    subject?: string;
    /** Button label shown on the card (e.g. "Get started", "Contact us"). */
    label: string;
}
/**
 * A single plan card shown in the CheckoutModal plan picker.
 *
 * Mirrors the ``app_prices`` DB row shape returned by ``_price_to_dict``.
 * The UI reads display fields from ``metadata`` (description, action, order, etc.).
 */
export interface CheckoutPlan {
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
/**
 * UI-local result of validating a promo code via the host callback.
 *
 * Mirrors the SDK's `PromoValidation` response shape. A grant/hackathon
 * code is recognisable by `appId` + `creditsGranted`; a discount-only code
 * has neither and applies to whichever plan is selected.
 */
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
 * UI-local result of redeeming a credit-grant code via the host callback.
 * Mirrors the SDK's `PromoRedemption` response shape.
 */
interface PromoRedemption$1 {
    /** True when the redemption succeeded. */
    redeemed: boolean;
    /** 'subscribed' = new $0 subscription; 'credits_only' = already subscribed. */
    mode: "subscribed" | "credits_only";
    /** App the code targets. */
    appId: string;
    /** Subscription status after redemption (e.g. 'active'). */
    status?: string;
    /** Credits granted ({resource: amount}). */
    credits: Record<string, number>;
}
type CheckoutModalPromoProps = {
    /**
     * Resolves a promo code without side effects. Providing the pair
     * renders a Promo Code box under the plan cards.
     */
    onValidatePromoCode: (code: string, priceId?: string) => Promise<PromoValidation$1>;
    /**
     * Redeems a credit-grant (hackathon) code — $0 subscription plus
     * immediate credits, no plan selection or payment step.
     */
    onRedeemPromoCode: (code: string) => Promise<PromoRedemption$1>;
} | {
    onValidatePromoCode?: undefined;
    onRedeemPromoCode?: undefined;
};
interface CheckoutModalBaseProps {
    /** Display name of the app being subscribed to (e.g. "RocketRide"). */
    appName: string;
    /** Short description shown below the app name. */
    appDescription?: string;
    /** Stripe publishable key (pk_test_* or pk_live_*). */
    stripePublishableKey: string;
    /**
     * When set, the modal skips the plan-picker step and goes straight to the
     * payment step for this plan (creating the subscription immediately). Omit
     * (the default) to show the picker first. Only the web pricing page sets
     * this; the in-app and VS Code extension flows leave it undefined and keep
     * the pick-a-plan → Continue UX.
     */
    preselectedPlan?: CheckoutPlan;
    /**
     * Discount code (already validated on the pricing page) to apply to a
     * preselected-plan checkout. Seeds the applied promo so the auto-advanced
     * payment step shows and charges the discounted amount.
     */
    preselectedPromo?: PromoValidation$1 | null;
    /** Fetches available subscription plans from the server. */
    onFetchPlans: () => Promise<CheckoutPlan[]>;
    /**
     * Creates a Stripe subscription on the server and returns the
     * client secret needed by Stripe Elements to confirm the payment.
     *
     * `clientSecret` is `null` when the first invoice is $0 (e.g. a 100%-off
     * promotion code) — the subscription is already active and the payment
     * step is skipped entirely.
     */
    onCreateCheckout: (priceId: string, promotionCode?: string) => Promise<{
        clientSecret: string | null;
        subscriptionId: string;
        status?: string;
    }>;
    /**
     * Notifies the server that payment was confirmed client-side.
     * The server writes 'incomplete' status; the webhook later flips to 'active'.
     */
    onConfirmPending: (subscriptionId: string, priceId: string) => Promise<void>;
    /** Called after a successful payment — host should close the modal. */
    onSuccess: () => void;
    /** Called when the user dismisses the modal without completing checkout. */
    onClose: () => void;
    /**
     * Overrides how a plan's action CTA (Free → link, Enterprise → mailto) is
     * opened. The browser default (window.open / mailto) works in the SaaS web
     * app; the VS Code extension passes a handler that routes through the host,
     * since webview navigation is sandboxed.
     */
    onActionClick?: (plan: CheckoutPlan, action: PlanAction) => void;
}
type CheckoutModalProps = CheckoutModalBaseProps & CheckoutModalPromoProps;
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
 * Both shell and VSCode emit and listen to events from this map.
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
     * Both shell and VSCode now share the ConnectionStatus type from
     * shared/types/connection.ts.
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
     * Contains the full services map, the summary's deduplicated icon
     * table, and an optional error string if the fetch failed.
     */
    "shell:servicesUpdated": {
        services: Record<string, unknown>;
        icons?: Record<string, string>;
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
     * interface to avoid importing shell's AppManifestEntry into shared.
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
     * when the result arrives. The summary's deduplicated icon table rides
     * along with the services map.
     */
    getCachedServices(): {
        services: Record<string, unknown>;
        icons?: Record<string, string>;
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
/**
 * Poll a fetcher function at a fixed interval, only while connected.
 *
 * Replaces the duplicated polling pattern found in monitor apps:
 * ```ts
 * useEffect(() => {
 *     if (!isConnected) return;
 *     fetchDashboard();
 *     const id = setInterval(fetchDashboard, 3000);
 *     return () => clearInterval(id);
 * }, [isConnected, fetchDashboard]);
 * ```
 *
 * @param fetcher  - Async function to call on each interval tick.
 * @param interval - Polling interval in milliseconds.
 *
 * @example
 * ```tsx
 * const fetchDashboard = useCallback(async () => {
 *     const client = ConnectionManager.getInstance().getClient();
 *     if (!client) return;
 *     const data = await client.getDashboard();
 *     setDashboard(data);
 * }, []);
 *
 * usePolling(fetchDashboard, 3000);
 * ```
 */
/** Options for {@link usePolling}. */
export interface IUsePollingOptions {
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
/** Wrapper for activity events from either channel. */
export type ActivityEvent = {
    source: "task";
    body: TaskEvent;
    receivedAt: number;
} | {
    source: "dashboard";
    body: DashboardEvent;
    receivedAt: number;
};
interface IMonitorViewProps {
    /**
     * Document display name for the page header. When provided, the view
     * renders a stock {@link ContentHeader} titled with this name (matching
     * the host's tab title), pinned between the page strip and the scrolling
     * page bodies. No header renders without it.
     */
    documentTitle?: string;
    /** Full dashboard snapshot from rrext_dashboard response, or null if not yet loaded. */
    data: DashboardResponse | null;
    /** Activity events pushed from the server (newest first). */
    events: ActivityEvent[];
    /** Whether the client is connected to the server. */
    isConnected: boolean;
    /** Callback to request a manual data refresh from the host. */
    onRefresh?: () => void;
    /**
     * Optional server-paginated connections fetcher — presence switches the
     * Connections grid to REMOTE mode (host binds it to `listConnections`).
     */
    listConnections?: (req: ListPageRequest) => Promise<ListPageResponse<DashboardConnection>>;
    /**
     * Optional server-paginated tasks fetcher — presence switches the Tasks
     * grid to REMOTE mode (host binds it to `listTasks`).
     */
    listTasks?: (req: ListPageRequest) => Promise<ListPageResponse<DashboardTask>>;
    /**
     * Receives ONE combined refetch that silently re-requests the current
     * page of every remote grid — the host polls it (usePolling, 3s) the way
     * the admin views poll their own grids.
     */
    onRefetchReady?: (refetch: () => void) => void;
}
export declare const MonitorView: React$1.FC<IMonitorViewProps>;
/**
 * Parse a raw server event into a monitor ActivityEvent.
 *
 * @param raw - Raw event object from the server WebSocket.
 * @returns ActivityEvent if the event is dashboard or task related, null otherwise.
 */
export declare function parseActivityEvent(raw: unknown): ActivityEvent | null;
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
export declare function useClickOutside(ref: React$1.RefObject<HTMLElement | null>, onClose: () => void): void;
export declare function useFixedPopupPosition(triggerRef: React$1.RefObject<HTMLElement | null>, isOpen: boolean, placement?: "below" | "above"): {
    top: number;
    left: number;
} | null;
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
 * Centralized connection manager for shell.
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
 * import { ConnectionManager } from 'shell';
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
     * Deduplicates concurrent calls for the same normalized endpoint and
     * credential. A different credential supersedes publication by the old call.
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
    /** Persist a user token to localStorage. */
    saveToken(token: string): void;
    /** Load token from localStorage. Migrates the old sessionStorage value once. */
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
     *
     * The summary response's deduplicated icon table rides along so consumers
     * (the canvas icon registry) never need a fetch of their own.
     */
    getCachedServices(): {
        services: Record<string, unknown>;
        icons?: Record<string, string>;
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
/** The shared preferences accessor: read one key, write one key. */
export interface IPrefsApi {
    /** Current value for `key`, or `undefined` if unset. Caller narrows the type. */
    getPref: (key: string) => unknown;
    /** Persist `value` under `key` (shallow-merged into the prefs bag). */
    setPref: (key: string, value: unknown) => void;
}
/**
 * Provides the app's prefs accessor to every shared component beneath it.
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
     * Stores the key in localStorage. An empty string
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
 * A no-op {@link IVirtualFileSystem} for hosts that drive the Explorer purely
 * through `entries` + callbacks. The Explorer never calls the VFS anymore, but
 * the frozen shell contract keeps the `vfs` prop required — pass this instead
 * of a hand-rolled stub or an `as any` cast.
 */
export declare const NOOP_VFS: IVirtualFileSystem;
/**
 * A file or directory entry in the document tree.
 *
 * The host builds a flat array of these; Explorer derives the directory
 * hierarchy on the fly via path parsing (S3-style).
 */
export interface ExplorerEntry {
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
export interface ExplorerChild {
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
export interface ExplorerStatus {
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
export interface ExplorerConfig {
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
/**
 * A custom action injected by the host into a file row's kebab menu.
 *
 * The Explorer is action-agnostic: it renders whatever actions the host
 * supplies and calls `onSelect(path)` when one is chosen. SaaS hosts use this
 * for features (e.g. Export/Download) that must stay out of the VS Code
 * bundle — hosts that omit `fileActions` show only the built-in rename/delete.
 */
export interface ExplorerFileAction {
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
export interface IExplorerProps {
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
export declare const Explorer: React$1.FC<IExplorerProps>;
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
export interface IconProps {
    size?: number;
    color?: string;
    className?: string;
    style?: React$1.CSSProperties;
}
export type IconComponent = React$1.FC<IconProps>;
export declare const BxPlusSquare: IconComponent;
export declare const BxPlusSquareSolid: IconComponent;
export declare const BxPlus: IconComponent;
export declare const BxNote: IconComponent;
export declare const BxLock: IconComponent;
export declare const BxLockOpen: IconComponent;
export declare const BxShow: IconComponent;
export declare const BxHide: IconComponent;
export declare const BxFullscreen: IconComponent;
export declare const BxBrush: IconComponent;
export declare const BxZoomIn: IconComponent;
export declare const BxZoomOut: IconComponent;
export declare const BxUndo: IconComponent;
export declare const BxRedo: IconComponent;
export declare const BxSelection: IconComponent;
export declare const BxPointer: IconComponent;
export declare const BxMove: IconComponent;
export declare const BxListUl: IconComponent;
export declare const BxFolderOpen: IconComponent;
export declare const BxFilePlus: IconComponent;
export declare const BxFolderPlus: IconComponent;
export declare const BxCollapseAll: IconComponent;
export declare const BxHome: IconComponent;
export declare const BxSearch: IconComponent;
export declare const BxFile: IconComponent;
export declare const BxFilter: IconComponent;
export declare const BxRefresh: IconComponent;
export declare const BxChevronRight: IconComponent;
export declare const BxChevronDown: IconComponent;
export declare const BxChevronLeft: IconComponent;
export declare const BxCheck: IconComponent;
export declare const BxCog: IconComponent;
export declare const BxUser: IconComponent;
export declare const BxGridAlt: IconComponent;
export declare const BxDesktop: IconComponent;
export declare const BxCloudUpload: IconComponent;
export declare const BxBookOpen: IconComponent;
export declare const BxRocket: IconComponent;
export declare const BxDockLeft: IconComponent;
export declare const BxPalette: IconComponent;
export declare const BxComponent: IconComponent;
export declare const BxDotsHorizontal: IconComponent;
export declare const BxPlay: IconComponent;
export declare const BxStop: IconComponent;
export declare const BxEditAlt: IconComponent;
export declare const BxExport: IconComponent;
export declare const BxDownload: IconComponent;
export declare const BxTrash: IconComponent;
export declare const BxSortAlt: IconComponent;
export declare const BxHand: IconComponent;
export declare const BxPurchaseTag: IconComponent;
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
/** Props for {@link AppLayout}. */
export interface AppLayoutProps {
    /** The scrolling portion of the sidebar column. Present = two-column app;
        absent = one-column app spanning the full client area. Components
        inside read `useSidebarCollapsed()` to choose their collapsed
        (icon-rail) form. */
    sidebar?: React$1.ReactNode;
    /** Show the status bar (stock connection identity). Defaults to false. */
    showStatus?: boolean;
    /** App content for the status bar's middle slot. Providing it implies
        `showStatus`. */
    status?: React$1.ReactNode;
    /** The app's client-area content. */
    children: React$1.ReactNode;
}
/**
 * The app-root layout. See the file header for the three layouts and the
 * sidebar/status contracts.
 *
 * @param props - See {@link AppLayoutProps}.
 */
export declare const AppLayout: React$1.FC<AppLayoutProps>;
/** Props for the {@link ConfirmDialog} component. */
export interface IConfirmDialogProps {
    /** Dialog title. */
    title: string;
    /** Body message — a plain string or a custom node. */
    message: React$1.ReactNode;
    /** Primary confirm button label. Default "Save". */
    confirmLabel?: string;
    /** Cancel button label. Default "Cancel". */
    cancelLabel?: string;
    /** Optional third action button label (rendered between Cancel and confirm). */
    secondaryLabel?: string;
    /** Fired when the primary action is confirmed. */
    onConfirm: () => void;
    /** Fired when the dialog is cancelled (Cancel button or Escape). */
    onCancel: () => void;
    /** Fired when the optional secondary action is chosen. */
    onSecondary?: () => void;
    /** Render the confirm button in the danger style (irreversible actions). */
    destructive?: boolean;
    /** Disable the confirm button (e.g. while a required field is empty). */
    confirmDisabled?: boolean;
}
/**
 * Renders a confirm/cancel dialog.
 *
 * @param props - {@link IConfirmDialogProps}.
 * @returns The confirm dialog element.
 */
export declare function ConfirmDialog({ title, message, confirmLabel, cancelLabel, secondaryLabel, onConfirm, onCancel, onSecondary, destructive, confirmDisabled, }: IConfirmDialogProps): React$1.ReactElement;
export declare const PopupRow: React$1.FC<{
    children: React$1.ReactNode;
    onClick?: (e: React$1.MouseEvent<HTMLDivElement>) => void;
}>;
/**
 * Cloud-UI AccountView wrapper.
 *
 * Fetches account data via DAP commands (`rrext_account_*`) and delegates
 * all rendering to the shared AccountView. Listens for `shell:accountUpdate`
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
/** Visual variant of a {@link Button}. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
/** Props for the {@link Button} component. */
export interface IButtonProps {
    /** Visual variant. Defaults to `'primary'`. */
    variant?: ButtonVariant;
    /** Render the compact (26px tall) size. */
    small?: boolean;
    /** Render the micro (16px tall) size — canvas-node chrome. Wins over `small`. */
    mini?: boolean;
    /** Disable the button — dimmed and non-interactive. */
    disabled?: boolean;
    /** Click handler. */
    onClick?: () => void;
    /** Button label / content. */
    children: React$1.ReactNode;
    /** Native tooltip text. */
    title?: string;
    /**
     * ARIA pressed state for toggle/segmented usage (ToggleGroup) — rendered
     * as `aria-pressed`; visual selection is conveyed by the variant.
     */
    pressed?: boolean;
    /**
     * ARIA expanded state for dropdown-trigger usage — rendered as
     * `aria-expanded` so assistive tech knows the popup's open state.
     */
    ariaExpanded?: boolean;
}
/**
 * Renders a themed action button.
 *
 * @param props - {@link IButtonProps}.
 * @returns The button element.
 */
export declare function Button({ variant, small, mini, disabled, onClick, children, title, pressed, ariaExpanded }: IButtonProps): React$1.ReactElement;
/** Semantic state variant shared by {@link StatusBadge} and {@link StatusDot}. */
export type StatusVariant = "success" | "info" | "warning" | "error" | "muted";
/** Props for the {@link StatusBadge} component. */
export interface IStatusBadgeProps {
    /** Semantic state variant. */
    variant: StatusVariant;
    /** Label content. */
    children: React$1.ReactNode;
}
/** Props for the {@link StatusDot} component. */
export interface IStatusDotProps {
    /** Semantic state variant. */
    variant: StatusVariant;
}
/**
 * Renders the bare 7px status dot.
 *
 * @param props - {@link IStatusDotProps}.
 * @returns The dot element.
 */
export declare function StatusDot({ variant }: IStatusDotProps): React$1.ReactElement;
/**
 * Renders a dot + label status pill.
 *
 * @param props - {@link IStatusBadgeProps}.
 * @returns The badge element.
 */
export declare function StatusBadge({ variant, children }: IStatusBadgeProps): React$1.ReactElement;
/** Props for the {@link EmptyState} component. */
export interface IEmptyStateProps {
    /** Optional icon rendered above the title (inherits the disabled text colour). */
    icon?: React$1.ReactNode;
    /** Heading line. */
    title: string;
    /** Optional supporting line beneath the title. */
    description?: string;
    /** Optional single action (at most one Button). */
    action?: React$1.ReactNode;
}
/**
 * Renders a centred empty-state placeholder.
 *
 * @param props - {@link IEmptyStateProps}.
 * @returns The empty-state element.
 */
export declare function EmptyState({ icon, title, description, action }: IEmptyStateProps): React$1.ReactElement;
/** Semantic variant of a {@link Banner}. */
export type BannerVariant = "info" | "warning" | "error";
/** Props for the {@link Banner} component. */
export interface IBannerProps {
    /** Semantic variant. */
    variant: BannerVariant;
    /** Message content. */
    children: React$1.ReactNode;
}
/**
 * Renders a semantic callout strip.
 *
 * @param props - {@link IBannerProps}.
 * @returns The banner element.
 */
export declare function Banner({ variant, children }: IBannerProps): React$1.ReactElement;
/** Props for the {@link InputField} component — all standard `<input>` props. */
export type IInputFieldProps = React$1.InputHTMLAttributes<HTMLInputElement>;
/**
 * Renders a themed single-line text input.
 *
 * @param props - {@link IInputFieldProps}; `className` and `style` are merged
 *   with the component's own class and base style, all other props pass through.
 * @returns The input element.
 */
export declare function InputField({ className, style, ...rest }: IInputFieldProps): React$1.ReactElement;
/** A single selectable option in a {@link ToggleGroup}. */
export interface IToggleGroupOption<T extends string> {
    /** Stable value returned via the change callback and matched for the active state. */
    id: T;
    /** Visible label. */
    label: string;
}
interface IToggleGroupBaseProps<T extends string> {
    /** Ordered list of options. */
    options: IToggleGroupOption<T>[];
    /**
     * Flow options onto multiple rows when they exceed the available width
     * (default: a single non-wrapping row). Set for long option lists such as
     * an event-type subscription set.
     */
    wrap?: boolean;
    /** Disable the entire group — every option renders dimmed and inert. */
    disabled?: boolean;
    /**
     * Accepted for call-site compatibility; inert. Every ToggleGroup renders
     * the stock SMALL Button — segmented controls are compact by definition,
     * and one size keeps them identical to the header buttons around them.
     *
     * @deprecated The stock small Button is the only toggle size.
     */
    small?: boolean;
}
interface IToggleGroupSingleProps<T extends string> extends IToggleGroupBaseProps<T> {
    /** Single-select is the default; omit or set false. */
    multi?: false;
    /** Currently selected option id. */
    value: T;
    /** Fired with the newly selected option id. */
    onChange: (id: T) => void;
}
interface IToggleGroupMultiProps<T extends string> extends IToggleGroupBaseProps<T> {
    /** Opt into multi-select. */
    multi: true;
    /** Currently active option ids. */
    values: T[];
    /** Fired with the option id whose active state the click flips. */
    onToggle: (id: T) => void;
}
/**
 * Props for the {@link ToggleGroup} component — a discriminated union on
 * `multi` so single- and multi-select callers cannot cross their prop sets.
 */
export type IToggleGroupProps<T extends string> = IToggleGroupSingleProps<T> | IToggleGroupMultiProps<T>;
/**
 * Renders a single- or multi-select segmented control from stock Buttons.
 *
 * @param props - {@link IToggleGroupProps}.
 * @returns The segmented control element.
 */
export declare function ToggleGroup<T extends string>(props: IToggleGroupProps<T>): React$1.ReactElement;
/** Props for the {@link Chip} component. */
export interface IChipProps {
    /** Tag label. */
    label: string;
    /** When provided, renders a remove glyph that calls this on activation. */
    onRemove?: () => void;
}
/** Props for the {@link ChipAdd} component. */
export interface IChipAddProps {
    /** Add-affordance label (rendered after the plus glyph). */
    label: string;
    /** Fired when the add affordance is activated. */
    onClick: () => void;
}
/**
 * Renders a removable tag pill.
 *
 * @param props - {@link IChipProps}.
 * @returns The chip element.
 */
export declare function Chip({ label, onRemove }: IChipProps): React$1.ReactElement;
/**
 * Renders the "add" tag affordance.
 *
 * @param props - {@link IChipAddProps}.
 * @returns The add-chip element.
 */
export declare function ChipAdd({ label, onClick }: IChipAddProps): React$1.ReactElement;
/** Props for the {@link DropZone} component. */
export interface IDropZoneProps {
    /** Primary prompt, e.g. "Drop documents here to ingest". */
    title: string;
    /** Optional secondary hint, e.g. "Supports PDF, TXT, MD, HTML, CSV". */
    hint?: string;
    /** Fired with the dropped files. */
    onFiles: (files: FileList) => void;
}
/**
 * Renders a dashed file-drop target.
 *
 * @param props - {@link IDropZoneProps}.
 * @returns The drop-zone element.
 */
export declare function DropZone({ title, hint, onFiles }: IDropZoneProps): React$1.ReactElement;
/** Props for the {@link Card} component. */
export interface ICardProps {
    /** Header content — a plain string title or a custom node. */
    header?: React$1.ReactNode;
    /** Right side of the header row (actions / controls). */
    headerActions?: React$1.ReactNode;
    /** Card body content. */
    children: React$1.ReactNode;
    /** Drop the body padding (for tables and media that fill the card). */
    noBodyPadding?: boolean;
    /**
     * Optional row rendered directly beneath the header row (and above the body):
     * filter/search strips, ToggleGroups, or any custom controls — e.g. hosting a
     * a DataGrid's search box at the card level. Renders with its own divider.
     */
    toolbar?: React$1.ReactNode;
    /**
     * Makes the whole card clickable. When set, the card gains a pointer cursor,
     * a hover border-color shift, and button semantics (role="button", keyboard
     * Enter / Space activation). When omitted the card is a static surface.
     */
    onClick?: () => void;
    /**
     * Fill the card's parent height and let the body flex into the remaining
     * space below the header (a definite-height body). Pair with `noBodyPadding`
     * and a fill-height child — e.g. a DataGrid given `height="100%"` — to host
     * an internally-scrolling grid instead of a paginated one. Default: the card
     * sizes to its content.
     */
    fill?: boolean;
}
/**
 * Renders a bordered card with an optional header and a padded body.
 *
 * @param props - {@link ICardProps}.
 * @returns The card element.
 */
export declare function Card({ header, headerActions, children, noBodyPadding, toolbar, onClick, fill }: ICardProps): React$1.ReactElement;
/** Props for the {@link MiniCard} component. */
export interface IMiniCardProps {
    /**
     * Optional heading rendered ABOVE the value, to be used under very
     * specific circumstances only — `label` is the preferred mode. When
     * `title` is specified it renders uppercase, and `label` may then be
     * mixed case.
     */
    title?: string;
    /** The metric value (number, formatted string, or a custom node). */
    value: React$1.ReactNode;
    /**
     * Caption beneath the value. Uppercase by default; when a `title` heading
     * is present the uppercase treatment moves to the title and the label
     * renders as authored (mixed case allowed).
     */
    label: string;
    /**
     * Optional CSS color for the value text (e.g. 'var(--rr-color-success)').
     * Defaults to the primary text color.
     */
    color?: string;
}
/** Props for the {@link MiniContainer} component. */
export interface IMiniContainerProps {
    /** Explicit column count; defaults to one column per child. */
    columns?: number;
    /** The MiniCards to lay out. */
    children: React$1.ReactNode;
}
/**
 * Renders a single compact metric tile: optional uppercase `title` heading
 * above the value (very specific circumstances only — `label` is the
 * preferred mode), the value in an optional `color`, and the `label` caption
 * beneath (uppercase by default; mixed case allowed when `title` is present).
 *
 * @param props - {@link IMiniCardProps}.
 * @returns The tile element.
 */
export declare function MiniCard({ title, value, label, color }: IMiniCardProps): React$1.ReactElement;
/**
 * Renders a grid row of {@link MiniCard}s.
 *
 * @param props - {@link IMiniContainerProps}.
 * @returns The grid element.
 */
export declare function MiniContainer({ columns, children }: IMiniContainerProps): React$1.ReactElement;
/** Props for the {@link Section} component. */
export interface ISectionProps {
    /** Uppercase section label. */
    label: string;
    /** Section body (typically {@link LabelValue} rows). */
    children: React$1.ReactNode;
}
/** Props for the {@link LabelValue} component. */
export interface ILabelValueProps {
    /** Row label (fixed-width left column). */
    label: string;
    /** Row value. */
    children: React$1.ReactNode;
    /** Render the value in a monospace face. */
    mono?: boolean;
}
/**
 * Renders an uppercase section label + divider above its children.
 *
 * @param props - {@link ISectionProps}.
 * @returns The section element.
 */
export declare function Section({ label, children }: ISectionProps): React$1.ReactElement;
/**
 * Renders a single label/value row.
 *
 * @param props - {@link ILabelValueProps}.
 * @returns The row element.
 */
export declare function LabelValue({ label, children, mono }: ILabelValueProps): React$1.ReactElement;
/** Props for the {@link ContentHeader} component. */
export interface IContentHeaderProps {
    /** Page / document title. */
    title: string;
    /** Optional one-line description of the view. */
    subtitle?: string;
    /** Optional right-aligned actions (primary Button at most once per view). */
    actions?: React$1.ReactNode;
}
/**
 * Renders the standard page header.
 *
 * @param props - {@link IContentHeaderProps}.
 * @returns The header element.
 */
export declare function ContentHeader({ title, subtitle, actions }: IContentHeaderProps): React$1.ReactElement;
/** Props for the {@link RocketRideMark} component. */
export interface IRocketRideMarkProps {
    /** Rendered width/height in px. Defaults to 24. */
    size?: number;
    /** Rocket body fill. Defaults to `currentColor`. */
    color?: string;
    /** Body fill alias (used by the app copies); overrides `color` when set. */
    bodyColor?: string;
    /** Optional class name. */
    className?: string;
    /** Optional inline style overrides. */
    style?: React$1.CSSProperties;
}
/**
 * Renders the RocketRide rocket mark.
 *
 * @param props - {@link IRocketRideMarkProps}.
 * @returns The SVG mark element.
 */
export declare function RocketRideMark({ size, color, bodyColor, className, style }: IRocketRideMarkProps): React$1.ReactElement;
/** Props for the {@link DetailPanel} component. */
export interface IDetailPanelProps {
    /** Whether the drawer is open. When false the component renders nothing. */
    open: boolean;
    /** Fired when the user dismisses the drawer (close glyph or Escape). */
    onClose: () => void;
    /** 42px round avatar/icon slot rendered at the start of the EntityHeader. */
    avatar?: React$1.ReactNode;
    /** Entity title — 17px/700. */
    title: string;
    /** Secondary line under the title — 12.5px, secondary colour. */
    subtitle?: string;
    /** Optional tab strip. Same entry shape as the ViewMenu renderers. */
    tabs?: ViewMenuEntry[];
    /** Id of the active tab (drawn with the brand underline). */
    activeTab?: string;
    /** Fired with a tab id when the user selects a tab. */
    onTabSelect?: (id: string) => void;
    /** Body content — composed from Section / LabelValue / Chip / StatusBadge /
        MiniContainer / Button. Scrolls independently of the header and tabs. */
    children: React$1.ReactNode;
    /**
     * Which edge the panel slides from. `'right'` (default) is the record-panel
     * standard: a full-height drawer for vertical record content. `'bottom'`
     * is a full-width tray for wide, ambient content (consoles, logs, wide
     * tables). All layering, focus, containment, and footer behavior is
     * identical between the two.
     */
    side?: "right" | "bottom";
    /** Drawer width in px (side 'right' only). Default {@link DEFAULT_WIDTH}. */
    width?: number;
    /**
     * Override the resize FLOOR (side 'right' only). The default floor is
     * {@link MIN_WIDTH} (380 — form-safe for record panels). A non-record drawer
     * whose content reads fine narrow (a node/catalog palette) can lower it so
     * the user can drag it slim. Ignored for `side: 'bottom'`.
     */
    minWidth?: number;
    /** Tray height in px (side 'bottom' only). Default {@link DEFAULT_HEIGHT}. */
    height?: number;
    /**
     * Fixed action row pinned below the scrolling body (record-panel verbs:
     * Save / Cancel / destructive actions). Rendered with a top divider;
     * omitted = no footer row (pure inspect panels).
     */
    footer?: React$1.ReactNode;
    /**
     * Body hosts a full VIEW (its own TabControl strip, gutters, and inner
     * scroll regions): the body becomes a definite, non-scrolling flex box
     * with no padding — the hosted View owns all scrolling. Without this, a
     * height-100% View collapses inside the default scrolling body and
     * scrollbars double up. Ignored when `tabs` are used (bodyTabs already
     * stops outer scrolling).
     */
    flushBody?: boolean;
    /**
     * Anchor the drawer to the nearest POSITIONED ANCESTOR instead of the
     * viewport. A slide-out anchors to the surface that OWNS the record:
     * grids on app pages open viewport drawers;
     * grids inside a dialog (the Account overlay) open drawers clipped to the
     * dialog's own edge — a window-edge drawer over a modal reads as an
     * unrelated second window and fights the backdrop stacking. The host
     * surface must be `position: relative` with `overflow: hidden`.
     */
    contained?: boolean;
    /**
     * Growing-edge drag resizing (ON by default; pass false to opt out) —
     * the left edge of a right drawer, the top edge of a bottom tray. The
     * size clamps between the axis floor ({@link MIN_WIDTH} / {@link MIN_HEIGHT})
     * and the OWNING SURFACE's size minus a visible sliver of dimmed context
     * (capped at 85%), so the panel can neither collapse below a usable
     * content size nor fully occlude the page behind it — the dimmed edge is
     * what communicates "overlay, not navigation". Double-click the handle to
     * restore the default size; the dragged size lasts for the panel's open
     * lifetime. In a STACK, only the top panel's handle is live and dragging
     * it resizes the whole stack (covered panels follow at +40px per level).
     */
    resizable?: boolean;
    /**
     * The panel's form mode (Edit/Create) holds unsaved changes. Arms the
     * DISCARD GUARD (interaction standard 2026-07-18): Escape, the back
     * arrow, the sliver click, and the header X all raise the stock
     * "Discard changes?" ConfirmDialog instead of exiting silently. The
     * consumer's footer Cancel should route through the same guard by
     * checking its own dirty state before calling {@link onExitMode}.
     */
    dirty?: boolean;
    /**
     * True while the panel is in a FORM mode (Edit or Create). Escape then
     * peels the innermost STATE layer — it acts as Cancel (guarded by
     * `dirty`) and calls {@link onExitMode} instead of closing the panel.
     */
    editing?: boolean;
    /**
     * Leave the form mode back to Inspect (Escape's Cancel path and the
     * confirmed discard). Create-mode panels typically close instead —
     * point this at the same handler that closes the create panel.
     */
    onExitMode?: () => void;
    /**
     * An async record action is in flight (saving/creating). The panel is
     * undismissable while true: X, Escape, back, and the sliver click all
     * no-op — the consumer's footer verbs disable themselves.
     */
    busy?: boolean;
    /**
     * MODELESS drawer (default false = modal). A modeless drawer drops the dim
     * backdrop and lets pointer / drag events pass THROUGH the overlay to the
     * surface behind it, so that surface stays fully interactive while the panel
     * is open — the canvas palettes (Add Node) that must keep drag-to-add onto
     * the graph working. It also skips the page-scroll lock and the Tab focus
     * trap, and reports `aria-modal="false"`. Dismissal is still deliberate-only
     * (close glyph / Escape); only the drawer box itself captures pointer events.
     * Everything else (slide-in, resize, footer, header) is identical to a modal
     * drawer. Not for records — a record editor is modal; reserve this for
     * non-modal tool/palette drawers over a live surface.
     */
    modeless?: boolean;
    /**
     * Opt-in width persistence. Set a STABLE key (one per panel role, not per
     * record — e.g. `panelDetailUserWidth`) and the drawer RESTORES its saved
     * size on open (clamped to the current usable band) and SAVES the new size on
     * every resize-end (drag, keyboard step, reset). Omit it and the drawer is
     * session-local — it opens at `width`/`height` every time (the default).
     * Persistence applies to a LONE panel only: a stack's shared width stays
     * session-local by the interaction standard.
     *
     * The value is read/written through the ambient {@link usePrefs} accessor —
     * the app's WORKSPACE preferences — so the width rides the workspace file and
     * syncs per-user, never browser `localStorage`. If no {@link PrefsProvider} is
     * mounted above the panel, persistence simply no-ops (the drawer stays
     * session-local); nothing crashes.
     */
    persistKey?: string;
}
/**
 * Renders the right slide-over detail drawer.
 *
 * @param props - {@link IDetailPanelProps}.
 * @returns The drawer element, or `null` when closed.
 */
export declare function DetailPanel({ open, onClose, avatar, title, subtitle, tabs, activeTab, onTabSelect, children, side, width, height, footer, flushBody, contained, resizable, dirty, editing, onExitMode, busy, modeless, minWidth, persistKey }: IDetailPanelProps): React$1.ReactElement | null;
/** Props for the {@link PanelTabBody} component. */
export interface IPanelTabBodyProps {
    /** The tab's content — typically a Section / LabelValue stack. */
    children: React$1.ReactNode;
}
/**
 * Renders a scrolling region filling a tabbed DetailPanel body.
 *
 * @param props - {@link IPanelTabBodyProps}.
 * @returns The scroll wrapper element.
 */
export declare function PanelTabBody({ children }: IPanelTabBodyProps): React$1.ReactElement;
/** Props for the {@link TabControl} component. */
export interface ITabControlProps {
    /** The declared menu whose entries render as the strip tabs. */
    menu: ViewMenu;
    /** Id of the currently active entry (drawn with the brand underline). */
    activeId: string;
    /** Fired with an entry id when the user selects it. */
    onSelect: (id: string) => void;
    /** Right-aligned slot (e.g. expand icon). Optional. */
    trailing?: React$1.ReactNode;
}
/**
 * Renders a ViewMenu as the top page strip.
 *
 * @param props - {@link ITabControlProps}.
 * @returns The strip element.
 */
export declare function TabControl({ menu, activeId, onSelect, trailing }: ITabControlProps): React$1.ReactElement;
/** One page body in the stack, keyed by its entry id in the panels map. */
export interface ITabPanelPanel {
    /** The panel's rendered content. */
    content: React$1.ReactNode;
}
/** Props for the {@link TabPanel} component. */
export interface ITabPanelProps {
    /** Map of panel id → { content }. Every panel is mounted; inactive ones hide. */
    panels: Record<string, ITabPanelPanel>;
    /** Id of the panel to show (all others are hidden with `display: none`). */
    activeId: string;
}
/**
 * Renders the panel stack (no pill bar) with the active panel visible.
 *
 * @param props - {@link ITabPanelProps}.
 * @returns The panel-stack element.
 */
export declare function TabPanel({ panels, activeId }: ITabPanelProps): React$1.ReactElement;
/** The one canonical close glyph (U+2715 MULTIPLICATION X) used by every dialog. */
export declare const CLOSE_GLYPH = "\u2715";
/** Props for the {@link Modal} component. */
export interface IModalProps {
    /** Header title — a plain string or a custom node. */
    title: React$1.ReactNode;
    /** Fired when the dialog is dismissed (✕ or Escape). */
    onClose: () => void;
    /** Body content. */
    children: React$1.ReactNode;
    /** Optional footer action row (Cancel / primary button, etc.). */
    footer?: React$1.ReactNode;
    /**
     * Whether to render the top-right ✕. Defaults to "only when there is no
     * footer" — a footer's Cancel/Close is the dismiss control, so a corner ✕
     * would be redundant. Pass `false` for auto-dismissing dialogs; pass `true`
     * to force the ✕ on a footered dialog that has no cancel affordance.
     */
    showClose?: boolean;
    /** Whether Escape closes the dialog. Default true. */
    closeOnEscape?: boolean;
    /** Box width in px. Default 440 (commonStyles.modalDialog). */
    width?: number;
    /** Drop the body padding (for content that fills the box, e.g. a DataGrid). */
    noBodyPadding?: boolean;
    /** Accessible label when `title` is not a plain string. */
    ariaLabel?: string;
}
/**
 * Renders a dialog box over a dimmed, inert backdrop.
 *
 * @param props - {@link IModalProps}.
 * @returns The modal element.
 */
export declare function Modal({ title, onClose, children, footer, showClose, closeOnEscape, width, noBodyPadding, ariaLabel, }: IModalProps): React$1.ReactElement;
/** One selectable file type — the OS Save-dialog "Save as type" vocabulary. */
export interface ISaveFileType {
    /** Human-readable type label, e.g. "RocketRide Pipeline". */
    label: string;
    /** Extension appended to the typed name, WITH the leading dot, e.g. ".pipe". */
    extension: string;
}
/** Props for the {@link SaveFileDialog} component. */
export interface ISaveFileDialogProps {
    /** Dialog title, e.g. "Save Pipeline As". */
    title: string;
    /** File system the dialog browses — only `list` and `mkdir` are called. */
    vfs: IVirtualFileSystem;
    /**
     * Selectable file types. The FIRST entry is the initial selection; a
     * single-entry list hides the type picker (the extension still shows as the
     * name input's suffix).
     */
    fileTypes: ISaveFileType[];
    /** Label rendered for the tree root row. Default "$/". */
    rootLabel?: string;
    /**
     * Directory preselected on open — relative to the VFS root, '/'-separated.
     * Rendered as a dimmed ghost row when it does not exist yet; the missing
     * segments are created on save.
     */
    defaultDir?: string;
    /** Initial value of the name input (no extension). */
    initialName?: string;
    /**
     * Called with the chosen path (relative to the VFS root, extension
     * included) AFTER any missing directories were created. The caller
     * performs the actual write.
     */
    onConfirm: (path: string) => void;
    /** Called when the dialog is dismissed (Cancel or Escape). */
    onCancel: () => void;
}
/**
 * Renders the stock Save-As dialog over a virtual file system.
 *
 * @param props - {@link ISaveFileDialogProps}.
 * @returns The dialog element.
 */
export declare function SaveFileDialog({ title, vfs, fileTypes, rootLabel, defaultDir, initialName, onConfirm, onCancel }: ISaveFileDialogProps): React$1.ReactElement;
/** Props for the {@link SidebarMenu} component. */
export interface ISidebarMenuProps {
    /** The declared menu whose entries render as the vertical list. */
    menu: ViewMenu;
    /** Id of the currently active entry (drawn as the brand-tinted pill). */
    activeId: string;
    /** Fired with an entry id when the user selects it. */
    onSelect: (id: string) => void;
    /**
     * Section label above the menu, e.g. the owning document name. The label
     * sits flush at indent 0 and every row nests 10px beneath it; without a
     * label, rows sit flush where the label would. Optional.
     */
    sectionLabel?: string;
    /**
     * Collapsed (icon-rail) rendering: entries draw icon-only (the entry's
     * `icon`, or a first-letter glyph fallback) with the label as a tooltip,
     * the section label hidden, and count badges shown as a compact overlay.
     * When omitted, the flag falls back to the shell-provided
     * {@link useSidebarCollapsed} context; an explicit prop always wins.
     */
    collapsed?: boolean;
}
/**
 * Renders a ViewMenu as a vertical sidebar list, with entries declaring
 * `children` rendered as expandable accordion sections (at most one open).
 *
 * @param props - {@link ISidebarMenuProps}.
 * @returns The sidebar menu element.
 */
export declare function SidebarMenu({ menu, activeId, onSelect, sectionLabel, collapsed }: ISidebarMenuProps): React$1.ReactElement;
/** Props for the {@link SidebarCollapsedProvider} component. */
export interface ISidebarCollapsedProviderProps {
    /** Whether the enclosing sidebar is currently collapsed to its icon rail. */
    value: boolean;
    /** The sidebar-slot subtree that may read the collapsed flag. */
    children: React$1.ReactNode;
}
/**
 * Provides the sidebar's collapsed flag to the registered sidebar content.
 * Mounted by the shell around the sidebar's app-content slot.
 *
 * @param props - {@link ISidebarCollapsedProviderProps}.
 * @returns The provider element.
 */
export declare const SidebarCollapsedProvider: React$1.FC<ISidebarCollapsedProviderProps>;
/**
 * Reads whether the enclosing shell sidebar is collapsed to its icon rail.
 * Any component inside app-registered sidebar content may call this; it
 * returns `false` when no provider is mounted (expanded / non-collapsible).
 *
 * @returns True while the sidebar is collapsed.
 */
export declare function useSidebarCollapsed(): boolean;
/** Props for the {@link SidebarCollapsedGate} component. */
export interface ISidebarCollapsedGateProps {
    /** The sidebar content to hide while the sidebar is collapsed. */
    children: React$1.ReactNode;
}
/**
 * Renders its children only while the sidebar is expanded.
 *
 * The shell renders registered sidebar content even while the sidebar is
 * collapsed to its icon rail. Free-form content with no icon-rail form (file
 * trees, chat explorers) wraps itself in this gate to disappear while
 * collapsed, instead of each app re-implementing the same four lines.
 *
 * @param props - {@link ISidebarCollapsedGateProps}.
 * @returns The children while expanded, or null while collapsed.
 */
export declare const SidebarCollapsedGate: React$1.FC<ISidebarCollapsedGateProps>;
/** A single item in the popup menu (or a submenu). */
export interface SidebarFooterMenuItem {
    /** Unique key for React list rendering. */
    id: string;
    /** Display label. */
    label: string;
    /** Optional icon rendered before the label. */
    icon?: IconComponent;
    /** Click handler (leaf items). */
    onClick?: () => void;
    /** If provided, clicking opens a nested submenu with these items. */
    submenu?: SidebarFooterMenuItem[];
    /** Show a checkmark next to this item (for radio-style selections). */
    checked?: boolean;
    /** Secondary status line rendered below the label (e.g. "Connected", "Downloading..."). */
    statusText?: string;
    /** Connection state — drives the colored dot next to statusText. */
    statusState?: "connected" | "connecting" | "disconnected";
    /** Render a horizontal divider before this item. */
    dividerBefore?: boolean;
    /** If true, render as a non-clickable section header (bold label, no hover). */
    header?: boolean;
}
export interface SidebarFooterProps {
    /** Whether the sidebar is in collapsed (icon-only) mode. */
    collapsed: boolean;
    /** User display name (e.g. "RodC"). Drives the avatar initials. */
    userName?: string;
    /** User email (shown below name). */
    userEmail?: string;
    /** Show a Documentation link. */
    onOpenDocs?: () => void;
    /** Host-specific menu items shown in the popup. */
    menuItems?: SidebarFooterMenuItem[];
}
export declare const SidebarFooter: React$1.FC<SidebarFooterProps>;
/**
 * Declared value type of a grid column — drives which filter control the
 * column's header popup renders (the DataGrid resolves the control from this
 * type; there is no per-view override map):
 *
 * - `'string'`  — free text; text "contains" input.
 * - `'number'`  — numeric scalar; Min / Max bound inputs writing the
 *                 `${field}__gte` / `${field}__lte` filter keys (the server
 *                 coerces numeric bounds).
 * - `'boolean'` — true/false flag; static two-entry Yes/No checklist.
 * - `'date'`    — ISO date / datetime; Start / End range inputs (each a date
 *                 plus an optional time) writing the `${field}__gte` /
 *                 `${field}__lte` filter keys — a bound with a time commits
 *                 as `${date}T${time}`; a date-only end bound is made
 *                 end-of-day inclusive server-side.
 * - `'enum'`    — low-cardinality discrete codes; distinct-value checklist
 *                 (fetchDistinct on remote grids, derived from the loaded
 *                 rows on local ones).
 * - `'strings'` — JSON string-array column (e.g. sysPermissions); text input
 *                 (server-side: contains ANY matching element).
 * - `'json'`    — structured payload blob (e.g. requestData); text input
 *                 over the serialized text (server coercion handles it).
 *
 * An undeclared type (including auto-derived columns) defaults to the text
 * "contains" input, exactly like `'string'`.
 */
export type GridColumnRRType = "string" | "number" | "boolean" | "date" | "enum" | "strings" | "json";
/**
 * ColumnDefinition plus DataGrid extensions — the full per-column contract a
 * view declares. `field` is the key in the result rows; `title`, `rrType`,
 * and any Tabulator-native option (width, formatter, `headerSort`, ...) ride
 * alongside. The DataGrid-private markers:
 *
 * - `rrNoPopup` exempts a column from the header popup (filter + show/hide +
 *   reset) AND from the toggle list — icon/chrome columns.
 * - `rrType` declares the column's value type ({@link GridColumnRRType}),
 *   which selects the header-popup filter control.
 * - `rrDefault` marks the column as part of the DEFAULT view; the default
 *   ORDER is the order the defaulted columns appear in the `columns` array.
 *   A column WITHOUT it is available (declared, filterable, toggleable from
 *   the header menu) but hidden by default. When ANY column declares
 *   `rrDefault` the grid runs in contract mode: the default layout derives
 *   from the flags alone ({@link applyDefaultLayout}) and applies whenever
 *   the user has no persisted layout — a persisted workspace layout, once
 *   saved, still wins. With NO flags declared the legacy behavior holds
 *   (array order + native `visible` flags).
 * - `rrDefaultSort` opts the column into the grid's DEFAULT sort (applied
 *   when the user has no persisted sort; multiple declarations compose in
 *   array order). Remote grids send it on the first request.
 * - `rrGroup` groups rows by this column by default (client-side — on remote
 *   grids groups form within the loaded page).
 * - `rrDescription` documents the column for humans: it becomes the header
 *   tooltip (Tabulator `headerTooltip`) and the toggle-list row tooltip.
 * - `rrOptions` declares a curated selection vocabulary: the filter control
 *   becomes a checklist of the declared options (label defaults to the
 *   value) UNIONed with the live distinct values, so values that ship in
 *   data appear without a code change — declared labels win on overlap.
 *   This is how enum-like string columns and JSON-array columns (e.g.
 *   sysPermissions) get a real selector: the committed array reaches the
 *   server as IN on scalar columns and contains-ANY on array columns.
 *
 * Every marker is stripped before the definitions reach Tabulator
 * ({@link normalizeColumns}), so exempt columns simply never receive the
 * `headerPopup` option and Tabulator never sees an unknown option.
 */
export type GridCellComponent = CellComponent;
export type GridColumnDefinition = ColumnDefinition & {
    /** Exempt this column from the header popup and its toggle list. */
    rrNoPopup?: boolean;
    /** Declared value type — selects the header-popup filter control. */
    rrType?: GridColumnRRType;
    /** Part of the default view (order = position in the columns array). */
    rrDefault?: boolean;
    /** Direction this column contributes to the grid's default sort. */
    rrDefaultSort?: "asc" | "desc";
    /** Group rows by this column by default. */
    rrGroup?: boolean;
    /**
     * REQUIRED short human description — every declared column carries a name
     * (`title`) and a description; the description renders as the header
     * tooltip and the COLUMNS toggle-list tooltip. State what the value IS
     * (units, sign conventions, id semantics) — not a restatement of the
     * title.
     */
    rrDescription: string;
    /** Curated filter vocabulary — checklist, unioned with live distinct values. */
    rrOptions?: (string | {
        value: string;
        label: string;
    })[];
};
/** Semantic variants for {@link badgeEl} — mirrors StatusBadge's variants. */
export type CellBadgeVariant = "success" | "info" | "warning" | "error" | "muted";
/** Visual kinds for {@link buttonEl} — mirrors the small Button variants. */
export type CellButtonKind = "ghost" | "secondary" | "danger";
/** One action rendered by {@link createActionsColumn}. */
export interface IGridAction<Row> {
    /** Stable key reported to `onAction` when the button is clicked. */
    key: string;
    /** Button label; a function derives it from the row (e.g. toggle labels). */
    label: string | ((row: Row) => string);
    /** Visual kind; a function derives it from the row. Default 'ghost'. */
    kind?: CellButtonKind | ((row: Row) => CellButtonKind);
}
/** Configuration for {@link createActionsColumn}. */
export interface IActionsColumnConfig<Row> {
    /** The actions rendered (in order) in every row. */
    actions: IGridAction<Row>[];
    /** Fired with the action key and the clicked row's data. */
    onAction: (key: string, row: Row) => void;
    /** Column width; defaults to 120. */
    width?: number;
}
/**
 * Build a status pill (StatusBadge clone) for a cell.
 *
 * @param variant - Semantic state variant.
 * @param label - Pill text.
 * @returns The pill element.
 */
export declare function badgeEl(variant: CellBadgeVariant, label: string): HTMLElement;
/**
 * Build a small action button (Button small-variant clone) for a cell.
 * The `data-action` attribute is how {@link createActionsColumn} routes clicks.
 *
 * @param kind - Visual kind.
 * @param label - Button text.
 * @param action - Stable action key stored in `data-action`.
 * @returns The button element.
 */
export declare function buttonEl(kind: CellButtonKind, label: string, action: string): HTMLElement;
/**
 * Build a 32px round avatar with initials for a cell.
 *
 * @param initials - One-or-two character label.
 * @param background - CSS background (use one of the `--rr-chart-*` tokens).
 * @returns The avatar element.
 */
export declare function avatarEl(initials: string, background: string): HTMLElement;
/**
 * Build a monospace text span for a cell (ids, emails, code-ish values).
 *
 * @param text - Cell text.
 * @returns The span element.
 */
export declare function monoEl(text: string): HTMLElement;
/**
 * Build a muted secondary text span for a cell (dates, de-emphasised values).
 *
 * @param text - Cell text.
 * @returns The span element.
 */
export declare function mutedEl(text: string): HTMLElement;
/**
 * Case-insensitive substring match over every own string/number value of a
 * row — the standard predicate for view-side filtering of LOCAL grid data
 * (replaces the old array-source's built-in search).
 *
 * @param row - The row object.
 * @param term - Raw search input (trimmed internally; empty matches all).
 * @returns True when the row matches.
 */
export declare function matchesSearch(row: Record<string, unknown>, term: string): boolean;
/**
 * Build the trailing Actions column — right-aligned small buttons, exempt from
 * sorting / moving / the header popup, and excluded from row-click handling
 * (the DataGrid's rowClick guard skips clicks inside `[data-rr-actions]`).
 *
 * @typeParam Row - Row shape of the grid.
 * @param config - Actions and click router.
 * @returns A DataGrid column definition to append to the columns array.
 */
export declare function createActionsColumn<Row>(config: IActionsColumnConfig<Row>): GridColumnDefinition;
/**
 * Type-heuristic formatter, keyed off the value actually in the cell:
 * boolean -> yes/no badge, ISO datetime string -> muted local date-time,
 * array -> badge list, object -> truncated JSON, null -> ''. Used by every
 * auto-derived column (which has no declared type), and exported for views
 * to reuse on declared hidden columns whose rare reveal does not warrant a
 * bespoke formatter.
 *
 * @param cell - The Tabulator cell.
 * @returns The formatted cell content.
 */
export declare function autoFormatter(cell: CellComponent): HTMLElement | string;
/**
 * Render a 'date' column value per its {@link IColumnFormat} date/time pick.
 * The date and time parts are independent: either alone renders just that
 * part; both render "date time". The 12-hour clock is the default; `clock24`
 * switches the time part to 24-hour. Values render in the viewer's LOCAL
 * time by default (the wire carries UTC); the `utc` pick renders the UTC
 * parts instead — including the date part, since a UTC instant near midnight
 * falls on a different local date.
 *
 * The modifiers ([24HR] / [UTC]) act even WITHOUT a pattern pick: toggled
 * alone, the override takes over the full default datetime
 * (MM/DD/YY HH:MM:SS) — otherwise the toggle would sit dead on a column
 * still rendered by its own formatter.
 *
 * @param value - The raw cell value (ISO string / epoch / Date).
 * @param fmt - The column's format override.
 * @returns The formatted text, or null when no date/time/modifier pick is
 *     set or the value does not parse as a date (callers fall back to the
 *     base render).
 */
export declare function formatDateValue(value: unknown, fmt: IColumnFormat): string | null;
interface IColumnFormat {
    /** Cell text alignment; unset = the column's declared hozAlign. */
    align?: "left" | "center" | "right";
    /** Date part of a 'date' column's rendering (exclusive pair). */
    dateFormat?: "MM/YY" | "MM/DD/YY";
    /** Time part of a 'date' column's rendering (exclusive pair). */
    timeFormat?: "HH:MM" | "HH:MM:SS";
    /** 24-hour clock for the time part (default 12-hour AM/PM). */
    clock24?: boolean;
    /**
     * Render the picked date/time parts in UTC. Default (unset) converts to
     * the viewer's LOCAL time — the platform wire contract is that server
     * datetimes are UTC.
     */
    utc?: boolean;
    /** Fixed decimal places of a 'number' column (exclusive 0-3). */
    decimals?: 0 | 1 | 2 | 3;
    /** Thousands separators on a 'number' column. */
    thousands?: boolean;
    /** '$' currency prefix on a 'number' column. */
    currency?: boolean;
}
/** One option of a select or typeahead filter control. */
export interface IGridFilterOption {
    /** Value stored (and sent to fetchPage) when chosen. */
    value: string;
    /** Visible label. */
    label: string;
}
/** Declarative definition of one filter control in the strip. */
export interface IGridFilterDef {
    /** Key under which the value appears in the filters record. */
    key: string;
    /** Uppercase label above the control. */
    label: string;
    /** Control type. */
    type: "text" | "select" | "date" | "typeahead";
    /** Placeholder for text / typeahead inputs. */
    placeholder?: string;
    /** Options for a select (include an empty-value "All ..." entry). */
    options?: IGridFilterOption[];
    /** Async suggestion lookup for a typeahead (value = picked option's value). */
    search?: (query: string) => Promise<IGridFilterOption[]>;
    /** Control width in px. Defaults per type (text/typeahead 180, others auto). */
    width?: number;
}
/** Props for the {@link FilterStrip} component. */
export interface IFilterStripProps {
    /** The filter controls to render, in order. */
    defs: IGridFilterDef[];
    /**
     * Current committed values keyed by def key. The record is shared with
     * the header-popup filters, so values may be arrays ('values' checklists)
     * — the strip's controls are string-valued and render arrays as ''.
     */
    values: Record<string, string | string[]>;
    /** Display labels for typeahead selections keyed by def key. */
    labels: Record<string, string>;
    /**
     * Fired on every user edit.
     *
     * @param key - The filter's key.
     * @param value - The new value ('' clears the filter).
     * @param label - Display label (typeahead picks only).
     */
    onChange: (key: string, value: string, label?: string) => void;
}
/**
 * Render the labelled filter controls row. See the module doc for behavior.
 *
 * @param props - {@link IFilterStripProps}.
 * @returns The strip element.
 */
export declare const FilterStrip: React$1.FC<IFilterStripProps>;
/**
 * DataGrid layout persistence — the storage contract behind Tabulator's
 * persistence module.
 *
 * Tabulator persists layout state (column widths / order / visibility, sort,
 * page size) through a SYNCHRONOUS reader/writer pair;
 * {@link IDataGridPersistence} is that contract plus `clear` for the grid's
 * "Reset layout" action.
 *
 * Views do NOT wire an adapter themselves. Whenever a DataGrid has a
 * `tableId` and no explicit `persistence` prop, it defaults to the
 * message-channel adapter (see gridConfigChannel.ts): the grid speaks a tiny
 * CustomEvent protocol and whatever host is present answers it — the web
 * shell from the active app's workspace prefs, the VSCode webview from the
 * extension host's project workspaceState; with no bridge listening the grid
 * simply renders its declared defaults. The `persistence` prop remains only
 * as an override for hosts that need a custom store.
 */
/** Persisted layout blobs for one table, keyed by Tabulator persistence type. */
export type DataGridLayout = Record<string, unknown>;
/**
 * Storage adapter consumed by {@link DataGrid}. Implementations must be
 * synchronous on `read` (Tabulator's persistence reader is sync).
 */
export interface IDataGridPersistence {
    /**
     * Read one persisted blob.
     *
     * @param tableId - The grid's stable persistence key.
     * @param type - Tabulator persistence type ('sort' | 'columns' | 'page' ...).
     * @returns The stored blob, or false when nothing is stored.
     */
    read(tableId: string, type: string): unknown | false;
    /**
     * Write one persisted blob.
     *
     * @param tableId - The grid's stable persistence key.
     * @param type - Tabulator persistence type.
     * @param data - The blob Tabulator wants stored (persisted verbatim).
     */
    write(tableId: string, type: string, data: unknown): void;
    /**
     * Drop every persisted blob for one table (the "Reset layout" action).
     *
     * @param tableId - The grid's stable persistence key.
     */
    clear(tableId: string): void;
}
/** One remote page request handed to {@link IDataGridProps.fetchPage}. */
export interface IDataGridPageRequest {
    /** 1-based page number (Tabulator convention; matches the saas list_* APIs). */
    page: number;
    /** Rows per page. */
    size: number;
    /** Active sorters (only populated when `remoteSort` is enabled). */
    sort: {
        field: string;
        dir: "asc" | "desc";
    }[];
    /**
     * Committed filter values (non-empty only; {} when no filters). A string
     * value means server-side "contains"; an array means server-side IN.
     * Range bounds ride as separate string entries under the
     * `${field}__gte` / `${field}__lte` keys: a 'date' column commits
     * date-only strings or, when the popup's optional time is set,
     * `${date}T${time}` ISO datetimes (the server makes a date-only upper
     * bound end-of-day inclusive); a 'number' column commits numeric strings
     * from its Min / Max inputs (the server coerces numeric bounds).
     */
    filters: Record<string, string | string[]>;
    /**
     * The committed title-bar search term — present only when non-empty.
     * Forward it verbatim as the list_* `search` arg: the server matches it
     * case-insensitively across the endpoint's searchable columns, so the
     * search spans ALL pages (not just the loaded one).
     */
    search?: string;
}
/** One remote page of rows plus the total row count across all pages. */
export interface IDataGridPage<Row> {
    /** The rows of the requested page. */
    rows: Row[];
    /** Total rows across every page (drives the pager). */
    total: number;
}
/** Props for the {@link DataGrid} component. */
export interface IDataGridProps<Row extends Record<string, unknown>> {
    /** Stable id keying layout persistence (required with `persistence`). */
    tableId?: string;
    /**
     * Optional heading text at the left of the built-in title bar (Card-header
     * look, rendered above the filter strip). The bar itself — search, count,
     * and export — renders on EVERY grid by default regardless of the title;
     * this prop only adds the heading. See `noSearch` / `noExport` to trim the
     * bar's contents (the bar hides only when both are suppressed AND no title
     * is set).
     */
    title?: string;
    /**
     * Hide the title bar's search entirely — magnifier toggle, input, and
     * matching-row count. EXCEPTIONAL (2026-07-18): the field is collapsed
     * behind the magnifier by default, so search costs one glyph and should
     * stay enabled everywhere — "the table is small" no longer justifies
     * this prop. REMOTE grids search server-side: the term rides every page
     * request as {@link IDataGridPageRequest.search}, so matches span ALL
     * pages and the pager pages within the results. LOCAL grids (all rows
     * already loaded) narrow client-side across every value.
     * With `noExport` also set and no `title`, the whole bar disappears.
     */
    noSearch?: boolean;
    /**
     * Hide the EXPORT section of the gear menu (CSV / JSON), which every grid
     * shows by default. Exports cover EVERY row matching the current committed
     * filters AND the active search term (remote grids walk all pages with
     * both riding each request), restricted to the visible columns in display
     * order. The gear itself (display toggles + column checklist) remains.
     * With `noSearch` also set, the grid contributes NO buttons at all
     * (gear and the transient Clear included): on a titled grid that leaves
     * an actions-only card header — `actions` always render regardless — and
     * with no `title`/`actions` either, the whole bar disappears.
     */
    noExport?: boolean;
    /**
     * Card-specific action buttons (e.g. "Add more capacity..."). Providing
     * `actions` OR `title` switches the bar to its card-header form: the
     * title stacked over the search + count tools on the left, and ONE
     * vertically-centered cluster on the right — these actions first, then
     * the grid's own buttons (Clear / Export) — under one shared fill and
     * bottom border, so a card-hosted grid carries a single header instead
     * of a Card header stacked on a grid bar. CardDataGrid is the same
     * component re-typed with `title` required, for call sites where the
     * grid IS the card.
     */
    actions?: React$1.ReactNode;
    /**
     * Declared column definitions — the full per-column contract
     * ({@link GridColumnDefinition}): Tabulator-native options plus the
     * DataGrid extensions. Declare EVERY available column; each declares its
     * result-row key (`field`), value type (`rrType` — selects the filter
     * control), and its place in the DEFAULT view:
     *
     * - `rrDefault: true` — part of the default view; the default ORDER is
     *   the order defaulted columns appear in this array. A column WITHOUT
     *   the flag is available (toggleable from the header menu, filterable,
     *   exportable) but hidden by default. The synthesized default layout
     *   applies exactly when the user has NO persisted layout; a saved
     *   workspace layout always wins, and Reset layout returns to the
     *   declared defaults.
     * - `rrDefaultSort: 'asc' | 'desc'` — the grid's default sort (composes
     *   across columns in array order; Clear returns to it).
     * - `rrGroup` — default row grouping by this column.
     * - `rrDescription` — human description; becomes the header tooltip and
     *   the COLUMNS toggle-list tooltip.
     * - `rrOptions` — static filter vocabulary; the column's filter becomes a
     *   checklist of exactly these options (how enum-like strings and JSON
     *   string-arrays like sysPermissions get real selectors).
     *
     * Legacy (flag-free) declarations keep the old behavior: array order +
     * native `visible` flags. Memoize; identity change re-applies.
     */
    columns: GridColumnDefinition[];
    /** LOCAL mode: current rows. Identity change applies silently in place. */
    data?: Row[];
    /** REMOTE mode: fetch one page. Mutually exclusive with `data`. */
    fetchPage?: (req: IDataGridPageRequest) => Promise<IDataGridPage<Row>>;
    /** Forward header-sort clicks to `fetchPage` instead of sorting locally. */
    remoteSort?: boolean;
    /** Page-size options; the first entry is the default size. */
    pageSizes?: number[];
    /** Disable pagination entirely (every row renders; no footer). */
    paginate?: boolean;
    /** Fixed height (px or CSS length) — enables internal scroll + virtual DOM. */
    height?: number | string;
    /** Empty-set placeholder title. */
    emptyTitle?: string;
    /** Empty-set placeholder description line. */
    emptyDescription?: string;
    /** Row click (ignored for clicks on action buttons inside the row). */
    onRowClick?: (row: Row) => void;
    /** Remote load failure (prior rows are kept; an overlay shows briefly). */
    onLoadError?: (error: Error) => void;
    /**
     * Layout persistence adapter override. Normally OMITTED: a grid with a
     * `tableId` persists over the grid config channel by default (the host
     * bridge answers — web shell from workspace prefs, VSCode from project
     * state; no bridge = defaults). Supply one only to bypass the channel.
     */
    persistence?: IDataGridPersistence;
    /**
     * Derive addable columns from the row keys: any key of the loaded rows
     * not covered by a declared column becomes a hidden column (toggleable
     * from the header menu, persisted like any other). The rows ARE the
     * shape — new server fields appear automatically. Prefer declaring the
     * full column set instead: auto columns carry no `rrType`, so they always
     * fall back to the text filter.
     */
    autoColumns?: boolean;
    /**
     * Filter controls rendered in a strip above the table (grid-owned).
     * Values auto-apply after a 300ms debounce: remote grids refetch from
     * page 1 with the values in `req.filters`; local grids filter THEMSELVES
     * — the committed record runs through the grid-internal predicate
     * (rowMatchesFilters, the server convention's semantics) over the loaded
     * rows. A strip key with no matching row field is skipped by the
     * predicate (server parity), so cross-field strip filters (typeaheads
     * over joined values) stay the host's job via `onFiltersChange`.
     */
    filters?: IGridFilterDef[];
    /**
     * Debounced committed filter values — an OPTIONAL observation hook (URL
     * sync, analytics, host-side filtering of strip-only keys). LOCAL grids
     * no longer require it to filter: they apply committed header-popup and
     * strip filters to their own rows grid-internally.
     */
    onFiltersChange?: (values: Record<string, string | string[]>) => void;
    /**
     * Async distinct-value lookup for the checklist filter of `rrType: 'enum'`
     * columns (views wire it to the server's `list_distinct`). When absent,
     * LOCAL grids derive the uniques from the current `data` rows; REMOTE
     * grids fall back to the text filter for that column (one page of rows is
     * not the full distinct set).
     */
    fetchDistinct?: (field: string) => Promise<(string | number | boolean)[]>;
    /** Native Tabulator options escape hatch — merged over the defaults. */
    options?: Options$1;
}
/** Imperative surface exposed through the component ref. */
export interface IDataGridHandle {
    /** The live Tabulator instance (null before mount / after unmount). */
    table: Tabulator | null;
    /**
     * Re-run the remote query. `resetPage` returns to page 1 (after filters or
     * search change); otherwise the current page is re-requested (mutations).
     */
    refetch(opts?: {
        resetPage?: boolean;
    }): void;
    /**
     * Reset the grid COMPLETELY: persisted layout, sort, all filters (strip +
     * header popups), and the grid-local search clear, then the instance
     * rebuilds and re-queries page 1 with no filters.
     */
    resetLayout(): void;
}
/**
 * The platform's stock table. See the module doc above for behavior; see
 * {@link IDataGridProps} for the API.
 */
export declare const DataGrid: <Row extends Record<string, unknown>>(props: IDataGridProps<Row> & {
    ref?: React$1.Ref<IDataGridHandle>;
}) => React$1.ReactElement;
/**
 * Props for {@link CardDataGrid}: the full DataGrid API with `title` made
 * REQUIRED — a card must be named. Everything else, `actions` included,
 * is inherited verbatim.
 */
export type ICardDataGridProps<Row extends Record<string, unknown>> = IDataGridProps<Row> & {
    /** Card title, rendered in the header's identity row (required). */
    title: string;
};
/**
 * The card-titled grid. Identical to {@link DataGrid} at runtime; the alias
 * exists purely so call sites that present a grid AS a card cannot omit the
 * title.
 */
export declare const CardDataGrid: <Row extends Record<string, unknown>>(props: ICardDataGridProps<Row> & {
    ref?: React$1.Ref<IDataGridHandle>;
}) => React$1.ReactElement;
/** Event name: synchronous read of one table's persisted layout blobs. */
export declare const GRID_CONFIG_GET = "rr:grid-config:get";
/** Event name: persist one layout blob for a table (fire-and-forget). */
export declare const GRID_CONFIG_SET = "rr:grid-config:set";
/** Event name: drop every persisted blob for a table (Reset layout). */
export declare const GRID_CONFIG_CLEAR = "rr:grid-config:clear";
/** Detail of {@link GRID_CONFIG_GET}. */
export interface IGridConfigGetDetail {
    /** The grid's stable persistence key. */
    tableId: string;
    /**
     * Called SYNCHRONOUSLY by the host bridge with the table's stored blobs
     * (keyed by Tabulator persistence type), or undefined when none exist.
     * Never called when no bridge is listening.
     */
    reply: (layouts: DataGridLayout | undefined) => void;
}
/** Detail of {@link GRID_CONFIG_SET}. */
export interface IGridConfigSetDetail {
    /** The grid's stable persistence key. */
    tableId: string;
    /** Tabulator persistence type ('sort' | 'columns' | 'page' | ...). */
    type: string;
    /** The blob to store verbatim. */
    blob: unknown;
}
/** Detail of {@link GRID_CONFIG_CLEAR}. */
export interface IGridConfigClearDetail {
    /** The grid's stable persistence key. */
    tableId: string;
}
/**
 * Create an {@link IDataGridPersistence} speaking the grid config channel.
 *
 * Reads seed a per-instance cache with ONE synchronous `get` per tableId
 * (the host bridge answers before dispatch returns); writes and clears
 * update the cache and notify the host fire-and-forget. With no bridge
 * present, reads return false (Tabulator applies the declared defaults)
 * and writes are dropped — the grid works, just without persistence.
 *
 * @returns A persistence adapter for one or more DataGrids.
 */
export declare function createMessageGridPersistence(): IDataGridPersistence;
/** A single message in the conversation. */
export interface ChatMessage {
    /** Unique monotonic ID — never collides even within the same millisecond. */
    id: number;
    /** Raw text content (may contain markdown). */
    text: string;
    /** Who produced the message. */
    sender: "user" | "bot" | "system" | "status";
    /** Formatted time string, e.g. "14:32". */
    timestamp: string;
    /** Pipeline result key — shown as a small label below bot messages. */
    resultKey?: string;
    /** SSE event type — used to identify thinking-group status messages. */
    sseType?: string;
    /** Optional metadata line (e.g. "2,340 tokens · 1.8s") shown under the bubble content. */
    meta?: string;
    /** When true, the message renders as an in-thread error Banner instead of a bubble. */
    isError?: boolean;
}
/** Props for the top-level ChatView component. */
export interface IChatViewProps {
    /** Current message list managed by the host via useChatMessages. */
    messages: ChatMessage[];
    /** Whether the assistant is currently composing a response. */
    isTyping: boolean;
    /** Whether the underlying WebSocket client is connected. */
    isConnected: boolean;
    /** Called when the user submits a message. */
    onSend: (text: string) => void;
    /** Placeholder shown in the input when idle. Defaults to "Ask anything…". */
    placeholder?: string;
    /** Title for the EmptyState shown when the conversation has no messages. */
    emptyTitle?: string;
    /** Description for the EmptyState shown when the conversation has no messages. */
    emptyDescription?: string;
    /** Optional node rendered before the input field (reserved for future attachments). */
    leadingInputSlot?: React$1.ReactNode;
}
/** Options for useChatMessages. */
export interface UseChatMessagesOptions {
    /** System message shown after clearMessages(). */
    welcomeMessage?: string;
    /** Seed messages to restore a previous conversation (preserves sender, timestamp, etc.). */
    initialMessages?: ChatMessage[];
}
/**
 * Renders the chat surface (message thread + composer).
 *
 * @param props - {@link IChatViewProps}. The composer is disabled whenever
 *   `isConnected` is false; `emptyTitle` / `emptyDescription` configure the
 *   EmptyState for new conversations; `leadingInputSlot` is rendered before the
 *   input (reserved for future attachments).
 * @returns The chat view element.
 */
export declare const ChatView: React$1.FC<IChatViewProps>;
interface MessageListProps {
    messages: ChatMessage[];
    isTyping: boolean;
    /** Title for the EmptyState shown when there are no messages. */
    emptyTitle?: string;
    /** Description for the EmptyState shown when there are no messages. */
    emptyDescription?: string;
}
/**
 * Renders the scrollable message thread with scroll-locked autoscroll.
 *
 * @param props - {@link MessageListProps}.
 * @returns The thread element (or an EmptyState when empty).
 */
export declare const MessageList: React$1.FC<MessageListProps>;
interface MarkdownRendererProps {
    content: string;
}
export declare const MarkdownRenderer: React$1.FC<MarkdownRendererProps>;
interface UseChatMessagesReturn {
    messages: ChatMessage[];
    isTyping: boolean;
    sendMessage: (text: string, client: any, authToken: string) => Promise<void>;
    clearMessages: () => void;
    addSystemMessage: (text: string) => void;
}
/**
 * Manages chat message state and RocketRide API communication.
 *
 * IMPORTANT: always use the internal updateMessages helper — never call
 * setMessages directly. Direct setMessages calls bypass the messagesRef
 * sync and will cause sendMessage to build history from a stale snapshot.
 */
export declare function useChatMessages({ welcomeMessage, initialMessages }?: UseChatMessagesOptions): UseChatMessagesReturn;
/** Props for the {@link ConnectionCard} component. */
export interface IConnectionCardProps {
    /** Optional source icon (rendered at 30px, inherits the card's icon colour). */
    icon?: React$1.ReactNode;
    /** Source name. */
    name: string;
    /** Source address / endpoint. */
    address: string;
    /** StatusBadge variant for the source's state. */
    status: Extract<StatusVariant, "success" | "muted" | "error">;
    /** StatusBadge label, e.g. "Connected" / "Disconnected". */
    statusLabel: string;
    /** When true, the card carries the brand border and brand icon colour. */
    connected?: boolean;
    /** Edit action — reveals the pencil icon on hover. */
    onEdit?: () => void;
    /** Delete action — reveals the trash icon on hover. */
    onDelete?: () => void;
    /** Select action for the whole card. */
    onClick?: () => void;
}
/** Props for the {@link ConnectionCardAdd} component. */
export interface IConnectionCardAddProps {
    /** Label beneath the plus glyph, e.g. "New Connection". */
    label: string;
    /** Fired when the add tile is activated. */
    onClick: () => void;
}
/**
 * Renders a connection / source card.
 *
 * @param props - {@link IConnectionCardProps}.
 * @returns The card element.
 */
export declare function ConnectionCard({ icon, name, address, status, statusLabel, connected, onEdit, onDelete, onClick, }: IConnectionCardProps): React$1.ReactElement;
/**
 * Renders the dashed "add a source" tile.
 *
 * @param props - {@link IConnectionCardAddProps}.
 * @returns The add-tile element.
 */
export declare function ConnectionCardAdd({ label, onClick }: IConnectionCardAddProps): React$1.ReactElement;
/** Display props derived from a connection for its {@link ConnectionCard}. */
export interface IConnectionCardDisplay {
    /** Card title (connection name). */
    name: string;
    /** Card sub-line (address / endpoint, e.g. "localhost:5590"). */
    address: string;
    /** StatusBadge variant for the connection's state. */
    status: Extract<StatusVariant, "success" | "muted" | "error">;
    /** StatusBadge label, e.g. "Connected" / "Disconnected". */
    statusLabel: string;
    /** When true, the card carries the brand border and brand icon colour. */
    connected?: boolean;
}
/** One field in the add/edit form. */
export interface IConnectionFormField {
    /** Key into the form's value map (also the persisted field name). */
    key: string;
    /** Field label shown above the input. */
    label: string;
    /** Placeholder text for the input. */
    placeholder?: string;
    /** Render as a password input with a Show/Hide reveal toggle. */
    secret?: boolean;
    /** The form cannot be saved while this field is empty (after trim). */
    required?: boolean;
    /** Autofocus this field when the dialog opens. */
    autoFocus?: boolean;
}
/** Props for {@link ConnectionManagerView}. */
export interface IConnectionManagerViewProps<T extends {
    id: string;
}> {
    /** Page title, e.g. "Model Server Connections". */
    title: string;
    /** One-line subtitle beneath the title. */
    subtitle: string;
    /** Empty-state heading. Defaults to "No connections yet". */
    emptyTitle?: string;
    /** Empty-state supporting line. */
    emptyDescription: string;
    /** The saved connections to list. */
    connections: T[];
    /** Derive a card's display props from a connection. */
    card: (conn: T) => IConnectionCardDisplay;
    /** The add/edit form fields (rendered in order). */
    fields: IConnectionFormField[];
    /** Seed values for a new (add) form, keyed by field key. */
    newValues: Record<string, string>;
    /** Extract an existing connection's field values for the edit form. */
    editValues: (conn: T) => Record<string, string>;
    /** Persist a new connection from the (raw) field values; may open it. */
    onCreate: (values: Record<string, string>) => void;
    /** Persist edits to an existing connection from the (raw) field values. */
    onUpdate: (conn: T, values: Record<string, string>) => void;
    /** Open a saved connection (app-specific — tab, doc, session, …). */
    onOpen: (conn: T) => void;
    /** Delete a saved connection (the app owns any confirmation prompt). */
    onDelete: (conn: T) => void;
    /** Icon renderer for cards (30px) and the empty state (40px). Defaults to BxDesktop. */
    icon?: (size: number) => React$1.ReactNode;
}
/**
 * Renders the shared connections landing page (Archetype C).
 *
 * @param props - {@link IConnectionManagerViewProps}.
 * @returns The connections landing element.
 */
export declare function ConnectionManagerView<T extends {
    id: string;
}>({ title, subtitle, emptyTitle, emptyDescription, connections, card, fields, newValues, editValues, onCreate, onUpdate, onOpen, onDelete, icon, }: IConnectionManagerViewProps<T>): React$1.ReactElement;
/**
 * Debounce a value: the returned value updates only after `delayMs` of
 * silence following the last change.
 *
 * @typeParam T - Value type.
 * @param value - The rapidly-changing source value.
 * @param delayMs - Trailing debounce window in milliseconds.
 * @returns The debounced value.
 */
export declare function useDebouncedValue<T>(value: T, delayMs: number): T;
/** Raw announcement entry from the remote JSON. */
export interface Announcement {
    /** Stable identifier for deduplication. */
    id: string;
    /** Short headline (supports inline markdown). */
    title: string;
    /** Longer description (supports inline markdown). */
    body: string;
    /** Visual priority: info (blue), warning (yellow), urgent (red). */
    priority: "info" | "warning" | "urgent";
    /** ISO-8601 UTC — announcement is hidden before this time. */
    valid_from?: string;
    /** ISO-8601 UTC — announcement is hidden after this time. */
    valid_until?: string;
    /** Optional URL rendered as a "Learn more" link. */
    link?: string;
    /** Whether the user can dismiss this announcement. Default true. */
    dismissable?: boolean;
}
/**
 * useAnnouncements — returns the current list of active announcements.
 * Fetches on mount (if cache is stale) and re-fetches every hour.
 */
export declare function useAnnouncements(): Announcement[];
/**
 * Shared value formatters — human-readable byte sizes, dates, and durations.
 *
 * Consolidated for reuse across apps (ported from the per-app formatter copies).
 * Pure functions with no dependencies; safe to import anywhere in shared.
 */
/**
 * Formats a byte count as a human-readable size with a unit suffix.
 *
 * @param bytes - The size in bytes.
 * @returns A short size string, e.g. `formatBytes(512)` → `"512 B"`,
 *   `formatBytes(2048)` → `"2.0 KB"`, `formatBytes(5_242_880)` → `"5.0 MB"`.
 */
export declare function formatBytes(bytes: number): string;
/**
 * Formats an ISO date string as a short localised "month day, time" label.
 *
 * @param iso - An ISO-8601 date string.
 * @returns A short date/time string, e.g. `formatDate('2026-07-07T14:30:00Z')`
 *   → `"Jul 7, 02:30 PM"` (exact form depends on the runtime locale).
 */
export declare function formatDate(iso: string): string;
/**
 * Formats a millisecond duration as a compact human-readable string.
 *
 * @param ms - The duration in milliseconds.
 * @returns A short duration string, e.g. `formatDuration(750)` → `"750ms"`,
 *   `formatDuration(1500)` → `"1.5s"`, `formatDuration(90000)` → `"1m 30s"`.
 */
export declare function formatDuration(ms: number): string;
/**
 * Complete set of --rr-* CSS custom property keys used across all
 * RocketRide components. Every theme JSON file must define all of these.
 */
export type ThemeTokens = {
    "--rr-brand": string;
    "--rr-palette-mode": string;
    "--rr-bg-default": string;
    "--rr-bg-paper": string;
    "--rr-bg-surface": string;
    "--rr-bg-surface-alt": string;
    "--rr-fg-titleBar-active": string;
    "--rr-fg-titleBar-inactive": string;
    "--rr-bg-titleBar-active": string;
    "--rr-bg-titleBar-inactive": string;
    "--rr-bg-widget": string;
    "--rr-fg-widget": string;
    "--rr-bg-widget-header": string;
    "--rr-bg-widget-hover": string;
    "--rr-bg-toolbar-hover": string;
    "--rr-shadow-widget": string;
    "--rr-font-family-widget": string;
    "--rr-font-size-widget": string;
    "--rr-text-primary": string;
    "--rr-text-secondary": string;
    "--rr-text-disabled": string;
    "--rr-text-link": string;
    "--rr-text-caption": string;
    "--rr-color-secondary": string;
    "--rr-color-error": string;
    "--rr-color-error-light": string;
    "--rr-color-warning": string;
    "--rr-color-info": string;
    "--rr-color-success": string;
    "--rr-border": string;
    "--rr-border-hover": string;
    "--rr-sash-hover": string;
    "--rr-border-focus": string;
    "--rr-border-input": string;
    "--rr-border-paper": string;
    "--rr-accent": string;
    "--rr-accent-faded": string;
    "--rr-bg-button": string;
    "--rr-fg-button": string;
    "--rr-btn-sm-height": string;
    "--rr-btn-sm-padding": string;
    "--rr-btn-sm-font-size": string;
    "--rr-btn-sm-radius": string;
    "--rr-bg-input": string;
    "--rr-bg-list-hover": string;
    "--rr-bg-list-active": string;
    "--rr-fg-list-active": string;
    "--rr-bg-scrollbar-thumb": string;
    "--rr-shadow-idle": string;
    "--rr-shadow-hover": string;
    "--rr-shadow-selected": string;
    "--rr-grey-200": string;
    "--rr-grey-400": string;
    "--rr-grey-500": string;
    "--rr-icon-color": string;
    "--rr-font-family": string;
    "--rr-font-size": string;
    "--rr-font-size-sm": string;
    "--rr-font-size-xs": string;
    "--rr-font-size-h1": string;
    "--rr-font-size-h2": string;
    "--rr-font-size-h3": string;
    "--rr-font-size-h4": string;
    "--rr-font-size-h5": string;
    "--rr-font-size-body": string;
    "--rr-font-size-button": string;
    "--rr-font-size-caption": string;
    "--rr-font-size-subtitle": string;
    "--rr-font-weight-h5": string;
    "--rr-font-weight-button": string;
    "--rr-annotation-bg-default": string;
    "--rr-chart-blue": string;
    "--rr-chart-green": string;
    "--rr-chart-yellow": string;
    "--rr-chart-purple": string;
    "--rr-chart-orange": string;
    "--rr-chart-red": string;
    [key: string]: string;
};
/**
 * Apply a theme by setting all --rr-* CSS custom properties on :root.
 * Works in any document context (main app, iframe, webview).
 */
export declare function applyTheme(tokens: ThemeTokens): void;
/**
 * VSCode integration utilities
 */
/**
 * Checks if the code is running within a VSCode webview environment.
 * This is detected by checking for VSCode-specific CSS variables.
 *
 * @returns {boolean} True if running in VSCode, false otherwise
 */
export declare const isInVSCode: () => boolean;
/**
 * OAuth configuration for the shared social-login buttons.
 *
 * User-OAuth (Google/Microsoft/Slack) is brokered by a RocketRide-hosted
 * function — NOT by the local engine. Self-hosters never register their own
 * Google OAuth app or client secret; a single hosted broker owns the verified
 * consent screen, the client secret, and the token-refresh proxy. See the
 * social-button widgets and `useOAuthCallbacks` for the consuming flow.
 *
 * The value is inlined at build time from `REACT_APP_OAUTH_ROOT_URL`: every
 * bundler that consumes shared `define`s it to a string literal (see
 * `rslib.config.ts` and `apps/vscode/rsbuild.config.mjs`), so no `process`
 * reference survives into the webview bundle. An empty/unset value falls back
 * to the production broker URL.
 */
export declare const OAUTH_ROOT_URL: string;
/**
 * Generic form data record type for dynamic form submissions.
 * Intentionally uses `any` to accommodate the wide variety of field types
 * produced by RJSF forms.
 */
export type IFormData = Record<string, any>;
/**
 * A dictionary of dynamic form definitions keyed by service/connector name.
 * This is the shape returned by the services API and consumed by the canvas
 * to build the node inventory.
 */
export interface IForm {
    [key: string]: IService;
}
/** Position on the canvas in pixel coordinates. */
export interface IPosition {
    x: number;
    y: number;
}
/** Measured dimensions of a rendered element. */
export interface IDimensions {
    width: number;
    height: number;
}
/**
 * User-configured form data for a pipeline component.
 * Contains key/value pairs from the RJSF configuration form.
 */
export type INodeConfig = Record<string, any>;
/**
 * Bitmask capabilities supported by a service driver.
 * Each flag indicates a specific feature the driver supports.
 */
export declare enum IServiceCapabilities {
    Security = 1,
    Filesystem = 2,
    Substream = 4,
    Network = 8,
    Datanet = 16,
    Sync = 32,
    Internal = 64,
    Catalog = 128,
    NoMonitor = 256,
    NoInclude = 512,
    Invoke = 1024,
    Remoting = 2048,
    Gpu = 4096,
    NoSaas = 8192,
    Focus = 16384,
    Deprecated = 32768,
    Experimental = 65536
}
/**
 * Pairs a JSON Schema with its corresponding RJSF UI schema for a single
 * form section (e.g. Pipe, Source, Target).
 *
 * The schema defines the data shape and validation rules. The ui schema
 * controls which widgets render each field and how they are laid out.
 */
export interface IServiceSchema {
    /** JSON Schema defining the data shape and validation rules. */
    schema: Record<string, any>;
    /** RJSF UI schema controlling widget rendering and layout. */
    ui: Record<string, any>;
}
interface IInvokeChannel {
    /** Human-readable description of what this channel provides. */
    description?: string;
    /** Minimum number of connections required (0 = optional). */
    min?: number;
    /** Maximum number of connections allowed (undefined = unlimited). */
    max?: number;
}
/**
 * A lane entry in the service definition — either a plain string
 * (lane name) or a structured object with metadata.
 */
export type IServiceLaneEntry = string | {
    type: string;
    description?: string;
    min?: number;
    max?: number;
};
/**
 * Service definition from the driver catalog (services.json).
 *
 * Describes a single pipeline service driver's metadata, configuration
 * schemas, capabilities, lane definitions, and invoke configuration.
 * This is the compiled form received by the UI — the engine resolves
 * `fields`, `shape`, and `preconfig` into `Pipe`/`Source`/`Target` schemas.
 */
export interface IService {
    /** Human-readable display title (e.g. "OpenAI", "PostgreSQL"). */
    title?: string;
    /** Tile display template strings shown on the node body (e.g. "Model: ${parameters.llm_openai.profile}"). */
    tile?: string[];
    /** Icon filename or URL for the node header (e.g. "openai.svg"). */
    icon?: string;
    /** Bitmask of actions this service supports. */
    actions?: number;
    /** Bitmask of capabilities (see {@link IServiceCapabilities}). */
    capabilities?: IServiceCapabilities;
    /** Class type tags determining which invoke channels accept this node (e.g. ["llm"], ["database", "tool"]). */
    classType?: string[];
    /**
     * Lane definitions: maps input lane keys to arrays of output lane entries.
     * Keys prefixed with `_` are hidden internal lanes.
     *
     * @example
     * ```json
     * { "questions": ["answers"], "_source": ["questions"] }
     * ```
     */
    lanes?: Record<string, IServiceLaneEntry[]>;
    /** Execution plan identifiers. */
    plans?: string[];
    /** Pipe configuration schema (compiled from fields/shape/preconfig by the engine). */
    Pipe?: IServiceSchema;
    /** Source configuration schema. */
    Source?: IServiceSchema;
    /**
     * Invoke configuration: maps channel names to their connection requirements.
     *
     * @example
     * ```json
     * { "llm": { "min": 1, "max": 1 }, "tool": { "min": 0 } }
     * ```
     */
    invoke?: Record<string, IInvokeChannel>;
    /** Control-flow configuration. */
    control?: Record<string, unknown>;
    /** HTML description for tooltips. */
    description?: string;
    /** URL to external documentation. */
    documentation?: string;
    /** Service type identifier. */
    type?: string;
    /** Display content string. */
    content?: string;
    /** Whether this service should receive focus in the catalog. */
    focus?: boolean;
}
/** Dictionary of service definitions keyed by provider name. */
export interface IServiceCatalog {
    [key: string]: IService;
}
/**
 * Visual and layout properties for a component on the canvas.
 * Stored under `component.ui` in the serialised project file.
 */
export interface IComponentUI {
    [key: string]: unknown;
    position: IPosition;
    measured: IDimensions;
    nodeType: string;
    formDataValid?: boolean;
    parentId?: string;
}
/**
 * Serialised representation of a single pipeline component (node).
 * Extends the SDK's PipelineComponent with a strongly-typed `ui` object
 * and invoke (control-flow) connections.
 */
export interface IProjectComponent extends Omit<PipelineComponent, "ui"> {
    ui: IComponentUI;
}
/**
 * Top-level project entity persisted to the .pipe file.
 * Extends the SDK's PipelineConfig.
 */
export interface IProject extends PipelineConfig {
}
/**
 * Response from the backend pipeline validation endpoint.
 */
export interface IValidateResponse {
    status: string;
    error?: {
        code?: number;
        message?: string;
    };
    data: {
        errors?: {
            code: number;
            message: string;
        }[];
        warnings?: {
            code: number;
            message: string;
        }[];
        component: IProjectComponent;
        pipeline: IProject;
    };
}
/**
 * Single-component validation payload. The node config panel validates one
 * component at a time on save; the validation endpoint accepts this shape
 * alongside a full pipeline.
 */
export interface IComponentValidatePayload {
    /** Pipeline schema version (PIPELINE_SCHEMA_VERSION). */
    version: number;
    /** The single component to validate. */
    component: IProjectComponent;
}
/**
 * Payload union accepted by the host's validate callback
 * (`handleValidatePipeline`): a full pipeline or a single component.
 */
export type IValidatePipelinePayload = IProject | IComponentValidatePayload;
/**
 * Shape of the JSON file produced by the export-toolchain feature.
 */
export interface IToolchainExport {
    components: IProjectComponent[];
    id: string;
    servicesVersion?: number;
    appVersion?: string;
    engineVersion?: string;
}
/**
 * Transient UI state flags for the pipeline editor.
 */
export interface IToolchainState {
    isSaving: boolean;
    isSaved: boolean;
    isPending: boolean;
    isRunning: boolean;
    isUpdated: boolean;
    isDevMode: boolean;
    isDragging: boolean;
}
export declare const DEFAULT_TOOLCHAIN_STATE: IToolchainState;
interface IOverviewGridProps {
    /** Full dashboard snapshot, or null while it has not loaded yet. */
    data: DashboardResponse | null;
    /** Optional manual refresh callback — renders the header's Refresh action. */
    onRefresh?: () => void;
}
/**
 * Overview grid — the unified Connections & Tasks CardDataGrid: connections
 * first, then running tasks, then the five most recent completed ones, with
 * CPU/Memory gauges and status badges. Clicking a client row opens the
 * connection record panel; clicking a task row opens the task record panel.
 *
 * @param props - {@link IOverviewGridProps}.
 * @returns The card-hosted grid plus both record panels.
 */
export declare const OverviewGrid: React$1.FC<IOverviewGridProps>;
interface IConnectionsPanelProps {
    /**
     * Snapshot connection rows (the dashboard snapshot). LOCAL mode renders
     * exactly these; with `listConnections` present the fetched pages take
     * over and this prop is unused.
     */
    connections?: DashboardConnection[];
    /**
     * Optional server-paginated fetcher — presence switches the grid to
     * REMOTE mode. Hosts bind it to their client's `listConnections`.
     */
    listConnections?: (req: ListPageRequest) => Promise<ListPageResponse<DashboardConnection>>;
    /**
     * Receives the grid's silent current-page refetch trigger (REMOTE mode
     * only) so the HOST owns the polling cadence.
     */
    onRefetchReady?: (refetch: () => void) => void;
}
/**
 * Connections grid — every active client connection as a CardDataGrid with
 * identity, client label, traffic counters, subscription counts, and auth
 * status; clicking a row opens the connection record panel.
 *
 * @param props - {@link IConnectionsPanelProps}.
 * @returns The card-hosted grid plus its record panel.
 */
export declare const ConnectionsPanel: React$1.FC<IConnectionsPanelProps>;
interface ITasksPanelProps {
    /**
     * Snapshot task rows (the dashboard snapshot): feeds the header's
     * running/completed counts in both modes, and the grid rows plus record
     * panel in LOCAL mode. Null while the snapshot has not loaded yet (the
     * header counts stay hidden).
     */
    tasks?: DashboardTask[] | null;
    /**
     * Optional server-paginated fetcher — presence switches the grid to
     * REMOTE mode. Hosts bind it to their client's `listTasks`.
     */
    listTasks?: (req: ListPageRequest) => Promise<ListPageResponse<DashboardTask>>;
    /**
     * Receives the grid's silent current-page refetch trigger (REMOTE mode
     * only) so the HOST owns the polling cadence.
     */
    onRefetchReady?: (refetch: () => void) => void;
}
/**
 * Tasks grid — all pipeline tasks as a CardDataGrid with CPU/Memory gauges,
 * elapsed time, completion counts, TTL/idle time, and status badges;
 * clicking a row opens the task record panel.
 *
 * @param props - {@link ITasksPanelProps}.
 * @returns The card-hosted grid plus its record panel.
 */
export declare const TasksPanel: React$1.FC<ITasksPanelProps>;
/** Semantic tone of an event, keyed off what happened (not who reported it). */
export type EventTone = "connection" | "task" | "warning" | "system";
interface IEventDisplay {
    /** Semantic tone (drives the badge / feed color). */
    tone: EventTone;
    /** Short category label (connect, disconnect, task, security, system). */
    label: string;
    /** Human-readable one-line summary. */
    message: string;
    /** Epoch-milliseconds arrival time of the event at this client. */
    timestamp: number;
}
interface IActivityPanelProps {
    /** Accumulated activity events (newest first, as delivered by the host). */
    events: ActivityEvent[];
}
/**
 * Describe one activity event from either channel (task / dashboard) as its
 * display fields. Exported for the Overview surfaces' Recent Activity feeds,
 * which render the same events in card form.
 *
 * @param event - The wrapped activity event.
 * @returns Tone, label, message, and the arrival timestamp (epoch ms).
 */
export declare function getEventDisplay(event: ActivityEvent): IEventDisplay;
/**
 * Activity grid — live stream of server events (connections, task lifecycle,
 * errors) as a CardDataGrid fed by the host's event feed (LOCAL mode: each
 * poll / push hands down a new events array, applied silently).
 *
 * @param props - {@link IActivityPanelProps}.
 * @returns The card-hosted grid.
 */
export declare const ActivityPanel: React$1.FC<IActivityPanelProps>;
/**
 * Formatting utilities for the Server Monitor module.
 */
/** Format seconds into a human-readable duration string (e.g. "4d 7h 23m"). */
export declare function formatUptime(seconds: number): string;
/** Format a Unix timestamp into a short time string (HH:MM:SS). */
export declare function formatTime(timestamp: number): string;
/**
 * Format a Unix timestamp as a short day-aware stamp: "Today at 4:55 PM"
 * for the current local day, "6/28/2026 at 1:30 PM" otherwise (browser
 * locale, like every other time in the product).
 *
 * @param timestamp - Unix seconds.
 * @returns The day-aware stamp.
 */
export declare function formatDayTime(timestamp: number): string;
/** Format a Unix timestamp as a relative "X ago" string. */
export declare function formatTimeAgo(timestamp: number): string;
/** Format a number with locale-appropriate thousands separators. */
export declare function formatNumber(n: number): string;
interface ActiveTask {
    /** Task identifier. */
    taskId: string;
    /** Pipeline or source name. */
    name: string;
    /** Current cumulative token total. */
    tokensTotal: number;
    /** Task state string. */
    state: string;
    /** Duration in seconds. */
    durationSeconds: number;
}
interface IAccountViewProps {
    /** Whether the shell client is connected to the server. */
    isConnected: boolean;
    /** Error message from the last failed data load for the active section, or null. */
    sectionError?: string | null;
    /** The live/editable profile data from the server, or null while loading. */
    profile: ConnectResult | null;
    /** Cached identity from the auth provider, used as display fallback. */
    authUser: ConnectResult | null;
    /** List of API key records owned by the current user. */
    keys: ApiKeyRecord[];
    /** Organization detail for the current user's org, or null while loading. */
    org: OrgDetail | null;
    /** Flat list of all organization members. */
    members: MemberRecord[];
    /** Flat list of all teams in the organization. */
    teams: TeamRecord[];
    /** Full detail for the currently selected team, or null. */
    teamDetail: TeamDetail | null;
    /** Per-app subscription rows for the billing panel. */
    subscriptions: BillingDetail[];
    /** True while billing data is being fetched. */
    billingLoading: boolean;
    /** Error message from the last billing operation, or null. */
    billingError: string | null;
    /** Current org credit balance, or null while loading. */
    creditBalance: CreditBalance | null;
    /** App manifest entries for resolving display names, icons, etc. from appId. */
    apps?: Array<{
        id: string;
        name: string;
        icon?: string;
        description?: string;
    }>;
    /** Cancel a subscription. Host re-fetches and updates subscriptions prop. */
    onCancelSubscription: (appId: string) => Promise<void>;
    /** Open the Stripe customer portal for payment management. */
    onOpenPortal: () => Promise<void>;
    /** Called when the user clicks the Subscribe CTA. Opens the checkout flow. */
    onSubscribe?: () => void;
    /** Paginated transaction result for the transaction log. */
    transactions?: TransactionsResult | null;
    /** Per-user usage rollup. */
    usageByUser?: UsageRollup[];
    /** Per-team usage rollup. */
    usageByTeam?: UsageRollup[];
    /** Currently running tasks with live token data. */
    activeTasks?: ActiveTask[];
    /** Whether dashboard data is still loading. */
    dashboardLoading?: boolean;
    /** Callback to change the transaction page. */
    onTransactionPage?: (page: number) => void;
    /** Direct ledger query for the transaction log (preferred; see BillingDashboardProps). */
    fetchTransactions?: (req: IDataGridPageRequest) => Promise<TransactionsResult | null>;
    /** Org-scoped distinct ledger values for the enum checklist filters. */
    fetchTransactionDistinct?: (field: string) => Promise<(string | number | boolean)[]>;
    /** Available top-up packs (filtered from plans by kind='topup'). */
    topupPlans?: any[];
    /** Callback when user clicks a top-up pack. */
    onBuyTopup?: (plan: any) => void;
    /** All plans from app_prices (for the TopUpModal). */
    allPlans?: any[];
    /** Called to purchase a top-up pack (charges card on file). */
    onPurchaseTopup?: (plan: any) => Promise<{
        status: string;
        clientSecret?: string;
    }>;
    /** Called when the user confirms a plan upgrade/downgrade from the billing panel. */
    onUpgradeSubscription?: (appId: string, newPriceId: string) => Promise<void>;
    /** The currently active section / tab. */
    section: AccountSection;
    /** Called when the user switches tabs. */
    onSectionChange: (section: AccountSection) => void;
    /** ID of the team currently being drilled into, or null for list view. */
    activeTeamId: string | null;
    /** Called when the user drills into / backs out of a team. */
    onActiveTeamIdChange: (id: string | null) => void;
    /** Persists updated profile fields. */
    onSaveProfile: (fields: ProfileUpdate) => Promise<void>;
    /** Sets the user's preferred default team. */
    onSetDefaultTeam: (teamId: string) => Promise<void>;
    /** Switches the user's active organization. */
    onSetDefaultOrg: (orgId: string) => Promise<void>;
    /**
     * @deprecated Unused — the shell owns the logout flow (`shell:logoutRequest`);
     * no panel in this view renders a sign-out control. Kept optional so existing
     * hosts still compile; will be removed once every caller stops passing it.
     */
    onLogout?: () => void;
    /**
     * @deprecated Unused — account deletion has no entry point in this view.
     * Kept optional so existing hosts still compile; will be removed once every
     * caller stops passing it.
     */
    onDeleteAccount?: () => Promise<void>;
    /** Persists an updated organization name. */
    onSaveOrgName: (name: string) => Promise<void>;
    /** Creates a new API key and returns the raw key string. */
    onCreateKey: (params: {
        name: string;
        permissions: string[];
        expiresAt?: string;
        teamId?: string;
    }) => Promise<{
        key: string;
    }>;
    /** Revokes an API key by its ID. */
    onRevokeKey: (keyId: string) => Promise<void>;
    /** Sends an invitation to a new organization member. */
    onInviteMember: (params: {
        email: string;
        givenName: string;
        familyName: string;
        role: string;
        teamAssignments?: Array<{
            teamId: string;
            permissions: string[];
        }>;
    }) => Promise<void>;
    /** Updates an organization member's role. */
    onUpdateMemberRole: (userId: string, role: string) => Promise<void>;
    /** Removes an organization member. */
    onRemoveMember: (userId: string) => Promise<void>;
    /** Resends the initialization email for a pending member. */
    onResendInvite: (userId: string) => Promise<void>;
    /** Creates a new team. */
    onCreateTeam: (name: string) => Promise<void>;
    /** Deletes a team. */
    onDeleteTeam: (teamId: string) => Promise<void>;
    /** Adds a member to a team with specified permissions. */
    onAddTeamMember: (params: {
        teamId: string;
        userId: string;
        permissions: string[];
    }) => Promise<void>;
    /** Updates a team member's permissions. */
    onEditTeamMemberPerms: (params: {
        teamId: string;
        userId: string;
        permissions: string[];
    }) => Promise<void>;
    /** Removes a member from a team. */
    onRemoveTeamMember: (params: {
        teamId: string;
        userId: string;
    }) => Promise<void>;
    /** Requests the host to load full detail for a specific team. */
    onLoadTeamDetail: (teamId: string) => void;
}
/**
 * AccountView is the pure, host-agnostic root component for account management.
 *
 * It renders five tab panels (Profile, API Keys, Organization, Teams, Members)
 * and owns all modal/form UI state internally. Server operations are delegated
 * to the host via async callback props defined in IAccountViewProps.
 */
export declare const AccountView: React$1.FC<IAccountViewProps>;
/** Possible environment scope levels. */
export type EnvironmentScope = "org" | "team" | "user";
/** Connection state and permissions for a single connection slot. */
export interface EnvironmentSlotConfig {
    /** Slot identifier (e.g. 'development', 'deployment', 'default'). */
    id: string;
    /** Display label for the tab (e.g. "Development", "Deployment"). */
    label: string;
    /** Whether this slot's server is connected. */
    isConnected: boolean;
    /** Whether the server is SaaS (true) or OSS (false). */
    isSaas: boolean;
    /** Whether the current user is an org admin on this slot. */
    isOrgAdmin: boolean;
    /** Whether the current user is a team admin on this slot. */
    isTeamAdmin: boolean;
    /** Organization ID (SaaS only). */
    orgId?: string;
    /** Team ID (SaaS only). */
    teamId?: string;
}
interface EnvironmentViewProps {
    /** Connection slots to display. Single slot = no tabs, multiple = tab panel. */
    slots: EnvironmentSlotConfig[];
    /**
     * Loaded env dicts keyed by `slotId:scope:scopeId`.
     * A key with `undefined` means loading; missing key means not yet requested.
     */
    envs: Record<string, Record<string, string> | undefined>;
    /** Requests the host to load env data for a scope. */
    onLoadEnv: (slotId: string, scope: EnvironmentScope, scopeId?: string) => void;
    /** Saves env data for a scope. */
    onSaveEnv: (slotId: string, scope: EnvironmentScope, env: Record<string, string>, scopeId?: string) => Promise<void>;
    /** Keys that must have non-empty values before save is allowed (user scope only). */
    requiredKeys?: string[];
    /** Page-level error message. */
    error?: string | null;
}
/**
 * EnvironmentView — host-agnostic environment variable management page.
 *
 * Renders env scope cards for one or more connection slots. When there
 * is a single slot, cards render directly. When there are multiple
 * slots, a TabControl strip switches between them.
 *
 * @param props - Environment view configuration and callbacks.
 */
export declare const EnvironmentView: React$1.FC<EnvironmentViewProps>;
/**
 * Two-step checkout modal: PlanPicker (step 1) then Stripe Elements (step 2).
 *
 * All server communication is via callback props — no SDK imports.
 */
export declare const CheckoutModal: React$1.FC<CheckoutModalProps>;
interface PlanPickerProps {
    /** Plans to display. Plans with ``metadata.action`` render as non-selectable CTA cards. */
    plans: CheckoutPlan[];
    /** True while plans are loading -- shows a placeholder. */
    loading?: boolean;
    /** Currently selected checkout-able plan (controlled). */
    selectedPlan?: CheckoutPlan | null;
    /** Called when the user selects a billable plan. Not called for action plans. */
    onSelectPlan?: (plan: CheckoutPlan) => void;
    /** Called when the user clicks an action plan's CTA. Defaults to opening the link/mailto natively. */
    onActionClick?: (plan: CheckoutPlan, action: PlanAction) => void;
    /**
     * When provided, each billable plan card renders a primary CTA button
     * (labelled by ``ctaLabel``) that calls this with the plan. The caller
     * owns what the click does (e.g. start checkout, or prompt sign-up first).
     * When omitted, billable cards have no CTA button — selection is via the
     * card click / ``onSelectPlan`` (the CheckoutModal flow).
     */
    onPlanCta?: (plan: CheckoutPlan) => void;
    /** Label for the per-card billable CTA. Default: ``'Get started'``. Only used with ``onPlanCta``. */
    ctaLabel?: string;
    /**
     * Optional per-plan CTA overrides, keyed by ``stripePriceId``. Lets a host
     * app render context-aware labels (e.g. "Selected", "Upgrade", "Switch
     * plan") and disable a card's CTA — without baking any subscription logic
     * into shared (this component ships in the VS Code extension too). A plan
     * with no entry falls back to ``ctaLabel``. Only used with ``onPlanCta``.
     */
    ctaConfig?: Record<string, {
        label?: string;
        disabled?: boolean;
    }>;
    /**
     * Stripe price ID of the user's current plan, in card-selection mode
     * (``onSelectPlan``). The matching card shows a "Current" badge and is made
     * non-selectable. The host owns what "current" means — no subscription logic
     * lives here. Used by the upgrade flow.
     */
    currentPriceId?: string;
    /** Content rendered below the plan cards (e.g. a "Continue" button). */
    footer?: React$1.ReactNode;
    /** Default interval on first render. Default: ``'month'``. */
    defaultInterval?: "month" | "year";
    /**
     * When true, ensures a billable plan is always selected: on mount (and
     * whenever the visible plans change) the lowest-order billable plan at the
     * current interval is selected if the current selection is absent or not
     * visible. Requires ``onSelectPlan``. Default: ``false`` (caller-controlled
     * selection, e.g. the upgrade/top-up modals).
     */
    autoSelectDefault?: boolean;
}
/**
 * Shared plan card grid with interval toggle.
 *
 * Renders plans as side-by-side cards. Manages the Monthly/Annual toggle
 * internally. Action plans (Free, Enterprise) always show; billable plans
 * are filtered by the selected interval.
 */
export declare const PlanPicker: React$1.FC<PlanPickerProps>;
interface UpgradeModalProps {
    /** All plans from app_prices for the subscribed app. */
    plans: CheckoutPlan[];
    /** Stripe price_* ID of the user's current subscription plan. */
    currentPriceId: string;
    /** Human-readable name of the current plan (e.g. "Pro Monthly"). */
    currentPlanName: string | null;
    /**
     * Optional Stripe price_* to preselect on open (e.g. the plan a user clicked
     * on the pricing page), so they land on the proration summary ready to
     * confirm. Ignored if it equals the current plan. Defaults to no selection.
     */
    preselectedPriceId?: string;
    /** Called when the user confirms the plan change. */
    onUpgrade: (newPriceId: string) => Promise<void>;
    /** Called when the modal is dismissed. */
    onClose: () => void;
}
/**
 * Modal dialog for upgrading or downgrading a subscription plan.
 *
 * Displays the PlanPicker grid with the current plan disabled. The user
 * selects a new plan and clicks Confirm to trigger the server-side
 * Stripe subscription modification with proration.
 */
export declare const UpgradeModal: React$1.FC<UpgradeModalProps>;
/**
 * The curated set of value symbols shell exposes to remote apps.
 *
 * Per the design-owner decision this covers shell's ENTIRE value export
 * surface. The object is frozen at build time so its type — `ShellApiShape` —
 * becomes the versioned contract enforced against shell's own compilation.
 */
export declare const shellApi: {
    readonly Button: typeof Button;
    readonly StatusBadge: typeof StatusBadge;
    readonly StatusDot: typeof StatusDot;
    readonly EmptyState: typeof EmptyState;
    readonly Banner: typeof Banner;
    readonly InputField: typeof InputField;
    readonly ToggleGroup: typeof ToggleGroup;
    readonly Chip: typeof Chip;
    readonly ChipAdd: typeof ChipAdd;
    readonly DropZone: typeof DropZone;
    readonly Card: typeof Card;
    readonly MiniCard: typeof MiniCard;
    readonly MiniContainer: typeof MiniContainer;
    readonly Section: typeof Section;
    readonly LabelValue: typeof LabelValue;
    readonly ContentHeader: typeof ContentHeader;
    readonly RocketRideMark: typeof RocketRideMark;
    readonly DetailPanel: typeof DetailPanel;
    readonly PanelTabBody: typeof PanelTabBody;
    readonly TabControl: typeof TabControl;
    readonly TabPanel: typeof TabPanel;
    readonly Modal: typeof Modal;
    readonly CLOSE_GLYPH: string;
    readonly SaveFileDialog: typeof SaveFileDialog;
    readonly SidebarMenu: typeof SidebarMenu;
    readonly SidebarCollapsedProvider: import("react").FC<ISidebarCollapsedProviderProps>;
    readonly SidebarCollapsedGate: import("react").FC<ISidebarCollapsedGateProps>;
    readonly useSidebarCollapsed: typeof useSidebarCollapsed;
    readonly SidebarFooter: import("react").FC<SidebarFooterProps>;
    readonly DataGrid: <Row extends Record<string, unknown>>(props: IDataGridProps<Row> & {
        ref?: import("react").Ref<IDataGridHandle>;
    }) => import("react").ReactElement;
    readonly CardDataGrid: <Row extends Record<string, unknown>>(props: ICardDataGridProps<Row> & {
        ref?: import("react").Ref<IDataGridHandle>;
    }) => import("react").ReactElement;
    readonly FilterStrip: import("react").FC<IFilterStripProps>;
    readonly createActionsColumn: typeof createActionsColumn;
    readonly autoFormatter: typeof autoFormatter;
    readonly badgeEl: typeof badgeEl;
    readonly buttonEl: typeof buttonEl;
    readonly avatarEl: typeof avatarEl;
    readonly monoEl: typeof monoEl;
    readonly mutedEl: typeof mutedEl;
    readonly matchesSearch: typeof matchesSearch;
    readonly createMessageGridPersistence: typeof createMessageGridPersistence;
    readonly GRID_CONFIG_GET: string;
    readonly GRID_CONFIG_SET: string;
    readonly GRID_CONFIG_CLEAR: string;
    readonly useDebouncedValue: typeof useDebouncedValue;
    readonly useAnnouncements: typeof useAnnouncements;
    readonly formatBytes: typeof formatBytes;
    readonly formatDate: typeof formatDate;
    readonly formatDuration: typeof formatDuration;
    readonly commonStyles: {
        card: import("react").CSSProperties;
        cardHeader: import("react").CSSProperties;
        cardBody: import("react").CSSProperties;
        cardFlat: import("react").CSSProperties;
        section: import("react").CSSProperties;
        sectionHeader: import("react").CSSProperties;
        sectionHeaderLabel: import("react").CSSProperties;
        buttonPrimary: import("react").CSSProperties;
        buttonDanger: import("react").CSSProperties;
        buttonDangerOutline: import("react").CSSProperties;
        buttonSecondary: import("react").CSSProperties;
        buttonSmall: import("react").CSSProperties;
        buttonPrimarySmall: import("react").CSSProperties;
        buttonSecondarySmall: import("react").CSSProperties;
        buttonDangerSmall: import("react").CSSProperties;
        buttonDisabled: import("react").CSSProperties;
        cardHeaderButton: import("react").CSSProperties;
        cardBodyButton: import("react").CSSProperties;
        toggleButton: (active: boolean) => import("react").CSSProperties;
        toggleGroup: import("react").CSSProperties;
        splitHeader: import("react").CSSProperties;
        tabContent: import("react").CSSProperties;
        viewPadding: import("react").CSSProperties;
        columnFill: import("react").CSSProperties;
        headerBar: import("react").CSSProperties;
        divider: import("react").CSSProperties;
        empty: import("react").CSSProperties;
        textMuted: import("react").CSSProperties;
        textEllipsis: import("react").CSSProperties;
        fontMono: import("react").CSSProperties;
        labelUppercase: import("react").CSSProperties;
        overlay: import("react").CSSProperties;
        modalOverlay: import("react").CSSProperties;
        dialog: import("react").CSSProperties;
        modalDialog: import("react").CSSProperties;
        modalHeader: import("react").CSSProperties;
        modalBody: import("react").CSSProperties;
        modalFooter: import("react").CSSProperties;
        popupMenu: import("react").CSSProperties;
        menuRow: import("react").CSSProperties;
        inputField: import("react").CSSProperties;
        listRow: (active: boolean) => import("react").CSSProperties;
        emptyState: import("react").CSSProperties;
        iconBox: import("react").CSSProperties;
        badge: import("react").CSSProperties;
        tableHeader: import("react").CSSProperties;
        tableCell: import("react").CSSProperties;
        indicatorBase: import("react").CSSProperties;
        indicatorSuccess: import("react").CSSProperties;
        indicatorInfo: import("react").CSSProperties;
        indicatorWarning: import("react").CSSProperties;
        indicatorError: import("react").CSSProperties;
        indicatorMuted: import("react").CSSProperties;
    };
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
    readonly NOOP_VFS: IVirtualFileSystem;
    readonly Explorer: import("react").FC<IExplorerProps>;
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
    readonly ConfirmDialog: typeof ConfirmDialog;
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
    readonly AppLayout: import("react").FC<AppLayoutProps>;
    readonly BxPlusSquare: IconComponent;
    readonly BxPlusSquareSolid: IconComponent;
    readonly BxLock: IconComponent;
    readonly BxShow: IconComponent;
    readonly BxHide: IconComponent;
    readonly BxFullscreen: IconComponent;
    readonly BxBrush: IconComponent;
    readonly BxZoomIn: IconComponent;
    readonly BxZoomOut: IconComponent;
    readonly BxUndo: IconComponent;
    readonly BxRedo: IconComponent;
    readonly BxSelection: IconComponent;
    readonly BxPointer: IconComponent;
    readonly BxMove: IconComponent;
    readonly BxFilePlus: IconComponent;
    readonly BxFolderPlus: IconComponent;
    readonly BxCollapseAll: IconComponent;
    readonly BxSearch: IconComponent;
    readonly BxFile: IconComponent;
    readonly BxFilter: IconComponent;
    readonly BxRefresh: IconComponent;
    readonly BxChevronDown: IconComponent;
    readonly BxChevronLeft: IconComponent;
    readonly BxCheck: IconComponent;
    readonly BxCloudUpload: IconComponent;
    readonly BxBookOpen: IconComponent;
    readonly BxDockLeft: IconComponent;
    readonly BxPalette: IconComponent;
    readonly BxDotsHorizontal: IconComponent;
    readonly BxExport: IconComponent;
    readonly BxDownload: IconComponent;
    readonly BxSortAlt: IconComponent;
    readonly BxHand: IconComponent;
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
 * Apps call this (via shell's public export) to obtain every shell-provided
 * hook, helper, class, component, and icon through one typed object rather than
 * importing each symbol individually.
 *
 * @returns The frozen `shellApi` object.
 */
export declare function getShellApi(): ShellApiShape;
export { AppManifestEntry$1 as AppManifestEntry, ConnectResult as AuthUser, Document$1 as Document, Explorer as DocExplorer, ExplorerChild as DocEntryChild, ExplorerConfig as DocExplorerConfig, ExplorerEntry as DocEntry, ExplorerStatus as DocEntryStatus, IConfirmDialogProps as ConfirmDialogProps, IExplorerProps as DocExplorerProps, PipelineControlConnection as IControlConnection, PipelineInputConnection as IInputConnection, PromoRedemption$1 as PromoRedemption, PromoValidation$1 as PromoValidation, ShellConnectionEventMap as ShellEventMap, TASK_STATE as ITaskState, TASK_STATUS as ITaskStatus, TASK_STATUS_FLOW as IFlowData, };
export {};
// ===== END FROZEN BUNDLE =====
export type ShellApiV1 = ShellApiShape;
