// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import {
	routeEmbeddedClipboardCommand,
	type EmbeddedClipboardMessageTarget,
	type EmbeddedClipboardReader,
} from '../shared/util/embeddedClipboardBridge';

function createTarget(messages: unknown[]): EmbeddedClipboardMessageTarget {
	return {
		postMessage: async (message: unknown) => {
			messages.push(message);
			return true;
		},
	};
}

test('paste reads the host clipboard and delivers its text to the embedded app', async () => {
	const messages: unknown[] = [];
	let reads = 0;
	const clipboard: EmbeddedClipboardReader = {
		readText: async () => {
			reads += 1;
			return 'copied outside RocketRide';
		},
	};

	const routed = await routeEmbeddedClipboardCommand(createTarget(messages), clipboard, 'paste');

	assert.equal(routed, true);
	assert.equal(reads, 1);
	assert.deepEqual(messages, [{ type: 'pasteContent', text: 'copied outside RocketRide' }]);
});

test('copy asks the embedded app for its focused selection without reading the host clipboard', async () => {
	const messages: unknown[] = [];
	let reads = 0;
	const clipboard: EmbeddedClipboardReader = {
		readText: async () => {
			reads += 1;
			return 'unused';
		},
	};

	const routed = await routeEmbeddedClipboardCommand(createTarget(messages), clipboard, 'copy');

	assert.equal(routed, true);
	assert.equal(reads, 0);
	assert.deepEqual(messages, [{ type: 'clipboardCommand', command: 'copy' }]);
});

test('cut asks the embedded app to remove an editable selection without reading the host clipboard', async () => {
	const messages: unknown[] = [];
	let reads = 0;
	const clipboard: EmbeddedClipboardReader = {
		readText: async () => {
			reads += 1;
			return 'unused';
		},
	};

	const routed = await routeEmbeddedClipboardCommand(createTarget(messages), clipboard, 'cut');

	assert.equal(routed, true);
	assert.equal(reads, 0);
	assert.deepEqual(messages, [{ type: 'clipboardCommand', command: 'cut' }]);
});

test('select all asks the embedded app to select content in its current focus context', async () => {
	const messages: unknown[] = [];
	const clipboard: EmbeddedClipboardReader = {
		readText: async () => 'unused',
	};

	const routed = await routeEmbeddedClipboardCommand(createTarget(messages), clipboard, 'selectAll');

	assert.equal(routed, true);
	assert.deepEqual(messages, [{ type: 'clipboardCommand', command: 'selectAll' }]);
});

test('paste reports failure when the host clipboard read rejects', async () => {
	const messages: unknown[] = [];
	const clipboard: EmbeddedClipboardReader = {
		readText: async () => {
			throw new Error('clipboard unavailable');
		},
	};

	const routed = await routeEmbeddedClipboardCommand(createTarget(messages), clipboard, 'paste');

	assert.equal(routed, false);
	assert.deepEqual(messages, []);
});

test('commands report failure when posting to the embedded app rejects', async () => {
	const target: EmbeddedClipboardMessageTarget = {
		postMessage: async () => {
			throw new Error('webview disposed');
		},
	};
	const clipboard: EmbeddedClipboardReader = {
		readText: async () => 'unused',
	};

	const routed = await routeEmbeddedClipboardCommand(target, clipboard, 'copy');

	assert.equal(routed, false);
});

test('clipboard commands are ignored when no embedded panel is active', async () => {
	let reads = 0;
	const clipboard: EmbeddedClipboardReader = {
		readText: async () => {
			reads += 1;
			return 'unused';
		},
	};

	const routed = await routeEmbeddedClipboardCommand(undefined, clipboard, 'paste');

	assert.equal(routed, false);
	assert.equal(reads, 0);
});
