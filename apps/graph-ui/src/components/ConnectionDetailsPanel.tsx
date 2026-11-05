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
// GRAPH-UI - CONNECTION DETAILS PANEL (inline, in a dev-tool connection document)
// =============================================================================
//
// What the full app's drawer shows (ConnectionDetails), as part of a dev-tool
// document's own layout. Not a DetailPanel: rocket-ui keeps hidden documents
// mounted (display: none), and a modal drawer left open in a background
// document would trap Tab, lock the page scroll and take Escape for the whole
// realm. So this panel has no overlay, no focus trap and no document or window
// listener: it closes with its own button, or with Escape while the focus is
// inside it.
//
// The document keys it on its connection and mounts it only while open, so a
// Test result never carries over. Each Test connection the document asks for
// (`testRequest`, see graph/connections.ts detailsPanelAfter) tests once.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { BxX, Button, commonStyles } from 'shell';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { announcer } from '../adapters/explorer';
import { connectionView } from '../graph/connections';
import { GraphIcon } from '../icons';
import { ConnectionDetailsBody, useConnectionTest } from './ConnectionDetails';

const styles = {
	/** A bordered block under the document's header; its body scrolls when the details are long. */
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
	header: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '12px 12px 0 16px',
	} as CSSProperties,
	icon: {
		display: 'inline-flex',
		width: 20,
		height: 20,
		flexShrink: 0,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	heading: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	title: {
		...commonStyles.textEllipsis,
		fontSize: 14,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	subtitle: {
		...commonStyles.textEllipsis,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	close: commonStyles.paneHeaderButton,
	body: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		padding: '0 16px 8px',
	} as CSSProperties,
	footer: {
		display: 'flex',
		justifyContent: 'flex-end',
		gap: 8,
		padding: '8px 16px 12px',
		borderTop: '1px solid var(--rr-border)',
	} as CSSProperties,
};

/** Props. */
export interface IConnectionDetailsPanelProps {
	endpoint: IExplorerEndpoint;
	probe: IProbeResult | undefined;
	/** The document's last Test connection request (0: none); each new one tests once. */
	testRequest: number;
	/** Re-probe the endpoint; resolves with the new result (null when nothing was sent). */
	onTest(endpoint: IExplorerEndpoint): Promise<IProbeResult | null>;
	/** Open the connection's workbench; omitted inside the workbench itself (no button then). */
	onOpen?(endpoint: IExplorerEndpoint): void;
	onClose(): void;
}

/**
 * The inline panel.
 *
 * @param props - See {@link IConnectionDetailsPanelProps}.
 * @returns The panel.
 */
export const ConnectionDetailsPanel: React.FC<IConnectionDetailsPanelProps> = ({ endpoint, probe, testRequest, onTest, onOpen, onClose }) => {
	const { testing, tested, test } = useConnectionTest(onTest);
	const view = connectionView(endpoint, probe);
	const region = useRef<HTMLElement>(null);
	const lastTest = useRef(0);

	// Opened: take the focus (its content is read, and Escape reaches it). Closed with the focus inside: give it back to
	// what opened it, if that is still on the page.
	useEffect(() => {
		const node = region.current;
		const opener = document.activeElement;
		region.current?.focus();
		return () => {
			const focused = document.activeElement;
			const lost = focused === null || focused === document.body || (node !== null && node.contains(focused));
			if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);

	// Each Test connection the document asked for tests once (the ref keeps StrictMode's second effect run from probing
	// again), with the endpoint and handler of that moment.
	useEffect(() => {
		if (testRequest === 0 || testRequest === lastTest.current) return;
		lastTest.current = testRequest;
		void test(endpoint);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once per request
	}, [testRequest]);

	// The result is said, not only shown: the focus may be on the button that asked for it.
	useEffect(() => {
		if (tested) announcer.announce(tested.text);
	}, [tested]);

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
				<span style={styles.icon}><GraphIcon /></span>
				<div style={styles.heading}>
					<div style={styles.title}>{view.title}</div>
					<div style={styles.subtitle}>{view.address}</div>
				</div>
				<button type="button" style={styles.close} title="Close details" aria-label="Close details" onClick={onClose}>
					<BxX size={18} />
				</button>
			</div>
			<div style={styles.body}>
				<ConnectionDetailsBody endpoint={endpoint} probe={probe} tested={tested} />
			</div>
			<div style={styles.footer}>
				<Button variant="ghost" onClick={() => { if (!testing) void test(endpoint); }}>
					{testing ? 'Testing...' : 'Test connection'}
				</Button>
				{onOpen && (
					<Button variant="primary" disabled={!view.openable} onClick={() => onOpen(endpoint)}>
						Open workbench
					</Button>
				)}
			</div>
		</section>
	);
};

export default ConnectionDetailsPanel;
