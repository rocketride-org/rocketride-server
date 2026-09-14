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

import { mapNativeCatalog, type OcProviderEntry } from '../src/catalog';

describe('mapNativeCatalog', () => {
	const nativeIds = new Set(['openai', 'anthropic']);

	// NOTE: opencode's real `/provider` payload leaves `tool_call` UNDEFINED, so the mapper must
	// NOT filter on it (that dropped every native model — the live bug). These fixtures leave it out.
	const all: OcProviderEntry[] = [
		{
			id: 'openai',
			models: {
				a: { id: 'gpt-5.4', name: 'GPT-5.4', status: 'active' },
				b: { id: 'gpt-4o', name: 'GPT-4o', status: 'beta' },
				d: { id: 'gpt-old', name: 'Old', status: 'deprecated' }, // dropped: deprecated
				e: { id: 'gpt-untitled', status: 'active' }, // title falls back to id
				f: { id: 'gpt-image-2', name: 'Image', status: 'active' }, // dropped: non-chat (image)
				g: { id: 'text-embedding-3-large', name: 'Embed', status: 'active' }, // dropped: non-chat (embedding)
			},
		},
		{ id: 'anthropic', models: { x: { id: 'claude-x', name: 'Claude X', status: 'active' } } },
		// A native provider whose models are ALL unusable -> omitted entirely.
		{ id: 'perplexity', models: { z: { id: 'whisper-1', status: 'active' } } },
		// A provider opencode knows but we don't surface -> excluded.
		{ id: 'ollama', models: { l: { id: 'llama', name: 'Llama', status: 'active' } } },
	];

	test('keeps native providers, dropping deprecated and non-chat models (never gating on tool_call)', () => {
		const out = mapNativeCatalog(all, nativeIds);
		expect(Object.keys(out).sort()).toEqual(['anthropic', 'openai']);
		expect(out.openai).toEqual([
			{ id: 'gpt-5.4', title: 'GPT-5.4' },
			{ id: 'gpt-4o', title: 'GPT-4o' },
			{ id: 'gpt-untitled', title: 'gpt-untitled' }, // name absent -> id is the title
		]);
		expect(out.anthropic).toEqual([{ id: 'claude-x', title: 'Claude X' }]);
	});

	test('omits a native provider left with zero usable models (all non-chat)', () => {
		const out = mapNativeCatalog(all, new Set(['openai', 'anthropic', 'perplexity']));
		expect(out).not.toHaveProperty('perplexity'); // its only model (whisper-1) is non-chat
	});

	test('excludes non-native providers even when they have usable models', () => {
		const out = mapNativeCatalog(all, nativeIds);
		expect(out).not.toHaveProperty('ollama');
	});

	test('empty input yields an empty catalog', () => {
		expect(mapNativeCatalog([], nativeIds)).toEqual({});
	});
});
