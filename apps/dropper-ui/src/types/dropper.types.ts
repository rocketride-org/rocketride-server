/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

/**
 * Type Definitions for RocketRide Dropper Application
 *
 * This module contains all TypeScript type definitions used throughout
 * the dropper application. These types provide:
 *
 * - Type safety across components
 * - Clear documentation of data structures
 * - Compile-time error detection
 * - IntelliSense support in IDEs
 *
 * Organization:
 * - File Upload Types: UploadedFile, FileStatus
 * - UI Types: TabType
 * - Content Types: ContentBlock, GroupedContent
 * - Results Types: ProcessedResults
 * - Configuration Types: DropperConfig
 */

// ============================================================================
// FILE UPLOAD TYPES
// ============================================================================

/**
 * Possible processing states for an uploaded file
 *
 * State Transitions:
 * - pending → processing: When upload starts
 * - processing → completed: When processing succeeds
 * - processing → error: When processing fails
 *
 * @example
 * ```typescript
 * const file: UploadedFile = {
 *   id: '123',
 *   file: fileObject,
 *   status: 'pending' // Initially pending
 * };
 *
 * // Later transitions to 'processing', then 'completed' or 'error'
 * ```
 */
export type FileStatus = 'pending' | 'processing' | 'completed' | 'error';

/**
 * Represents a single uploaded file with its processing status
 *
 * Lifecycle:
 * 1. Created when file is selected/dropped
 * 2. Status tracked through processing pipeline
 * 3. Error message added if processing fails
 * 4. Persists in state until explicitly removed
 *
 * @example
 * ```typescript
 * const uploadedFile: UploadedFile = {
 *   id: 'file-1234567890',
 *   file: new File(['content'], 'document.pdf'),
 *   status: 'completed'
 * };
 *
 * // With error
 * const failedFile: UploadedFile = {
 *   id: 'file-0987654321',
 *   file: new File(['content'], 'image.jpg'),
 *   status: 'error',
 *   error: 'Unsupported file format'
 * };
 * ```
 */
export interface UploadedFile {
	/** Unique identifier for the file (generated client-side) */
	id: string;

	/** The actual File object from browser */
	file: File;

	/** Current processing status */
	status: FileStatus;

	/** Error message if status is 'error' (optional) */
	error?: string;
}

// ============================================================================
// UI TYPES
// ============================================================================

/**
 * Types of tabs available in the results section
 *
 * Tab Purposes:
 * - 'results': Raw JSON view of all results
 * - 'text': Extracted text content from documents
 * - 'documents': Structured document content
 * - 'tables': Extracted tables in markdown format
 * - 'images': Extracted images from documents
 * - 'questions': Extracted questions from Q&A processing
 * - 'answers': Extracted answers from Q&A processing
 *
 * Tab Selection Logic:
 * - Auto-selects first non-empty tab
 * - Priority: text > documents > tables > images > questions > answers > results
 *
 * @example
 * ```typescript
 * const [activeTab, setActiveTab] = useState<TabType>('text');
 *
 * // Switch to images tab
 * setActiveTab('images');
 * ```
 */
export type TabType = 'results' | 'text' | 'documents' | 'tables' | 'images' | 'videos' | 'questions' | 'answers';

// ============================================================================
// CONTENT TYPES
// ============================================================================

/**
 * Content block with optional field name label
 *
 * Content can be:
 * - string: For text, tables, images (as data URLs)
 * - object: For documents (Doc objects) and complex answer structures
 */
export interface ContentBlock {
	/** The actual content (string for simple types, object for complex types) */
	content: string | any;

	/** Field name from pipeline result (e.g., "response_1", "text") */
	fieldName?: string;
}

/**
 * Content grouped by filename with multiple content blocks
 *
 * Structure:
 * - One GroupedContent per source file
 * - Contains all content blocks extracted from that file
 * - Preserves field names for labeling
 *
 * Purpose:
 * - Organizes results by source file
 * - Allows side-by-side comparison in compare mode
 * - Maintains traceability from results to source
 *
 * @example
 * ```typescript
 * const groupedContent: GroupedContent = {
 *   filename: 'document.pdf',
 *   contents: [
 *     { content: 'Page 1 text...', fieldName: 'response_1' },
 *     { content: 'Page 2 text...', fieldName: 'response_2' }
 *   ]
 * };
 * ```
 */
export interface GroupedContent {
	/** Source filename (e.g., 'document.pdf') */
	filename: string;

	/** Array of content blocks extracted from this file */
	contents: ContentBlock[];
}

// ============================================================================
// RESULTS TYPES
// ============================================================================

/**
 * Organized results from file processing
 *
 * Structure:
 * - Results organized by content type (text, documents, tables, images, questions, answers)
 * - Each type grouped by source filename
 * - Raw JSON preserved for debugging
 *
 * Processing Flow:
 * 1. RocketRide returns UPLOAD_RESULT array
 * 2. parseDropperResults() organizes into this structure
 * 3. UI renders appropriate tab based on content
 *
 * Content Organization:
 * - textContent: Extracted text and answers
 * - documents: Structured document content
 * - tables: Extracted tables in markdown format
 * - images: Extracted images as base64 data URLs
 * - questions: Extracted questions from Q&A processing
 * - answers: Extracted answers from Q&A processing
 *
 * @example
 * ```typescript
 * const results: ProcessedResults = {
 *   rawJson: [...], // Original upload results
 *   textContent: [
 *     {
 *       filename: 'doc1.pdf',
 *       contents: [
 *         { content: 'Extracted text...', fieldName: 'text' }
 *       ]
 *     }
 *   ],
 *   documents: [
 *     {
 *       filename: 'doc2.pdf',
 *       contents: [
 *         { content: {...}, fieldName: 'document' }
 *       ]
 *     }
 *   ],
 *   tables: [
 *     {
 *       filename: 'sheet.xlsx',
 *       contents: [
 *         { content: '| A | B |\n|---|---|\n| 1 | 2 |', fieldName: 'table' }
 *       ]
 *     }
 *   ],
 *   images: [
 *     {
 *       filename: 'scan.pdf',
 *       contents: [
 *         { content: 'data:image/png;base64,...', fieldName: 'image' }
 *       ]
 *     }
 *   ],
 *   questions: [
 *     {
 *       filename: 'qa.pdf',
 *       contents: [
 *         { content: 'What is the capital of France?', fieldName: 'question_1' }
 *       ]
 *     }
 *   ],
 *   answers: [
 *     {
 *       filename: 'qa.pdf',
 *       contents: [
 *         { content: 'The capital of France is Paris.', fieldName: 'answer_1' }
 *       ]
 *     }
 *   ]
 * };
 * ```
 */
export interface ProcessedResults {
	/** Raw JSON response from RocketRide API (for debugging) */
	rawJson: any;

	/** Extracted text content grouped by filename */
	textContent: GroupedContent[];

	/** Structured document content grouped by filename */
	documents: GroupedContent[];

	/** Extracted tables grouped by filename */
	tables: GroupedContent[];

	/** Extracted images grouped by filename */
	images: GroupedContent[];

	/** Assembled videos grouped by filename (Blob URLs assembled from SSE chunks) */
	videos: GroupedContent[];

	/** Extracted questions grouped by filename */
	questions: GroupedContent[];

	/** Extracted answers grouped by filename */
	answers: GroupedContent[];
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

/**
 * Configuration for dropper connection
 *
 * Purpose:
 * - Controls how the application connects to RocketRide
 * - Supports both development and production modes
 * - Provides flexibility for different deployment scenarios
 *
 * Configuration Modes:
 * - devMode=true: Direct API connection with API key
 * - devMode=false: Backend-mediated authentication
 *
 * @example
 * ```typescript
 * // Development configuration
 * const devConfig: DropperConfig = {
 *   devMode: true,
 *   host: 'wss://dev.rocketride.com',
 *   apiKey: 'dev-api-key-123'
 * };
 *
 * // Production configuration
 * const prodConfig: DropperConfig = {
 *   devMode: false
 *   // host and apiKey not needed (handled by backend)
 * };
 * ```
 */
export interface DropperConfig {
	/** Development mode flag */
	devMode: boolean;

	/** RocketRide WebSocket host URL (optional, for dev mode) */
	host?: string;

	/** API key for authentication (optional, for dev mode) */
	apiKey?: string;
}
