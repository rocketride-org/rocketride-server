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
// GRAPH-UI - DEV-TOOL FRAME MOUNT (AppDescriptor.devToolFrame)
// =============================================================================
//
// A thin React shell over devtool/frame.ts: it builds the frame in an effect
// (disposed in the cleanup), follows `host:connection`, and routes the docKey:
//
//   undefined / ''    the generic frame: one EmptyState (the sidebar is the list)
//   workbench:<key>   that connection's workbench
//   write:<key>       that connection's write console
//   anything else     a "not found" empty state
//
// It holds no client (R1): every view below reads the REMOTE GraphEnv.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, EmptyState } from 'shell';
import type { DevToolProps } from 'shell';
import { announcer } from './adapters/explorer';
import RealmLiveRegion from './components/RealmLiveRegion';
import { createGraphFrame } from './devtool/frame';
import type { IGraphFrame } from './devtool/frame';
import { CONTROLLER_NOT_READY_TEXT, DOC_STATE_TEXT, LANDING_TEXT, UNKNOWN_DOCUMENT_DESCRIPTION, UNKNOWN_DOCUMENT_TITLE, connectionDocState, frameFailureText, missingConnectionText, showsControllerBanner } from './devtool/frameText';
import type { IDocGates } from './devtool/frameText';
import type { DocRoute } from './devtool/protocol';
import { FRAME_PROTOCOL } from './devtool/wiring';
import { GraphEnvProvider, useGraphEndpoints, useGraphEnv, useReadable } from './env';
import { GraphIcon } from './icons';
import WorkbenchView from './views/WorkbenchView';
import WriteConsoleView from './views/WriteConsoleView';

const styles = {
	root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' } as CSSProperties,
	center: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' } as CSSProperties,
	notice: { padding: '8px 24px 0' } as CSSProperties,
};

/**
 * The dev-tool frame: one document of the tool.
 *
 * @param props - The host's DevToolProps.
 * @returns The frame.
 */
export const GraphDevTool: React.FC<DevToolProps> = ({ peer, channel, documents, docKey }) => {
	const [frame, setFrame] = useState<IGraphFrame | null>(null);
	useEffect(() => {
		// The frame this effect builds, for its own error reporter (which runs only later, after the frame exists).
		const mount: { frame: IGraphFrame | null } = { frame: null };
		// A failure nobody awaits (a history record, a refresh a person asked for): said in words a person can act on
		// ("open the sidebar" when no controller is up), never an internal op name; a dropped call says nothing.
		const onError = (error: unknown): void => {
			const text = frameFailureText(error, mount.frame?.controllerReady.get() ?? false);
			if (text !== null) announcer.announce(text);
		};
		const created: IGraphFrame = createGraphFrame({ peer, ...(channel ? { channel } : {}), ...(documents ? { documents } : {}), docKey: docKey ?? null, ...FRAME_PROTOCOL, onError });
		mount.frame = created;
		setFrame(created);
		return () => {
			created.dispose();
			setFrame((current) => (current === created ? null : current));
		};
	}, [peer, channel, documents, docKey]);
	if (!frame) return null;
	return <FrameRoot frame={frame} />;
};

/** The frame's env provider (rebuilt when `host:connection` flips) and its routed body. */
const FrameRoot: React.FC<{ frame: IGraphFrame }> = ({ frame }) => {
	const host = useReadable(frame.connected);
	const summon = useReadable(frame.summon);
	const signIn = useReadable(frame.signIn);
	// Not yet published is not ready either; the document states tell the two apart.
	const ready = host === true;
	const env = useMemo(() => frame.env(ready), [frame, ready]);
	const gates: IDocGates = { host, summon, signIn };
	return (
		<GraphEnvProvider value={env}>
			<div style={styles.root}>
				<RealmLiveRegion />
				<FrameBody route={frame.route} gates={gates} />
			</div>
		</GraphEnvProvider>
	);
};

/**
 * The view a route renders.
 *
 * @param props.route - The frame's route.
 * @param props.gates - The host connection, the summon and the sign-in (a connection document's state).
 * @returns The view.
 */
export const FrameBody: React.FC<{ route: DocRoute; gates: IDocGates }> = ({ route, gates }) => {
	if (route.kind === 'landing') {
		return (
			<div style={styles.center}>
				<EmptyState icon={<GraphIcon />} title={LANDING_TEXT.title} description={LANDING_TEXT.description} />
			</div>
		);
	}
	if (route.kind === 'unknown') {
		return (
			<div style={styles.center}>
				<EmptyState icon={<GraphIcon />} title={UNKNOWN_DOCUMENT_TITLE} description={UNKNOWN_DOCUMENT_DESCRIPTION} />
			</div>
		);
	}
	return <FrameConnectionDocument kind={route.kind} endpointKey={route.key} gates={gates} />;
};

/**
 * A connection's document, bound to the live endpoint the controller publishes. What it shows is decided by
 * connectionDocState (F13); a document that has shown its view keeps it while its controller is summoned again.
 *
 * @param props.kind - Workbench or write console.
 * @param props.endpointKey - The connection.
 * @param props.gates - The host connection, the summon and the sign-in.
 * @returns The view, or why there is none yet.
 */
const FrameConnectionDocument: React.FC<{ kind: 'workbench' | 'write'; endpointKey: string; gates: IDocGates }> = ({ kind, endpointKey, gates }) => {
	const env = useGraphEnv();
	const { status, endpoints, omitted } = useGraphEndpoints();
	const endpoint = endpoints.find((candidate) => candidate.key === endpointKey) ?? null;
	const opened = useRef(false);

	// A document restored before anything was discovered asks for discovery (an op: it also activates the controller).
	// Automatic, so quiet: a refusal while the controller settles its identity is not announced.
	useEffect(() => {
		if (env.ready && status === 'idle') void env.refresh({ quiet: true });
	}, [env, status]);

	const state = connectionDocState({ host: gates.host, summon: gates.summon, signIn: gates.signIn, found: endpoint !== null, opened: opened.current });
	// Marked once the view has been committed, not during render; the next state change reads it.
	useEffect(() => {
		if (state === 'open') opened.current = true;
	}, [state]);
	if (state === 'open' && endpoint) {
		return (
			<>
				{showsControllerBanner(state, gates.summon) && (
					<div style={styles.notice}>
						<Banner variant="warning">{CONTROLLER_NOT_READY_TEXT}</Banner>
					</div>
				)}
				{kind === 'write' ? <WriteConsoleView key={endpoint.key} endpoint={endpoint} /> : <WorkbenchView key={endpoint.key} endpoint={endpoint} />}
			</>
		);
	}
	// ('open' always has its endpoint: connectionDocState says so only when the list holds it.) No button: in a dev tool
	// the sidebar is the connection list, and the text says to pick one there.
	const text = state === 'missing' || state === 'open' ? missingConnectionText(status, omitted) : DOC_STATE_TEXT[state];
	return (
		<div style={styles.center}>
			<EmptyState icon={<GraphIcon />} title={text.title} description={text.description} />
		</div>
	);
};

export default GraphDevTool;
