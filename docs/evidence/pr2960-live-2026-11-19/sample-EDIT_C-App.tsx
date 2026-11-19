// Disposable live acceptance fixture for PR 2960; contains no credentials.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppLayout, useShellConnection, useAuthUser } from 'shell';
import { createHandshakeProbe, type ProbeRecord } from './handshakeProbe';

const RUN = 'RR2960_20261119_LIVE';
const EDIT = 'EDIT_C';
const PROBE_PATH = 'rr2960-live-probe.txt';
type PreviewWindow = Window & typeof globalThis;

export default function App(): React.ReactElement {
	const { client, isConnected } = useShellConnection();
	const identity = useAuthUser();
	const [probe, setProbe] = useState('waiting');
	const [reads, setReads] = useState(0);
	const [handshake, setHandshake] = useState<ProbeRecord | null>(null);
	const probeController = useRef<ReturnType<typeof createHandshakeProbe> | null>(null);
	const mainRef = useRef<HTMLElement>(null);
	const [target, setTarget] = useState<PreviewWindow | null>(null);
	// Web-linked component closures may belong to the builder's realm.
	// Inspect the window that OWNS the rendered DOM, not the closure's window.
	useEffect(() => { setTarget((mainRef.current?.ownerDocument.defaultView as PreviewWindow | null) ?? null); }, []);
	const origin = target?.location.origin ?? '(pending rendered document)';
	const protocol = target?.location.protocol ?? '(pending)';
	const framed = target ? target.parent !== target : null;
	const opener = target ? target.opener !== null : null;
	const devHooks = target ? typeof (target as Window & { __rrShellDev?: unknown }).__rrShellDev !== 'undefined' : null;
	let openerSameOrigin = false;
	try { openerSameOrigin = Boolean(target?.opener && target.opener.location.origin === origin); } catch { /* foreign opener */ }
	useEffect(() => {
		if (!target) return;
		const controller = createHandshakeProbe(target, setHandshake);
		probeController.current = controller;
		return () => {
			controller.dispose();
			if (probeController.current === controller) probeController.current = null;
		};
	}, [target]);
	const recheckHandshake = useCallback((): void => { probeController.current?.start(); }, []);
	const recheck = useCallback(async (): Promise<void> => {
		if (!client || !isConnected) return;
		setProbe('requesting');
		try {
			const text = await client.fsReadString(PROBE_PATH);
			const passed = text.trim() === RUN;
			setProbe(passed ? 'PASS' : 'FAIL: unexpected fixture');
			setReads((n) => n + 1);
			target?.console.log(`${RUN}_AUTHENTICATED_ENGINE_READ ${passed ? 'PASS' : 'FAIL'}`);
		} catch {
			setProbe('FAIL: request rejected');
			target?.console.log(`${RUN}_AUTHENTICATED_ENGINE_READ FAIL`);
		}
	}, [client, isConnected, target]);
	useEffect(() => {
		if (!target) return;
		target.console.log(`${RUN}_CONSOLE_SENTINEL ${EDIT}`);
		target.console.log(`${RUN}_SURFACE ownerDocument=true origin=${origin} protocol=${protocol} framed=${framed} opener=${opener} devHooks=${devHooks}`);
	}, [target]);
	useEffect(() => { void recheck(); }, [recheck]);
	return (
		<AppLayout showStatus>
			<main ref={mainRef} style={{ padding: 28, color: 'var(--rr-text-primary)', fontFamily: 'system-ui' }}>
				<h1>PR 2960 — live preview</h1>
				<p style={{ fontSize: 20 }}><strong>{RUN} · {EDIT}</strong></p>
				<p>Connected: <strong>{client === null ? 'unknown' : isConnected ? 'yes' : 'no'}</strong></p>
				<p>User: <strong>{identity?.displayName || '(none)'}</strong></p>
				<p>Authenticated engine read: <strong>{probe}</strong> · completed reads: {reads}</p>
				<p>Origin: {origin} · protocol: {protocol}</p>
				<p>Diagnostics target: rendered ownerDocument.defaultView</p>
				<p>Framed: {String(framed)} · opener present: {String(opener)} · opener same origin: {String(openerSameOrigin)}</p>
				<p>Dev hooks present: {String(devHooks)}</p>
				<button onClick={() => { void recheck(); }} disabled={!client || !isConnected} style={{ padding: '10px 16px', fontSize: 16 }}>Recheck authenticated engine read</button>
				{framed === false && <>
					<p>Opener handshake: <strong>{handshake?.status ?? 'IDLE'}</strong> · attempt #{handshake?.attempt ?? 0} · elapsed {handshake?.elapsedMs ?? 0} ms</p>
					{handshake && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(handshake, null, 2)}</pre>}
					<button onClick={recheckHandshake} disabled={!target} style={{ padding: '10px 16px', fontSize: 16 }}>Recheck opener handshake</button>
					<p>This sends only when clicked. Reply observations use the active attempt, source window and time; the product reply has no echoed attempt ID.</p>
				</>}
				<p>No credentials are displayed or logged by this fixture.</p>
			</main>
		</AppLayout>
	);
}
