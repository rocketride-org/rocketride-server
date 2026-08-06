// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * VersionRecordPanel — one immutable registry version as a wide record
 * drawer: the readonly canvas render of the published artifact (the
 * DeploymentView DESIGN page without the page strip — a version has no
 * runtime, so there is nothing else to show). Opened from the version
 * cards on the DEPLOY page.
 *
 * ONE DetailPanel instance across loading→loaded (the record-drawer
 * standard: the opening gesture is never a dead click and never a double
 * slide-in), and NO footer verbs — the artifact is immutable; Deploy
 * lives on the card, not here.
 */

import React, { useMemo, CSSProperties, ComponentProps } from 'react';

import { DetailPanel } from 'shell';
import CanvasPanel from '../canvas';
import { OAUTH_ROOT_URL } from 'shell/src/auth/oauth';
import { formatTime } from '../../modules/server/util/formatters';
import type { DeployVersionCard } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default drawer width as a fraction of the viewport (the wide-record
    standard shared with DeploymentRecordPanel). */
const DEFAULT_HOST_FRACTION = 0.75;

// =============================================================================
// PROPS
// =============================================================================

/** Props for {@link VersionRecordPanel}. */
export interface IVersionRecordPanelProps {
	/** Whether the drawer is open (renders nothing when closed). */
	open: boolean;
	/** Dismiss the drawer (close glyph / Escape / sliver). */
	onClose: () => void;
	/** The registry card that was clicked (title + provenance line). */
	card: DeployVersionCard;
	/** Pipeline display name for the title (falls back to 'Pipeline'). */
	pipelineName?: string;
	/** The fetched artifact pipeline; absent = loading (or failed). */
	pipeline?: ComponentProps<typeof CanvasPanel>['project'];
	/** Load failure message (rendered as the body while data is absent). */
	loadError?: string;
	/** Service catalog for the readonly canvas render. */
	servicesJson: ComponentProps<typeof CanvasPanel>['servicesJson'];
	/** Pipeline validation passthrough (the canvas requires one). */
	handleValidatePipeline: ComponentProps<typeof CanvasPanel>['handleValidatePipeline'];
	/** Whether the host is connected (canvas status affordances). */
	isConnected: boolean;
	/** Whether the caller holds an active subscription (canvas gating). */
	isSubscribed?: boolean;
	/** Server host URL for {host} placeholder replacement. */
	serverHost?: string;
	/** Open an external link in the host's browser. */
	onOpenLink?: (url: string, displayName?: string) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	// flushBody hands the drawer a definite flex body; the canvas needs a
	// definite, non-zero box to compute its viewport fit. position:relative
	// is LOAD-BEARING: CanvasPanel's root is absolute inset-0 and fills its
	// nearest positioned ancestor — without this it fills the DetailPanel
	// itself and paints over the drawer header (title + close).
	canvasFill: {
		position: 'relative',
		flex: 1,
		minHeight: 0,
	} as CSSProperties,
	stateMessage: {
		padding: 24,
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders one immutable registry version as a wide, verb-less record
 * drawer holding the readonly canvas.
 *
 * @param props - {@link IVersionRecordPanelProps}.
 * @returns The drawer element, or null while closed.
 */
export const VersionRecordPanel: React.FC<IVersionRecordPanelProps> = ({ open, onClose, card, pipelineName, pipeline, loadError, servicesJson, handleValidatePipeline, isConnected, isSubscribed = true, serverHost = '', onOpenLink }) => {
	// Default width per open: 75% of the current viewport (the DetailPanel
	// clamps to its usable band and a persisted drag width overrides).
	const width = useMemo(() => Math.round(window.innerWidth * DEFAULT_HOST_FRACTION), []);

	if (!open) return null;

	// Provenance line: who published it, when, and the locked hash.
	const subtitle = `Immutable published snapshot — read-only · ${card.publishedBy}${card.publishedAt ? ` · ${formatTime(card.publishedAt)}` : ''}`;

	return (
		<DetailPanel open onClose={onClose} title={`${pipelineName || 'Pipeline'} v${card.version}`} subtitle={subtitle} width={width} persistKey="panelVersionRecordWidth" flushBody>
			{pipeline ? (
				<div style={S.canvasFill}>
					<CanvasPanel oauth2RootUrl={OAUTH_ROOT_URL} project={pipeline} servicesJson={servicesJson} handleValidatePipeline={handleValidatePipeline} isConnected={isConnected} isSubscribed={isSubscribed} serverHost={serverHost} onOpenLink={onOpenLink} isReadonly />
				</div>
			) : (
				<div style={S.stateMessage}>{loadError ? `Failed to load version: ${loadError}` : 'Loading version…'}</div>
			)}
		</DetailPanel>
	);
};
