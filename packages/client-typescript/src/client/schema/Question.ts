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

import { Doc } from './Doc';
import { DocFilter } from './DocFilter';

/**
 * Defines different types of questions and queries you can ask.
 */
export enum QuestionType {
	QUESTION = 'question',
	SEMANTIC = 'semantic',
	KEYWORD = 'keyword',
	GET = 'get',
	PROMPT = 'prompt'
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
export class Answer {
	private answer?: string | object | unknown[];
	private expectJson: boolean;

	constructor(expectJson = false) {
		this.expectJson = expectJson;
	}

	/**
	 * Parse AI response text into JSON structure.
	 */
	static parseJson(value: string): unknown {
		// Clean up the response text
		let cleanValue = value.trim()
			.replace(/\r/g, '')
			.replace(/\n/g, '')
			.replace(/\t/g, ' ');

		// Remove JSON code block markers if present
		let offset = cleanValue.indexOf('```json');
		if (offset >= 0) {
			cleanValue = cleanValue.substring(offset + 7).trim();
			offset = cleanValue.lastIndexOf('```');
			if (offset >= 0) {
				cleanValue = cleanValue.substring(0, offset).trim();
			}
		}

		// Remove generic code block markers
		offset = cleanValue.indexOf('```');
		if (offset >= 0) {
			cleanValue = cleanValue.substring(offset + 3).trim();
			offset = cleanValue.lastIndexOf('```');
			if (offset >= 0) {
				cleanValue = cleanValue.substring(0, offset).trim();
			}
		}

		// Remove AI thinking steps (common with some models)
		// Use a more compatible approach instead of the 's' flag
		cleanValue = cleanValue.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

		// Parse the cleaned JSON
		return JSON.parse(cleanValue);
	}

	/**
	 * Extract Python code from AI response.
	 */
	static parsePython(value: string): string {
		let offset = value.indexOf('```python');
		if (offset >= 0) {
			value = value.substring(offset + 9);
			offset = value.lastIndexOf('```');
			if (offset >= 0) {
				value = value.substring(0, offset);
			}
		}
		return value;
	}

	/**
	 * Set the AI response value (used internally by the system).
	 */
	setAnswer(value: string | object | unknown[]): void {
		if (this.expectJson) {
			if (typeof value === 'object') {
				this.answer = value;
				return;
			}
			if (typeof value === 'string') {
				try {
					this.answer = Answer.parseJson(value) as object | unknown[];
					return;
				} catch {
					throw new Error('Expected a JSON-compatible answer (object or array).');
				}
			}
			throw new Error('Expected a JSON-compatible answer (object or array).');
		} else {
			if (typeof value === 'object') {
				this.answer = JSON.stringify(value);
				return;
			}
			if (typeof value === 'string') {
				this.answer = value;
				return;
			}
			throw new Error('Answer must be text, object, or array.');
		}
	}

	/**
	 * Get the response as plain text.
	 */
	getText(): string {
		if (this.answer === undefined || this.answer === null) {
			return '';
		}
		if (typeof this.answer === 'object') {
			return JSON.stringify(this.answer);
		}
		return String(this.answer);
	}

	/**
	 * Get the response as structured JSON data.
	 */
	getJson(): unknown {
		if (this.answer === undefined || this.answer === null) {
			return null;
		}
		if (typeof this.answer === 'object') {
			return this.answer;
		}
		try {
			return JSON.parse(String(this.answer));
		} catch {
			throw new Error('Answer is not in JSON format.');
		}
	}

	/**
	 * Check if this answer contains JSON data.
	 */
	isJson(): boolean {
		return this.expectJson;
	}
}

/**
 * Main class for asking questions to RocketRide's AI system.
 */
export class Question {
	type: QuestionType = QuestionType.QUESTION;
	filter: DocFilter;
	expectJson = false;
	role = '';
	instructions: QuestionInstruction[] = [];
	history: QuestionHistory[] = [];
	examples: QuestionExample[] = [];
	context: string[] = [];
	documents: Doc[] = [];
	questions: QuestionText[] = [];

	constructor(options: {
		type?: QuestionType;
		filter?: DocFilter;
		expectJson?: boolean;
		role?: string;
	} = {}) {
		this.type = options.type || QuestionType.QUESTION;
		this.filter = options.filter || {
			fullTables: false,
			fullDocuments: false,
			offset: 0,
			limit: 25,
			useQuickRank: false,
			useGroupRank: false,
			followUpQuestions: 5,
			context: false
		};
		this.expectJson = options.expectJson || false;
		this.role = options.role || '';
	}

	/**
	 * Add a custom instruction to guide the AI's response.
	 */
	addInstruction(title: string, instruction: string): void {
		this.instructions.push({
			subtitle: title,
			instructions: instruction
		});
	}

	/**
	 * Add an example to show the AI the kind of response you want.
	 */
	addExample(given: string, result: string | object | unknown[]): void {
		const resultString = typeof result === 'object'
			? JSON.stringify(result)
			: String(result);

		this.examples.push({
			given,
			result: resultString
		});
	}

	/**
	 * Add context information to help the AI understand your question better.
	 */
	addContext(context: string | object | string[] | object[]): void {
		const contextItems = Array.isArray(context) ? context : [context];

		for (const item of contextItems) {
			if (typeof item === 'string') {
				this.context.push(item);
			} else if (typeof item === 'object') {
				this.context.push(String(item));
			} else {
				throw new Error(`Context item must be string or object, not ${typeof item}`);
			}
		}
	}

	/**
	 * Add a conversation history item for multi-turn chat.
	 */
	addHistory(item: QuestionHistory): void {
		this.history.push(item);
	}

	/**
	 * Add a question to ask the AI.
	 */
	addQuestion(question: string): void {
		this.questions.push({ text: question });
	}

	/**
	 * Add specific documents for the AI to reference.
	 */
	addDocuments(documents: Doc | Doc[]): void {
		const docArray = Array.isArray(documents) ? documents : [documents];

		for (const item of docArray) {
			if (typeof item === 'string') {
				this.documents.push({
					type: 'Document',
					page_content: item,
					metadata: { objectId: '', chunkId: 0 }
				});
			} else {
				this.documents.push(item);
			}
		}
	}

	/**
	 * Generate the complete prompt text for the AI (used internally).
	 */
	getPrompt(hasPreviousJsonFailed = false): string {
		const crlf = '\r\n';
		let prompt = '';

		// Helper functions for formatting different sections
		let instructionId = 0;
		let hasOutputInstructions = false;

		const addPromptInstruction = (instruction: QuestionInstruction) => {
			if (!hasOutputInstructions) {
				prompt += '### Instructions:' + crlf;
				hasOutputInstructions = true;
			}
			prompt += `    ${instructionId + 1}) **${instruction.subtitle.trim()}**: ${instruction.instructions.trim()}` + crlf + crlf;
			instructionId++;
		};

		let exampleId = 0;

		const addPromptExample = (example: QuestionExample) => {
			const jsonBegin = this.expectJson ? '```json' + crlf : '';
			const jsonEnd = this.expectJson ? '```' + crlf : '';
			prompt += `    Example ${exampleId + 1}` + crlf;
			prompt += `        **Given**: ${example.given.trim()}` + crlf;
			prompt += `        **Expected output**: ${jsonBegin}${example.result.trim()}${jsonEnd}`;
			exampleId++;
		};

		let contextId = 0;
		let hasOutputContext = false;

		const addPromptContext = (context: string) => {
			if (!hasOutputContext) {
				prompt += '### Context:' + crlf;
				hasOutputContext = true;
			}
			prompt += `    ${contextId + 1}) ${context.trim()}` + crlf + crlf;
			contextId++;
		};

		let documentId = 0;
		let hasOutputDocuments = false;

		const addPromptDocument = (document: Doc) => {
			if (!hasOutputDocuments) {
				prompt += '### Documents:' + crlf;
				hasOutputDocuments = true;
			}
			const doc = document.page_content || '';
			prompt += `    Document ${documentId + 1}) Content: ${doc.trim()}` + crlf;
			documentId++;
		};

		// Add role if specified
		if (this.role) {
			prompt += this.role + crlf;
		}

		// Add default instruction if none provided
		if (this.instructions.length === 0) {
			addPromptInstruction({
				subtitle: 'Answer the following questions',
				instructions: 'Answer the following questions.'
			});
			if (this.documents.length > 0) {
				addPromptInstruction({
					subtitle: 'Documents',
					instructions: 'Use the provided documents as context for your answer.'
				});
			}
		}

		// Add all instructions
		for (const instruction of this.instructions) {
			addPromptInstruction(instruction);
		}

		// Add JSON formatting instructions if needed
		if (this.expectJson) {
			addPromptInstruction({
				subtitle: 'JSON Response Format',
				instructions: `
                    - Respond **only** with a valid JSON structure.
                    - Properly escape all quotes within content strings
                    - No additional text, comments, or explanations.
                    - Ensure your answer is strictly valid JSON format.
                    - Double check the JSON response to ensure it is valid.
                    - Enclose the json with \`\`\`\`json\` and \` \`\`\` \` tags.
                    `
			});

			if (hasPreviousJsonFailed) {
				addPromptInstruction({
					subtitle: 'CRITICAL',
					instructions: `
                        - Your previous response returned invalid JSON.
                        - Examine your JSON and ensure it is complete and follows the JSON standards.
                        `
				});
			}
		}

		// Add examples if provided
		if (this.examples.length > 0) {
			addPromptInstruction({
				subtitle: 'Examples',
				instructions: ''
			});
			for (const example of this.examples) {
				addPromptExample(example);
			}
		}

		// Add conversation history
		if (this.history.length > 0) {
			prompt += '### Conversation History:' + crlf;
			for (const item of this.history) {
				prompt += `    ${item.role}: ${item.content}` + crlf;
			}
		}

		// Add questions
		if (this.questions.length > 0) {
			if (this.questions.length === 1) {
				prompt += this.questions[0].text + crlf;
			} else {
				this.questions.forEach((question, index) => {
					prompt += `Question ${index + 1}: ${question.text}${crlf}`;
				});
			}
		}

		// Add context
		for (const context of this.context) {
			addPromptContext(context);
		}

		// Add documents
		for (const document of this.documents) {
			addPromptDocument(document);
		}

		return prompt;
	}

	/**
	 * Convert Question to dictionary for serialization.
	 */
	toDict(): Record<string, unknown> {
		return {
			type: this.type,
			filter: this.filter,
			expectJson: this.expectJson,
			role: this.role,
			instructions: this.instructions,
			history: this.history,
			examples: this.examples,
			context: this.context,
			documents: this.documents,
			questions: this.questions
		};
	}

	/**
	 * Create Question from dictionary.
	 */
	static fromDict(data: Record<string, unknown>): Question {
		const question = new Question({
			type: data.type as QuestionType,
			filter: data.filter as DocFilter,
			expectJson: data.expectJson as boolean,
			role: data.role as string
		});

		question.instructions = (data.instructions || []) as QuestionInstruction[];
		question.history = (data.history || []) as QuestionHistory[];
		question.examples = (data.examples || []) as QuestionExample[];
		question.context = (data.context || []) as string[];
		question.documents = (data.documents || []) as Doc[];
		question.questions = (data.questions || []) as QuestionText[];

		return question;
	}
}
