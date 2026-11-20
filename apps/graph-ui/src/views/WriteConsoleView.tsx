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
// GRAPH-UI - WRITE CONSOLE VIEW (the one place that can change data)
// =============================================================================
//
// Shown only for a connection whose node reports `allow_execute` and the graph
// result shape. Every statement goes through `execute` with `shape: 'graph'`, after
// a confirmation that lists the statements the text check marks as mutating. There is
// no automatic retry, no "stop asking", and no claim of atomicity: each statement is
// its own request, so a batch that stops half way leaves the earlier ones done.
//
// The text check is not a database safeguard. For Neo4j and FalkorDB the database
// account the node connects with is the boundary (a read-only one for browsing, one
// that can write only where this console is meant to). rocketride_graph has no
// account to choose: it connects as the role that owns the RocketRide database,
// so for it the boundary is whether the node allows execute at all.
//
// As a dev tool, where the console is unavailable Test connection shows the
// connection details inline in this document, with a test (ConnectionDetailsPanel,
// never a drawer); the full app keeps Open Connections.
// =============================================================================

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Banner, Button, ContentHeader, EmptyState } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { announcer } from '../adapters/explorer';
import { useGraphEndpoints, useGraphEnv } from '../env';
import { DETAILS_CLOSED, connectionView, detailsPanelAfter, surfaceGate } from '../graph/connections';
import type { DetailsPanelAction, IDetailsPanelState } from '../graph/connections';
import { canWrite, engineText, parseDialect, targetText } from '../graph/dialect';
import { WRITE_CONSOLE_BANNER, rerunAnnouncement } from '../graph/writeConfirm';
import { GraphIcon } from '../icons';
import { styles } from '../styles';
import ConnectionDetailsPanel from '../components/ConnectionDetailsPanel';
import HistoryPanel from '../components/HistoryPanel';
import RunSurface from '../components/RunSurface';
import { createLoadSlot } from '../graph/loadSlot';

/** Why the console is unavailable for a node, in words. */
export function writeUnavailableText(allowExecute: boolean, graphShape: boolean): string {
	if (!allowExecute) return 'This node has direct execution turned off (allow_execute), so it cannot change data. Browsing works. To change data, an owner has to turn execution on for the node, and the node should connect with a database account that is allowed to write.';
	if (!graphShape) return 'This node allows execute but does not support the graph result shape, so this console cannot show what a statement did. Upgrade the node.';
	return 'The node has not answered yet.';
}

/** Props. */
export interface IWriteConsoleViewProps {
	endpoint: IExplorerEndpoint;
}

/**
 * The write console of one connection.
 *
 * @param props - See {@link IWriteConsoleViewProps}.
 * @returns The view.
 */
export const WriteConsoleView: React.FC<IWriteConsoleViewProps> = ({ endpoint }) => {
	const env = useGraphEnv();
	const { probes } = useGraphEndpoints();
	const probe = probes[endpoint.key];
	const dialect = useMemo(() => (probe?.ok ? parseDialect(probe.info) : null), [probe]);
	const view = connectionView(endpoint, probe);
	const allowed = canWrite(dialect) && endpoint.state === 'ready';
	// A console that has been on screen stays through a re-probe (see surfaceGate): Execute pauses instead of the
	// console unmounting in the middle of a batch.
	const opened = useRef(false);
	if (allowed) opened.current = true;
	const unavailable = endpoint.state !== 'ready' ? view.blocked : dialect === null ? null : writeUnavailableText(dialect.allowExecute === true, dialect.capabilities.execute_shape_graph === true);
	const gate = surfaceGate({ openable: allowed, blocked: allowed ? null : unavailable }, opened.current);

	const [historyOpen, setHistoryOpen] = useState(false);
	// A dev-tool frame shows the connection details inline here, from Test connection (see detailsPanelAfter).
	const inFrame = env.mount === 'frame';
	const [details, setDetails] = useState<IDetailsPanelState>(DETAILS_CLOSED);
	const panel = (action: DetailsPanelAction): void => setDetails((current) => detailsPanelAfter(current, action));
	// One slot for the life of the document: the surface takes each request once (see loadSlot.ts).
	const [slot] = useState(createLoadSlot);
	const [loadSeq, setLoadSeq] = useState(0);
	// From History a statement is only loaded here, never sent: it runs when Execute is pressed, after the confirmation
	// when the text check flags it (rerunAnnouncement says which).
	const put = useCallback((text: string) => {
		setLoadSeq(slot.put({ text, run: false }));
	}, [slot]);
	const subtitle = dialect ? [engineText(dialect), targetText(dialect)].filter(Boolean).join(' \u00b7 ') : view.address;

	return (
		<div style={styles.root}>
			<ContentHeader title={`${view.title} \u2014 write console`} subtitle={subtitle} />
			{inFrame && details.open && (
				<ConnectionDetailsPanel
					key={endpoint.key}
					endpoint={endpoint}
					probe={probe}
					testRequest={details.testRequest}
					onTest={(target) => (env.ready ? env.probe(target.key) : Promise.resolve(null))}
					onOpen={(target) => {
						panel('close');
						env.openDocument({ kind: 'workbench', endpoint: target });
					}}
					onClose={() => panel('close')}
				/>
			)}
			{gate.mounted ? (
				<>
					<div style={{ padding: '8px 24px 0' }}>
						<Banner variant="warning">{WRITE_CONSOLE_BANNER}</Banner>
					</div>
					<div style={{ flex: 1, minHeight: 0 }}>
						<RunSurface endpoint={endpoint} mode="write" paused={gate.paused} loadSlot={slot} loadSeq={loadSeq} onOpenHistory={() => setHistoryOpen(true)} />
					</div>
				</>
			) : (
				<EmptyState
					icon={<GraphIcon />}
					title="The write console is not available for this connection"
					description={endpoint.state !== 'ready' ? (view.blocked ?? 'This connection is not available.') : writeUnavailableText(dialect?.allowExecute === true, dialect !== null && dialect.capabilities.execute_shape_graph === true)}
					action={
						inFrame ? (
							<Button variant="primary" onClick={() => panel('test')}>
								Test connection
							</Button>
						) : (
							<Button variant="primary" onClick={() => env.openDocument({ kind: 'connections' })}>
								Open Connections
							</Button>
						)
					}
				/>
			)}
			<HistoryPanel
				endpointKey={endpoint.key}
				nodeName={view.title}
				open={historyOpen}
				onClose={() => setHistoryOpen(false)}
				onLoad={(cypher) => {
					put(cypher);
					setHistoryOpen(false);
				}}
				onRerun={(cypher) => {
					put(cypher);
					setHistoryOpen(false);
					announcer.announce(rerunAnnouncement(cypher));
				}}
				announce={(text) => announcer.announce(text)}
			/>
		</div>
	);
};

export default WriteConsoleView;
