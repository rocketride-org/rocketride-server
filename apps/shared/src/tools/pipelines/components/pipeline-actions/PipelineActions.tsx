// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * PipelineActions — Renders action buttons derived from a running pipeline's
 * status notes: the node's own front-end button (Open Chat / Open Dropper /
 * Explore, from its `open-tool` note; plan 3.6) and "Endpoint Info".
 *
 * The endpoint info comes from `taskStatus.notes[0]` when the server reports
 * that a service is ready. A node's button opens its front end's document
 * bound to the running control's address and the node through the host op
 * `openTool(appId, address, nodeId)`; no URL is built for a node.
 *
 * Used on canvas source nodes and the status page header.
 *
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 */

import React, { ReactElement, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from 'shell';
import EndpointInfoModal from './EndpointInfoModal';
import type { EndpointKeyMinter } from './endpointKey';
import { openToolNotes, sourceEndpointNote } from './openTool';
import type { IOpenToolNote } from './openTool';

// =============================================================================
// Styles
// =============================================================================

const styles: Record<string, CSSProperties> = {
	container: {
		display: 'flex',
		gap: '4px',
		marginTop: '4px',
		width: '100%',
	},
};

// =============================================================================
// Types
// =============================================================================

/**
 * Endpoint info structure embedded in a source's status notes by the server
 * when its service is ready: the data door of a webhook (`url-link`), or the
 * front end of a chat/dropper source (`open-tool`; no URL, the page servers
 * are gone).
 */
export interface IEndpointInfo {
	/** Label for the node's front-end button (e.g. "Open Chat", "Open Dropper"). */
	'button-text'?: string;
	/**
	 * The app id of the front end that talks to this node (`rocketride.chat`,
	 * `rocketride.dropper`, `rocketride.sql`): the node's button (plan 3.6).
	 * The host opens that app's document bound to `address` and `nodeId`.
	 */
	'open-tool'?: string;
	/** The node the front end binds to: its component id in the pipeline. */
	nodeId?: string;
	/** Label for the endpoint URL row (e.g. "Webhook interface URL"). Absent on a source without a URL. */
	'url-text'?: string;
	/** The data door's URL (webhook). Absent on a chat/dropper source: nothing to POST to. */
	'url-link'?: string;
	/**
	 * The control's address, `developerId.pipeId.source` — what a machine
	 * caller POSTs to and what the minted key is scoped to (plan §2.2). The
	 * notes carry NO credential: the pk_/tk_ tokens are gone (plan §2.4).
	 * Absent on older engines.
	 */
	address?: string;
	/**
	 * Data lanes some component downstream of this source reads, as reported by
	 * the running pipeline. Drives which Content-Type the endpoint panel
	 * preselects. Absent on older engines or when the wiring could not be read.
	 */
	lanes?: string[];
}

/** Opens a front end's document bound to one running node (plan 3.6). */
export type OpenToolHandler = (appId: string, address: string, nodeId: string) => void;

export interface IPipelineActionsProps {
	/** The notes array from taskStatus: the endpoint info (the first endpoint-shaped note) and, absent `tools`, the buttons. */
	notes?: (string | Record<string, unknown>)[];
	/** The node's buttons when the caller resolved them itself (a canvas node: its notes across every source's status). */
	tools?: IOpenToolNote[];
	/** The source component the notes belong to: tells its own endpoint note from a database node's. */
	sourceId?: string;
	/** Host address used to replace `{host}` placeholders in URLs. */
	host?: string;
	/** Called when a docs URL needs to be opened in the browser (the endpoint modal's links). */
	onOpenLink?: (url: string, displayName?: string) => void;
	/** Opens the node's front end for its `open-tool` note. Absent = the host cannot; the button is not shown. */
	onOpenTool?: OpenToolHandler;
	/** Display name for the source node (the endpoint modal's title). */
	displayName?: string;
	/** Mints the owner's scoped key for the endpoint (the modal's Create API key; plan §2.4). Absent = the host cannot mint. */
	onCreateEndpointKey?: EndpointKeyMinter;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * The source's endpoint note: its data door (`url-link`) or its own
 * `open-tool` note; a database node's note merged into the list is never
 * the endpoint (see {@link sourceEndpointNote}).
 */
function getEndpointInfo(notes?: (string | Record<string, unknown>)[], sourceId?: string): IEndpointInfo | null {
	return (sourceEndpointNote(notes, sourceId) as IEndpointInfo | null) ?? null;
}

// =============================================================================
// Component
// =============================================================================

export default function PipelineActions({ notes, tools: toolsProp, sourceId, host, onOpenLink, onOpenTool, displayName, onCreateEndpointKey }: IPipelineActionsProps): ReactElement | null {
	const endpointInfo = useMemo(() => getEndpointInfo(notes, sourceId), [notes, sourceId]);
	// The node's own buttons: one per open-tool note the server filled. Shown
	// only when the host can open a tool document.
	const tools = useMemo(() => (onOpenTool ? (toolsProp ?? openToolNotes(notes)) : []), [notes, toolsProp, onOpenTool]);
	const [isModalOpen, setIsModalOpen] = useState(false);

	if (!endpointInfo && tools.length === 0) return null;

	// Stock Buttons only, at the mini (canvas-node) size — the 26px small tier
	// overflows the node card. Clicks stop at the container so a press never
	// bubbles into canvas node selection/drag.
	return (
		<>
			<div style={styles.container} onClick={(e: React.MouseEvent) => e.stopPropagation()}>
				{tools.map((tool) => (
					<Button key={`${tool.appId}/${tool.address}/${tool.nodeId}`} mini variant="primary" onClick={() => onOpenTool?.(tool.appId, tool.address, tool.nodeId)}>
						{tool.label}
					</Button>
				))}
				{endpointInfo && (
					<Button mini variant="secondary" onClick={() => setIsModalOpen(true)}>
						Endpoint Info
					</Button>
				)}
			</div>
			{endpointInfo && <EndpointInfoModal endpointInfo={endpointInfo} isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onOpenLink={onOpenLink} tool={tools.find((t) => t.appId === endpointInfo['open-tool'])} onOpenTool={onOpenTool} displayName={displayName} host={host} onCreateEndpointKey={onCreateEndpointKey} />}
		</>
	);
}
