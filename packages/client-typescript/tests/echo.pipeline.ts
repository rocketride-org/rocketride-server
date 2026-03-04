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
 * Get the echo pipeline configuration.
 * 
 * This pipeline receives data and returns it unchanged, making it ideal
 * for testing basic connectivity and data transmission.
 * 
 * @returns Echo pipeline configuration
 */
export function getEchoPipeline() {
	return {
		components: [
			{
				id: "webhook_1",
				provider: "webhook",
				name: "My webhook",
				description: "A webhook to receive data",
				config: {
					hideForm: true,
					mode: "Source",
					type: "webhook"
				}
			},
			{
				id: "response_1",
				provider: "response",
				config: { lanes: [] },
				input: [{ lane: "text", from: "webhook_1" }]
			}
		],
		source: "webhook_1",
		project_id: "e612b741-748c-4b35-a8b7-186797a8ea42"
	};
}
