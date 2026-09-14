// Copyright (c) 2026 Aparavi Software AG. MIT License.

/**
 * useWorkspaceSync — bidirectional live sync between an agent session's
 * workspace file and the open canvas document (Task 4.4, subview only:
 * {@link AgentPanel} mounts this; the standalone `agent:` tab has no canvas
 * and never calls this hook).
 *
 * Workspace file is truth during a session:
 *  - Agent edits (OpenCode `file.edited`) -> fetch file content -> `Documents.updateContent`
 *    -> canvas reload (`FlowGraphContext`, keyed on `docRevision`) in well under 1s.
 *  - Canvas edits (a `Documents` content change) -> 300ms debounce -> `PUT` write-through
 *    to the workspace file. The debounce coalesces rapid edits (e.g. a node drag) into
 *    one write.
 *
 * Echo suppression is symmetric, keyed off the SAME `components`-only content
 * signature `FlowGraphContext.projectContentSig` uses:
 *  - Inbound echoes (our own PUT round-tripping back into `currentProject`) are
 *    `FlowGraphContext`'s job already — it skips reloading when the incoming
 *    signature matches what it last loaded.
 *  - Outbound echoes (an agent edit landing in `Documents`, then re-observed by
 *    this hook's subscribe listener) are THIS hook's job: never PUT content
 *    whose signature equals the last inbound apply.
 *
 * Merge policy is last-writer per side; write-through conflicts/failures are
 * logged via `console.warn` (workspace-is-truth framing — the write is simply
 * dropped, the workspace file stays authoritative).
 */
import { useCallback, useEffect, useRef } from 'react';
import { agentApi } from '../../services/agentApi';
import { getDocs } from '../../docs';

const DEBOUNCE_MS = 300;

/** Matches FlowGraphContext.projectContentSig: components are the identity of a change. */
function sig(content: unknown): string {
	try {
		return JSON.stringify((content as { components?: unknown[] })?.components ?? []);
	} catch {
		return 'nosig';
	}
}

/** Handlers {@link AgentPanel} wires into `AgentSessionView.onFileChange` and the Revert button. */
export interface WorkspaceSync {
	/** Called with the workspace-relative path on every agent file edit. */
	onFileChange: (file: string) => void;
	/** Reverts the session's changes back to the canvas's last-known state. */
	revert: () => Promise<void>;
}

/**
 * @param sessionId - The attached rocket-agent session id.
 * @param uri - The open pipe's Documents URI.
 * @returns `{ onFileChange, revert }` — see {@link WorkspaceSync}.
 */
export function useWorkspaceSync(sessionId: string, uri: string): WorkspaceSync {
	const wsRel = uri.split('/').pop() ?? uri; // the workspace seeds the pipe by basename
	const lastInboundSig = useRef<string>(''); // components-sig of the last agent edit applied to the canvas
	const startSnapshot = useRef<string | null>(null); // pristine pre-session content (revert fallback when D3 absent)
	const startSnapshotCaptured = useRef(false); // guards the mount-time capture below so it runs exactly once
	const debounceT = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastVersion = useRef(-1);

	// Capture the PRISTINE pre-session content synchronously on the first render —
	// strictly before the outbound subscribe effect below can ever invoke its listener.
	// Without this, the first Documents change this hook observes is often the agent's
	// OWN first edit (the primary use case), and capturing startSnapshot only inside the
	// listener would then record "state after the first edit" as the revert baseline,
	// silently dropping that edit from what the D3-absent revert path restores. If the
	// doc isn't open yet at mount (content undefined), this intentionally leaves
	// startSnapshot null — the listener's own `if (startSnapshot.current === null)`
	// fallback below then captures whatever the first observed change is, which is the
	// best available baseline in that case.
	if (!startSnapshotCaptured.current) {
		startSnapshotCaptured.current = true;
		const content = getDocs()?.getDocument(uri)?.content;
		if (content !== undefined) startSnapshot.current = JSON.stringify(content);
	}

	// Inbound: agent file.edited (wired via AgentSessionView.onFileChange) -> fetch -> updateContent.
	const onFileChange = useCallback(
		(file: string) => {
			if (file !== wsRel) return;
			void (async () => {
				// P4-V4: the opencode file/content proxy's envelope is unverified against a
				// live server — handle both a bare string and a `{ content }` wrapper.
				const raw = await agentApi.oc<string | { content: string }>(sessionId, 'GET', `/file/content?path=${encodeURIComponent(wsRel)}`);
				const parsed = JSON.parse(typeof raw === 'string' ? raw : raw.content) as object;
				lastInboundSig.current = sig(parsed);
				getDocs()?.updateContent(uri, parsed); // fresh object every time — Documents no-ops on identity
			})().catch((err: unknown) => console.warn('[agent-sync] inbound failed:', err));
		},
		[sessionId, uri, wsRel],
	);

	// Outbound: Documents change -> debounce 300ms -> PUT write-through (agent echoes skipped by sig).
	useEffect(() => {
		const docs = getDocs();
		if (!docs) return;
		const unsub = docs.subscribe(() => {
			const doc = docs.getDocument(uri);
			if (!doc || doc.version === lastVersion.current) return;
			lastVersion.current = doc.version;
			if (startSnapshot.current === null) startSnapshot.current = JSON.stringify(doc.content);
			const s = sig(doc.content);
			if (s === lastInboundSig.current) return; // echo of an agent edit — never written back
			if (debounceT.current) clearTimeout(debounceT.current);
			const body = JSON.stringify(doc.content, null, '\t');
			debounceT.current = setTimeout(() => {
				agentApi.writeFile(sessionId, wsRel, body).catch((err: unknown) => console.warn('[agent-sync] write-through conflict/failure (workspace file is truth):', err));
			}, DEBOUNCE_MS);
		});
		return () => {
			unsub();
			if (debounceT.current) clearTimeout(debounceT.current);
		};
	}, [sessionId, uri, wsRel]);

	// Revert: prefer server turns (D3, oldest = session start); fall back to the client-side snapshot.
	const revert = useCallback(async () => {
		try {
			const turns = await agentApi.turns(sessionId);
			const first = turns[turns.length - 1];
			if (first) {
				await agentApi.revert(sessionId, first.sha);
				onFileChange(wsRel);
				return;
			}
		} catch {
			/* D3 absent — fall through to client snapshot */
		}
		if (startSnapshot.current !== null) {
			const parsed = JSON.parse(startSnapshot.current) as object;
			lastInboundSig.current = sig(parsed);
			getDocs()?.updateContent(uri, parsed);
			await agentApi.writeFile(sessionId, wsRel, startSnapshot.current);
		}
	}, [sessionId, uri, wsRel, onFileChange]);

	return { onFileChange, revert };
}
