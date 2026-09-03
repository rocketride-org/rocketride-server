// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * CloudCanvasPrompt - centered callout for connecting the IDE canvas to Cloud.
 *
 * This component is host-agnostic. The host decides whether Cloud is already
 * configured and what opening Cloud setup means.
 */

import { type CSSProperties, type ReactElement, useEffect, useRef } from 'react';

import { commonStyles } from 'shell';
// Deliberate deep import via shell's published `./src/*` subpath: these overlay-stack
// helpers are what DetailPanel uses to keep Escape from crossing between layers, but they
// are not re-exported from `shell`'s index. Importing them here keeps this prompt on the
// shared stack without widening shell's public API surface (which the gallery mirrors).
// @ts-expect-error -- the shell source subpath requires its .tsx suffix.
import { acquireOverlayLayer, isTopOverlayLayer, releaseOverlayLayer } from 'shell/src/components/modal/Modal.tsx';

// =============================================================================
// RocketRide mark
// =============================================================================

function RocketRideMark(): ReactElement {
	return (
		<svg width="18" height="18" viewBox="0 0 191 192" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style={styles.mark}>
			<path d="M159.5 161.424L153.7 167.224C151.9 169.024 148.9 169.024 147 167.224L126.6 146.824C115.6 135.824 115.6 118.024 126.6 107.024C138.1 95.5245 138.1 76.9245 126.6 65.4245L125.1 63.9245C113.6 52.4245 95 52.4245 83.5 63.9245C72.5 74.9245 54.6 74.9245 43.6 63.9245L23.2 43.5245C21.4 41.7245 21.4 38.7245 23.2 36.8245L29 31.0245C37 23.0245 49.1 20.5245 59.6 24.9245L87.5 36.3245C97.3 40.1245 108.4 38.0245 116.3 31.1245L137 10.4245C138.6 8.92449 140.4 7.42449 142.5 6.22449C146.2 4.12449 150.3 3.02449 154.5 2.62449L185.4 0.0244895C188.3 -0.275511 190.8 2.22449 190.5 5.12449L187.8 36.4245C187.3 42.8245 184.5 48.8245 180.1 53.5245L160.5 73.1245C152.5 81.2245 150.1 93.3245 154.5 103.824L155.5 106.224L161.2 120.024L165.6 130.924C169.9 141.424 167.5 153.524 159.5 161.524V161.424Z" fill="currentColor" />
			<path d="M0.799997 190.325C-0.200003 189.325 -0.300003 187.625 0.599997 186.425L21.1 162.024C31.1 150.024 37.9 137.725 41.3 125.325C43.6 116.625 44.6 108.525 44.1 101.225C44.1 100.325 44.4 99.4245 45.1 98.8245C45.8 98.2245 46.8 97.9245 47.7 98.1245C65 101.625 83.5 98.3245 98.5 88.9245C99.6 88.2245 101.1 88.4245 102 89.3245C102.9 90.2245 103.1 91.7245 102.4 92.8245C93 107.825 89.7 126.325 93.2 143.525C93.4 144.325 93.2 145.225 92.6 145.925C92 146.625 91 147.225 90.1 147.125C82.8 146.625 74.6 147.525 66 149.925C53.6 153.225 41.2 160.025 29.3 170.125L4.9 190.625C3.8 191.525 2.1 191.525 0.999997 190.425H0.799997V190.325Z" fill="#F93822" />
		</svg>
	);
}

const styles = {
	overlay: {
		position: 'absolute' as const,
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		boxSizing: 'border-box' as const,
		padding: '16px',
		pointerEvents: 'none' as const,
		zIndex: 1200,
	},
	card: {
		pointerEvents: 'auto' as const,
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: '8px',
		padding: '18px 20px',
		maxWidth: '500px',
		width: '100%',
		fontFamily: 'var(--rr-font-family-widget)',
		color: 'var(--rr-fg-widget)',
		boxShadow: '0 14px 34px rgba(0,0,0,0.2)',
	},
	titleRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' },
	mark: { width: 18, height: 18, color: 'var(--rr-brand)', flexShrink: 0 },
	heading: { margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--rr-text-primary)', lineHeight: 1.25 },
	body: { margin: '0 0 18px 26px', fontSize: '13px', lineHeight: 1.5, color: 'var(--rr-text-secondary)' },
	actions: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginLeft: 26 },
	leftActions: { display: 'flex', alignItems: 'center', gap: 8 },
	linkButton: { border: 'none', background: 'transparent', color: 'var(--rr-text-secondary)', cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit', padding: '6px 0', textDecoration: 'none', whiteSpace: 'nowrap' },
} satisfies Record<string, CSSProperties>;

interface CloudCanvasPromptProps {
	onOpenCloudSetup: () => void;
	onDismiss: () => void;
	onDismissForever: () => void;
}

export default function CloudCanvasPrompt({ onOpenCloudSetup, onDismiss, onDismissForever }: CloudCanvasPromptProps): ReactElement {
	const cardRef = useRef<HTMLDivElement>(null);
	const openerRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	useEffect(() => {
		const layer = acquireOverlayLayer(false);
		if (document.activeElement === null || document.activeElement === document.body) cardRef.current?.focus();
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || !isTopOverlayLayer(layer)) return;
			if (event.key === 'Escape') onDismissRef.current();
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => {
			document.removeEventListener('keydown', handleKeyDown);
			releaseOverlayLayer(layer);
			if (cardRef.current?.contains(document.activeElement)) openerRef.current?.focus();
		};
	}, []);

	return (
		<div style={styles.overlay}>
			<div ref={cardRef} role="dialog" aria-labelledby="cloud-canvas-prompt-title" tabIndex={-1} style={styles.card}>
				<div style={styles.titleRow}>
					<RocketRideMark />
					<h3 id="cloud-canvas-prompt-title" style={styles.heading}>
						Connect this pipeline to RocketRide Cloud
					</h3>
				</div>
				<p style={styles.body}>
					<strong style={{ color: 'var(--rr-text-primary)' }}>RocketRide Cloud</strong> lets you run, deploy, and manage pipelines from your IDE with hosted infrastructure.
				</p>
				<div style={styles.actions}>
					<div style={styles.leftActions}>
						<button type="button" style={commonStyles.buttonPrimary as CSSProperties} onClick={onOpenCloudSetup}>
							Connect to Cloud
						</button>
						<button type="button" style={commonStyles.buttonSecondary as CSSProperties} onClick={onDismiss}>
							Dismiss
						</button>
					</div>
					<button type="button" style={styles.linkButton} onClick={onDismissForever}>
						Don't show again
					</button>
				</div>
			</div>
		</div>
	);
}
