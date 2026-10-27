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
// VECTOR-UI - DEV-TOOL FRAME MOUNT (AppDescriptor.devToolFrame)
// =============================================================================
//
// A thin React shell over devtool/frame.ts: it builds the frame in an effect
// (disposed in the cleanup), follows `host:connection`, and routes the docKey:
//
//   undefined / ''                       the generic frame: one EmptyState (the
//                                        sidebar is the connection list)
//   console:<key>                        that connection's console (the map is
//                                        a tab inside it)
//   document:<key>:<encoded objectId>    one stored document
//   anything else                        a "not found" empty state
//
// It holds no client (R1): every view below reads the frame's REMOTE env.
// What a dev-tool mount cannot do degrades in place (R11): the chat area says
// why and still offers Search, the upload area says why, a refused download
// offers a copy. Writes are confirmed inline in the document that asked, and
// the console's Details open as an inline panel (F14): nothing here is a
// window-wide overlay.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, EmptyState } from 'shell';
import type { DevToolProps } from 'shell';
import type { IExplorerEndpoint } from 'shared/explorer';
import { announcer } from './adapters/explorer';
import DocumentWriteLine from './components/DocumentWriteLine';
import InlineRemoveConfirm from './components/InlineRemoveConfirm';
import RealmLiveRegion from './components/RealmLiveRegion';
import { createVectorFrame } from './devtool/frame';
import type { IVectorFrame } from './devtool/frame';
import { CONTROLLER_NOT_READY_TEXT, DOCUMENT_GONE_TITLE, DOC_STATE_TEXT, LANDING_TEXT, UNKNOWN_DOCUMENT_DESCRIPTION, UNKNOWN_DOCUMENT_TITLE, connectionDocState, frameFailureText, missingConnectionText, showsControllerBanner } from './devtool/frameText';
import type { IDocGates } from './devtool/frameText';
import type { DocRoute } from './devtool/protocol';
import { FRAME_PROTOCOL } from './devtool/wiring';
import { STOPPED_DETAIL } from './env';
import { VectorEnvProvider, useConnection, useEndpointsState, useLiveEndpoint, useReadable, useVectorEnv } from './envContext';
import { VectorIcon } from './icons';
import { CONSOLE_ORIGIN } from './vector/confirm';
import { documentFocus, focusAdrift, focusLost } from './vector/focus';
import { writeTouches } from './vector/workbench';
import { CODE_SENTENCES } from './vector/wording';
import ConsoleView from './views/ConsoleView';
import DocumentView from './views/DocumentView';

const styles = {
	root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' } as CSSProperties,
	center: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' } as CSSProperties,
	notice: { padding: '8px 24px 0' } as CSSProperties,
	document: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } as CSSProperties,
	/** The document (or what says it is gone) above its write slot: the room the slot leaves. */
	documentBody: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 } as CSSProperties,
	gone: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', outline: 'none' } as CSSProperties,
};

/**
 * The dev-tool frame: one document of the tool.
 *
 * @param props - The host's DevToolProps.
 * @returns The frame.
 */
export const VectorDevTool: React.FC<DevToolProps> = ({ peer, channel, documents, docKey }) => {
	const [frame, setFrame] = useState<IVectorFrame | null>(null);
	useEffect(() => {
		// The frame this effect builds, for its own error reporter (which runs only later, after the frame exists).
		const mount: { frame: IVectorFrame | null } = { frame: null };
		// A failure nobody awaits (a refresh a person asked for, a relay): said in words a person can act on ("open the
		// sidebar" when no controller is up), never an internal op name; a dropped call says nothing.
		const onError = (error: unknown): void => {
			const text = frameFailureText(error, mount.frame?.controllerReady.get() ?? false);
			if (text !== null) announcer.announce(text);
		};
		const created: IVectorFrame = createVectorFrame({ peer, ...(channel ? { channel } : {}), ...(documents ? { documents } : {}), docKey: docKey ?? null, ...FRAME_PROTOCOL, onError });
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
const FrameRoot: React.FC<{ frame: IVectorFrame }> = ({ frame }) => {
	const host = useReadable(frame.connected);
	const summon = useReadable(frame.summon);
	const signIn = useReadable(frame.signIn);
	// Not yet published is not ready either; the document states tell the two apart.
	const ready = host === true;
	const env = useMemo(() => frame.env(ready), [frame, ready]);
	const gates: IDocGates = { host, summon, signIn };
	return (
		<VectorEnvProvider value={env}>
			<div style={styles.root}>
				<RealmLiveRegion />
				<FrameBody frame={frame} route={frame.route} gates={gates} />
			</div>
		</VectorEnvProvider>
	);
};

/**
 * The view a route renders.
 *
 * @param props.frame - The frame.
 * @param props.route - The frame's route.
 * @param props.gates - The host connection, the summon and the sign-in (a connection document's state).
 * @returns The view.
 */
export const FrameBody: React.FC<{ frame: IVectorFrame; route: DocRoute; gates: IDocGates }> = ({ frame, route, gates }) => {
	if (route.kind === 'landing') {
		return (
			<div style={styles.center}>
				<EmptyState icon={<VectorIcon />} title={LANDING_TEXT.title} description={LANDING_TEXT.description} />
			</div>
		);
	}
	if (route.kind === 'unknown') {
		return (
			<div style={styles.center}>
				<EmptyState icon={<VectorIcon />} title={UNKNOWN_DOCUMENT_TITLE} description={UNKNOWN_DOCUMENT_DESCRIPTION} />
			</div>
		);
	}
	return <FrameConnectionDocument frame={frame} route={route} gates={gates} />;
};

/**
 * A connection's document (its console, or one stored document), bound to the live endpoint the controller
 * publishes. What it shows is decided by connectionDocState (F13); a document that has shown its view keeps it while
 * its controller is summoned again, and one whose pipeline stopped stays, marked stopped.
 *
 * @param props.frame - The frame.
 * @param props.route - A console or document route.
 * @param props.gates - The host connection, the summon and the sign-in.
 * @returns The view, or why there is none yet.
 */
const FrameConnectionDocument: React.FC<{ frame: IVectorFrame; route: Extract<DocRoute, { kind: 'console' | 'document' }>; gates: IDocGates }> = ({ frame, route, gates }) => {
	const env = useVectorEnv();
	const { status, endpoints, omitted } = useEndpointsState();
	const listed = endpoints.find((candidate) => candidate.key === route.key) ?? null;
	const opened = useRef(false);
	const seen = useRef<IExplorerEndpoint | null>(null);
	if (listed) seen.current = listed;
	// An opened document whose connection left the list stays on screen, marked stopped (env.ts liveEndpoint).
	const endpoint = listed ?? (opened.current ? seen.current : null);

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
						<Banner variant="info">{CONTROLLER_NOT_READY_TEXT}</Banner>
					</div>
				)}
				{route.kind === 'console' ? <ConsoleFrame key={endpoint.key} frame={frame} endpoint={endpoint} /> : <DocumentFrame key={endpoint.key} frame={frame} endpoint={endpoint} objectId={route.objectId} />}
			</>
		);
	}
	// ('open' always has its endpoint.) No button: in a dev tool the sidebar is the connection list, and the text says
	// to pick one there.
	const text = state === 'missing' || state === 'open' ? missingConnectionText(status, omitted) : DOC_STATE_TEXT[state];
	return (
		<div style={styles.center}>
			<EmptyState icon={<VectorIcon />} title={text.title} description={text.description} />
		</div>
	);
};

/**
 * A connection's console in a frame: the full app's console (its inline confirmation and Details panel included) over
 * the REMOTE env, bound to the frame (hints out; other frames' writes and map requests in).
 *
 * @param props.frame - The frame.
 * @param props.endpoint - The connection.
 * @returns The console.
 */
const ConsoleFrame: React.FC<{ frame: IVectorFrame; endpoint: IExplorerEndpoint }> = ({ frame, endpoint }) => {
	const live = useLiveEndpoint(endpoint);
	const { entry } = useConnection(live);
	const visible = useReadable(frame.visible);
	// A document's Show on map (its map request, taken once and short-lived) is a press's arrival: counted for the view.
	const [arrivals, setArrivals] = useState(0);
	useEffect(() => frame.bindConsole(entry, { arrived: () => setArrivals((n) => n + 1) }), [frame, entry]);
	return <ConsoleView opened={endpoint} active={visible} arrivals={arrivals} />;
};

/**
 * One stored document in a frame: the full app's document view over the REMOTE env, with its own controller for its
 * writes (confirmed inline), the console's query and median, the chunk it is asked to show, and every write on the
 * connection read again (a document that left the store says so).
 *
 * @param props.frame - The frame.
 * @param props.endpoint - The connection.
 * @param props.objectId - The document.
 * @returns The document.
 */
const DocumentFrame: React.FC<{ frame: IVectorFrame; endpoint: IExplorerEndpoint; objectId: string }> = ({ frame, endpoint, objectId }) => {
	const live = useLiveEndpoint(endpoint);
	const { entry, model, channels } = useConnection(live);
	const { probes } = useEndpointsState();
	const visible = useReadable(frame.visible);
	const summaries = useReadable(frame.summaries);
	const [chunkId, setChunkId] = useState<number | undefined>(undefined);
	const [version, setVersion] = useState(0);
	const [gone, setGone] = useState(false);
	useEffect(
		() =>
			frame.bindDocument(entry, objectId, {
				// A press opened or fronted this frame (its arrival, taken once): the focus comes to its Reader | Chunks tabs
				// when nothing shown has it, never the page. A frame nobody pressed for (restored at load, opened behind)
				// gets no arrival, and leaves the focus where it is, in the host or another frame.
				focus: (id) => {
					if (id !== null) setChunkId(id);
					if (typeof document !== 'undefined' && focusAdrift(document.activeElement as HTMLElement | null, document.body)) returnFocus(null)?.focus();
				},
				// Read again, in place (DocumentView's refreshKey), only for a write that may have changed THIS document: another
				// document's write leaves the view as it is.
				version: (written) => {
					if (!writeTouches(written.gone, objectId)) return;
					setGone(false);
					setVersion((n) => n + 1);
				},
			}),
		[frame, entry, objectId]
	);
	// The focus never stays on the page body: after a read again (a remount) or when the document is gone, it goes back
	// into the document; after a confirmation, to its opener while it is shown.
	const root = useRef<HTMLDivElement>(null);
	const returnFocus = (opener: HTMLElement | null): HTMLElement | null => documentFocus(root.current, opener) as HTMLElement | null;
	// Only on a change: a read again or the document going is not a frame opening.
	const seen = useRef({ version, gone });
	useEffect(() => {
		if (seen.current.version === version && seen.current.gone === gone) return;
		seen.current = { version, gone };
		if (typeof document === 'undefined' || !focusLost(document.activeElement, document.body, null)) return;
		// After a read again or the document going; returnFocus reads the root when it runs.
		returnFocus(null)?.focus();
	}, [version, gone]);
	// Removing from a document needs the console model's write switch (its own controller confirms and sends).
	useEffect(() => {
		entry.controller.setWritesEnabled(model.writes.enabled);
	}, [model.writes.enabled, entry]);
	const actions = useMemo(() => frame.documentActions(entry), [frame, entry]);
	const median = summaries[live.key]?.medianChunks ?? null;
	const confirm = <InlineRemoveConfirm entry={entry} probe={probes[live.key]} returnFocus={returnFocus} />;
	// The document (or what says it is gone) and its write slot are one surface (data-document): Write details opens
	// inside its rectangle.
	return (
		<div ref={root} style={styles.document} data-document={objectId}>
			{live.state === 'stopped' && (
				<div style={styles.notice}>
					<Banner variant="info">{live.stateDetail ?? STOPPED_DETAIL}</Banner>
				</div>
			)}
			<div style={styles.documentBody}>
				{gone ? (
					<>
						{confirm}
						<div tabIndex={-1} style={styles.gone} data-document-gone="">
							<EmptyState icon={<VectorIcon />} title={DOCUMENT_GONE_TITLE} description={CODE_SENTENCES.NOT_FOUND} />
						</div>
					</>
				) : (
					<DocumentView refreshKey={version} model={model} channels={channels} selection={entry.selection} actions={actions} objectId={objectId} path={null} active={visible} consoleMedian={median} onDocument={(row) => setGone(row === null)} beforeBody={confirm} {...(chunkId === undefined ? {} : { chunkId })} />
				)}
			</div>
			{/* Its own controller: every write of it is this frame's, in a fixed slot under the document. */}
			{model.writes.enabled && <DocumentWriteLine entry={entry} origin={CONSOLE_ORIGIN} returnFocus={() => returnFocus(null)} />}
		</div>
	);
};

export default VectorDevTool;
