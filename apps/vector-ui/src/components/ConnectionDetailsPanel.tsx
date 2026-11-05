// =============================================================================
// MIT License
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
// VECTOR-UI - CONNECTION DETAILS PANEL (inline, in a dev-tool console document)
// =============================================================================
//
// What the full app's drawer shows (the Connections landing's DetailPanel:
// the state, the sources and flags, why the console cannot be opened, Test
// connection and the store's details), as part of a dev-tool console's own
// layout. Not a DetailPanel: rocket-ui keeps hidden documents mounted
// (display: none), and a modal drawer left open in a background document
// would trap Tab, lock the page scroll and take Escape for the whole realm
// (F14). So this panel has no overlay, no focus trap and no document or
// window listener: it closes with its own button, or with Escape while the
// focus is inside it.
//
// The console keys it on its connection and mounts it only while open, so a
// Test result never carries over to another connection.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, BxX, Button, StatusBadge, commonStyles } from 'shell';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { announcer } from '../adapters/explorer';
import { TONE_EDGE } from '../vector/colors';
import { drawerView, testResultText, vectorCardView } from '../vector/connections';
import type { ITestResult } from '../vector/connections';
import type { IStatsView } from '../vector/results';
import { VectorIcon } from '../icons';
import { styles as appStyles } from '../styles';
import ConnectionDrawerDetails from './ConnectionDrawerDetails';

const styles = {
	/** A bordered block under the console's header; its body scrolls when the details are long. */
	panel: {
		flexShrink: 0,
		display: 'flex',
		flexDirection: 'column',
		maxHeight: '50%',
		margin: '12px 24px 0',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		background: 'var(--rr-bg-paper)',
		overflow: 'hidden',
		outline: 'none',
	} as CSSProperties,
	header: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 12px 0 16px' } as CSSProperties,
	icon: { display: 'inline-flex', width: 20, height: 20, flexShrink: 0, color: 'var(--rr-text-secondary)' } as CSSProperties,
	heading: { flex: 1, minWidth: 0 } as CSSProperties,
	title: { ...commonStyles.textEllipsis, fontSize: 14, fontWeight: 600, color: 'var(--rr-text-primary)' } as CSSProperties,
	subtitle: { ...commonStyles.textEllipsis, fontSize: 12, color: 'var(--rr-text-secondary)' } as CSSProperties,
	close: commonStyles.paneHeaderButton,
	body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 16px' } as CSSProperties,
	status: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 } as CSSProperties,
	banner: { marginBottom: 8 } as CSSProperties,
	footer: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '8px 16px 12px', borderTop: '1px solid var(--rr-border)' } as CSSProperties,
};

/** Props. */
export interface IConnectionDetailsPanelProps {
	endpoint: IExplorerEndpoint;
	probe: IProbeResult | undefined;
	/** The console's last stats answer: it fills what the dialect read at discovery lacks. */
	stats: IStatsView | null;
	/** Re-probe the endpoint; resolves with the new result (null when nothing was sent). */
	onTest(endpoint: IExplorerEndpoint): Promise<IProbeResult | null>;
	onClose(): void;
}

/**
 * The inline panel.
 *
 * @param props - See {@link IConnectionDetailsPanelProps}.
 * @returns The panel.
 */
export const ConnectionDetailsPanel: React.FC<IConnectionDetailsPanelProps> = ({ endpoint, probe, stats, onTest, onClose }) => {
	const view = vectorCardView(endpoint, probe);
	const region = useRef<HTMLElement>(null);
	const [testing, setTesting] = useState(false);
	const [tested, setTested] = useState<ITestResult | null>(null);

	// Opened: take the focus (its content is read, and Escape reaches it). Closed with the focus inside: give it back to
	// what opened it, if that is still on the page.
	useEffect(() => {
		const node = region.current;
		const opener = typeof document === 'undefined' ? null : document.activeElement;
		node?.focus();
		return () => {
			if (typeof document === 'undefined') return;
			const focused = document.activeElement;
			const lost = focused === null || focused === document.body || (node !== null && node.contains(focused));
			if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);

	const test = async (): Promise<void> => {
		if (testing) return;
		setTesting(true);
		try {
			const result = testResultText(await onTest(endpoint));
			setTested(result);
			// Said, not only shown: the focus is on the button that asked for it.
			announcer.announce(result.text);
		} finally {
			setTesting(false);
		}
	};

	return (
		<section
			ref={region}
			tabIndex={-1}
			aria-label={`Connection details: ${view.title}`}
			style={styles.panel}
			onKeyDown={(event) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					onClose();
				}
			}}
		>
			<div style={styles.header}>
				<span style={styles.icon}><VectorIcon /></span>
				<div style={styles.heading}>
					<div style={styles.title}>{view.title}</div>
					<div style={styles.subtitle}>{view.address}</div>
				</div>
				<button type="button" style={styles.close} title="Close details" aria-label="Close details" onClick={onClose}>
					<BxX size={18} />
				</button>
			</div>
			<div style={styles.body}>
				<div style={styles.status}>
					<StatusBadge variant={view.badge.variant}>{view.badge.label}</StatusBadge>
					<span style={appStyles.small}>{view.roleLine}</span>
					{view.flags.map((flag) => (
						<span key={flag.label} style={appStyles.chip(TONE_EDGE[flag.variant])} title={flag.tooltip}>
							{flag.label}
						</span>
					))}
				</div>
				{view.blocked && (
					<div style={styles.banner}>
						<Banner variant={endpoint.state === 'ready' ? 'warning' : 'info'}>{view.blocked}</Banner>
					</div>
				)}
				{tested && (
					<div style={styles.banner}>
						<Banner variant={tested.variant}>{tested.text}</Banner>
					</div>
				)}
				<ConnectionDrawerDetails drawer={drawerView(endpoint, probe, stats)} />
			</div>
			<div style={styles.footer}>
				<Button variant="ghost" onClick={() => void test()}>
					{testing ? 'Testing…' : 'Test connection'}
				</Button>
			</div>
		</section>
	);
};

export default ConnectionDetailsPanel;
