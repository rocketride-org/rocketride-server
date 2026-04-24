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
 * Creates a dynamically configured LLM component based on available API keys.
 * 
 * This function checks environment variables for LLM provider API keys in priority order
 * and returns the appropriate component configuration. The priority order ensures
 * consistent behavior when multiple API keys are available.
 * 
 * Priority Order:
 * 1. OpenAI (ROCKETRIDE_OPENAI_KEY) - Uses GPT-4 with 128K context
 * 2. Anthropic (ROCKETRIDE_ANTHROPIC_KEY) - Uses Claude-3 Sonnet
 * 3. Gemini (ROCKETRIDE_GEMINI_KEY) - Uses Gemini Pro model
 * 4. Ollama (ROCKETRIDE_OLLAMA_HOST) - Uses local Ollama server
 * 
 * @returns {Object} LLM component configuration object with provider-specific settings
 * @throws {Error} When no valid API keys are found in environment variables
 */
function createLLMComponent() {
	const openaiKey = process.env.ROCKETRIDE_OPENAI_KEY;
	const anthropicKey = process.env.ROCKETRIDE_ANTHROPIC_KEY;
	const geminiKey = process.env.ROCKETRIDE_GEMINI_KEY;
	const ollamaHost = process.env.ROCKETRIDE_OLLAMA_HOST;

	if (openaiKey) {
		return {
			id: "llm_openai_1",
			provider: "llm_openai",
			config: {
				profile: "openai-5",
				"openai-5": { apikey: openaiKey }
			},
			input: [{ lane: "questions", from: "chat_1" }]
		};
	}
	else if (anthropicKey) {
		return {
			id: "llm_anthropic_1",
			provider: "llm_anthropic",
			config: {
				profile: "claude-3_7-sonnet",
				"claude-3-sonnet": { apikey: anthropicKey }
			},
			input: [{ lane: "questions", from: "chat_1" }]
		};
	}
	else if (geminiKey) {
		return {
			id: "llm_gemini_1",
			provider: "llm_gemini",
			config: {
				profile: "gemini-1_5-pro",
				"gemini-1_5-pro": { apikey: geminiKey }
			},
			input: [{ lane: "questions", from: "chat_1" }]
		};
	}
	else if (ollamaHost) {
		return {
			id: "llm_ollama_1",
			provider: "llm_ollama",
			config: {
				profile: "llama3_3",
				llama3_3: { serverbase: ollamaHost }
			},
			input: [{ lane: "questions", from: "chat_1" }]
		};
	}
	else {
		throw new Error(
			"No LLM API key found. Please set one of the following environment variables:\n" +
			"- ROCKETRIDE_OPENAI_KEY (for OpenAI GPT-4)\n" +
			"- ROCKETRIDE_ANTHROPIC_KEY (for Anthropic Claude)\n" +
			"- ROCKETRIDE_GEMINI_KEY (for Google Gemini)\n" +
			"- ROCKETRIDE_OLLAMA_HOST (for Ollama)"
		);
	}
}

/**
 * Get the chat pipeline configuration.
 * 
 * This function creates the pipeline lazily on demand, avoiding the need
 * for LLM API keys to be present at module load time.
 * 
 * @returns Complete pipeline configuration for chat-based LLM interactions
 */
export function getChatPipeline() {
	const llmComponent = createLLMComponent();
	
	return {
		components: [
			{
				id: "chat_1",
				provider: "chat",
				config: {
					hideForm: true,
					mode: "Source",
					type: "chat"
				},
			},
			llmComponent,
			{
				id: "response_1",
				provider: "response",
				config: { lanes: [] },
				input: [{ lane: "answers", from: llmComponent.id }]
			}
		],
		source: "chat_1",
		project_id: "8b866c3b-6c76-42d7-8091-301be3dce0f2"
	};
}
