// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { SERVICE_TIER_SCOPES } from './LoginWithMicrosoftButton';

// The canvas hands the button formContext.provider = the node's protocol name
// (e.g. 'tool_excel'), so the scope map must be keyed by exactly that. Read the
// Microsoft 365 service definitions from the repo so a new service or tier
// cannot ship without scopes.
const M365_NODE_DIR = path.resolve(__dirname, '../../../../../../../../nodes/src/nodes/tool_microsoft_365');

interface M365Service {
	file: string;
	provider: string;
	tiers: string[];
}

function loadServices(): M365Service[] {
	return readdirSync(M365_NODE_DIR)
		.filter((f) => /^services\..+\.json$/.test(f))
		.map((file) => {
			const def = JSON.parse(readFileSync(path.join(M365_NODE_DIR, file), 'utf8'));
			const provider = String(def.protocol).replace(/:\/\/$/, '');
			const accessField = Object.entries(def.fields ?? {}).find(([key]) => key.endsWith('.access'))?.[1] as { enum?: unknown[] } | undefined;
			// Enum entries are either bare values or [value, label] pairs.
			const tiers = (accessField?.enum ?? []).map((e) => String(Array.isArray(e) ? e[0] : e));
			return { file, provider, tiers };
		});
}

test('every Microsoft 365 service definition is found with access tiers', () => {
	const services = loadServices();
	assert.ok(services.length > 0, `no services.*.json under ${M365_NODE_DIR}`);
	for (const { file, tiers } of services) assert.ok(tiers.length > 0, `${file} has no <prefix>.access enum`);
});

test('scope map is keyed by node protocol with scopes for every access tier', () => {
	for (const { file, provider, tiers } of loadServices()) {
		const byTier = SERVICE_TIER_SCOPES[provider];
		assert.ok(byTier, `SERVICE_TIER_SCOPES has no entry for provider '${provider}' (${file})`);
		for (const tier of tiers) {
			assert.ok(byTier[tier]?.length, `SERVICE_TIER_SCOPES['${provider}'] has no scopes for tier '${tier}' (${file})`);
		}
	}
});
