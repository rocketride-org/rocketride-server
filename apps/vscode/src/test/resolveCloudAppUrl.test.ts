// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCloudAppUrl } from '../auth/resolveCloudAppUrl';

const FALLBACK = 'https://cloud.rocketride.ai/';

const cases: Array<{ name: string; input: string; expected: string }> = [
	{
		name: 'maps production api host to cloud host',
		input: 'https://api.rocketride.ai',
		expected: 'https://cloud.rocketride.ai/',
	},
	{
		name: 'maps staging api host and strips engine port / forces https',
		input: 'https://api.staging.example.com',
		expected: 'https://cloud.staging.example.com/',
	},
	{
		name: 'maps wss api host to https cloud host (openExternal-safe)',
		input: 'wss://api.rocketride.ai',
		expected: 'https://cloud.rocketride.ai/',
	},
	{
		name: 'falls back for localhost (no derivable web app URL)',
		input: 'http://localhost:5565',
		expected: FALLBACK,
	},
	{
		name: 'falls back for non-api host',
		input: 'https://engine.example.com',
		expected: FALLBACK,
	},
	{
		name: 'falls back for unparseable input',
		input: 'not a url',
		expected: FALLBACK,
	},
];

for (const { name, input, expected } of cases) {
	test(name, () => {
		assert.equal(resolveCloudAppUrl(input), expected);
	});
}
