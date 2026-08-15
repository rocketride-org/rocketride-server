// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWorkflow, verifyPins } from './verify-action-pins.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

describe('action pin verification', () => {
	it('accepts a pin whose version resolves to its SHA', async () => {
		const pins = parseWorkflow(`- uses: actions/checkout@${SHA} # v4`, 'ci.yml');
		assert.deepEqual(await verifyPins(pins, async () => SHA), []);
	});

	it('reports a drifted version comment', async () => {
		const pins = parseWorkflow(`uses: astral-sh/setup-uv@${SHA} # v5.4.1`, 'lock.yml');
		const errors = await verifyPins(pins, async () => OTHER_SHA);
		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /does not include pinned commit a{40}/);
	});

	it('accepts a pinned patch commit within a major version line', async () => {
		const pins = parseWorkflow(`uses: actions/checkout@${SHA} # v4`, 'ci.yml');
		assert.deepEqual(await verifyPins(pins, async () => [OTHER_SHA, SHA]), []);
	});

	it('validates single- and double-quoted uses values', async () => {
		const pins = parseWorkflow(`uses: "actions/checkout@${SHA}" # v4\n- uses: 'actions/setup-node@${OTHER_SHA}' # v4`, 'quoted.yml');
		assert.deepEqual(
			pins.map(({ action, sha, version }) => ({ action, sha, version })),
			[
				{ action: 'actions/checkout', sha: SHA, version: 'v4' },
				{ action: 'actions/setup-node', sha: OTHER_SHA, version: 'v4' },
			]
		);
		assert.deepEqual(await verifyPins(pins, async (_repository, _version) => [SHA, OTHER_SHA]), []);
	});

	it('requires comments on SHA-pinned remote actions', async () => {
		const pins = parseWorkflow(`uses: actions/github-script@${SHA}`, 'release.yml');
		const errors = await verifyPins(pins, async () => SHA);
		assert.match(errors[0].message, /missing a version comment/);
	});

	it('resolves an action subpath through its two-segment repository', () => {
		const [pin] = parseWorkflow(`uses: github/gh-aw/actions/setup@${SHA} # v1`, 'agentic.yml');
		assert.equal(pin.repository, 'github/gh-aw');
	});

	it('ignores local, Docker, and unpinned action references', () => {
		const pins = parseWorkflow(
			`
uses: ./local-action
uses: docker://alpine:3
uses: actions/checkout@v4
`,
			'ci.yml'
		);
		assert.deepEqual(pins, []);
	});
});
