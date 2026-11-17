// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Dropper — the dev-tool mounts (workbench mode, plan 3.6).
 *
 * The host workbench (rocket-ui's tool documents, the VS Code dev-tool panel)
 * mounts `DropperDevTool` as a per-document frame: the document key IS the
 * address of the dropper source the drop zone is bound to. A node's
 * `open-tool` note opens one (`documents.open(address, title)` — the host
 * op lands with plan C.16b); nothing opens on tool activation, so the
 * sidebar controller only explains how a dropper document comes to exist.
 */

import React from 'react';
import type { DevToolProps } from 'shell';
import { EmptyState } from 'shell';
import { DropperDocument } from './DropperDocument';

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
 * The main surface: the drop zone for `docKey` (an address), or the generic
 * frame when the tool was opened without a document.
 *
 * @param props - {@link DevToolProps}; `docKey` is the dropper source's address.
 */
export const DropperDevTool: React.FC<DevToolProps> = ({ docKey }) => {
	if (docKey) {
		return (
			<div style={styles.fill}>
				<DropperDocument address={docKey} />
			</div>
		);
	}
	return (
		<div style={styles.fill}>
			<div style={styles.center}>
				<EmptyState
					title="Dropper"
					description="Press Open Dropper on a dropper source on the canvas. Each drop zone opens as its own document, bound to that pipeline's address."
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
 * the sidebar says where dropper documents come from.
 *
 * @param props - {@link DevToolProps}.
 */
export const DropperDevToolSidebar: React.FC<DevToolProps> = () => (
	<div style={styles.sidebar}>
		<EmptyState
			title="Dropper"
			description="Run a pipeline with a dropper source and press Open Dropper on the node. The drop zone opens beside the canvas."
		/>
	</div>
);
