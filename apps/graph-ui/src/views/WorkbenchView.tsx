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
// GRAPH-UI - WORKBENCH VIEW (browse one connection: Ask, Cypher, results, graph)
// =============================================================================
//
// The browsing document of one connection. Everything here READS: the editor sends
// `read_query`, Ask only previews, a label or type click in the sidebar runs the
// generated 25-row preview, and the graph's expand/connect/path actions are reads.
// Changing data is the write console's job, and exists only where the node allows it.
//
// A sidebar click is a preview REQUEST (graph/previews.ts): this workbench takes it
// by its nonce, once, whenever it mounts, so the click that summoned a cold dev-tool
// webview is not lost. A request waits while this connection has not answered its
// check yet, instead of being dropped.
//
// As a dev tool there is no Connections landing: the connection details (what the
// node reports, Test connection) show inline in this document, under its header
// (ConnectionDetailsPanel, never a drawer), toggled by a Details header action and
// opened, with a test, by Test connection where the connection cannot be browsed.
// The full app keeps its landing, so its workbench is unchanged.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ContentHeader, EmptyState } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { announcer } from '../adapters/explorer';
import { typePreview, labelPreview, isRefusal } from '../cypher/recipes';
import { useGraphEndpoints, useGraphEnv, usePendingPreview } from '../env';
import { DETAILS_CLOSED, connectionView, detailsPanelAfter, surfaceGate } from '../graph/connections';
import type { DetailsPanelAction, IDetailsPanelState } from '../graph/connections';
import { canWrite, engineText, parseDialect, targetText } from '../graph/dialect';
import { previewFor } from '../graph/previews';
import { GraphIcon } from '../icons';
import { styles } from '../styles';
import AskBar from '../components/AskBar';
import ConnectionDetailsPanel from '../components/ConnectionDetailsPanel';
import HistoryPanel from '../components/HistoryPanel';
import RunSurface from '../components/RunSurface';
import { createLoadSlot } from '../graph/loadSlot';

/** Nothing is remembered here: a request is taken through the env, which clears it for every later mount. */
const NONE_TAKEN: ReadonlySet<string> = new Set();

/** Props. */
export interface IWorkbenchViewProps {
	endpoint: IExplorerEndpoint;
}

/**
 * The workbench of one connection.
 *
 * @param props - See {@link IWorkbenchViewProps}.
 * @returns The view.
 */
export const WorkbenchView: React.FC<IWorkbenchViewProps> = ({ endpoint }) => {
	const env = useGraphEnv();
	const { probes } = useGraphEndpoints();
	const probe = probes[endpoint.key];
	const dialect = useMemo(() => (probe?.ok ? parseDialect(probe.info) : null), [probe]);
	const view = connectionView(endpoint, probe);
	const writable = canWrite(dialect);
	// A surface that has been on screen stays through a re-probe (see surfaceGate): it pauses instead of unmounting.
	const opened = useRef(false);
	if (view.openable) opened.current = true;
	const gate = surfaceGate(view, opened.current);

	const [historyOpen, setHistoryOpen] = useState(false);
	// A dev-tool frame shows the connection details inline here (see detailsPanelAfter).
	const inFrame = env.mount === 'frame';
	const [details, setDetails] = useState<IDetailsPanelState>(DETAILS_CLOSED);
	const panel = (action: DetailsPanelAction): void => setDetails((current) => detailsPanelAfter(current, action));
	// One slot for the life of the document: the surface takes each request once (see loadSlot.ts).
	const [slot] = useState(createLoadSlot);
	const [loadSeq, setLoadSeq] = useState(0);
	const gateNow = useRef(gate);
	gateNow.current = gate;
	// A run is asked for only while the surface is on screen and can run it: nothing is queued to run by itself later.
	const put = useCallback((text: string, run: boolean) => {
		const now = gateNow.current;
		const runNow = run && now.mounted && now.paused === null;
		if (run && !runNow) announcer.announce(`The statement was put in the editor but not run. ${now.paused ?? 'This connection cannot be browsed yet.'}`);
		setLoadSeq(slot.put({ text, run: runNow }));
	}, [slot]);

	// No probe yet (opened from a stale link or right after a refresh): ask the node who it is.
	useEffect(() => {
		if (env.ready && !probe && endpoint.state === 'ready') void env.probe(endpoint.key);
	}, [env, probe, endpoint.key, endpoint.state]);

	// A click on a label or relationship type in the sidebar: show and run the 25-row preview. The request is TAKEN
	// (by nonce) only when it can be acted on; while the connection is still being checked it waits.
	const pending = usePendingPreview();
	useEffect(() => {
		const request = previewFor(pending, endpoint.key, NONE_TAKEN, Date.now());
		if (!request) return;
		const waiting = !dialect && !probe && (endpoint.state === 'ready' || endpoint.state === 'probing');
		if (waiting) return;
		if (!env.previews.consume(request.nonce)) return;
		if (!dialect) {
			announcer.announce('This connection has not answered yet, so the preview was not run.');
			return;
		}
		const engine = { dialect: dialect.dialect, version: dialect.engineVersion };
		const recipe = request.action === 'label-preview' ? labelPreview(engine, request.name) : typePreview(engine, request.name);
		if (isRefusal(recipe)) {
			announcer.announce(recipe.refusal);
			put(`// ${recipe.refusal}`, false);
			return;
		}
		put(recipe.cypher, true);
	}, [pending, env, endpoint.key, endpoint.state, dialect, probe, put]);

	const openWrite = (): void => {
		env.openDocument({ kind: 'write', endpoint });
	};
	const subtitle = dialect ? [engineText(dialect), targetText(dialect)].filter(Boolean).join(' \u00b7 ') : view.address;

	return (
		<div style={styles.root}>
			<ContentHeader
				title={view.title}
				subtitle={subtitle}
				actions={
					inFrame || writable ? (
						<>
							{inFrame && (
								<Button variant="ghost" onClick={() => panel('toggle')} ariaExpanded={details.open} title="What the node reports about itself, and Test connection.">
									Details
								</Button>
							)}
							{writable && (
								<Button variant="ghost" onClick={openWrite} title="Open the console that can change data. It asks before it sends a statement that looks like a write.">
									Write console
								</Button>
							)}
						</>
					) : undefined
				}
			/>
			{inFrame && details.open && (
				<ConnectionDetailsPanel
					key={endpoint.key}
					endpoint={endpoint}
					probe={probe}
					testRequest={details.testRequest}
					onTest={(target) => (env.ready ? env.probe(target.key) : Promise.resolve(null))}
					onClose={() => panel('close')}
				/>
			)}
			{gate.mounted ? (
				<div style={{ flex: 1, minHeight: 0 }}>
					<RunSurface
						endpoint={endpoint}
						mode="read"
						paused={gate.paused}
						loadSlot={slot}
						loadSeq={loadSeq}
						topSlot={<AskBar endpoint={endpoint} onPreview={(cypher) => put(cypher, false)} />}
						onOpenHistory={() => setHistoryOpen(true)}
					/>
				</div>
			) : (
				<EmptyState
					icon={<GraphIcon />}
					title={endpoint.state === 'ready' ? 'This connection cannot be browsed yet' : 'This connection is not available'}
					description={view.blocked ?? 'The connection has not answered yet.'}
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
					put(cypher, false);
					setHistoryOpen(false);
				}}
				onRerun={(cypher) => {
					put(cypher, true);
					setHistoryOpen(false);
				}}
				announce={(text) => announcer.announce(text)}
			/>
		</div>
	);
};

export default WorkbenchView;
