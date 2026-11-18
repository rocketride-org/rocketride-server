// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// showBeside over a real Documents (no vfs), so the group rules run against Documents' own verbs.
// What only React shows (a split drawing the chat again, the turn going on) is the real run's job.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LayoutNode } from 'shell';
// the class itself, not the 'shell' barrel: the barrel pulls in stylesheets node cannot load
import { Documents } from '../../../../packages/shell/src/components/docs/Documents';
import { showBeside } from './userView';

const CHAT = 'tool:agent/c1';
const BUILDER = 'tool:apps/local.daybook';
const CANVAS = 'support.pipe';
const DAYBOOK = { kind: 'app', app: { id: 'local.daybook', folder: 'daybook-ui', name: 'Daybook' } } as const;
const SUPPORT = { kind: 'pipeline', path: 'pipelines/support.pipe' } as const;

/** The groups left to right: each one's tabs by document, the one it shows, and whether it is the active group. */
function layout(docs: Documents): Array<{ tabs: string[]; shows: string; active: boolean }> {
	const state = docs.getState();
	const leaves = (node: LayoutNode): string[] => (node.type === 'leaf' ? [node.groupId] : node.children.flatMap(leaves));
	return leaves(state.rootNode).map((id) => {
		const group = state.groups[id]!;
		const tabs = group.editorIds.map((e) => state.editors[e]!.documentUri);
		return { tabs, shows: tabs[group.activeEditorIndex] ?? '', active: state.activeGroupId === id };
	});
}

/** A Documents holding only the chat. */
function chatAlone(): { docs: Documents; chatGroup: string } {
	const docs = new Documents();
	docs.openStaticDocument(CHAT, 'Chat');
	return { docs, chatGroup: docs.getState().activeGroupId };
}

/** Opens a static tab in a group, as the Explorer opens a file viewer. */
function openTab(docs: Documents, uri: string, groupId: string): void {
	docs.openStaticDocument(uri, uri, undefined, groupId);
}

test("a view goes beside the chat: the chat alone is split to the right; a builder in the chat's own group moves out, the same editor, not a second one; another group next to the chat is used as is; and the chat is shown and its group active after each", async () => {
	// step: the chat alone
	const alone = chatAlone();
	await showBeside(alone.docs, DAYBOOK, 'c1');
	assert.deepEqual(layout(alone.docs), [
		{ tabs: [CHAT], shows: CHAT, active: true },
		{ tabs: [BUILDER], shows: BUILDER, active: false },
	]);

	// step: the builder behind the chat in the chat's own group moves out
	const shared = chatAlone();
	openTab(shared.docs, BUILDER, shared.chatGroup);
	const builderEditor = shared.docs.getState().groups[shared.chatGroup]!.editorIds[1];
	await showBeside(shared.docs, DAYBOOK, 'c1');
	assert.deepEqual(layout(shared.docs), [
		{ tabs: [CHAT], shows: CHAT, active: true },
		{ tabs: [BUILDER], shows: BUILDER, active: false },
	]);
	const state = shared.docs.getState();
	assert.equal(state.editors[builderEditor!]?.documentUri, BUILDER, 'the same editor moved');
	assert.equal(state.documents[BUILDER]?.editorCount, 1);

	// step: a neighbour group already there takes the view; no split
	const pair = chatAlone();
	openTab(pair.docs, 'file:README.md', pair.docs.splitGroup(pair.chatGroup, 'horizontal', 'after'));
	await showBeside(pair.docs, SUPPORT, 'c1');
	assert.deepEqual(layout(pair.docs), [
		{ tabs: [CHAT], shows: CHAT, active: true },
		{ tabs: ['file:README.md', CANVAS], shows: CANVAS, active: false },
	]);

	// step: three groups, the chat in the middle: the view goes to the chat's own neighbour, not the first group
	const three = chatAlone();
	openTab(three.docs, 'file:files', three.docs.splitGroup(three.chatGroup, 'horizontal', 'before'));
	openTab(three.docs, 'file:other', three.docs.splitGroup(three.chatGroup, 'horizontal', 'after'));
	await showBeside(three.docs, DAYBOOK, 'c1');
	assert.deepEqual(layout(three.docs), [
		{ tabs: ['file:files'], shows: 'file:files', active: false },
		{ tabs: [CHAT], shows: CHAT, active: true },
		{ tabs: ['file:other', BUILDER], shows: BUILDER, active: false },
	]);

	// step: the tab bar's Split duplicated the chat; the view goes beside the copy in the active group
	const split = chatAlone();
	split.docs.splitGroupWithDocument(split.chatGroup, 'horizontal');
	await showBeside(split.docs, DAYBOOK, 'c1');
	assert.deepEqual(layout(split.docs), [
		{ tabs: [CHAT, BUILDER], shows: BUILDER, active: false },
		{ tabs: [CHAT], shows: CHAT, active: true },
	]);
});

test("a view already open outside the chat's group is brought to the front where it is: a builder behind another tab, and a canvas open in both the chat's group and another, which gets no third editor", async () => {
	// step: the builder sits behind a file in the other group
	const behind = chatAlone();
	const other = behind.docs.splitGroup(behind.chatGroup, 'horizontal', 'after');
	openTab(behind.docs, BUILDER, other);
	openTab(behind.docs, 'file:x', other);
	await showBeside(behind.docs, DAYBOOK, 'c1');
	assert.deepEqual(layout(behind.docs), [
		{ tabs: [CHAT], shows: CHAT, active: true },
		{ tabs: [BUILDER, 'file:x'], shows: BUILDER, active: false },
	]);

	// step: the canvas is open in the chat's group and behind a file in another
	const twice = chatAlone();
	await twice.docs.openDocument(CANVAS, twice.chatGroup);
	twice.docs.setActiveEditor(twice.chatGroup, 0);
	const second = twice.docs.splitGroup(twice.chatGroup, 'horizontal', 'after');
	await twice.docs.openDocument(CANVAS, second);
	openTab(twice.docs, 'file:x', second);
	await showBeside(twice.docs, SUPPORT, 'c1');
	assert.deepEqual(layout(twice.docs), [
		{ tabs: [CHAT, CANVAS], shows: CHAT, active: true },
		{ tabs: [CANVAS, 'file:x'], shows: CANVAS, active: false },
	]);

	// step: a second call for the same view changes nothing
	const again = chatAlone();
	await showBeside(again.docs, DAYBOOK, 'c1');
	const first = layout(again.docs);
	await showBeside(again.docs, DAYBOOK, 'c1');
	assert.deepEqual(layout(again.docs), first);
});
