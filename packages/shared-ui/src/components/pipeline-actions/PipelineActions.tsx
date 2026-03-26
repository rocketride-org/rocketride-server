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
import EndpointInfoModal from './EndpointInfoModal';
import { actionsStyles as styles } from './index.style';

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

function truncateForNode(url: string): string {
	if (url.length <= 42) return url;
	return `${url.slice(0, 39)}...`;
}

function isWebhookEndpoint(info: IEndpointInfo, host?: string): boolean {
	const url = processLink(info['url-link'], host) ?? info['url-link'];
	const label = info['url-text'] ?? '';
	return /web[\s-]?hook/i.test(url) || /web[\s-]?hook/i.test(label);
}

// =============================================================================
// Component
// =============================================================================

export default function PipelineActions({ notes, host, onOpenLink, displayName }: IPipelineActionsProps): ReactElement | null {
	const endpointInfo = useMemo(() => getEndpointInfo(notes), [notes]);
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [copyFeedback, setCopyFeedback] = useState(false);

	if (!endpointInfo) return null;

	const buttonLink = processLink(endpointInfo['button-link'], host);
	const endpointUrl = processLink(endpointInfo['url-link'], host) ?? endpointInfo['url-link'];
	const hasButton = endpointInfo['button-text'] && buttonLink;
	const shouldShowEndpointUi = isWebhookEndpoint(endpointInfo, host);

	const handleCopyEndpoint = (e: React.MouseEvent) => {
		e.stopPropagation();
		navigator.clipboard
			.writeText(endpointUrl)
			.then(() => {
				setCopyFeedback(true);
				setTimeout(() => setCopyFeedback(false), 1200);
			})
			.catch(() => {
				// Clipboard may be blocked by host.
			});
	};

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
					{shouldShowEndpointUi && (
						<button
							style={styles.secondaryBtn}
							onClick={(e: React.MouseEvent) => {
								e.stopPropagation();
								setIsModalOpen(true);
							}}
						>
							Endpoint Info
						</button>
					)}
				</div>
				{shouldShowEndpointUi && (
					<div style={styles.endpointRow} title={endpointUrl}>
						<div style={styles.endpointLabel}>Endpoint</div>
						<div style={styles.endpointValue}>{truncateForNode(endpointUrl)}</div>
						<button style={{ ...styles.endpointCopyBtn, ...(copyFeedback ? styles.endpointCopyBtnSuccess : {}) }} onClick={handleCopyEndpoint}>
							{copyFeedback ? 'Copied' : 'Copy'}
						</button>
					</div>
				)}
			</div>
			{shouldShowEndpointUi && <EndpointInfoModal endpointInfo={endpointInfo} isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onOpenLink={onOpenLink} displayName={displayName} host={host} />}
		</>
	);
}
