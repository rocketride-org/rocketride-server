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

import { Doc, DocHelper } from './Doc';

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

export class DocGroupHelper {
	/**
	 * Create a readable string representation showing the filename and relevance score.
	 */
	static toString(group: DocGroup): string {
		const filename = group.parent.split('/').pop() || group.parent;
		return `${filename}=${group.score}`;
	}

	/**
	 * Create a new DocGroup.
	 */
	static create(objectId: string, parent: string, documents: Doc[] = [], score = 0): DocGroup {
		return {
			score,
			objectId,
			parent,
			documents,
		};
	}

	/**
	 * Add a document to the group and update the score.
	 */
	static addDocument(group: DocGroup, doc: Doc): DocGroup {
		const newDocuments = [...group.documents, doc];

		// Recalculate group score - use the maximum score from all documents
		const newScore = Math.max(group.score, doc.score || 0);

		return {
			...group,
			documents: newDocuments,
			score: newScore,
		};
	}

	/**
	 * Get the total content from all documents in the group.
	 */
	static getFullContent(group: DocGroup): string {
		return group.documents
			.map(doc => doc.page_content || '')
			.join('\n');
	}

	/**
	 * Get the highest scoring document in the group.
	 */
	static getBestDocument(group: DocGroup): Doc | undefined {
		if (group.documents.length === 0) {
			return undefined;
		}

		return group.documents.reduce((best, current) => {
			const bestScore = best.score || 0;
			const currentScore = current.score || 0;
			return currentScore > bestScore ? current : best;
		});
	}

	/**
	 * Sort documents in the group by score (highest first) or chunk ID.
	 */
	static sortDocuments(group: DocGroup, sortBy: 'score' | 'chunkId' = 'score'): DocGroup {
		const sortedDocuments = [...group.documents].sort((a, b) => {
			if (sortBy === 'score') {
				const scoreA = a.score || 0;
				const scoreB = b.score || 0;
				return scoreB - scoreA; // Highest first
			} else {
				const chunkA = a.metadata?.chunkId || 0;
				const chunkB = b.metadata?.chunkId || 0;
				return chunkA - chunkB; // Lowest first
			}
		});

		return {
			...group,
			documents: sortedDocuments,
		};
	}

	/**
	 * Filter documents in the group by score threshold.
	 */
	static filterByScore(group: DocGroup, minScore: number): DocGroup {
		const filteredDocuments = group.documents.filter(doc => (doc.score || 0) >= minScore);

		return {
			...group,
			documents: filteredDocuments,
		};
	}

	/**
	 * Get document count in the group.
	 */
	static getDocumentCount(group: DocGroup): number {
		return group.documents.length;
	}

	/**
	 * Get total tokens count for all documents in the group.
	 */
	static getTotalTokens(group: DocGroup): number {
		return group.documents.reduce((total, doc) => total + (doc.tokens || 0), 0);
	}

	/**
	 * Get average score of documents in the group.
	 */
	static getAverageScore(group: DocGroup): number {
		if (group.documents.length === 0) {
			return 0;
		}

		const totalScore = group.documents.reduce((sum, doc) => sum + (doc.score || 0), 0);
		return totalScore / group.documents.length;
	}

	/**
	 * Check if group contains table data.
	 */
	static hasTableData(group: DocGroup): boolean {
		return group.documents.some(doc => doc.metadata?.isTable === true);
	}

	/**
	 * Get only table documents from the group.
	 */
	static getTableDocuments(group: DocGroup): Doc[] {
		return group.documents.filter(doc => doc.metadata?.isTable === true);
	}

	/**
	 * Get only text documents from the group.
	 */
	static getTextDocuments(group: DocGroup): Doc[] {
		return group.documents.filter(doc => doc.metadata?.isTable !== true);
	}

	/**
	 * Convert DocGroup to dictionary for serialization.
	 */
	static toDict(group: DocGroup): Record<string, unknown> {
		return {
			score: group.score,
			objectId: group.objectId,
			parent: group.parent,
			documents: group.documents.map(doc => DocHelper.toDict(doc)),
		};
	}

	/**
	 * Create DocGroup from dictionary.
	 */
	static fromDict(data: Record<string, unknown>): DocGroup {
		return {
			score: (data.score as number) || 0,
			objectId: (data.objectId as string) || '',
			parent: (data.parent as string) || '',
			documents: ((data.documents || []) as unknown[]).map((docData: unknown) => {
				// Convert back to Doc if needed
				if (typeof docData === 'object' && docData !== null) {
					return docData as Doc;
				}
				return docData as Doc;
			}),
		};
	}

	/**
	 * Merge multiple DocGroups from the same source document.
	 */
	static merge(groups: DocGroup[]): DocGroup | undefined {
		if (groups.length === 0) {
			return undefined;
		}

		if (groups.length === 1) {
			return groups[0];
		}

		// Ensure all groups are from the same document
		const firstGroup = groups[0];
		const sameSource = groups.every(group => group.objectId === firstGroup.objectId);

		if (!sameSource) {
			throw new Error('Cannot merge DocGroups from different source documents');
		}

		// Merge all documents
		const allDocuments = groups.flatMap(group => group.documents);

		// Use the highest score
		const maxScore = Math.max(...groups.map(group => group.score));

		return {
			score: maxScore,
			objectId: firstGroup.objectId,
			parent: firstGroup.parent,
			documents: allDocuments,
		};
	}

	/**
	 * Split a DocGroup into smaller groups by chunk ranges.
	 */
	static splitByChunkRange(group: DocGroup, chunkSize: number): DocGroup[] {
		if (chunkSize <= 0) {
			throw new Error('Chunk size must be positive');
		}

		const sortedGroup = DocGroupHelper.sortDocuments(group, 'chunkId');
		const result: DocGroup[] = [];

		for (let i = 0; i < sortedGroup.documents.length; i += chunkSize) {
			const chunkDocuments = sortedGroup.documents.slice(i, i + chunkSize);
			const chunkScore = Math.max(...chunkDocuments.map(doc => doc.score || 0));

			result.push({
				score: chunkScore,
				objectId: group.objectId,
				parent: group.parent,
				documents: chunkDocuments,
			});
		}

		return result;
	}
}
