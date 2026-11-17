// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Chat — the dev-tool mounts (workbench mode, plan 3.6).
 *
 * The host workbench (rocket-ui's tool documents, the VS Code dev-tool panel)
 * mounts `ChatDevTool` as a per-document frame: the document key IS the
 * address of the chat source the conversation is bound to. A node's
 * `open-tool` note opens one (`documents.open(address, title)` — the host
 * op lands with plan C.16b); nothing opens on tool activation, so the
 * sidebar controller only explains how a chat document comes to exist.
 */

import React from 'react';
import type { DevToolProps } from 'shell';
import { EmptyState } from 'shell';
import { ChatDocument } from './ChatDocument';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	fill: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
	},
	center: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		flex: 1,
		padding: 24,
	},
	sidebar: {
		padding: 16,
		fontFamily: 'var(--rr-font-family, system-ui)',
	},
};

// =============================================================================
// FRAME
// =============================================================================

/**
 * The main surface: the conversation for `docKey` (an address), or the
 * generic frame when the tool was opened without a document.
 *
 * @param props - {@link DevToolProps}; `docKey` is the chat source's address.
 */
export const ChatDevTool: React.FC<DevToolProps> = ({ docKey }) => {
	if (docKey) {
		return (
			<div style={styles.fill}>
				<ChatDocument address={docKey} />
			</div>
		);
	}
	return (
		<div style={styles.fill}>
			<div style={styles.center}>
				<EmptyState
					title="Chat"
					description="Press Open Chat on a chat source on the canvas. Each chat opens as its own document, bound to that pipeline's address."
				/>
			</div>
		</div>
	);
};

// =============================================================================
// SIDEBAR
// =============================================================================

/**
 * The controller: a per-document tool has no list of its own to show, so
 * the sidebar says where chat documents come from.
 *
 * @param props - {@link DevToolProps}.
 */
export const ChatDevToolSidebar: React.FC<DevToolProps> = () => (
	<div style={styles.sidebar}>
		<EmptyState
			title="Chat"
			description="Run a pipeline with a chat source and press Open Chat on the node. The conversation opens beside the canvas."
		/>
	</div>
);
