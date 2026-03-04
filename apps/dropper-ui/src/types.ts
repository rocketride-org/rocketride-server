/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

/**
 * TypeScript interface declarations corresponding to Python Pydantic models
 * for the RocketRide AI dropper system.
 * 
 * These interfaces provide type safety when working with question data
 * structures in the frontend application.
 */

// =============================================================================
// CORE ANSWER MODEL
// =============================================================================

/**
 * Represents an answer to a question, which can be either plain text or JSON format.
 * 
 * @interface Answer
 * @property {string | object | any[] | null} answer - The answer content (null during creation)
 * @property {boolean} expectJson - Flag indicating if JSON format is expected
 */
export interface Answer {
	/** The answer content - can be string, object, array, or null */
	answer: string | object | any[] | null;

	/** Flag indicating whether a JSON response is expected */
	expectJson: boolean;
}

// =============================================================================
// QUESTION HISTORY AND CONVERSATION
// =============================================================================

/**
 * Represents a single entry in the conversation history.
 * 
 * @interface QuestionHistory
 * @property {string} role - The role: 'user', 'system', or 'assistant'
 * @property {string} content - The content of the message/response
 */
export interface QuestionHistory {
	/** The role of the message sender (user, system, or assistant) */
	role: string;

	/** Content of the answer/response */
	content: string;
}

// =============================================================================
// QUESTION INSTRUCTIONS AND EXAMPLES
// =============================================================================

/**
 * Represents instructions for how to handle the question.
 * 
 * @interface QuestionInstruction
 * @property {string} subtitle - A brief subtitle describing the instruction
 * @property {string} instructions - Detailed instructions for handling the question
 */
export interface QuestionInstruction {
	/** A short descriptive title for the instruction */
	subtitle: string;

	/** The detailed instructions for answering the question */
	instructions: string;
}

/**
 * Represents an example question and its expected result.
 * Used to provide context and expected format for answers.
 * 
 * @interface QuestionExample
 * @property {string} given - The example question provided
 * @property {string} result - The expected result or answer (as string, even if originally JSON)
 */
export interface QuestionExample {
	/** The example question input */
	given: string;

	/** The expected output or answer for the given question */
	result: string;
}

// =============================================================================
// QUESTION TEXT AND EMBEDDINGS
// =============================================================================

/**
 * Represents a question with optional embedding data for semantic search.
 * 
 * @interface QuestionText
 * @property {string} text - The question text
 * @property {string | null} embedding_model - The name of the embedding model used (if any)
 * @property {number[] | null} embedding - The numerical embedding representation of the question
 */
export interface QuestionText {
	/** The question text */
	text: string;

	/** The embedding model name, if applicable */
	embedding_model?: string | null;

	/** A list of numerical values representing the embedding */
	embedding?: number[] | null;
}

// =============================================================================
// QUESTION TYPES ENUM
// =============================================================================

/**
 * Enum representing different types of questions and how they should be processed.
 * 
 * @enum {string} QuestionType
 */
export enum QuestionType {
	/** Question that relies on semantic understanding and context */
	SEMANTIC = 'semantic',

	/** Question that is based on keyword matching */
	KEYWORD = 'keyword',

	/** Question that retrieves specific information */
	GET = 'get',

	/** Question that serves as a prompt for further interaction */
	QUESTION = 'question',

	/** Question that serves as a prompt for further interaction */
	PROMPT = 'prompt'
}

// =============================================================================
// DOCUMENT INTERFACES
// =============================================================================

/**
 * Document filter criteria for selecting relevant documents.
 * Note: This interface should be updated to match your actual DocFilter model
 * 
 * @interface DocFilter
 */
export interface DocFilter {
	// Placeholder - update with actual DocFilter properties from your Python model
	[key: string]: any;
}

/**
 * Document representation with content and metadata.
 * Note: This interface should be updated to match your actual Doc model
 * 
 * @interface Doc
 */
export interface Doc {
	/** Unique identifier for the document chunk */
	chunkId: number;

	/** Object ID for the document */
	objectId: string;

	/** The actual content of the document */
	page_content: string;

	// Placeholder for additional properties - update with actual Doc model properties
	[key: string]: any;
}

// =============================================================================
// MAIN QUESTION MODEL
// =============================================================================

/**
 * Main Question model representing a complete question with all associated data.
 * 
 * This serves as a container for the entire structure of a question,
 * including its instructions, examples, context, documents, and sub-questions.
 * 
 * @interface Question
 */
export interface Question {
	/** The type of question being represented */
	type: QuestionType;

	/** Filter criteria for document selection */
	filter?: DocFilter | null;

	/** Flag indicating whether a JSON response is expected */
	expectJson?: boolean;

	/** The role associated with the question, if any */
	role?: string;

	/** List of instructions for handling the question */
	instructions?: QuestionInstruction[];

	/** History of the conversation */
	history?: QuestionHistory[];

	/** Example questions and their expected results */
	examples?: QuestionExample[];

	/** Contextual information related to the question */
	context?: string[];

	/** List of associated documents */
	documents?: Doc[];

	/** List of sub-questions related to this question */
	questions?: QuestionText[];
}

// =============================================================================
// DROPPER-SPECIFIC INTERFACES
// =============================================================================

/**
 * Interface for uploaded files with processing status
 */
export interface UploadedFile {
	id: string;
	file: File;
	status: 'pending' | 'processing' | 'completed' | 'error';
	error?: string;
}

/**
 * Interface for processed results from RocketRide
 */
export interface ProcessedResults {
	rawJson: any;
	textContent: string[];
	tables: string[];
	images: string[];
}

/**
 * Tab types for the results display
 */
export type TabType = 'results' | 'text' | 'tables' | 'images';
