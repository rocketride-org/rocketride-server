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
// GRAPH-UI - CONNECTION DETAILS (what a node says about itself, and its Test)
// =============================================================================
//
// The body two places share: the full app's ConnectionDrawer (a DetailPanel
// over the window, opened from a Connections card) and, as a dev tool, a
// connection document's inline details panel. Status (the badge, why it
// cannot be browsed, the last Test result), Connection (pipeline, node, run,
// engine, target, writes) and What to know (the read boundary, upgrades).
// `useConnectionTest` is the Test connection step both run. Nothing here
// holds or shows a credential, and nothing here listens outside itself.
// =============================================================================

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, LabelValue, Section, StatusBadge } from 'shell';
import type { IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { connectionView, testResultText } from '../graph/connections';
import type { ITestResult } from '../graph/connections';

const styles = {
	/** A banner under the status badge. */
	notice: { marginTop: 12 } as CSSProperties,
	/** One sentence of What to know. */
	note: { fontSize: 12.5, color: 'var(--rr-text-secondary)', lineHeight: 1.5, marginBottom: 8 } as CSSProperties,
};

/** The Test connection step: whether it runs, and what it said last. */
export interface IConnectionTest {
	testing: boolean;
	tested: ITestResult | null;
	/** Probe the endpoint again and word the answer (testResultText). */
	test(endpoint: IExplorerEndpoint): Promise<void>;
}

/**
 * The Test connection step. A host mounts one per connection it shows, so a result never carries over to another.
 *
 * @param onTest - Re-probe; resolves with the new result, or null when nothing was sent (no running task, or a check already running).
 * @returns The step.
 */
export function useConnectionTest(onTest: (endpoint: IExplorerEndpoint) => Promise<IProbeResult | null>): IConnectionTest {
	const [testing, setTesting] = useState(false);
	const [tested, setTested] = useState<ITestResult | null>(null);
	const test = async (endpoint: IExplorerEndpoint): Promise<void> => {
		setTesting(true);
		try {
			const result = await onTest(endpoint);
			setTested(testResultText(result));
		} finally {
			setTesting(false);
		}
	};
	return { testing, tested, test };
}

/** Props. */
export interface IConnectionDetailsBodyProps {
	endpoint: IExplorerEndpoint;
	probe: IProbeResult | undefined;
	/** The last Test connection result, if any. */
	tested: ITestResult | null;
}

/**
 * The details: Status, Connection and What to know.
 *
 * @param props - See {@link IConnectionDetailsBodyProps}.
 * @returns The sections.
 */
export const ConnectionDetailsBody: React.FC<IConnectionDetailsBodyProps> = ({ endpoint, probe, tested }) => {
	const view = connectionView(endpoint, probe);
	return (
		<>
			<Section label="Status">
				<StatusBadge variant={view.badge.variant}>{view.badge.label}</StatusBadge>
				{view.blocked && (
					<div style={styles.notice}>
						<Banner variant={endpoint.state === 'ready' ? 'warning' : 'info'}>{view.blocked}</Banner>
					</div>
				)}
				{tested && <div style={styles.notice}><Banner variant={tested.variant}>{tested.text}</Banner></div>}
			</Section>
			<Section label="Connection">
				{view.details.map((row) => (
					<LabelValue key={row.label} label={row.label}>
						{row.value}
					</LabelValue>
				))}
			</Section>
			{view.notes.length > 0 && (
				<Section label="What to know">
					{view.notes.map((note) => (
						<div key={note} style={styles.note}>
							{note}
						</div>
					))}
				</Section>
			)}
		</>
	);
};
