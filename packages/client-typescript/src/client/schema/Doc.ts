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

import { DocMetadata } from './DocMetadata.js';

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

export class DocHelper {
	/**
	 * Create a readable string representation showing the key identifiers and relevance score.
	 */
	static toString(doc: Doc): string {
		return `Document(${doc.metadata?.objectId}.${doc.metadata?.chunkId}=${doc.score})`;
	}

	/**
	 * Convert this document to a dictionary for serialization or storage.
	 */
	static toDict(doc: Doc): Record<string, unknown> {
		const result: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(doc)) {
			if (value !== undefined && value !== null) {
				result[key] = value;
			}
		}

		return result;
	}

	/**
	 * Create a Document from a dictionary (reverse of toDict).
	 */
	static fromDict(data: Record<string, unknown>): Doc {
		return {
			type: (data.type as string) || 'Document',
			page_content: data.page_content as string | undefined,
			embedding_model: data.embedding_model as string | undefined,
			embedding: data.embedding as number[] | undefined,
			score: data.score as number | undefined,
			highlight_score: data.highlight_score as number | undefined,
			context: data.context as string[] | undefined,
			tokens: data.tokens as number | undefined,
			metadata: data.metadata as DocMetadata | undefined,
		};
	}

	/**
	 * Create a new document with default values.
	 */
	static create(content: string, metadata?: Partial<DocMetadata>): Doc {
		return {
			type: 'Document',
			page_content: content,
			score: 0,
			metadata: {
				objectId: '',
				chunkId: 0,
				...metadata,
			},
		};
	}
}
