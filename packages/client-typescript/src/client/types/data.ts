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
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dynamic fields are runtime-determined by pipeline config
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
	action: 'open' | 'write' | 'close' | 'complete' | 'error';

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
