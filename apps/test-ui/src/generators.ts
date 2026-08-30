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
// TEST-UI — Realistic Data Generators
// =============================================================================
//
// Ported from benchmark-ui. Generates realistic text payloads that exercise
// the NLP pipeline properly (tokenization, chunking, embedding, NER).
// Random bytes don't stress these workloads meaningfully — real words do.
// =============================================================================

// =============================================================================
// WORD POOL
// =============================================================================

/**
 * Word pool covering business/tech/medical domains for realistic
 * tokenization and NER behavior.
 */
const WORD_POOL = [
	'The',
	'company',
	'announced',
	'a',
	'new',
	'product',
	'launch',
	'for',
	'the',
	'upcoming',
	'quarter',
	'with',
	'expected',
	'revenue',
	'growth',
	'of',
	'fifteen',
	'percent',
	'compared',
	'to',
	'last',
	'year',
	'results',
	'The',
	'board',
	'approved',
	'the',
	'acquisition',
	'strategy',
	'targeting',
	'three',
	'key',
	'markets',
	'in',
	'Europe',
	'and',
	'Asia',
	'Pacific',
	'regions',
	'Financial',
	'analysts',
	'predict',
	'strong',
	'performance',
	'driven',
	'by',
	'artificial',
	'intelligence',
	'integration',
	'across',
	'all',
	'business',
	'units',
	'The',
	'technology',
	'platform',
	'processes',
	'millions',
	'of',
	'documents',
	'daily',
	'using',
	'advanced',
	'natural',
	'language',
	'processing',
	'and',
	'machine',
	'learning',
	'algorithms',
	'Customer',
	'satisfaction',
	'scores',
	'improved',
	'significantly',
	'after',
	'implementing',
	'the',
	'automated',
	'workflow',
	'system',
	'Research',
	'indicates',
	'that',
	'organizations',
	'adopting',
	'cloud',
	'native',
	'architectures',
	'see',
	'reduced',
	'operational',
	'costs',
	'and',
	'improved',
	'scalability',
	'metrics',
	'Data',
	'security',
	'remains',
	'a',
	'top',
	'priority',
	'with',
	'encryption',
	'protocols',
	'applied',
	'at',
	'every',
	'layer',
	'of',
	'the',
	'infrastructure',
	'stack',
	'Medical',
	'records',
	'processing',
	'requires',
	'HIPAA',
	'compliant',
	'handling',
	'of',
	'patient',
	'information',
	'including',
	'names',
	'addresses',
	'social',
	'security',
	'numbers',
	'and',
	'diagnostic',
	'codes',
	'John',
	'Smith',
	'from',
	'New',
	'York',
	'filed',
	'a',
	'patent',
	'application',
	'with',
	'the',
	'United',
	'States',
	'Patent',
	'Office',
	'on',
	'January',
	'fifteenth',
	'two',
	'thousand',
	'twenty',
	'six',
	'regarding',
	'novel',
	'approaches',
	'to',
	'distributed',
	'computing',
];

// =============================================================================
// TEXT GENERATORS
// =============================================================================

/**
 * Generate a deterministic text chunk of approximately avgWords words.
 * The seed ensures the same index always produces the same text.
 *
 * @param index    - Unique index for deterministic seeding.
 * @param avgWords - Target word count (default 100).
 */
export function generateTextChunk(index: number, avgWords: number = 100): string {
	const words: string[] = [];
	const seed = index * 7919;
	for (let i = 0; i < avgWords; i++) {
		const wordIdx = (seed + i * 31) % WORD_POOL.length;
		words.push(WORD_POOL[wordIdx]);
	}
	return words.join(' ');
}

/**
 * Generate a batched text payload — multiple chunks joined by double-newlines.
 * The preprocessor_langchain node splits them back into individual documents.
 *
 * @param batchIndex     - Batch number (for deterministic seeding).
 * @param chunksPerBatch - Number of chunks per batch (default 100).
 * @param avgWords       - Words per chunk (default 100).
 */
export function generateBatchedText(batchIndex: number, chunksPerBatch: number = 100, avgWords: number = 100): string {
	const chunks: string[] = [];
	const startIdx = batchIndex * chunksPerBatch;
	for (let i = 0; i < chunksPerBatch; i++) {
		chunks.push(generateTextChunk(startIdx + i, avgWords));
	}
	return chunks.join('\n\n');
}

/** Synthetic RAG/chat query templates. */
const QUERY_TEMPLATES = ['What are the key findings in the latest quarterly report?', 'Summarize the main risks identified in the compliance review.', 'How does the new product compare to competitor offerings?', 'What were the top customer complaints last month?', 'Explain the architecture of the distributed processing system.', 'What is the expected timeline for the regulatory approval?', 'How many patents were filed in the healthcare division this year?', 'What are the projected cost savings from the cloud migration?', 'Describe the security protocols used for data encryption.', 'What environmental certifications does the company hold?', 'List the top performing products by revenue in Q3.', 'What training data was used for the classification model?', 'How does the NER system handle ambiguous entity mentions?', 'What is the average processing time per document in the OCR pipeline?', 'Describe the backup and disaster recovery procedures.'];

/**
 * Generate a synthetic query string (cycles through 15 templates).
 *
 * @param index - Query index for cycling.
 */
export function generateQuery(index: number): string {
	return QUERY_TEMPLATES[index % QUERY_TEMPLATES.length];
}
