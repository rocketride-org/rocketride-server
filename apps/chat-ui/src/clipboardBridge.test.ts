/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
	copyChatText,
	cutClipboardText,
	getChatHostCapabilities,
	getEmbeddedClipboardCommand,
	getSanitizedChatPath,
	getSelectedClipboardText,
	insertClipboardText,
	isActiveClipboardTextControl,
	isVSCodeEmbeddedChat,
	selectAllChatContent,
	type ClipboardTextControl,
} from './clipboardBridge.ts';

function createTextControl(
	value: string,
	selectionStart: number,
	selectionEnd: number,
	tagName: 'INPUT' | 'TEXTAREA' = 'TEXTAREA'
): ClipboardTextControl & { selectedRange?: [number, number] } {
	return {
		tagName,
		value,
		selectionStart,
		selectionEnd,
		setSelectionRange(start: number, end: number) {
			this.selectedRange = [start, end];
		},
	};
}

test('copy uses the focused text control selection instead of a stale transcript selection', () => {
	const input = createTextControl('hello RocketRide', 6, 16);

	assert.equal(getSelectedClipboardText(input, 'stale transcript selection'), 'RocketRide');
});

test('copy returns no text when the focused text control selection is collapsed', () => {
	const input = createTextControl('hello RocketRide', 5, 5);

	assert.equal(getSelectedClipboardText(input, 'stale transcript selection'), '');
});

test('copy uses the document selection when focus is outside an editable control', () => {
	assert.equal(getSelectedClipboardText({ tagName: 'DIV' }, 'selected assistant answer'), 'selected assistant answer');
});

test('select all selects the entire focused chat input', () => {
	const input = createTextControl('select this complete prompt', 4, 8);
	let transcriptSelections = 0;

	const selected = selectAllChatContent(input, () => {
		transcriptSelections += 1;
		return true;
	});

	assert.equal(selected, 'editable');
	assert.deepEqual(input.selectedRange, [0, input.value.length]);
	assert.equal(transcriptSelections, 0);
});

test('select all selects the transcript when focus is outside an editable control', () => {
	let transcriptSelections = 0;

	const selected = selectAllChatContent({ tagName: 'DIV' }, () => {
		transcriptSelections += 1;
		return true;
	});

	assert.equal(selected, 'transcript');
	assert.equal(transcriptSelections, 1);
});

test('paste replaces the current input selection and returns the new caret position', () => {
	assert.deepEqual(insertClipboardText('before OLD after', 7, 10, 'NEW'), {
		value: 'before NEW after',
		caret: 10,
	});
});

test('cut removes the focused input selection and returns the clipboard text and caret', () => {
	assert.deepEqual(cutClipboardText('before CUT after', 7, 10), {
		value: 'before  after',
		text: 'CUT',
		caret: 7,
	});
});

test('cut is a no-op when the input selection is collapsed', () => {
	assert.deepEqual(cutClipboardText('leave this alone', 5, 5), {
		value: 'leave this alone',
		text: '',
		caret: 5,
	});
});

test('a relayed cut only targets the chat input while that exact input is focused', () => {
	const input = createTextControl('draft with stale selection', 6, 10);

	assert.equal(isActiveClipboardTextControl(input, input), true);
	assert.equal(isActiveClipboardTextControl({ tagName: 'DIV' }, input), false);
	assert.equal(isActiveClipboardTextControl(createTextControl('other input', 0, 5), input), false);
});

test('VS Code integration requires the explicit host marker, not merely an iframe', () => {
	assert.equal(isVSCodeEmbeddedChat('?auth=token&_rocketrideHost=vscode'), true);
	assert.equal(isVSCodeEmbeddedChat('?auth=token'), false);
	assert.equal(isVSCodeEmbeddedChat(''), false);
});

test('a nested VS Code chat uses the clipboard bridge without replacing the RocketRide theme', () => {
	assert.deepEqual(getChatHostCapabilities(false, '?_rocketrideHost=vscode'), {
		isVSCode: false,
		isEmbeddedVSCode: true,
	});
});

test('a top-level VS Code webview can use the editor theme without the nested bridge', () => {
	assert.deepEqual(getChatHostCapabilities(true, ''), {
		isVSCode: true,
		isEmbeddedVSCode: false,
	});
});

test('auth cleanup preserves only the non-secret nested host marker for reloads', () => {
	assert.equal(
		getSanitizedChatPath(
			'/chat/project/source',
			'?auth=sensitive-token&_t=123&_rocketrideHost=vscode'
		),
		'/chat/project/source?_rocketrideHost=vscode'
	);
	assert.equal(
		getSanitizedChatPath('/chat/project/source', '?auth=sensitive-token&_t=123'),
		'/chat/project/source'
	);
});

test('embedded clipboard shortcuts recognize Command and Control variants', () => {
	for (const [key, command] of [
		['a', 'selectAll'],
		['c', 'copy'],
		['v', 'paste'],
		['x', 'cut'],
	] as const) {
		assert.equal(getEmbeddedClipboardCommand({ key, metaKey: true, ctrlKey: false }), command);
		assert.equal(getEmbeddedClipboardCommand({ key: key.toUpperCase(), metaKey: false, ctrlKey: true }), command);
	}
});

test('embedded clipboard shortcuts ignore unmodified, Alt-modified, and Shift-modified keys', () => {
	assert.equal(getEmbeddedClipboardCommand({ key: 'a', metaKey: false, ctrlKey: false }), undefined);
	assert.equal(getEmbeddedClipboardCommand({ key: 'c', metaKey: true, ctrlKey: false, altKey: true }), undefined);
	assert.equal(getEmbeddedClipboardCommand({ key: 'a', metaKey: true, ctrlKey: false, shiftKey: true }), undefined);
	assert.equal(getEmbeddedClipboardCommand({ key: 'C', metaKey: false, ctrlKey: true, shiftKey: true }), undefined);
	assert.equal(getEmbeddedClipboardCommand({ key: 'z', metaKey: true, ctrlKey: false }), undefined);
});

test('copy button sends the complete message through the parent bridge when embedded', async () => {
	const posted: unknown[] = [];
	const written: string[] = [];

	const didCopy = await copyChatText(
		'complete assistant answer',
		true,
		message => posted.push(message),
		async text => {
			written.push(text);
		}
	);

	assert.equal(didCopy, true);
	assert.deepEqual(posted, [{ type: 'copyText', text: 'complete assistant answer' }]);
	assert.deepEqual(written, []);
});

test('copy button uses the browser clipboard for standalone chat', async () => {
	const posted: unknown[] = [];
	const written: string[] = [];

	const didCopy = await copyChatText(
		'complete user question',
		false,
		message => posted.push(message),
		async text => {
			written.push(text);
		}
	);

	assert.equal(didCopy, true);
	assert.deepEqual(posted, []);
	assert.deepEqual(written, ['complete user question']);
});

test('copy button reports browser clipboard failures without throwing or showing success', async () => {
	const didCopy = await copyChatText(
		'clipboard-denied message',
		false,
		() => assert.fail('standalone copy must not post to the parent'),
		async () => {
			throw new Error('clipboard permission denied');
		}
	);

	assert.equal(didCopy, false);
});
