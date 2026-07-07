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

/**
 * Tool pipeline fixture for integration tests.
 *
 * Provides a minimal pipeline with a tool_python node whose `execute` tool
 * can be invoked via `client.tool()` without any external API keys or services.
 */

export function getToolPipeline(projectId = 'a1b2c3d4-tool-test-0000-000000000001') {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				config: { hideForm: true, mode: 'Source', type: 'webhook' },
			},
			{
				id: 'tool_python_1',
				provider: 'tool_python',
				config: {},
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
			{
				id: 'response_1',
				provider: 'response',
				config: { lanes: [] },
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
		],
		source: 'webhook_1',
		project_id: projectId,
	};
}
