// Copyright (c) 2026 Aparavi Software AG. MIT License.

/**
 * AgentPanel — the canvas right-rail drawer that attaches an agent session to
 * the OPEN pipe (create-or-attach by pipe path), behind `agent.enabled`.
 *
 * A {@link DetailPanel} gives position/resize/persistence for free (the
 * `NodeConfigPanel` pattern — `contained` anchors it to the canvas surface
 * instead of the viewport). The body is the same {@link AgentSessionView}
 * every agent surface mounts, so chat state stays in lockstep with the
 * `agent:` document tab for the same session.
 */
import React, { useEffect, useState } from 'react';
import { DetailPanel } from 'shell';
import { agentApi } from '../../services/agentApi';
import { AgentSessionView } from './AgentSessionView';
import { useWorkspaceSync } from './useWorkspaceSync';
import { getDocs } from '../../docs';

const PANEL_WIDTH = 460;
const WIDTH_PERSIST_KEY = 'panelAgentWidth';

/** Props for {@link AgentPanel}. */
export interface AgentPanelProps {
	/** The open pipe's document path (create-or-attach key). */
	uri: string;
	/** Fired when the user dismisses the drawer. */
	onClose: () => void;
}

/** Derives the panel/tab title from the pipe path's filename. */
function pipeTitle(uri: string): string {
	return `Agent — ${uri.split('/').pop() ?? uri}`;
}

/**
 * One create-or-attach round trip in flight for a pipe path, shared by every
 * caller currently interested in it.
 *
 * `controller` is owned by the ENTRY, not by any one caller's effect — a
 * close→reopen (or React StrictMode's dev-only mount→cleanup→mount
 * double-invoke) can produce a second `attachSession` call for the same
 * pipePath while the first is still in flight; that second call must AWAIT
 * the first's request rather than starting its own, or both would race
 * `agentApi.list()` and both decide "no session yet" → both call
 * `agentApi.create()` → two sessions for one pipe. `refCount` tracks how many
 * callers are still waiting, so the underlying request is cancelled only once
 * EVERY interested caller has gone away — an unmounting first caller must not
 * cancel a request a still-mounted second caller just joined.
 */
interface InFlightAttach {
	promise: Promise<string>;
	controller: AbortController;
	refCount: number;
}

/** In-flight attach entries, keyed by pipe path. */
const inFlightAttach = new Map<string, InFlightAttach>();

/**
 * Create-or-attach by pipe path: reuse the caller's newest non-archived
 * session for this pipe, else create. Concurrent calls for the SAME pipe
 * path share one request (see {@link InFlightAttach}).
 *
 * @param pipePath - The open pipe's document path.
 * @returns The shared promise, plus a `release` the caller MUST invoke from
 *   its effect cleanup (decrements the ref count; aborts the underlying
 *   request only once no caller still wants it).
 */
function attachSession(pipePath: string): { promise: Promise<string>; release: () => void } {
	let entry = inFlightAttach.get(pipePath);
	if (!entry) {
		const controller = new AbortController();
		const promise = (async () => {
			const sessions = await agentApi.list(controller.signal);
			const match = sessions.find((s) => s.pipePath === pipePath && s.status !== 'archived') ?? sessions.find((s) => s.pipePath === pipePath);
			if (match) return match.sessionId; // useAgentSession resumes archived sessions on attach
			return (await agentApi.create({ pipePath, title: pipeTitle(pipePath) }, controller.signal)).sessionId;
		})();
		entry = { promise, controller, refCount: 0 };
		inFlightAttach.set(pipePath, entry);
		// Evict on settle (success, failure, or abort) so a LATER, non-overlapping
		// attach starts a fresh request instead of reusing a dead entry forever.
		const evict = (): void => {
			if (inFlightAttach.get(pipePath) === entry) inFlightAttach.delete(pipePath);
		};
		promise.then(evict, evict);
	}
	entry.refCount += 1;
	const joined = entry;
	return {
		promise: joined.promise,
		release: () => {
			joined.refCount -= 1;
			if (joined.refCount <= 0) joined.controller.abort();
		},
	};
}

/**
 * Renders the canvas right-rail agent drawer, attaching to (or creating) the
 * open pipe's session on mount / whenever `uri` changes.
 *
 * @param props - {@link AgentPanelProps}.
 */
export function AgentPanel({ uri, onClose }: AgentPanelProps): React.JSX.Element {
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let stale = false;
		setSessionId(null);
		setError(null);
		const { promise, release } = attachSession(uri);
		promise
			.then((id) => {
				if (!stale) setSessionId(id);
			})
			.catch((e: Error) => {
				// `stale` is set before `release()` runs (see cleanup below), so a
				// rejection this instance itself caused by being the last release
				// (an AbortError from the shared request finally being cancelled)
				// always finds `stale === true` here and is swallowed. A `false`
				// reading here is a genuine failure (or an abort triggered by some
				// OTHER, still-superseding effect run) worth surfacing.
				if (!stale) setError(e.message);
			});
		return () => {
			stale = true;
			release();
		};
	}, [uri]);

	return (
		<DetailPanel width={PANEL_WIDTH} persistKey={WIDTH_PERSIST_KEY} open contained onClose={onClose} title={pipeTitle(uri)}>
			{error ? (
				<div style={{ padding: 16 }}>Agent unavailable: {error}</div>
			) : !sessionId ? (
				<div style={{ padding: 16 }}>Starting session…</div>
			) : (
				<AgentPanelBody sessionId={sessionId} uri={uri} />
			)}
		</DetailPanel>
	);
}

/** Split so useWorkspaceSync runs with a guaranteed session (hooks stay unconditional). */
function AgentPanelBody({ sessionId, uri }: { sessionId: string; uri: string }): React.JSX.Element {
	const sync = useWorkspaceSync(sessionId, uri); // Task 4.4
	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
			<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '4px 12px' }}>
				<button onClick={() => void sync.revert()}>Revert session changes</button>
				<button onClick={() => getDocs()?.openStaticDocument(`agent:${sessionId}`, pipeTitle(uri))}>Open as tab</button>
			</div>
			<AgentSessionView sessionId={sessionId} onFileChange={sync.onFileChange} />
		</div>
	);
}
