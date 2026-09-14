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
 * The provider registry the canvas agent's bring-your-own-key/model feature is built on:
 * one entry per inference provider the agent can be pointed at.
 *
 * - `id` is the opencode provider id — it forms the `<id>/<modelId>` model string and the
 *   `provider.<id>` config block. For `native` providers it MUST match opencode's own
 *   provider id (so opencode's bundled models.dev catalog and `enabled_providers` line up);
 *   for `openai-compatible` providers it's an id we mint for the generic `@ai-sdk/openai-compatible` block.
 * - `keyVar` is the RocketRide user-variable a key is read from — the SAME variable the user
 *   already sets for that provider's pipeline nodes, so a configured pipeline key is reused
 *   with no re-entry (see keys.ts `UserVarKeyResolver`).
 * - `mode` distinguishes opencode's native integrations (models come from opencode's built-in
 *   catalog, fetched at runtime — see catalog.ts) from generic OpenAI-compatible providers
 *   opencode doesn't know natively (they need a `baseURL` and a curated `models` list, since
 *   opencode can't enumerate them). Curated ids/titles are lifted verbatim from RocketRide's
 *   own `nodes/src/nodes/llm_<name>/services.json` so they match what RocketRide itself offers.
 */
export interface ProviderDef {
	/** opencode provider id, e.g. 'openai' (native must match opencode's id). */
	id: string;
	/** RocketRide catalog node this maps to, e.g. 'llm_openai' (documentation / keyVar origin). */
	rrNode: string;
	/** Human label, e.g. 'OpenAI'. */
	label: string;
	/** User-variable a key is read from / written to, e.g. 'ROCKETRIDE_OPENAI_KEY'. */
	keyVar: string;
	/** `native` = models from opencode's built-in catalog; `openai-compatible` = curated + baseURL. */
	mode: 'native' | 'openai-compatible';
	/** OpenAI-compatible base URL (required for `openai-compatible`; unused for `native`). */
	baseURL?: string;
	/**
	 * Curated selectable models for `openai-compatible` providers opencode can't enumerate.
	 * Ids/titles are copied from the provider's RocketRide `services.json` preconfig profiles.
	 * `native` providers omit this — their models come from opencode's catalog at runtime.
	 */
	models?: Array<{ id: string; title: string }>;
}

/**
 * opencode-native providers: opencode knows these and supplies their model list from its
 * bundled models.dev catalog (network-locked). We only need the id↔keyVar mapping here.
 */
const NATIVE: ProviderDef[] = [
	{ id: 'openai', rrNode: 'llm_openai', label: 'OpenAI', keyVar: 'ROCKETRIDE_OPENAI_KEY', mode: 'native' },
	{ id: 'anthropic', rrNode: 'llm_anthropic', label: 'Anthropic', keyVar: 'ROCKETRIDE_ANTHROPIC_KEY', mode: 'native' },
	{ id: 'google', rrNode: 'llm_gemini', label: 'Google Gemini', keyVar: 'ROCKETRIDE_GEMINI_KEY', mode: 'native' },
	{ id: 'deepseek', rrNode: 'llm_deepseek', label: 'DeepSeek', keyVar: 'ROCKETRIDE_DEEPSEEK_KEY', mode: 'native' },
	{ id: 'mistral', rrNode: 'llm_mistral', label: 'Mistral', keyVar: 'ROCKETRIDE_MISTRAL_KEY', mode: 'native' },
	{ id: 'xai', rrNode: 'llm_xai', label: 'xAI Grok', keyVar: 'ROCKETRIDE_XAI_KEY', mode: 'native' },
	{ id: 'perplexity', rrNode: 'llm_perplexity', label: 'Perplexity', keyVar: 'ROCKETRIDE_PERPLEXITY_KEY', mode: 'native' },
];

/**
 * OpenAI-compatible providers opencode does NOT know natively. Each carries its hosted
 * OpenAI-compatible base URL and a curated model list (ids/titles from the provider's
 * RocketRide `services.json`; local/self-hosted profiles dropped — the agent only offers
 * each provider's hosted API). `qwen`'s base URL is Alibaba DashScope's international
 * OpenAI-compatible endpoint (RocketRide's node carries no `serverbase`, so it's supplied here).
 */
const COMPAT: ProviderDef[] = [
	{
		id: 'kimi', rrNode: 'llm_kimi', label: 'Kimi (Moonshot)', keyVar: 'ROCKETRIDE_KIMI_KEY',
		mode: 'openai-compatible', baseURL: 'https://api.moonshot.ai/v1',
		models: [
			{ id: 'kimi-k2.6', title: 'Kimi K2.6' },
			{ id: 'kimi-k2.5', title: 'Kimi K2.5' },
			{ id: 'kimi-k2-thinking', title: 'Kimi K2 Thinking' },
			{ id: 'kimi-k2.7-code', title: 'Kimi K2.7 Code' },
			{ id: 'kimi-k2-0905', title: 'Kimi K2 0905' },
			{ id: 'kimi-k2', title: 'Kimi K2 0711' },
			{ id: 'kimi-latest', title: 'Kimi Latest' },
			{ id: 'moonshot-v1-128k', title: 'Moonshot v1 128K' },
			{ id: 'moonshot-v1-32k', title: 'Moonshot v1 32K' },
			{ id: 'moonshot-v1-8k', title: 'Moonshot v1 8K' },
		],
	},
	{
		id: 'minimax', rrNode: 'llm_minimax', label: 'MiniMax', keyVar: 'ROCKETRIDE_MINIMAX_KEY',
		mode: 'openai-compatible', baseURL: 'https://api.minimax.io/v1',
		// Hosted models only — the `MiniMaxAI/*` self-hosted profiles are dropped.
		models: [
			{ id: 'MiniMax-M2.7', title: 'MiniMax M2.7' },
			{ id: 'MiniMax-M2.7-highspeed', title: 'MiniMax M2.7 Highspeed' },
			{ id: 'MiniMax-M2.5', title: 'MiniMax M2.5' },
			{ id: 'MiniMax-M2.5-highspeed', title: 'MiniMax M2.5 Highspeed' },
			{ id: 'MiniMax-M2.1', title: 'MiniMax M2.1' },
			{ id: 'MiniMax-M2', title: 'MiniMax M2' },
			{ id: 'minimax-m1', title: 'MiniMax M1' },
			{ id: 'minimax-01', title: 'MiniMax-01' },
		],
	},
	{
		id: 'qwen', rrNode: 'llm_qwen', label: 'Qwen', keyVar: 'ROCKETRIDE_QWEN_KEY',
		mode: 'openai-compatible', baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
		models: [
			{ id: 'qwen3.7-max', title: 'Qwen3.7 Max' },
			{ id: 'qwen3.7-plus', title: 'Qwen3.7 Plus' },
			{ id: 'qwen3.6-flash', title: 'Qwen3.6 Flash' },
			{ id: 'qwen-max', title: 'Qwen Max (latest)' },
			{ id: 'qwen-plus', title: 'Qwen Plus (latest)' },
			{ id: 'qwen-flash', title: 'Qwen Flash (latest)' },
			{ id: 'qwen-turbo', title: 'Qwen Turbo (latest)' },
			{ id: 'qwen-2.5-72b-instruct', title: 'Qwen2.5 72B Instruct' },
			{ id: 'qwen-2.5-coder-32b-instruct', title: 'Qwen2.5 Coder 32B Instruct' },
		],
	},
	{
		id: 'gmi', rrNode: 'llm_gmi_cloud', label: 'GMI Cloud', keyVar: 'ROCKETRIDE_GMI_KEY',
		mode: 'openai-compatible', baseURL: 'https://api.gmi-serving.com/v1',
		models: [
			{ id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', title: 'Llama 4 Maverick' },
			{ id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', title: 'Llama 4 Scout' },
			{ id: 'Qwen/Qwen3-235B-A22B-FP8', title: 'Qwen3 235B' },
			{ id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', title: 'Qwen3 Coder 480B' },
			{ id: 'Qwen/Qwen3-32B-FP8', title: 'Qwen3 32B' },
			{ id: 'deepseek-ai/DeepSeek-V3.2', title: 'DeepSeek V3.2' },
			{ id: 'deepseek-ai/DeepSeek-R1', title: 'DeepSeek R1' },
		],
	},
	{
		id: 'qianfan', rrNode: 'llm_baidu_qianfan', label: 'Baidu Qianfan', keyVar: 'ROCKETRIDE_QIANFAN_KEY',
		mode: 'openai-compatible', baseURL: 'https://qianfan.baidubce.com/v2',
		models: [
			{ id: 'ernie-5.0-thinking-preview', title: 'ERNIE 5.0 Thinking Preview' },
			{ id: 'ernie-4.5-turbo-128k', title: 'ERNIE 4.5 Turbo 128K' },
			{ id: 'ernie-4.5-turbo-32k', title: 'ERNIE 4.5 Turbo 32K' },
		],
	},
];

export const PROVIDERS: ProviderDef[] = [...NATIVE, ...COMPAT];

export function providerById(id: string): ProviderDef | undefined {
	return PROVIDERS.find((p) => p.id === id);
}

export function providerByKeyVar(v: string): ProviderDef | undefined {
	return PROVIDERS.find((p) => p.keyVar === v);
}
