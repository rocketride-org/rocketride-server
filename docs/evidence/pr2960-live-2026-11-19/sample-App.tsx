// Disposable live acceptance fixture for PR 2960; contains no credentials.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppLayout, useShellConnection, useAuthUser } from 'shell';

const RUN = 'RR2960_20261119_LIVE';
const EDIT = 'EDIT_B';
const PROBE_PATH = 'rr2960-live-probe.txt';
type PreviewWindow = Window & typeof globalThis;

export default function App(): React.ReactElement {
	const { client, isConnected } = useShellConnection();
	const identity = useAuthUser();
	const [probe, setProbe] = useState('waiting');
	const [reads, setReads] = useState(0);
	const [handshake, setHandshake] = useState('not observed');
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
	const recheckHandshake = useCallback((): void => {
		if (!target?.opener) return;
		setHandshake('waiting for real builder reply');
		let timeout: number;
		const observe = (event: MessageEvent): void => {
			const data = event.data as { type?: string; token?: unknown } | undefined;
			if (data?.type !== 'rrdev:auth') return;
			const fromOpener = event.source === target.opener;
			const sameOrigin = event.origin === target.location.origin;
			const tokenPresent = typeof data.token === 'string' && data.token.length > 0;
			const facts = `type=rrdev:auth origin=${event.origin} sourceIsOpener=${fromOpener} sameOrigin=${sameOrigin} tokenPresent=${tokenPresent}`;
			setHandshake(facts);
			target.console.log(`${RUN}_OPENER_HANDSHAKE ${facts}`);
			target.removeEventListener('message', observe);
			target.clearTimeout(timeout);
		};
		target.addEventListener('message', observe);
		timeout = target.setTimeout(() => {
			target.removeEventListener('message', observe);
			setHandshake('FAIL: builder reply not observed');
		}, 5000);
		// Create this value-free sender in the rendered window's realm so
		// postMessage's source is the real debug tab, not the linker realm.
		const sendReady = (target as unknown as { Function: FunctionConstructor }).Function('window.opener?.postMessage({ type: "shell:devReady" }, window.location.origin);');
		sendReady();
	}, [target]);
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
				{opener && <><p>Opener handshake: {handshake}</p><button onClick={recheckHandshake} style={{ padding: '10px 16px', fontSize: 16 }}>Recheck opener handshake</button></>}
				<p>No credentials are displayed or logged by this fixture.</p>
			</main>
		</AppLayout>
	);
}
