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

// =============================================================================
// USER VIEW — the user's own App Builder or canvas, beside the agent's chat
// =============================================================================

/**
 * Where show_view's view goes in the editor area. It reads the layout once, then uses only Documents'
 * existing verbs (setActiveEditor, splitGroup, moveEditor, the two open verbs), so nothing in the shell
 * changes. It owns three rules:
 * - a view showing in a group other than the chat's comes to the front there, which is also how a
 *   pipeline never gets a second canvas: openDocument reuses an editor only in its target group, so it
 *   is called only when no editor of the pipeline exists outside the chat's group;
 * - otherwise the view goes to the group next to the chat's in the layout (Documents keeps no history of
 *   which group was active last, and "next to" is what "beside" means), or to a new group split off the
 *   chat's to the right when the chat's is the only one; a view sitting in the chat's own group is moved
 *   there, never opened twice (openStaticDocument would only re-focus it, behind the chat);
 * - the chat is shown and its group made active last, since every verb above makes its own group active.
 * The chat never moves. A split draws every editor of the chat's group again (DocSplitLayout): the turn
 * and the unsent draft go on (the session owns them), but a builder's preview there reloads.
 *
 * Only type imports from shell and shared, so the test runs it over a real Documents in node.
 */

import type { Documents, DocumentsState, LayoutNode } from 'shell';
import type { UserView } from 'shared/modules/agent/host';

// =============================================================================
// TYPES
// =============================================================================

/** What placing a view needs of Documents. */
export type PlacingDocs = Pick<Documents, 'getState' | 'destroyed' | 'openStaticDocument' | 'openDocument' | 'splitGroup' | 'moveEditor' | 'setActiveEditor'>;

/** One editor of a document, where it sits. */
interface Placed {
	readonly groupId: string;
	readonly editorId: string;
	/** Its index in the group, for setActiveEditor. */
	readonly index: number;
}

/** A view as Documents holds it: its document uri, and how a fresh editor of it opens in a group. */
interface ViewDoc {
	readonly uri: string;
	open(groupId: string | undefined): Promise<void>;
}

// =============================================================================
// PLACEMENT
// =============================================================================

/**
 * Puts the user's view beside the chat `conversationId` and brings the chat to the front again.
 * Idempotent: a second call for the same view finds it beside the chat and only brings it to the front.
 * Two calls in one step for different views land in the same neighbour group, not two splits, because
 * everything up to the split runs before the one await (a canvas's first read), and the second call
 * reads the split the first made.
 *
 * @param docs - The app's Documents (getDocs()).
 * @param view - The resolved view; the App Builder's stage is the caller's job (agentHost.ts), not this module's.
 * @param conversationId - The chat's session id; its tab is the static doc `tool:agent/<id>`.
 * @throws When the editor area closed during the open (a team switch), or the view did not open.
 */
export async function showBeside(docs: PlacingDocs, view: UserView, conversationId: string): Promise<void> {
	const before = docs.getState();
	const target = viewDoc(docs, view);
	const chat = theChat(editorsOf(before, `tool:agent/${conversationId}`), before);
	const shown = editorsOf(before, target.uri);
	const elsewhere = shown.find((e) => e.groupId !== chat?.groupId);
	if (elsewhere) docs.setActiveEditor(elsewhere.groupId, elsewhere.index);
	else if (!chat) await target.open(undefined);
	else {
		const group = neighbourGroup(before.rootNode, chat.groupId) ?? docs.splitGroup(chat.groupId, 'horizontal', 'after');
		// step: every editor of the view is in the chat's group here; move one, never open a second
		if (shown[0]) docs.moveEditor(shown[0].editorId, group);
		else await target.open(group);
	}
	// step: the canvas read is the one await; a team switch during it tore the editor area down
	if (docs.destroyed === true) throw new Error('the editor area closed while the view opened');
	if (editorsOf(docs.getState(), target.uri).length === 0) throw new Error('the view did not open');
	// step: back to the chat; a move out of its group may have left another tab active there (moveEditor
	// keeps the old index when an earlier tab leaves), and each verb above made its own group active
	if (chat) {
		const index = docs.getState().groups[chat.groupId]?.editorIds.indexOf(chat.editorId) ?? -1;
		if (index >= 0) docs.setActiveEditor(chat.groupId, index);
	}
}

/**
 * The view's document and its open verb. The uris are the ones openWorkspaceFile and the New App wizard
 * already open: `tool:apps/<manifest id>` (static, labelled with the app's name) and a canvas's path
 * under pipelines/.
 */
function viewDoc(docs: PlacingDocs, view: UserView): ViewDoc {
	if (view.kind === 'app') {
		const uri = `tool:apps/${view.app.id}`;
		return { uri, open: async (groupId) => docs.openStaticDocument(uri, view.app.name, undefined, groupId) };
	}
	const uri = view.path.slice('pipelines/'.length);
	return { uri, open: (groupId) => docs.openDocument(uri, groupId) };
}

/** Every editor of a document, in group order. */
function editorsOf(state: DocumentsState, uri: string): Placed[] {
	return Object.values(state.groups).flatMap((group) => group.editorIds.flatMap((editorId, index) => (state.editors[editorId]?.documentUri === uri ? [{ groupId: group.id, editorId, index }] : [])));
}

/**
 * The chat the view goes beside, when the chat has several tabs (the tab bar's Split duplicates it): the
 * one in the active group (where the user is), else one its group shows, else the first. Null for none.
 */
function theChat(editors: Placed[], state: DocumentsState): Placed | null {
	return editors.find((e) => e.groupId === state.activeGroupId) ?? editors.find((e) => state.groups[e.groupId]?.activeEditorIndex === e.index) ?? editors[0] ?? null;
}

/**
 * The group right next to `groupId` in the layout: in the split that holds its leaf, the nearest leaf of
 * the other side (that side's first leaf when it lies after, its last when before). Null when `groupId`
 * is the only group.
 */
function neighbourGroup(root: LayoutNode, groupId: string): string | null {
	if (root.type === 'leaf') return null;
	const [a, b] = root.children;
	if (a.type === 'leaf' && a.groupId === groupId) return edgeLeaf(b, 0);
	if (b.type === 'leaf' && b.groupId === groupId) return edgeLeaf(a, 1);
	return neighbourGroup(a, groupId) ?? neighbourGroup(b, groupId);
}

/** The first (0) or last (1) leaf's group under a node. */
function edgeLeaf(node: LayoutNode, side: 0 | 1): string {
	return node.type === 'leaf' ? node.groupId : edgeLeaf(node.children[side], side);
}
