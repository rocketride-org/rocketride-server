// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// EXPLORER DOCS BRIDGE — the tree's document actions, local or cross-document
// =============================================================================
//
// The file tree opens documents and keeps tabs honest across rename/move/
// delete. Inside the app, tree and editor share one Documents singleton —
// the LOCAL bridge talks to it directly. Mounted as a devToolSidebar, the
// tree lives in the HOST's sidebar webview, an isolated document — the
// CHANNEL bridge sends the same actions as tool-channel events ('docs'
// toward the frame, which owns Documents and applies them through the local
// bridge; 'active' back toward the tree highlight).

import { typedToolChannel } from 'shell';
import type { ToolChannel, ToolEventMap as ToolEventMapBase, ToolStateMap as ToolStateMapBase } from 'shell';
import { getDocs } from './docs';
import type { ViewerId } from './viewerRegistry';

// =============================================================================
// TYPES
// =============================================================================

/** The tree's document-side actions plus the active-path feed. */
export interface ExplorerDocsBridge {
	/** Open a file. */
	open(path: string): void;
	/** Open a file pinned to a specific viewer. */
	openWith(path: string, viewerId: ViewerId): void;
	/** A file/dir was renamed on the server — re-point open tabs. */
	renamed(from: string, to: string): void;
	/** A file/dir was moved on the server — re-point open tabs. */
	moved(from: string, to: string): void;
	/** A file was deleted on the server — discard its tab. */
	deleted(path: string): void;
	/** Subscribe to the active document path (tree highlight). Returns unsubscribe. */
	subscribeActive(cb: (path: string) => void): () => void;
}

/** The 'docs' channel event's payload (sidebar → frame, app-internal). */
type ExplorerDocsAction =
	| { op: 'open'; path: string }
	| { op: 'openWith'; path: string; viewerId: ViewerId }
	| { op: 'renamed'; from: string; to: string }
	| { op: 'moved'; from: string; to: string }
	| { op: 'deleted'; path: string };

/** The explorer's channel events (either direction). */
interface ExplorerEventMap extends ToolEventMapBase {
	/** A tree action for the frame's Documents (user-initiated — may summon
	 *  a closed frame, which is the point of a tree click). */
	docs: ExplorerDocsAction;
	/** The frame's active document path (tree highlight). The host retains
	 *  the last frame push for a remounted sidebar. */
	active: string;
}

// =============================================================================
// LOCAL BRIDGE — tree and Documents in the same document
// =============================================================================

/** Reads the active document path from the Documents store. */
function readActivePath(): string {
	const docs = getDocs();
	if (!docs) return '';
	const s = docs.getState();
	const group = s.groups[s.activeGroupId];
	if (!group) return '';
	const editorId = group.editorIds[group.activeEditorIndex];
	return editorId ? (s.editors[editorId]?.documentUri ?? '') : '';
}

/** The in-document bridge over the Documents singleton. */
export const localDocsBridge: ExplorerDocsBridge = {
	open(path) {
		void getDocs()?.openDocument(path);
	},

	openWith(path, viewerId) {
		const docs = getDocs();
		if (!docs) return;
		// Open the file (may already be open), then pin the viewer on its tab.
		void docs.openDocument(path).then(() => {
			const s = docs.getState();
			const group = s.groups[s.activeGroupId];
			if (!group) return;
			const editorId = group.editorIds.find((eid) => s.editors[eid]?.documentUri === path);
			if (!editorId) return;
			docs.updateEditorViewState(editorId, { ...s.editors[editorId]?.viewState, viewerId });
		});
	},

	renamed(from, to) {
		const docs = getDocs();
		if (!docs) return;
		const s = docs.getState();
		const editorIds = Object.entries(s.editors)
			.filter(([, ed]) => ed.documentUri === from)
			.map(([id]) => id);
		for (const eid of editorIds) docs.closeEditor(eid);
		if (editorIds.length > 0) void docs.openDocument(to);
	},

	moved(from, to) {
		const docs = getDocs();
		if (!docs) return;
		// A moved file re-points its tab; a moved directory re-points every
		// open tab whose path lives under the old prefix.
		const s = docs.getState();
		const dirPrefix = `${from}/`;
		const affected = Object.entries(s.editors)
			.map(([id, ed]) => ({ id, uri: ed.documentUri }))
			.filter(({ uri }) => uri === from || uri.startsWith(dirPrefix));
		const reopenPaths: string[] = [];
		for (const { id, uri } of affected) {
			reopenPaths.push(uri === from ? to : `${to}/${uri.slice(dirPrefix.length)}`);
			docs.closeEditor(id);
		}
		void (async () => {
			for (const movedUri of reopenPaths) await docs.openDocument(movedUri);
		})();
	},

	deleted(path) {
		getDocs()?.discardDocument(path);
	},

	subscribeActive(cb) {
		const docs = getDocs();
		if (!docs) {
			cb('');
			return () => {};
		}
		cb(readActivePath());
		return docs.subscribe(() => cb(readActivePath()));
	},
};

// =============================================================================
// PEER BRIDGE — tree in the host's sidebar, Documents in the frame
// =============================================================================

/**
 * Builds the sidebar-mount bridge: actions ride the channel's 'docs' event;
 * the active path arrives as the frame's 'active' event.
 *
 * @param channel - The mount's channel from DevToolProps.
 * @returns The bridge the tree renders against.
 */
export function createPeerDocsBridge(channel: ToolChannel): ExplorerDocsBridge {
	const typed = typedToolChannel<ToolStateMapBase, ExplorerEventMap>(channel);
	const send = (action: ExplorerDocsAction) => typed.sendEvent('docs', action);
	return {
		open: (path) => send({ op: 'open', path }),
		openWith: (path, viewerId) => send({ op: 'openWith', path, viewerId }),
		renamed: (from, to) => send({ op: 'renamed', from, to }),
		moved: (from, to) => send({ op: 'moved', from, to }),
		deleted: (path) => send({ op: 'deleted', path }),
		subscribeActive: (cb) => typed.onEvent('active', cb),
	};
}

/**
 * Attaches the FRAME side of the protocol: applies incoming tree actions
 * through the local bridge and publishes active-path changes.
 * Call once Documents exists; returns the detach function.
 *
 * @param channel - The mount's channel from DevToolProps.
 * @returns Unsubscribe for both directions.
 */
export function attachExplorerPeerHost(channel: ToolChannel): () => void {
	const typed = typedToolChannel<ToolStateMapBase, ExplorerEventMap>(channel);
	const offDocsEvents = typed.onEvent('docs', (msg) => {
		if (!msg || typeof msg !== 'object') return;
		switch (msg.op) {
			case 'open': localDocsBridge.open(msg.path); break;
			case 'openWith': localDocsBridge.openWith(msg.path, msg.viewerId); break;
			case 'renamed': localDocsBridge.renamed(msg.from, msg.to); break;
			case 'moved': localDocsBridge.moved(msg.from, msg.to); break;
			case 'deleted': localDocsBridge.deleted(msg.path); break;
		}
	});
	// Publish the active path — now, and on every Documents change. The
	// sidebar mount may attach late; the host retains the last frame push,
	// and every subsequent change re-publishes anyway.
	const docs = getDocs();
	let last: string | null = null;
	const publish = () => {
		const path = readActivePath();
		if (path === last) return;
		last = path;
		typed.sendEvent('active', path);
	};
	publish();
	const offDocs = docs ? docs.subscribe(publish) : () => {};
	return () => {
		offDocsEvents();
		offDocs();
	};
}
