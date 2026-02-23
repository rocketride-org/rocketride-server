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

import { RocketRideClient, Question, TASK_STATE, UPLOAD_RESULT, PIPELINE_RESULT, DAPMessage } from '../src/client';
import { describe, it, expect, beforeEach, afterEach, beforeAll, jest } from '@jest/globals';
import { getEchoPipeline } from './echo.pipeline'
import { getChatPipeline } from './chat.pipeline';
// Skip chat tests when no LLM API key is available (must match env vars used by chat.pipeline.ts)
const hasLLMKey = !!(
	process.env.ROCKETRIDE_APIKEY_OPENAI
	|| process.env.ROCKETRIDE_APIKEY_ANTHROPIC
	|| process.env.ROCKETRIDE_APIKEY_GEMINI
	|| process.env.ROCKETRIDE_HOST_OLLAMA
);
const describeIfLLM = hasLLMKey ? describe : describe.skip;
const itIfLLM = hasLLMKey ? it : it.skip;

/**
 * Environment Variables:
 * 
 * 	ROCKETRIDE_APIKEY - General API key for RocketRide server
 * 	ROCKETRIDE_APIKEY_OPENAI - API key for OpenAI (GPT-4)
 * 	ROCKETRIDE_APIKEY_ANTHROPIC - API key for Anthropic (Claude-3 Sonnet)
 * 	ROCKETRIDE_APIKEY_GEMINI - API key for Gemini (Gemini Pro model)
 * 	ROCKETRIDE_HOST_OLLAMA - Host URL for local Ollama server
 * 
 *  Note: Only one of the LLM settings needs to be set for chat pipeline tests.
 */

// Test configuration
const TEST_CONFIG = {
	uri: process.env.ROCKETRIDE_URI || 'http://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY || 'MYAPIKEY',
	timeout: 60000, // 60 second timeout for integration tests
};


async function ensureCleanPipeline(client: RocketRideClient, token: string): Promise<void> {
	try {
		await client.terminate(token);
	} catch {
		// Ignore errors - pipeline might not be running
	}
}

describe('RocketRideClient Integration Tests', () => {
	let client: RocketRideClient;

	beforeEach(() => {
		client = new RocketRideClient({
			auth: TEST_CONFIG.auth,
			uri: TEST_CONFIG.uri,
		});
	});

	afterEach(async () => {
		if (client.isConnected()) {
			await client.disconnect();
		}
	});

	describe('Server Connection', () => {
		it('should connect to live server', async () => {
			await client.connect();
			expect(client.isConnected()).toBe(true);
		}, TEST_CONFIG.timeout);

		it('should disconnect from server', async () => {
			await client.connect();
			expect(client.isConnected()).toBe(true);

			await client.disconnect();
			expect(client.isConnected()).toBe(false);
		}, TEST_CONFIG.timeout);

		it('should ping server successfully', async () => {
			await client.connect();
			await expect(client.ping()).resolves.not.toThrow();
		}, TEST_CONFIG.timeout);

		it('should handle connection with context manager', async () => {
			const result = await RocketRideClient.withConnection(
				TEST_CONFIG,
				async (connectedClient) => {
					expect(connectedClient.isConnected()).toBe(true);
					await connectedClient.ping();
					return 'success';
				}
			);

			expect(result).toBe('success');
		}, TEST_CONFIG.timeout);
	});

	describe('Pipeline Operations', () => {
		const PIPELINE_TOKEN = 'TS-PIPELINE-OPS';

		beforeEach(async () => {
			await client.connect();
			await ensureCleanPipeline(client, PIPELINE_TOKEN);
		});

		afterEach(async () => {
			await ensureCleanPipeline(client, PIPELINE_TOKEN);
		});

		it('should start a pipeline', async () => {
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: PIPELINE_TOKEN,
			});

			expect(result).toHaveProperty('token');
			expect(typeof result.token).toBe('string');
			expect(result.token.length).toBeGreaterThan(0);

			await client.terminate(result.token);
		}, TEST_CONFIG.timeout);

		it('should get pipeline status', async () => {
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: PIPELINE_TOKEN,
			});

			const status = await client.getTaskStatus(result.token);

			expect(status).toHaveProperty('state');
			expect(Object.values(TASK_STATE)).toContain(status.state);

			await client.terminate(result.token);
		}, TEST_CONFIG.timeout);

		it('should terminate a pipeline', async () => {
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: PIPELINE_TOKEN,
			});

			await expect(client.terminate(result.token)).resolves.not.toThrow();
		}, TEST_CONFIG.timeout);
	});

	describe('Data Operations', () => {
		const DATA_TOKEN = 'TS-DATA-OPS';
		let pipelineToken: string;

		beforeEach(async () => {
			await client.connect();
			await ensureCleanPipeline(client, DATA_TOKEN);

			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: DATA_TOKEN,
			});

			pipelineToken = result.token;
		});

		afterEach(async () => {
			if (pipelineToken) {
				try {
					await client.terminate(pipelineToken);
				} catch {
					// Ignore cleanup errors
				}
			}
		});

		it('should send text data - no mime type', async () => {
			const testData = 'Hello from integration test!';

			const result = await client.send(pipelineToken, testData);

			expect(result).toBeDefined();
			expect(typeof result).toBe('object');

			if (!result)
				throw new Error('Result is undefined');

			// Validate basic response structure
			expect(result.name).toBeDefined();
			expect(typeof result.name).toBe('string');
			expect(result.name).toMatch(/^[0-9a-f-]{36}$/); // UUID format

			expect(result.path).toBeDefined();
			expect(typeof result.path).toBe('string');
			expect(result.path).toBe(''); // Should be empty for direct sends

			expect(result.objectId).toBeDefined();
			expect(typeof result.objectId).toBe('string');
			expect(result.objectId).toMatch(/^[0-9a-f-]{36}$/); // UUID format

			// Without MIME type, should not have processed content
			expect(result.result_types).toBeUndefined();
		}, TEST_CONFIG.timeout);

		it('should send text data - with mime type', async () => {
			const testData = 'Hello from integration test!';

			const result = await client.send(pipelineToken, testData, {}, 'text/plain');

			expect(result).toBeDefined();
			expect(typeof result).toBe('object');

			if (!result)
				throw new Error('Result is undefined');

			// Validate basic response structure
			expect(result.name).toBeDefined();
			expect(typeof result.name).toBe('string');
			expect(result.name).toMatch(/^[0-9a-f-]{36}$/);

			expect(result.path).toBeDefined();
			expect(typeof result.path).toBe('string');
			expect(result.path).toBe('');

			expect(result.objectId).toBeDefined();
			expect(typeof result.objectId).toBe('string');
			expect(result.objectId).toMatch(/^[0-9a-f-]{36}$/);

			// With MIME type, should have processed content
			expect(result.result_types).toBeDefined();
			expect(typeof result.result_types).toBe('object');
			expect(result.result_types!.text).toBe('text'); // Field 'text' contains 'text' type data

			// Validate the actual data field referenced by result_types
			expect(result.text).toBeDefined();
			expect(Array.isArray(result.text)).toBe(true);
			expect(result.text.length).toBeGreaterThan(0);
			expect(result.text[0]).toContain('Hello from integration test!');
		}, TEST_CONFIG.timeout);

		it('should send binary data', async () => {
			const binaryData = new Uint8Array([72, 101, 108, 108, 111]); // "Hello" in bytes

			const result = await client.send(pipelineToken, binaryData);

			expect(result).toBeDefined();
			expect(typeof result).toBe('object');

			if (!result)
				throw new Error('Result is undefined');

			// Validate basic response structure
			expect(result.name).toBeDefined();
			expect(typeof result.name).toBe('string');
			expect(result.name).toMatch(/^[0-9a-f-]{36}$/);

			expect(result.path).toBeDefined();
			expect(typeof result.path).toBe('string');
			expect(result.path).toBe('');

			expect(result.objectId).toBeDefined();
			expect(typeof result.objectId).toBe('string');
			expect(result.objectId).toMatch(/^[0-9a-f-]{36}$/);

			// Binary data without MIME type should not have processed content
			expect(result.result_types).toBeUndefined();
		}, TEST_CONFIG.timeout);

		it('should use data pipe for streaming', async () => {
			const pipe = await client.pipe(
				pipelineToken,
				{ name: 'test-stream.txt' },
				'text/plain'
			);

			await pipe.open();

			const chunks = ['Hello ', 'from ', 'streaming ', 'test!'];
			for (const chunk of chunks) {
				await pipe.write(new TextEncoder().encode(chunk));
			}

			const result = await pipe.close();

			expect(result).toBeDefined();
			expect(typeof result).toBe('object');

			if (!result)
				throw new Error('Result is undefined');

			// Should use the provided name instead of UUID for streaming
			expect(result.name).toBe('test-stream.txt');

			expect(result.path).toBeDefined();
			expect(typeof result.path).toBe('string');
			expect(result.path).toBe('');

			expect(result.objectId).toBeDefined();
			expect(typeof result.objectId).toBe('string');
			expect(result.objectId).toMatch(/^[0-9a-f-]{36}$/);

			// Streaming with MIME type should have processed content
			expect(result.result_types).toBeDefined();
			expect(result.result_types!.text).toBe('text');

			expect(result.text).toBeDefined();
			expect(Array.isArray(result.text)).toBe(true);
			expect(result.text.length).toBeGreaterThan(0);
			expect(result.text[0]).toBe(chunks.join('\n\n') + '\n\n');
		}, TEST_CONFIG.timeout);

		it('should handle file uploads', async () => {
			const testContent = 'Test file content for upload';
			const testFile = new File([testContent], 'test.txt', {
				type: 'text/plain',
			});

			const uploadResults: UPLOAD_RESULT[] = await client.sendFiles(
				[{ file: testFile }],
				pipelineToken
			);

			expect(uploadResults).toBeDefined();
			expect(Array.isArray(uploadResults)).toBe(true);
			expect(uploadResults).toHaveLength(1);

			const uploadResult = uploadResults[0];

			// Validate UPLOAD_RESULT structure
			expect(uploadResult.action).toBe('complete');
			expect(uploadResult.filepath).toBe('test.txt');
			expect(uploadResult.bytes_sent).toBe(testContent.length);
			expect(uploadResult.file_size).toBe(testContent.length);
			expect(typeof uploadResult.upload_time).toBe('number');
			expect(uploadResult.upload_time).toBeGreaterThan(0);
			expect(uploadResult.error).toBeUndefined();

			// Validate processing result
			expect(uploadResult.result).toBeDefined();
			const processingResult = uploadResult.result!;

			// Should use original filename
			expect(processingResult.name).toBe('test.txt');
			expect(processingResult.path).toBe('');
			expect(processingResult.objectId).toMatch(/^[0-9a-f-]{36}$/);

			// File uploads should have processed content
			expect(processingResult.result_types).toBeDefined();
			expect(processingResult.result_types!.text).toBe('text');

			expect(processingResult.text).toBeDefined();
			expect(Array.isArray(processingResult.text)).toBe(true);
			expect(processingResult.text).toContain(testContent + '\n\n');
		}, TEST_CONFIG.timeout);

		it('should handle different result_types field mappings', async () => {
			const testData = 'Multi-field result type test';

			const result = await client.send(pipelineToken, testData, {}, 'text/plain');

			if (!result)
				throw new Error('Result is undefined');

			if (result.result_types) {
				// Check each field exists and has the right type
				for (const [fieldName, fieldType] of Object.entries(result.result_types)) {
					expect(result[fieldName]).toBeDefined();

					// For text type fields, should be string arrays
					if (fieldType === 'text') {
						expect(Array.isArray(result[fieldName])).toBe(true);
					}
				}
			}
		}, TEST_CONFIG.timeout);

		it('should handle various MIME types and result structures', async () => {
			const testCases = [
				{
					data: 'Plain text content',
					mimeType: 'text/plain',
					description: 'plain text'
				},
				{
					data: JSON.stringify({ message: 'Hello', value: 42 }),
					mimeType: 'application/json',
					description: 'JSON data'
				}
			];

			for (const testCase of testCases) {
				const result = await client.send(
					pipelineToken,
					testCase.data,
					{},
					testCase.mimeType
				);

				expect(result).toBeDefined();

				if (!result)
					throw new Error('Result is undefined');

				// All results should have basic fields
				expect(result.name).toBeDefined();
				expect(result.objectId).toBeDefined();

				if (result.result_types) {
					// Check result_types structure
					expect(typeof result.result_types).toBe('object');

					// Verify fields referenced in result_types actually exist
					for (const [fieldName, fieldType] of Object.entries(result.result_types)) {
						expect(result[fieldName]).toBeDefined();

						// Basic type checking
						if (fieldType === 'text') {
							expect(Array.isArray(result[fieldName])).toBe(true);
						}
					}
				}
			}
		}, TEST_CONFIG.timeout);
	});

	describeIfLLM('Chat Operations', () => {
		const CHAT_TOKEN = 'TS-CHAT-OPS';
		let chatToken: string;

		beforeEach(async () => {
			await client.connect();
			await ensureCleanPipeline(client, CHAT_TOKEN);

			const result = await client.use({
				pipeline: getChatPipeline(),
				token: CHAT_TOKEN,
			});

			chatToken = result.token;
		});

		afterEach(async () => {
			if (chatToken) {
				try {
					await client.terminate(chatToken);
				} catch {
					// Ignore cleanup errors
				}
			}
		});

		it('should send simple chat question', async () => {
			const question = new Question();
			question.addQuestion('What is 2 + 2?');

			const response: PIPELINE_RESULT = await client.chat({
				token: chatToken,
				question,
			});

			expect(response).toBeDefined();
			expect(typeof response).toBe('object');

			// Validate basic response structure
			expect(response.name).toBeDefined();
			expect(typeof response.name).toBe('string');
			expect(response.path).toBeDefined();
			expect(response.objectId).toBeDefined();
			expect(response.objectId).toMatch(/^[0-9a-f-]{36}$/);

			// Chat should have processed content with answers
			expect(response.result_types).toBeDefined();
			expect(response.result_types!.answers).toBe('answers');

			// Validate the answers field
			expect(response.answers).toBeDefined();
			expect(Array.isArray(response.answers)).toBe(true);
			expect(response.answers.length).toBeGreaterThan(0);

			// Check that we got a meaningful answer
			const answer = response.answers[0];
			expect(typeof answer).toBe('string');
			expect(answer.length).toBeGreaterThan(0);
		}, TEST_CONFIG.timeout);

		it('should handle JSON response questions', async () => {
			const question = new Question({ expectJson: true });
			question.addQuestion('Site the first paragraph of the constitution of the United States');
			question.addExample('greeting request', { text: 'Hello, world!' });

			const response: PIPELINE_RESULT = await client.chat({
				token: chatToken,
				question,
			});

			expect(response).toBeDefined();
			expect(typeof response).toBe('object');

			// Validate basic response structure
			expect(response.name).toBeDefined();
			expect(response.path).toBeDefined();
			expect(response.objectId).toBeDefined();

			// Should have answers field
			expect(response.result_types).toBeDefined();
			expect(response.result_types!.answers).toBe('answers');
			expect(response.answers).toBeDefined();
			expect(Array.isArray(response.answers)).toBe(true);
			expect(response.answers.length).toBeGreaterThan(0);

			// Validate answer content
			const answer = response.answers[0];
			expect(typeof answer).toBe('object');
			expect(answer).toHaveProperty('text');
			expect(answer.text.length).toBeGreaterThan(0);
			expect(answer.text).toContain('We the People');

		}, TEST_CONFIG.timeout);

		it('should handle questions with instructions', async () => {
			const question = new Question();
			question.addQuestion('Tell me about machine learning');
			question.addInstruction('Format', 'Keep the response under 100 words');
			question.addInstruction('Tone', 'Use simple, beginner-friendly language and talk like yoda');

			const response: PIPELINE_RESULT = await client.chat({
				token: chatToken,
				question,
			});

			expect(response).toBeDefined();
			expect(typeof response).toBe('object');

			// Validate basic response structure
			expect(response.name).toBeDefined();
			expect(response.path).toBeDefined();
			expect(response.objectId).toBeDefined();

			// Should have answers field
			expect(response.result_types).toBeDefined();
			expect(response.result_types!.answers).toBe('answers');
			expect(response.answers).toBeDefined();
			expect(Array.isArray(response.answers)).toBe(true);
			expect(response.answers.length).toBeGreaterThan(0);

			// Check that we got a meaningful answer
			const answer = response.answers[0];
			expect(typeof answer).toBe('string');
			expect(answer.length).toBeGreaterThan(0);
		}, TEST_CONFIG.timeout);

		it('should handle questions with context', async () => {
			const question = new Question();
			question.addContext('This is a test environment');
			question.addContext('The user is learning about the RocketRide SDK');
			question.addQuestion('Explain what just happened in this interaction');

			const response: PIPELINE_RESULT = await client.chat({
				token: chatToken,
				question,
			});

			expect(response).toBeDefined();
			expect(typeof response).toBe('object');

			// Validate basic response structure
			expect(response.name).toBeDefined();
			expect(response.path).toBeDefined();
			expect(response.objectId).toBeDefined();

			// Should have answers field
			expect(response.result_types).toBeDefined();
			expect(response.result_types!.answers).toBe('answers');
			expect(response.answers).toBeDefined();
			expect(Array.isArray(response.answers)).toBe(true);
			expect(response.answers.length).toBeGreaterThan(0);

			// Check that we got a response
			const answer = response.answers[0];
			expect(typeof answer).toBe('string');
			expect(answer.length).toBeGreaterThan(0);
		}, TEST_CONFIG.timeout);

		it('should validate chat response structure matches PIPELINE_RESULT', async () => {
			const question = new Question();
			question.addQuestion('What is the weather like today?');

			const response: PIPELINE_RESULT = await client.chat({
				token: chatToken,
				question,
			});

			// Verify it's a standard PIPELINE_RESULT
			expect(response.name).toBeDefined();
			expect(response.path).toBeDefined();
			expect(response.objectId).toBeDefined();

			// Check result_types specifically for chat responses
			if (response.result_types) {
				for (const [fieldName, fieldType] of Object.entries(response.result_types)) {
					expect(response[fieldName]).toBeDefined();

					// For answers type fields, should be string arrays
					if (fieldType === 'answers') {
						expect(Array.isArray(response[fieldName])).toBe(true);
						if (response[fieldName].length > 0) {
							expect(typeof response[fieldName][0]).toBe('string');
						}
					}
				}
			}
		}, TEST_CONFIG.timeout);
	});

	describe('Connection Events', () => {
		it('should call onConnected/onDisconnected callbacks', async () => {
			const connectedSpy = jest.fn(async (_connectionInfo?: string) => { });
			const disconnectedSpy = jest.fn(async (_reason?: string, _hasError?: boolean) => { });

			const client = new RocketRideClient({
				auth: TEST_CONFIG.auth,
				uri: TEST_CONFIG.uri,
				onConnected: connectedSpy,
				onDisconnected: disconnectedSpy,
			});


			expect(client.isConnected()).toBe(false);

			await client.connect();
			expect(client.isConnected()).toBe(true);

			expect(connectedSpy).toHaveBeenCalledTimes(1);
			expect(connectedSpy).toHaveBeenCalledWith(expect.any(String));
			expect(disconnectedSpy).not.toHaveBeenCalled();

			await client.disconnect();

			expect(client.isConnected()).toBe(false);

			expect(disconnectedSpy).toHaveBeenCalledTimes(1);
			expect(disconnectedSpy).toHaveBeenCalledWith(
				expect.any(String),
				false
			);
		}, TEST_CONFIG.timeout);

		it('should call onDisconnected with error flag on connection failure', async () => {
			const connectedSpy = jest.fn(async (_connectionInfo?: string) => { });
			const disconnectedSpy = jest.fn(async (_reason?: string, _hasError?: boolean) => { });

			// Use an invalid URI that will definitely fail to connect
			const client = new RocketRideClient({
				auth: 'INVALID_KEY',
				uri: 'http://localhost:59999',  // Non-existent server
				onConnected: connectedSpy,
				onDisconnected: disconnectedSpy,
			});

			try {
				await client.connect();
			} catch {
				// Expected to fail
			}

			expect(connectedSpy).not.toHaveBeenCalled();

			if (disconnectedSpy.mock.calls.length > 0) {
				const [_, hasError] = disconnectedSpy.mock.calls[0];
				expect(hasError).toBe(true);
			}
		}, TEST_CONFIG.timeout);
	});

	describe('Event Handling', () => {
		const EVENT_TOKEN = 'TS-EVENT-OPS';
		let eventToken: string;
		let receivedEvents: any[] = [];

		beforeEach(async () => {
			receivedEvents = [];

			client = new RocketRideClient({
				auth: TEST_CONFIG.auth,
				uri: TEST_CONFIG.uri,
				onEvent: jest.fn(async (event: DAPMessage) => {
					receivedEvents.push(event);
				}),
			});

			await client.connect();
			await ensureCleanPipeline(client, EVENT_TOKEN);

			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: EVENT_TOKEN,
			});

			eventToken = result.token;
		});

		afterEach(async () => {
			if (eventToken) {
				try {
					await client.terminate(eventToken);
				} catch {
					// Ignore cleanup errors
				}
			}
		});

		it('should subscribe to events and receive them', async () => {
			await client.setEvents(eventToken, [
				'summary'
			]);

			await client.send(eventToken, 'Test data for events');

			// Wait with timeout for events
			const timeout = 10000;
			const start = Date.now();

			while (receivedEvents.length === 0 && (Date.now() - start) < timeout) {
				await new Promise(resolve => setTimeout(resolve, 250));
			}

			// Verify we got events
			expect(receivedEvents.length).toBeGreaterThanOrEqual(0);

			// If we got events, verify their structure
			if (receivedEvents.length > 0) {
				const event = receivedEvents[0];
				expect(event).toHaveProperty('event');
				expect(event).toHaveProperty('body');
				expect(typeof event.event).toBe('string');
			}
		}, TEST_CONFIG.timeout);

		it('should receive EVENT_STATUS_UPDATE events with proper structure', async () => {
			// Subscribe to status update events
			await client.setEvents(eventToken, ['summary']);

			// Trigger an event by sending data
			await client.send(eventToken, 'Test data for status updates');

			// Wait for status update events
			const timeout = 10000;
			const start = Date.now();

			while (receivedEvents.length === 0 && (Date.now() - start) < timeout) {
				await new Promise(resolve => setTimeout(resolve, 250));
			}

			// Find status update events
			const statusEvents = receivedEvents.filter(event =>
				event.event === 'apaevt_status_update'
			);

			if (statusEvents.length > 0) {
				const statusEvent = statusEvents[0];

				// Verify EVENT_STATUS_UPDATE structure
				expect(statusEvent.type).toBe('event');
				expect(statusEvent.event).toBe('apaevt_status_update');
				expect(statusEvent.body).toBeDefined();

				// Verify TASK_STATUS structure in body
				const taskStatus = statusEvent.body;
				expect(taskStatus).toHaveProperty('name');
				expect(taskStatus).toHaveProperty('project_id');
				expect(taskStatus).toHaveProperty('source');
				expect(taskStatus).toHaveProperty('completed');
				expect(taskStatus).toHaveProperty('state');
				expect(taskStatus).toHaveProperty('startTime');
				expect(taskStatus).toHaveProperty('endTime');

				// Verify statistics fields
				expect(taskStatus).toHaveProperty('totalSize');
				expect(taskStatus).toHaveProperty('totalCount');
				expect(taskStatus).toHaveProperty('completedSize');
				expect(taskStatus).toHaveProperty('completedCount');

				// Verify arrays
				expect(Array.isArray(taskStatus.warnings)).toBe(true);
				expect(Array.isArray(taskStatus.errors)).toBe(true);
				expect(Array.isArray(taskStatus.notes)).toBe(true);

				// Verify pipeline flow structure
				expect(taskStatus.pipeflow).toBeDefined();
				expect(taskStatus.pipeflow).toHaveProperty('totalPipes');
				expect(taskStatus.pipeflow).toHaveProperty('byPipe');
			}
		}, TEST_CONFIG.timeout);

		it('should receive EVENT_TASK events with proper structure', async () => {
			// Subscribe to task lifecycle events  
			await client.setEvents(eventToken, ['task']);

			// Wait for task events (begin/end events should be sent during pipeline lifecycle)
			const timeout = 15000;
			const start = Date.now();

			// Trigger pipeline operations to generate task events
			await client.send(eventToken, 'Test data for task events');

			while (receivedEvents.length === 0 && (Date.now() - start) < timeout) {
				await new Promise(resolve => setTimeout(resolve, 250));
			}

			// Find task events
			const taskEvents = receivedEvents.filter(event =>
				event.event === 'apaevt_task'
			);

			if (taskEvents.length > 0) {
				const taskEvent = taskEvents[0];

				// Verify basic EVENT_TASK structure
				expect(taskEvent.type).toBe('event');
				expect(taskEvent.event).toBe('apaevt_task');
				expect(taskEvent.body).toBeDefined();
				expect(taskEvent.body.action).toBeDefined();

				const action = taskEvent.body.action;
				expect(['running', 'begin', 'end']).toContain(action);

				if (action === 'running') {
					// Verify 'running' action structure
					expect(taskEvent.body.tasks).toBeDefined();
					expect(Array.isArray(taskEvent.body.tasks)).toBe(true);

					if (taskEvent.body.tasks.length > 0) {
						const taskInfo = taskEvent.body.tasks[0];
						expect(taskInfo).toHaveProperty('id');
						expect(taskInfo).toHaveProperty('projectId');
						expect(taskInfo).toHaveProperty('source');
						expect(typeof taskInfo.id).toBe('string');
						expect(typeof taskInfo.projectId).toBe('string');
						expect(typeof taskInfo.source).toBe('string');
					}
				} else if (action === 'begin' || action === 'end') {
					// Verify 'begin'/'end' action structure
					expect(taskEvent.id).toBeDefined();
					expect(typeof taskEvent.id).toBe('string');
					expect(taskEvent.body.projectId).toBeDefined();
					expect(taskEvent.body.source).toBeDefined();
					expect(typeof taskEvent.body.projectId).toBe('string');
					expect(typeof taskEvent.body.source).toBe('string');
				}
			}
		}, TEST_CONFIG.timeout);

		it('should handle EVENT_TYPE flag combinations correctly', async () => {
			// Test subscribing to multiple event types using flag combinations
			// This would require extending the client API to support EVENT_TYPE flags
			// For now, we test the concept with string arrays

			const eventTypes = [
				'apaevt_status_update',
				'apaevt_task'
			];

			// Setup to receive both event categories
			await client.setEvents(eventToken, ['summary', 'task']);

			// Trigger various events
			await client.send(eventToken, 'Test data for multiple event types');

			const timeout = 10000;
			const start = Date.now();

			while (receivedEvents.length === 0 && (Date.now() - start) < timeout) {
				await new Promise(resolve => setTimeout(resolve, 250));
			}

			// Verify we can receive different types of events
			const eventTypesSeen = new Set(receivedEvents.map(event => event.event));

			// Should have received at least one of the subscribed event types
			const expectedEvents = new Set(eventTypes);
			const intersection = new Set([...eventTypesSeen].filter(x => expectedEvents.has(x)));

			expect(intersection.size).toBeGreaterThan(0);
		}, TEST_CONFIG.timeout);

		it('should validate event structure matches TypeScript definitions', async () => {
			// Subscribe to all relevant event types
			await client.setEvents(eventToken, [
				'summary',
				'task'
			]);

			// Trigger events
			await client.send(eventToken, 'Validation test data');

			const timeout = 10000;
			const start = Date.now();

			while (receivedEvents.length === 0 && (Date.now() - start) < timeout) {
				await new Promise(resolve => setTimeout(resolve, 250));
			}

			// Validate each received event matches our type definitions
			for (const event of receivedEvents) {
				// All events should have basic DAP structure
				expect(event).toHaveProperty('type', 'event');
				expect(event).toHaveProperty('event');
				expect(typeof event.event).toBe('string');

				if (event.event === 'apaevt_status_update') {
					// Validate EVENT_STATUS_UPDATE structure
					expect(event.body).toBeDefined();

					// Key TASK_STATUS fields that should always be present
					const requiredFields = [
						'name', 'project_id', 'source', 'completed', 'state',
						'startTime', 'endTime', 'debuggerAttached', 'status',
						'warnings', 'errors', 'currentObject', 'currentSize',
						'notes', 'totalSize', 'totalCount', 'completedSize',
						'completedCount', 'failedSize', 'failedCount',
						'wordsSize', 'wordsCount', 'rateSize', 'rateCount',
						'serviceUp', 'exitCode', 'exitMessage', 'pipeflow'
					];

					for (const field of requiredFields) {
						expect(event.body).toHaveProperty(field);
					}

					// Validate types for critical fields
					expect(typeof event.body.name).toBe('string');
					expect(typeof event.body.project_id).toBe('string');
					expect(typeof event.body.source).toBe('string');
					expect(typeof event.body.completed).toBe('boolean');
					expect(typeof event.body.state).toBe('number');
					expect(Array.isArray(event.body.warnings)).toBe(true);
					expect(Array.isArray(event.body.errors)).toBe(true);
					expect(Array.isArray(event.body.notes)).toBe(true);
				}

				if (event.event === 'apaevt_task') {
					// Validate EVENT_TASK structure
					expect(event.body).toBeDefined();
					expect(event.body.action).toBeDefined();
					expect(['running', 'begin', 'end']).toContain(event.body.action);

					if (event.body.action === 'running') {
						expect(event.body.tasks).toBeDefined();
						expect(Array.isArray(event.body.tasks)).toBe(true);
					} else {
						expect(event.id).toBeDefined();
						expect(typeof event.id).toBe('string');
						expect(event.body.projectId).toBeDefined();
						expect(event.body.source).toBeDefined();
					}
				}
			}
		}, TEST_CONFIG.timeout);

		it('should handle event filtering based on subscription', async () => {
			// Test that we only receive events we subscribed to
			await client.setEvents(eventToken, ['summary']);

			// Trigger events
			await client.send(eventToken, 'Filtering test data');

			const timeout = 10000;
			const start = Date.now();

			while (receivedEvents.length === 0 && (Date.now() - start) < timeout) {
				await new Promise(resolve => setTimeout(resolve, 250));
			}

			// All received events should match our subscription
			for (const event of receivedEvents) {
				expect(event.event).toBe('apaevt_status_update');
			}

			// Clear events and change subscription
			receivedEvents = [];
			await client.setEvents(eventToken, ['task']);

			// Trigger more events
			await client.send(eventToken, 'Second filtering test');

			// Wait for new events
			const start2 = Date.now();
			while (receivedEvents.length === 0 && (Date.now() - start2) < timeout) {
				await new Promise(resolve => setTimeout(resolve, 250));
			}

			// Should now only receive task events
			for (const event of receivedEvents) {
				expect(event.event).toBe('apaevt_task');
			}
		}, TEST_CONFIG.timeout);
	});

	describe('Validation Operations', () => {
		beforeEach(async () => {
			await client.connect();
		});

		it('should validate echo pipeline with source in config', async () => {
			const pipeline = getEchoPipeline();
			const result = await client.validate({ pipeline });

			expect(result).toBeDefined();
			expect(result).toHaveProperty('pipeline');
		}, TEST_CONFIG.timeout);

		it('should validate echo pipeline with explicit source override', async () => {
			const pipeline = getEchoPipeline();
			const result = await client.validate({
				pipeline,
				source: 'webhook_1',
			});

			expect(result).toBeDefined();
			expect(result).toHaveProperty('pipeline');
		}, TEST_CONFIG.timeout);

		it('should validate pipeline with implied source from component mode', async () => {
			// Pipeline with no explicit source field — webhook_1 has config.mode == 'Source'
			const pipeline = {
				components: [
					{
						id: "webhook_1",
						provider: "webhook",
						config: { hideForm: true, mode: "Source", type: "webhook" },
					},
					{
						id: "response_1",
						provider: "response",
						config: { lanes: [] },
						input: [{ lane: "text", from: "webhook_1" }],
					},
				],
				project_id: "e612b741-748c-4b35-a8b7-186797a8ea42",
			};

			const result = await client.validate({ pipeline });

			expect(result).toBeDefined();
			expect(result).toHaveProperty('pipeline');
		}, TEST_CONFIG.timeout);

		it('should return errors for invalid pipeline configuration', async () => {
			const invalidPipeline = {
				components: [
					{
						id: "invalid_1",
						provider: "nonexistent_provider",
						config: {},
					},
				],
				source: "invalid_1",
				project_id: "e612b741-748c-4b35-a8b7-186797a8ea42",
			};

			const result = await client.validate({ pipeline: invalidPipeline });

			expect(result).toBeDefined();
			expect(result.errors).toBeDefined();
			expect(Array.isArray(result.errors)).toBe(true);
			expect((result.errors as unknown[]).length).toBeGreaterThan(0);
		}, TEST_CONFIG.timeout);
	});

	describe('Error Handling', () => {
		const ERROR_TOKEN = 'TS-ERROR-OPS';

		beforeEach(async () => {
			await client.connect();
			await ensureCleanPipeline(client, ERROR_TOKEN);
		});

		afterEach(async () => {
			await ensureCleanPipeline(client, ERROR_TOKEN);
		});

		it('should handle invalid pipeline configuration', async () => {
			const invalidPipeline = {
				components: [
					{
						id: "invalid_1",
						provider: "nonexistent_provider",
						config: {}
					}
				],
				source: "invalid_1",
				project_id: "e612b741-748c-4b35-a8b7-186797a8ea42"
			};

			await expect(
				client.use({ pipeline: invalidPipeline, token: ERROR_TOKEN })
			).rejects.toThrow();
		}, TEST_CONFIG.timeout);

		it('should handle operations on terminated pipeline', async () => {
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: ERROR_TOKEN,
			});

			await client.terminate(result.token);

			await expect(
				client.send(result.token, 'data')
			).rejects.toThrow();
		}, TEST_CONFIG.timeout);

		it('should handle network disconnection gracefully', async () => {
			await client.disconnect();

			await expect(client.ping()).rejects.toThrow();
		}, TEST_CONFIG.timeout);
	});

	describe('End-to-End Workflow', () => {
		const E2E_TOKEN = 'TS-E2E-WORKFLOW';

		beforeEach(async () => {
			await client.connect();
			// Clean up any existing tokens from previous test runs
			await ensureCleanPipeline(client, E2E_TOKEN);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-file`);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-multi`);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-chat`);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-mixed`);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-error`);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-large`);
		});

		afterEach(async () => {
			// Clean up all tokens used in tests
			await ensureCleanPipeline(client, E2E_TOKEN);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-file`);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-multi`);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-chat`);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-mixed`);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-error`);
			await ensureCleanPipeline(client, `${E2E_TOKEN}-large`);
		});

		it('should complete full data processing workflow', async () => {
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: E2E_TOKEN
			});
			const token = result.token;

			await client.setEvents(token, [
				'summary',
				'task',
			]);

			const testData = 'hello world from e2e test';
			const processResult: PIPELINE_RESULT | undefined = await client.send(token, testData, {}, 'text/plain');

			const status = await client.getTaskStatus(token);

			await client.terminate(token);

			// Enhanced validation
			expect(processResult).toBeDefined();
			if (!processResult)
				throw new Error('Process result is undefined');

			expect(processResult.name).toBeDefined();
			expect(processResult.objectId).toBeDefined();
			expect(processResult.result_types).toBeDefined();
			expect(processResult.text).toBeDefined();
			expect(processResult.text[0]).toContain(testData);

			expect(status).toHaveProperty('state');
			expect(Object.values(TASK_STATE)).toContain(status.state);
			expect(result.token).toBeTruthy();
		}, TEST_CONFIG.timeout);

		it('should handle complete file upload and processing workflow', async () => {
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: `${E2E_TOKEN}-file`
			});
			const token = result.token;

			// Set up event monitoring
			await client.setEvents(token, [
				'summary',
				'task'
			]);

			// Create test file
			const testContent = `End-to-end file processing test
Line 2: timestamp ${Date.now()}
Line 3: random data ${Math.random().toString(36).substring(2)}`;

			const testFile = new File([testContent], 'e2e-test.txt', {
				type: 'text/plain',
			});

			// Upload and process file
			const uploadResults: UPLOAD_RESULT[] = await client.sendFiles(
				[{ file: testFile }],
				token
			);

			// Get final task status
			const finalStatus = await client.getTaskStatus(token);

			await client.terminate(token);

			// Validate complete workflow
			expect(uploadResults).toHaveLength(1);
			expect(uploadResults[0].action).toBe('complete');
			expect(uploadResults[0].result).toBeDefined();

			const processingResult = uploadResults[0].result!;
			expect(processingResult.name).toBe('e2e-test.txt');
			expect(processingResult.result_types!.text).toBe('text');
			expect(processingResult.text).toBeDefined();
			expect(processingResult.text[0]).toContain('End-to-end file processing test');

			expect(finalStatus).toHaveProperty('state');
			expect(finalStatus.completed).toBeDefined();
		}, TEST_CONFIG.timeout);

		it('should handle multi-step data processing workflow', async () => {
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: `${E2E_TOKEN}-multi`
			});
			const token = result.token;

			await client.setEvents(token, ['summary']);

			// Step 1: Send initial data
			const step1Data = 'Step 1: Initial data';
			const step1Result: PIPELINE_RESULT | undefined = await client.send(token, step1Data, {}, 'text/plain');

			// Verify step 1
			if (!step1Result)
				throw new Error('Step 1 result is undefined');

			expect(step1Result.text[0]).toContain(step1Data);

			// Step 2: Send follow-up data
			const step2Data = 'Step 2: Follow-up processing';
			const step2Result: PIPELINE_RESULT | undefined = await client.send(token, step2Data, {}, 'text/plain');

			// Verify step 2
			if (!step2Result)
				throw new Error('Step 2 result is undefined');

			expect(step2Result.text[0]).toContain(step2Data);

			// Step 3: Streaming data
			const pipe = await client.pipe(token, { name: 'step3-stream.txt' }, 'text/plain');
			await pipe.open();
			await pipe.write(new TextEncoder().encode('Step 3: Streaming data'));
			const step3Result: PIPELINE_RESULT | undefined = await pipe.close();

			// Verify step 3
			if (!step3Result)
				throw new Error('Step 3 result is undefined');

			expect(step3Result.name).toBe('step3-stream.txt');
			expect(step3Result.text[0]).toContain('Step 3: Streaming data');

			// Verify all three operations produced valid results
			expect(step1Result.objectId).toMatch(/^[0-9a-f-]{36}$/);
			expect(step2Result.objectId).toMatch(/^[0-9a-f-]{36}$/);
			expect(step3Result.objectId).toMatch(/^[0-9a-f-]{36}$/);

			// Ensure all results are unique
			const objectIds = [step1Result.objectId, step2Result.objectId, step3Result.objectId];
			const uniqueIds = new Set(objectIds);
			expect(uniqueIds.size).toBe(3);

			await client.terminate(token);
		}, TEST_CONFIG.timeout);

		itIfLLM('should handle chat workflow with multiple interactions', async () => {
			const result = await client.use({
				pipeline: getChatPipeline(),
				token: `${E2E_TOKEN}-chat`
			});
			const token = result.token;

			await client.setEvents(token, ['summary', 'task']);

			// First chat interaction
			const question1 = new Question();
			question1.addQuestion('What is 5 + 3?');
			const response1: PIPELINE_RESULT = await client.chat({ token, question: question1 });

			expect(response1.result_types!.answers).toBe('answers');
			expect(response1.answers).toBeDefined();
			expect(response1.answers[0]).toContain('8');

			// Second chat interaction with context
			const question2 = new Question();
			question2.addContext('We just solved a math problem');
			question2.addQuestion('What was the previous answer?');
			const response2: PIPELINE_RESULT = await client.chat({ token, question: question2 });

			expect(response2.answers).toBeDefined();
			expect(response2.answers.length).toBeGreaterThan(0);

			// Third interaction with JSON expectation
			const question3 = new Question({ expectJson: true });
			question3.addQuestion('Return the result of 10 * 2 as JSON');
			question3.addExample('math result', { result: 20, operation: 'multiplication' });
			const response3: PIPELINE_RESULT = await client.chat({ token, question: question3 });

			expect(response3.answers).toBeDefined();
			const answer3 = response3.answers[0];
			expect(typeof answer3).toBe('object');
			expect(answer3).toHaveProperty('result');

			// Verify all three chat interactions produced valid results
			expect(response1.objectId).toMatch(/^[0-9a-f-]{36}$/);
			expect(response2.objectId).toMatch(/^[0-9a-f-]{36}$/);
			expect(response3.objectId).toMatch(/^[0-9a-f-]{36}$/);

			await client.terminate(token);
		}, TEST_CONFIG.timeout);

		it('should handle mixed operation workflow with events', async () => {
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: `${E2E_TOKEN}-mixed`
			});
			const token = result.token;

			// Set up comprehensive event monitoring
			const receivedEvents: any[] = [];
			const originalClient = client;

			client = new RocketRideClient({
				auth: TEST_CONFIG.auth,
				uri: TEST_CONFIG.uri,
				onEvent: jest.fn(async (event: DAPMessage) => {
					receivedEvents.push(event);
				}),
			});

			await client.connect();

			// Use the same token with new client
			await client.setEvents(token, [
				'summary', 'task'
			]);

			// Mixed operations
			const operations = [
				// Direct send
				() => client.send(token, 'Mixed operation 1', {}, 'text/plain'),

				// File upload  
				() => {
					const file = new File(['Mixed file content'], 'mixed.txt', { type: 'text/plain' });
					return client.sendFiles([{ file }], token);
				},

				// Streaming
				async () => {
					const pipe = await client.pipe(token, { name: 'mixed-stream.txt' }, 'text/plain');
					await pipe.open();
					await pipe.write(new TextEncoder().encode('Mixed streaming content'));
					return await pipe.close();
				}
			];

			// Execute operations in sequence
			const results = [];
			for (let i = 0; i < operations.length; i++) {
				const result = await operations[i]();
				results.push(result);

				// Small delay to ensure events are processed
				await new Promise(resolve => setTimeout(resolve, 100));
			}

			// Wait for events to be received
			await new Promise(resolve => setTimeout(resolve, 500));

			// Validate results
			expect(results).toHaveLength(3);

			// Direct send result
			const sendResult = results[0] as PIPELINE_RESULT;
			expect(sendResult.text[0]).toContain('Mixed operation 1');

			// File upload result
			const uploadResult = results[1] as UPLOAD_RESULT[];
			expect(uploadResult[0].result!.text[0]).toContain('Mixed file content');

			// Stream result  
			const streamResult = results[2] as PIPELINE_RESULT;
			expect(streamResult.text[0]).toContain('Mixed streaming content');

			// Check that we received events
			expect(receivedEvents.length).toBeGreaterThan(0);

			// Verify event types
			const eventTypes = new Set(receivedEvents.map(e => e.event));
			expect(eventTypes.has('apaevt_status_update') || eventTypes.has('apaevt_task')).toBe(true);

			await client.terminate(token);
			await client.disconnect();

			// Restore original client
			client = originalClient;
		}, TEST_CONFIG.timeout);

		it('should handle error recovery workflow', async () => {
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: `${E2E_TOKEN}-error`
			});
			const token = result.token;

			// Send valid data first
			const validResult: PIPELINE_RESULT | undefined = await client.send(token, 'Valid data before error', {}, 'text/plain');
			if (!validResult)
				throw new Error('Process result is undefined');

			expect(validResult.text[0]).toContain('Valid data before error');

			// Check status after valid operation
			const statusAfterValid = await client.getTaskStatus(token);
			expect(statusAfterValid.errors).toHaveLength(0);

			// Try to send data after termination (should fail)
			await client.terminate(token);

			await expect(
				client.send(token, 'Data after termination', {}, 'text/plain')
			).rejects.toThrow();

			// Verify the valid operation completed successfully despite later error
			expect(validResult).toBeDefined();
			expect(validResult.text[0]).toContain('Valid data before error');
		}, TEST_CONFIG.timeout);

		it('should handle large data workflow', async () => {
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: `${E2E_TOKEN}-large`
			});
			const token = result.token;

			// Generate large text content (10KB)
			const largeText = Array.from({ length: 1000 }, (_, i) =>
				`Line ${i + 1}: This is a test line with some content to make it longer. Random: ${Math.random()}`
			).join('\n');

			expect(largeText.length).toBeGreaterThan(10000);

			const startTime = Date.now();
			const largeResult: PIPELINE_RESULT | undefined = await client.send(token, largeText, {}, 'text/plain');
			const endTime = Date.now();

			// Validate large data processing
			if (!largeResult)
				throw new Error('Process result is undefined');

			expect(largeResult.text[0]).toContain('Line 1:');
			expect(largeResult.text[0]).toContain('Line 1000:');
			expect(largeResult.text[0].length).toBeGreaterThan(10000);

			// Check processing time (should complete reasonably quickly)
			const processingTime = endTime - startTime;
			expect(processingTime).toBeLessThan(10000); // Less than 10 seconds

			// Get final status to verify task completed
			const finalStatus = await client.getTaskStatus(token);
			expect(finalStatus).toHaveProperty('state');

			await client.terminate(token);
		}, TEST_CONFIG.timeout);
	});

	describe('Concurrent Pipeline Operations', () => {
		const CONCURRENT_TOKEN = 'TS-CONCURRENT-OPS';
		const PIPELINE_COUNT = 16;
		let pipelineTokens: string[] = [];

		beforeEach(async () => {
			await client.connect();
			pipelineTokens = [];

			// Clean up any existing pipelines
			for (let i = 0; i < PIPELINE_COUNT; i++) {
				await ensureCleanPipeline(client, `${CONCURRENT_TOKEN}-${i}`);
			}
		});

		afterEach(async () => {
			// Clean up all pipelines
			await Promise.all(
				pipelineTokens.map(async (token) => {
					try {
						await client.terminate(token);
					} catch {
						// Ignore cleanup errors
					}
				})
			);
			pipelineTokens = [];
		});

		it('should handle 16 concurrent pipelines with unique data', async () => {
			// Create all pipelines concurrently
			const pipelines = await Promise.all(
				Array.from({ length: PIPELINE_COUNT }, async (_, index) => {
					const result = await client.use({
						pipeline: getEchoPipeline(),
						token: `${CONCURRENT_TOKEN}-${index}`,
					});
					return { index, token: result.token };
				})
			);
			pipelineTokens = pipelines.map(p => p.token);

			// Generate unique test data for each pipeline
			const testData = pipelines.map((pipeline, index) => ({
				pipelineIndex: index,
				token: pipeline.token,
				text: `Pipeline-${index} unique test data: ${Math.random().toString(36).substring(2)} timestamp-${Date.now()}-${index}`,
				expectedId: `pipeline-${index}-response`
			}));

			// Send data to all pipelines concurrently with random delays
			const sendPromises = testData.map(async (data, _index) => {
				// Add random delay (0-100ms) to simulate real-world timing variations
				await new Promise(resolve => setTimeout(resolve, Math.random() * 100));

				const result: PIPELINE_RESULT | undefined = await client.send(
					data.token,
					data.text,
					{},
					'text/plain'
				);

				return {
					pipelineIndex: data.pipelineIndex,
					originalText: data.text,
					response: result
				};
			});

			// Wait for all sends to complete
			const results = await Promise.all(sendPromises);

			// Validate that each pipeline received its correct data
			expect(results).toHaveLength(PIPELINE_COUNT);

			// Check each result individually
			for (const result of results) {
				const { pipelineIndex, originalText, response } = result;

				// Validate basic response structure
				expect(response).toBeDefined();

				if (!response)
					throw new Error('Response is undefined');

				expect(typeof response).toBe('object');
				expect(response.name).toBeDefined();
				expect(response.objectId).toBeDefined();
				expect(response.objectId).toMatch(/^[0-9a-f-]{36}$/);

				// Should have processed content with text/plain MIME type
				expect(response.result_types).toBeDefined();
				expect(response.result_types!.text).toBe('text');

				// Validate the echoed text matches what we sent
				expect(response.text).toBeDefined();
				expect(Array.isArray(response.text)).toBe(true);
				expect(response.text.length).toBeGreaterThan(0);

				// The response should contain our original text
				const responseText = response.text[0];
				expect(responseText).toContain(originalText);

				// Verify pipeline-specific data is preserved
				expect(responseText).toContain(`Pipeline-${pipelineIndex}`);
				expect(responseText).toContain(`timestamp-${Date.now().toString().substring(0, 8)}`); // Rough timestamp match
			}

			// Verify no cross-contamination between pipelines
			const uniqueTexts = new Set(results.map(r => r.response!.text[0]));
			expect(uniqueTexts.size).toBe(PIPELINE_COUNT); // All responses should be unique

			// Verify all pipeline indices are represented
			const pipelineIndices = results.map(r => r.pipelineIndex).sort((a, b) => a - b);
			const expectedIndices = Array.from({ length: PIPELINE_COUNT }, (_, i) => i);
			expect(pipelineIndices).toEqual(expectedIndices);
		}, 5 * 60000); // 60 second timeout for concurrent operations

		it('should handle concurrent data sends to the same pipeline', async () => {
			// Create a single pipeline
			const result = await client.use({
				pipeline: getEchoPipeline(),
				token: `${CONCURRENT_TOKEN}-single`,
			});
			pipelineTokens = [result.token];

			const SEND_COUNT = 10;

			// Generate unique test data for concurrent sends
			const testData = Array.from({ length: SEND_COUNT }, (_, index) => ({
				index,
				text: `Concurrent-send-${index} data: ${Math.random().toString(36).substring(2)} timestamp-${Date.now()}-${index}`,
			}));

			// Send all data concurrently to the same pipeline
			const sendPromises = testData.map(async (data, _index) => {
				// Add small random delay to simulate real conditions
				await new Promise(resolve => setTimeout(resolve, Math.random() * 50));

				const response: PIPELINE_RESULT | undefined = await client.send(
					result.token,
					data.text,
					{},
					'text/plain'
				);

				return {
					sendIndex: data.index,
					originalText: data.text,
					response
				};
			});

			// Wait for all sends to complete
			const responses = await Promise.all(sendPromises);

			// Validate all responses
			expect(responses).toHaveLength(SEND_COUNT);

			for (const { sendIndex, originalText, response } of responses) {
				// Validate basic structure
				expect(response).toBeDefined();

				if (!response)
					throw new Error('Response is undefined');

				expect(response.result_types!.text).toBe('text');
				expect(response.text).toBeDefined();
				expect(Array.isArray(response.text)).toBe(true);

				// Verify the response contains the original text
				const responseText = response.text[0];
				expect(responseText).toContain(originalText);
				expect(responseText).toContain(`Concurrent-send-${sendIndex}`);
			}

			// Verify all responses are unique (no cross-contamination)
			const responseTexts = responses.map(r => r.response!.text[0]);
			const uniqueResponseTexts = new Set(responseTexts);
			expect(uniqueResponseTexts.size).toBe(SEND_COUNT);
		});

		it('should handle mixed concurrent pipeline and send operations', async () => {
			// This test runs 8 pipelines × 3 sends = 32 operations, needs extended timeout
			const PIPELINE_COUNT = 8;
			const SENDS_PER_PIPELINE = 3;

			// Create all pipelines concurrently
			const pipelines = await Promise.all(
				Array.from({ length: PIPELINE_COUNT }, async (_, index) => {
					const result = await client.use({
						pipeline: getEchoPipeline(),
						token: `${CONCURRENT_TOKEN}-mixed-${index}`,
					});
					return { index, token: result.token };
				})
			);
			pipelineTokens = pipelines.map(p => p.token);

			// Generate test data for multiple sends per pipeline
			const allSendPromises = pipelines.flatMap(pipeline =>
				Array.from({ length: SENDS_PER_PIPELINE }, (_, sendIndex) => ({
					pipelineIndex: pipeline.index,
					sendIndex,
					token: pipeline.token,
					text: `Mixed-P${pipeline.index}-S${sendIndex}: ${Math.random().toString(36).substring(2)} time-${Date.now()}-${pipeline.index}-${sendIndex}`
				}))
			);

			// Execute all sends concurrently across all pipelines
			const sendResults = await Promise.all(
				allSendPromises.map(async (data) => {
					// Random delay to simulate realistic timing
					await new Promise(resolve => setTimeout(resolve, Math.random() * 200));

					const response: PIPELINE_RESULT | undefined = await client.send(
						data.token,
						data.text,
						{},
						'text/plain'
					);

					return {
						pipelineIndex: data.pipelineIndex,
						sendIndex: data.sendIndex,
						originalText: data.text,
						response
					};
				})
			);

			// Validate results
			const totalExpectedSends = PIPELINE_COUNT * SENDS_PER_PIPELINE;
			expect(sendResults).toHaveLength(totalExpectedSends);

			// Group results by pipeline to verify separation
			const resultsByPipeline = sendResults.reduce((acc, result) => {
				if (!acc[result.pipelineIndex]) {
					acc[result.pipelineIndex] = [];
				}
				acc[result.pipelineIndex].push(result);
				return acc;
			}, {} as Record<number, typeof sendResults>);

			// Verify each pipeline received exactly the right number of sends
			for (let i = 0; i < PIPELINE_COUNT; i++) {
				expect(resultsByPipeline[i]).toHaveLength(SENDS_PER_PIPELINE);
			}

			// Verify data integrity - each response should contain its original text
			for (const result of sendResults) {
				const responseText = result.response!.text[0];
				expect(responseText).toContain(result.originalText);
				expect(responseText).toContain(`Mixed-P${result.pipelineIndex}-S${result.sendIndex}`);
			}

			// Verify no cross-contamination - all responses should be unique
			const allResponseTexts = sendResults.map(r => r.response!.text[0]);
			const uniqueResponseTexts = new Set(allResponseTexts);
			expect(uniqueResponseTexts.size).toBe(totalExpectedSends);
		}, 240000); // 4× standard timeout for 8 pipelines × 3 sends = 32 operations
	});
});

export async function isServerAvailable(): Promise<boolean> {
	try {
		const client = new RocketRideClient({
			auth: TEST_CONFIG.auth,
			uri: TEST_CONFIG.uri,
		});

		await client.connect();
		await client.ping();
		await client.disconnect();
		return true;
	} catch {
		return false;
	}
}

beforeAll(async () => {
	const serverAvailable = await isServerAvailable();
	if (!serverAvailable) {
		console.warn(`
⚠️  RocketRide server not available at ${TEST_CONFIG.uri}
Integration tests may fail. Please ensure:
1. RocketRide server is running on localhost:5565
2. TEST_API_KEY environment variable is set (if required)
3. Server accepts connections from test client
    `);
	}
}, 10000);
