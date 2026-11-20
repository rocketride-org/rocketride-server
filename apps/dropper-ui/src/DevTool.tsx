// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Dropper — the dev-tool mounts (workbench mode, plan 3.6).
 *
 * The host workbench (rocket-ui's tool documents, the VS Code dev-tool panel)
 * mounts `DropperDevTool` as a per-document frame: the document key is
 * `<address>/<nodeId>` (the URI `tool:rocketride.dropper/<address>/<nodeId>`,
 * plan 3.6), which a node's `open-tool` note opens through the host op
 * `openTool`; the drop zone binds to the address, and the node is the
 * dropper source the address already names. A bare address is accepted too.
 * Nothing opens on tool activation, so the sidebar controller only explains
 * how a dropper document comes to exist.
 */

import React from 'react';
import type { DevToolProps } from 'shell';
import { EmptyState } from 'shell';
import { parseToolDocKey } from 'shared/tools/pipelines/components/pipeline-actions/openTool';
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
 * The main surface: the drop zone for `docKey` (`<address>/<nodeId>`, or a
 * bare address), or the generic frame when the tool was opened without a
 * document.
 *
 * @param props - {@link DevToolProps}; `docKey` names the dropper source's address.
 */
export const DropperDevTool: React.FC<DevToolProps> = ({ docKey }) => {
	if (docKey) {
		// The node id is the source the address already names; a key that is
		// not address-shaped is passed through as the address (the server is
		// the authority and answers with its own error).
		const address = parseToolDocKey(docKey)?.address ?? docKey;
		return (
			<div style={styles.fill}>
				<DropperDocument address={address} />
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
