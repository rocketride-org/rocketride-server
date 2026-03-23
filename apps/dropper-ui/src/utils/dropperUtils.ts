/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import { UPLOAD_RESULT } from 'rocketride';
import { ProcessedResults, GroupedContent, ContentBlock } from '../types/dropper.types';

// ============================================================================
// TABLE PROCESSING
// ============================================================================

const normalizeTable = (tableText: string): string => {
	const lines = tableText.trim().split('\n');

	if (lines.length < 2) {
		return tableText;
	}

	const secondLine = lines[1];
	if (secondLine && secondLine.trim().match(/^\|[\s\-:]+\|/)) {
		return tableText;
	}

	const firstLine = lines[0];
	if (!firstLine) {
		return tableText;
	}

	const headerCols = (firstLine.match(/\|/g) || []).length - 1;
	const separator = '|' + Array(headerCols).fill('---').join('|') + '|';

	lines.splice(1, 0, separator);

	return lines.join('\n');
};

// ============================================================================
// CONTENT TYPE PROCESSORS
// ============================================================================

/**
 * Processes text content (simple strings only)
 */
const processTextData = (data: any): string[] => {
	const results: string[] = [];

	if (Array.isArray(data)) {
		const validItems = data.filter((item) => typeof item === 'string' && item.trim());
		if (validItems.length > 0) {
			results.push(validItems.join('\n\n'));
		}
	} else if (typeof data === 'string' && data.trim()) {
		results.push(data);
	}

	return results;
};

/**
 * Processes object-based content (documents, questions, answers)
 * These are Doc objects, Question objects, or Answer objects
 * Returns them as-is without modification
 */
const processObjectData = (data: any): any[] => {
	const results: any[] = [];

	if (Array.isArray(data)) {
		data.forEach((item) => {
			if (item !== null && item !== undefined) {
				results.push(item);
			}
		});
	} else if (data !== null && data !== undefined) {
		results.push(data);
	}

	return results;
};

/**
 * Processes table content
 */
const processTableData = (data: any): string[] => {
	const results: string[] = [];

	if (Array.isArray(data)) {
		const validItems = data.filter((item) => typeof item === 'string' && item.trim());
		if (validItems.length > 0) {
			results.push(validItems.map(normalizeTable).join('\n\n'));
		}
	} else if (typeof data === 'string' && data.trim()) {
		results.push(normalizeTable(data));
	}

	return results;
};

/**
 * Processes image content
 */
const processImageData = (data: any): string[] => {
	const imageUrls: string[] = [];

	if (Array.isArray(data)) {
		data.forEach((item) => {
			if (typeof item === 'object' && item.image && item.mime_type) {
				const dataUrl = `data:${item.mime_type};base64,${item.image}`;
				imageUrls.push(dataUrl);
			} else if (typeof item === 'string' && item.trim()) {
				imageUrls.push(item);
			}
		});
	} else if (typeof data === 'object' && data.image && data.mime_type) {
		const dataUrl = `data:${data.mime_type};base64,${data.image}`;
		imageUrls.push(dataUrl);
	} else if (typeof data === 'string' && data.trim()) {
		imageUrls.push(data);
	}

	return imageUrls;
};

// ============================================================================
// GROUPING AND ORGANIZATION
// ============================================================================

/**
 * Groups content by filename, preserving field names
 * Supports both string content (text, tables, images) and object content (documents, questions, answers)
 */
const groupByFilename = (items: Array<{ filename: string; content: any; fieldName: string }>): GroupedContent[] => {
	const grouped = new Map<string, ContentBlock[]>();

	// Group items by filename
	items.forEach(({ filename, content, fieldName }) => {
		if (!grouped.has(filename)) {
			grouped.set(filename, []);
		}
		grouped.get(filename)!.push({ content, fieldName });
	});

	// Convert Map to array format
	return Array.from(grouped.entries()).map(([filename, contents]) => ({
		filename,
		contents,
	}));
};

// ============================================================================
// MAIN PARSER
// ============================================================================

export const parseDropperResults = (uploadResults: UPLOAD_RESULT[]): ProcessedResults => {
	// Use 'any' for content type since it can be string or object
	const textItems: Array<{ filename: string; content: any; fieldName: string }> = [];
	const documentItems: Array<{ filename: string; content: any; fieldName: string }> = [];
	const tableItems: Array<{ filename: string; content: any; fieldName: string }> = [];
	const imageItems: Array<{ filename: string; content: any; fieldName: string }> = [];
	const videoItems: Array<{ filename: string; content: any; fieldName: string }> = [];
	const questionItems: Array<{ filename: string; content: any; fieldName: string }> = [];
	const answerItems: Array<{ filename: string; content: any; fieldName: string }> = [];

	// Process each upload result
	uploadResults.forEach((uploadResult) => {
		const filename = uploadResult.filepath;
		const pipelineResult = uploadResult.result;

		// Skip results without proper structure
		if (!pipelineResult || !pipelineResult.result_types) {
			return;
		}

		// Process each field based on its declared type
		for (const [fieldName, fieldType] of Object.entries(pipelineResult.result_types)) {
			const fieldData = pipelineResult[fieldName];

			switch (fieldType) {
				case 'text':
					// Process text content (simple strings)
					processTextData(fieldData).forEach((content) => {
						textItems.push({ filename, content, fieldName });
					});
					break;

				case 'document':
				case 'documents':
					// Process document content (Doc objects)
					processObjectData(fieldData).forEach((content) => {
						documentItems.push({ filename, content, fieldName });
					});
					break;

				case 'table':
				case 'tables':
					// Process and normalize table content (strings)
					processTableData(fieldData).forEach((content) => {
						tableItems.push({ filename, content, fieldName });
					});
					break;

				case 'image':
				case 'images': {
					// Process image content (data URLs)
					const imageUrls = processImageData(fieldData);
					if (imageUrls.length > 0) {
						// Join multiple images with delimiter for later splitting
						imageItems.push({
							filename,
							content: imageUrls.join('|||'),
							fieldName,
						});
					}
					break;
				}

				case 'video':
				case 'videos':
					// Video content is a Blob URL assembled from SSE chunks — pass through as-is
					if (Array.isArray(fieldData)) {
						fieldData.forEach((item) => {
							if (typeof item === 'string' && item.trim()) {
								videoItems.push({ filename, content: item, fieldName });
							}
						});
					} else if (typeof fieldData === 'string' && fieldData.trim()) {
						videoItems.push({ filename, content: fieldData, fieldName });
					}
					break;

				case 'question':
				case 'questions':
					// Process question content (Question objects)
					processObjectData(fieldData).forEach((content) => {
						questionItems.push({ filename, content, fieldName });
					});
					break;

				case 'answer':
				case 'answers':
					// Process answer content (Answer objects - can be text, object, or array)
					processObjectData(fieldData).forEach((content) => {
						answerItems.push({ filename, content, fieldName });
					});
					break;

				default:
					// Log unknown types for debugging
					console.warn('Unknown field type in pipeline result:', fieldType);
			}
		}
	});

	// Group content by filename and return organized structure
	return {
		rawJson: uploadResults,
		textContent: groupByFilename(textItems),
		documents: groupByFilename(documentItems),
		tables: groupByFilename(tableItems),
		images: groupByFilename(imageItems),
		videos: groupByFilename(videoItems),
		questions: groupByFilename(questionItems),
		answers: groupByFilename(answerItems),
	};
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export const generateFileId = (): string => {
	return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
};

export const formatBytes = (bytes: number): string => {
	if (bytes === 0) return '0 B';

	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];

	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};
