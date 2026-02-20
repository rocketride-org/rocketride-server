/**
 * MIT License
 * 
 * Copyright (c) 2026 RocketRide, Inc.
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

export class DocFilterHelper {
	/**
	 * Create a default DocFilter with sensible defaults.
	 */
	static createDefault(): DocFilter {
		return {
			fullTables: false,
			fullDocuments: false,
			offset: 0,
			limit: 25,
			useQuickRank: false,
			useGroupRank: false,
			followUpQuestions: 5,
			context: false,
		};
	}

	/**
	 * Create a DocFilter for paginated table results.
	 */
	static forTables(limit = 20, offset = 0): DocFilter {
		return {
			...DocFilterHelper.createDefault(),
			isTable: true,
			fullTables: true,
			limit,
			offset,
			useQuickRank: true,
		};
	}

	/**
	 * Create a DocFilter for complete documents.
	 */
	static forFullDocuments(limit = 10): DocFilter {
		return {
			...DocFilterHelper.createDefault(),
			fullDocuments: true,
			limit,
		};
	}

	/**
	 * Create a DocFilter with AI enhancements enabled.
	 */
	static withAIEnhancements(): DocFilter {
		return {
			...DocFilterHelper.createDefault(),
			useQuickRank: true,
			useGroupRank: true,
			context: true,
		};
	}

	/**
	 * Validate that a DocFilter has reasonable values.
	 */
	static validate(filter: DocFilter): string[] {
		const errors: string[] = [];

		if (filter.limit !== undefined && (filter.limit < 1 || filter.limit > 1000)) {
			errors.push('Limit must be between 1 and 1000');
		}

		if (filter.offset !== undefined && filter.offset < 0) {
			errors.push('Offset must be non-negative');
		}

		if (filter.followUpQuestions !== undefined && filter.followUpQuestions < 0) {
			errors.push('Follow-up questions count must be non-negative');
		}

		return errors;
	}

	/**
	 * Convert DocFilter to dictionary for serialization.
	 */
	static toDict(filter: DocFilter): Record<string, unknown> {
		const result: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(filter)) {
			if (value !== undefined && value !== null) {
				result[key] = value;
			}
		}

		return result;
	}

	/**
	 * Create DocFilter from dictionary.
	 */
	static fromDict(data: Record<string, unknown>): DocFilter {
		return {
			fullTables: data.fullTables as boolean | undefined,
			fullDocuments: data.fullDocuments as boolean | undefined,
			offset: data.offset as number | undefined,
			limit: data.limit as number | undefined,
			minChunkId: data.minChunkId as number | undefined,
			maxChunkId: data.maxChunkId as number | undefined,
			nodeId: data.nodeId as string | undefined,
			parent: data.parent as string | undefined,
			name: data.name as string | undefined,
			permissions: data.permissions as number[] | undefined,
			isDeleted: data.isDeleted as boolean | undefined,
			objectIds: data.objectIds as string[] | undefined,
			chunkIds: data.chunkIds as number[] | undefined,
			isTable: data.isTable as boolean | undefined,
			tableIds: data.tableIds as number[] | undefined,
			useQuickRank: data.useQuickRank as boolean | undefined,
			useGroupRank: data.useGroupRank as boolean | undefined,
			followUpQuestions: data.followUpQuestions as number | undefined,
			context: data.context as boolean | undefined,
		};
	}
}
