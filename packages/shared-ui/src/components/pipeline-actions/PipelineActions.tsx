// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * PipelineActions — Renders action buttons derived from a running pipeline's
 * endpoint info (e.g. "Chat now", "Endpoint Info").
 *
 * The endpoint info comes from `taskStatus.notes[0]` when the server reports
 * that a service is ready. This component extracts the button metadata and
 * renders compact action buttons.
 *
 * Used on canvas source nodes and the status page header.
 *
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 */

import React, { ReactElement, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import EndpointInfoModal from './EndpointInfoModal';

// =============================================================================
// Styles
// =============================================================================

const btnSmBase: CSSProperties = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	height: 'var(--rr-btn-sm-height, 16px)',
	padding: 'var(--rr-btn-sm-padding, 0 6px)',
	borderRadius: 'var(--rr-btn-sm-radius, 3px)',
	cursor: 'pointer',
	fontSize: 'var(--rr-btn-sm-font-size, 9px)',
	fontWeight: 500,
	lineHeight: 1,
	whiteSpace: 'nowrap',
};

const styles: Record<string, CSSProperties> = {
	container: {
		display: 'flex',
		gap: '4px',
		marginTop: '4px',
		width: '100%',
	},
	endpointRow: {
		marginTop: '4px',
		display: 'flex',
		alignItems: 'center',
		gap: '6px',
		width: '100%',
		backgroundColor: 'var(--rr-bg-surface-alt, var(--rr-bg-paper))',
		border: '1px solid var(--rr-border)',
		borderRadius: '4px',
		padding: '3px 6px',
	},
	endpointLabel: {
		fontSize: '9px',
		color: 'var(--rr-text-disabled)',
		flexShrink: 0,
	},
	endpointValue: {
		flex: 1,
		minWidth: 0,
		fontSize: '9px',
		...commonStyles.fontMono,
		color: 'var(--rr-text-secondary)',
		...commonStyles.textEllipsis,
	},
	endpointCopyBtn: {
		...btnSmBase,
		height: '14px',
		padding: '0 5px',
		fontSize: '8px',
		border: '1px solid var(--rr-border)',
		backgroundColor: 'transparent',
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
	},
	endpointCopyBtnSuccess: {
		backgroundColor: 'var(--rr-accent)',
		borderColor: 'var(--rr-accent)',
		color: 'var(--rr-fg-button)',
	},
	primaryBtn: {
		...btnSmBase,
		flex: 1,
		border: 'none',
		backgroundColor: 'var(--rr-accent)',
		color: 'var(--rr-fg-button)',
	},
	secondaryBtn: {
		...btnSmBase,
		flex: 1,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-paper)',
		color: 'var(--rr-text-secondary)',
	},
};

// =============================================================================
// Types
// =============================================================================

/**
 * Endpoint info structure embedded in `taskStatus.notes[0]` by the server
 * when a pipeline service exposes an external endpoint (chat UI, webhook, etc.).
 */
export interface IEndpointInfo {
	/** Label for the primary action button (e.g. "Chat now", "Open Dropper"). */
	'button-text'?: string;
	/** URL the primary button opens. May contain `{host}` placeholders. */
	'button-link'?: string;
	/** Label for the endpoint URL row (e.g. "Chat interface URL"). */
	'url-text': string;
	/** The actual endpoint URL. */
	'url-link': string;
	/** Label for the auth key row (e.g. "Public Authorization Key"). */
	'auth-text': string;
	/** The actual auth key value. */
	'auth-key': string;
	/** Label for an optional private token row. */
	'token-text'?: string;
	/** The actual private token value. */
	'token-key'?: string;
}

export interface IPipelineActionsProps {
	/** The notes array from taskStatus. Endpoint info is extracted from notes[0]. */
	notes?: (string | Record<string, unknown>)[];
	/** Host address used to replace `{host}` placeholders in URLs. */
	host?: string;
	/** Called when a URL needs to be opened externally. */
	onOpenLink?: (url: string, displayName?: string) => void;
	/** Display name for the source node (used as the tab title when opening links). */
	displayName?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Type guard: checks whether an unknown value is IEndpointInfo. */
function isEndpointInfo(value: unknown): value is IEndpointInfo {
	return value != null && typeof value === 'object' && 'url-text' in value && 'url-link' in value && 'auth-text' in value && 'auth-key' in value;
}

function getEndpointInfo(notes?: (string | Record<string, unknown>)[]): IEndpointInfo | null {
	if (!notes || notes.length === 0) return null;
	const first = notes[0];
	return isEndpointInfo(first) ? first : null;
}

/** Replaces {host} placeholders in a URL. */
function processLink(link: string | undefined, host?: string): string | undefined {
	if (!link || !host) return link;
	return link.replace(/{host}/g, host);
}

// =============================================================================
// Component
// =============================================================================

export default function PipelineActions({ notes, host, onOpenLink, displayName }: IPipelineActionsProps): ReactElement | null {
	const endpointInfo = useMemo(() => getEndpointInfo(notes), [notes]);
	const [isModalOpen, setIsModalOpen] = useState(false);

	if (!endpointInfo) return null;

	const buttonLink = processLink(endpointInfo['button-link'], host);
	const hasButton = endpointInfo['button-text'] && buttonLink;

	return (
		<>
			<div>
				<div style={styles.container}>
					{hasButton && (
						<button
							style={styles.primaryBtn}
							onClick={(e: React.MouseEvent) => {
								e.stopPropagation();
								onOpenLink?.(buttonLink, displayName);
							}}
						>
							{endpointInfo['button-text']}
						</button>
					)}
					<button
						style={styles.secondaryBtn}
						onClick={(e: React.MouseEvent) => {
							e.stopPropagation();
							setIsModalOpen(true);
						}}
					>
						Endpoint Info
					</button>
				</div>
			</div>
			<EndpointInfoModal endpointInfo={endpointInfo} isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onOpenLink={onOpenLink} displayName={displayName} host={host} />
		</>
	);
}
