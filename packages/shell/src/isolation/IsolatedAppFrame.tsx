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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// ISOLATED APP FRAME — what an isolated app renders as in the shell (PR2b, plan §3.3, §4.1, §4.7)
// =============================================================================
//
// An isolated app's descriptor is this frame, never the app's own code
// (E1). The frame asks the host for an `/apps/frame` grant, checks the origin,
// frames `<origin>/_rr/frame.html?c=<ticket>` with the exact attributes of
// `frameAttrs.ts`, and runs the handshake: the realm is attached to the app
// root only when the frame's ready arrives, and the `rr:bridge:init` comes
// out of the root's choke point (`bridgeInit`). Any failure, a detach (logout,
// another user's sign-in, a reload inside the frame) or the unknown state
// shows a tile with a Reload button; nothing reloads by itself.
//
// The module also keeps the frame strip (notify/status chips, the open-link
// confirmation), the `rr:isolation:visited` record and the logout clear.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppDescriptor, ShellAppProps, ShellBrandingConfig } from '../components/workspace/types';
import { getAppVersionOverride } from '../util/versionOverride';
import { originOf } from './appKey';
import { isolationMode } from './config';
import { frameAttributes, SWEEP_SANDBOX } from './frameAttrs';
import { createHandshake } from './handshake';
import type { IHandshake } from './handshake';
import { planLogoutClear, plainOrigin, shouldSweepAtBoot, VISITED_KEY, visitedRecord } from './logoutClear';
import { portEndpoint } from './portEndpoint';
import type { BridgeInit, FrameOk, IAppRoot, IAppRootOptions, IsolatedEntry, RealmId, StripItem } from './types';

// =============================================================================
// HOST — set by Shell.tsx when it creates the app root
// =============================================================================

/** What the frames need from the shell. */
export interface IFrameHost {
	root: IAppRoot;
	/** `POST /apps/frame {appId, version}`; rejects with `{status}` on a non-200. */
	fetchFrame(appId: string, version: number): Promise<FrameOk>;
	shellOrigins: readonly string[];
	originTemplate: string;
	/** The shell's view of the session for the init (theme, engine URL). */
	session(): { theme: Record<string, string>; engineHttpUrl: string; themeName: string };
	/** Settles once the boot-time sweep ran (no frame mounts before it). */
	ready: Promise<void>;
}

let host: IFrameHost | null = null;
const hostListeners = new Set<() => void>();

/** Installs (or removes) the frame host. */
export function setFrameHost(next: IFrameHost | null): void {
	host = next;
	for (const cb of [...hostListeners]) cb();
}

// =============================================================================
// PER-REALM UI — the root's `ui` and `onDetached` hooks, routed to the frame
// =============================================================================

interface IRealmUi {
	strip(item: StripItem): void;
	confirmOpen(url: string): Promise<boolean>;
	detached(): void;
}

const realmUi = new Map<RealmId, IRealmUi>();

/** The root options that reach the frames (Shell passes them to `createAppRoot`). */
export const frameUi: Pick<IAppRootOptions, 'ui' | 'onDetached'> = {
	ui: {
		strip: (realmId, item) => realmUi.get(realmId)?.strip(item),
		confirmOpen: (realmId, url) => realmUi.get(realmId)?.confirmOpen(url) ?? Promise.resolve(false),
	},
	onDetached: (realmId) => realmUi.get(realmId)?.detached(),
};

// =============================================================================
// RELOAD REQUIRED — an id loaded in-realm that became isolated (plan §4.6)
// =============================================================================

let reloadRequired = false;
const reloadListeners = new Set<() => void>();

/** Marks the page as needing a reload (an in-realm app became isolated). */
export function requireReload(): void {
	if (reloadRequired) return;
	reloadRequired = true;
	for (const cb of [...reloadListeners]) cb();
}

/** Whether the blocking "Reload required" overlay is due. */
export function useReloadRequired(): boolean {
	return useSyncExternalStore(
		(cb) => {
			reloadListeners.add(cb);
			return () => void reloadListeners.delete(cb);
		},
		() => reloadRequired,
		() => reloadRequired
	);
}

// =============================================================================
// VISITED ORIGINS AND THE LOGOUT CLEAR (plan §4.7)
// =============================================================================

let visitedOwner = '';
/** Open frames by origin: navigate one to its clear page. */
const openFrames = new Map<string, Set<(url: string) => Promise<void>>>();

/** sha256(userId) as hex, the owner of the visited record. */
export async function ownerHashOf(userId: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readVisited(): unknown {
	try {
		const raw = localStorage.getItem(VISITED_KEY);
		return raw ? (JSON.parse(raw) as unknown) : null;
	} catch {
		return { owner: null };
	}
}

function recordVisited(origin: string): void {
	try {
		const current = readVisited() as { owner?: unknown; origins?: unknown } | null;
		const origins = current && current.owner === visitedOwner && Array.isArray(current.origins) ? (current.origins as string[]).filter((o) => plainOrigin(o) !== null) : [];
		localStorage.setItem(VISITED_KEY, JSON.stringify(visitedRecord(visitedOwner, [...origins, origin])));
	} catch {
		/* storage unavailable: the boot-time sweep cannot help, the logout sweep still navigates open frames */
	}
}

/** Loads `url` in a hidden sweep frame; settles on load or after `timeoutMs`. */
function sweepOne(url: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		const frame = document.createElement('iframe');
		frame.setAttribute('sandbox', SWEEP_SANDBOX);
		frame.setAttribute('referrerpolicy', 'no-referrer');
		frame.setAttribute('aria-hidden', 'true');
		frame.style.display = 'none';
		const done = (): void => {
			clearTimeout(timer);
			frame.remove();
			resolve();
		};
		const timer = setTimeout(done, timeoutMs);
		frame.addEventListener('load', done);
		frame.src = url;
		document.body.appendChild(frame);
	});
}

async function sweep(origins: readonly string[], parallel: number, timeoutMs: number): Promise<void> {
	const queue = [...origins];
	const worker = async (): Promise<void> => {
		for (let o = queue.shift(); o !== undefined; o = queue.shift()) await sweepOne(`${o}/_rr/frame.html#clear`, timeoutMs);
	};
	await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
}

/** After `teardownAll`: open frames go to their clear page, other visited origins are swept, the list is forgotten. */
export async function runLogoutClear(): Promise<void> {
	const record = readVisited() as { origins?: unknown } | null;
	const plan = planLogoutClear({ open: [...openFrames.keys()], visited: Array.isArray(record?.origins) ? record.origins : [] });
	const navigations = plan.navigate.map((url) => {
		const origin = new URL(url).origin;
		return Promise.all([...(openFrames.get(origin) ?? [])].map((go) => go(url)));
	});
	await Promise.all([...navigations, sweep(plan.sweep, plan.parallel, plan.timeoutMs)]);
	try {
		localStorage.removeItem(VISITED_KEY);
	} catch {
		/* nothing stored */
	}
}

/**
 * The boot-time sweep (missed sweeps): signed out, or another user than the
 * record's owner, sweeps the stored origins first. Also sets the record owner.
 */
export async function sweepAtBoot(userId: string | null): Promise<void> {
	const ownerHash = userId ? await ownerHashOf(userId) : null;
	visitedOwner = ownerHash ?? '';
	const record = readVisited();
	if (!shouldSweepAtBoot({ record, signedIn: ownerHash !== null, ownerHash })) return;
	const origins = Array.isArray((record as { origins?: unknown } | null)?.origins) ? ((record as { origins: unknown[] }).origins.map(plainOrigin).filter((o) => o !== null) as string[]) : [];
	await sweep(origins, 4, 2000);
	try {
		localStorage.removeItem(VISITED_KEY);
	} catch {
		/* nothing stored */
	}
}

// =============================================================================
// THE FRAME
// =============================================================================

/** The server entry fields the frame needs. */
export interface IIsolatedFrameEntry {
	id: string;
	moduleId: string;
	name: string;
	icon?: string;
	registryVersion?: number;
	firstParty?: boolean;
}

type FrameState = { kind: 'loading' } | { kind: 'failed'; text: string } | { kind: 'framed'; grant: FrameOk; attrs: NonNullable<ReturnType<typeof frameAttributes>> };

interface IChip {
	id: number;
	text: string;
	open?: { url: string; resolve(answer: boolean): void };
}

const tileStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, height: '100%', padding: 24, textAlign: 'center' };

function Tile({ text, onReload }: { text: string; onReload: () => void }): React.ReactElement {
	return (
		<div style={tileStyle} role="status">
			<div>{text}</div>
			<button type="button" onClick={onReload}>
				Reload
			</button>
		</div>
	);
}

function IsolatedAppFrame({ entry, isConnected, identity }: { entry: IIsolatedFrameEntry } & ShellAppProps): React.ReactElement {
	const currentHost = useSyncExternalStore(
		(cb) => {
			hostListeners.add(cb);
			return () => void hostListeners.delete(cb);
		},
		() => host,
		() => host
	);
	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<FrameState>({ kind: 'loading' });
	const [chips, setChips] = useState<IChip[]>([]);
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	const handshakeRef = useRef<IHandshake | null>(null);
	const sessionRef = useRef({ isConnected, displayName: identity?.displayName ?? '' });
	sessionRef.current = { isConnected, displayName: identity?.displayName ?? '' };
	const reload = useCallback(() => setAttempt((n) => n + 1), []);
	const unknown = isolationMode() === 'unknown';

	// 1. The grant: a non-200, a wrong origin or a same-site origin is a tile.
	useEffect(() => {
		if (unknown || !currentHost) return;
		let live = true;
		setState({ kind: 'loading' });
		const version = getAppVersionOverride(entry.id)?.version ?? entry.registryVersion;
		void (async () => {
			try {
				await currentHost.ready;
				if (typeof version !== 'number') throw new Error('no version');
				const grant = await currentHost.fetchFrame(entry.id, version);
				const expected = originOf(currentHost.originTemplate, entry.id);
				const attrs = grant && grant.origin === expected ? frameAttributes(grant.origin, grant.frame, currentHost.shellOrigins, entry.name) : null;
				if (!live) return;
				setState(attrs ? { kind: 'framed', grant, attrs } : { kind: 'failed', text: 'This app could not be opened.' });
			} catch {
				if (live) setState({ kind: 'failed', text: 'This app could not be opened.' });
			}
		})();
		return () => {
			live = false;
		};
	}, [currentHost, entry.id, entry.name, entry.registryVersion, attempt, unknown]);

	// 2. The handshake, for the framed state only.
	useEffect(() => {
		if (state.kind !== 'framed' || !currentHost) return;
		const { grant } = state;
		const origin = grant.origin;
		let realmId: RealmId | null = null;
		let handshake: IHandshake | null = null;
		let ended = false;
		const end = (text: string): void => {
			if (ended) return;
			ended = true;
			if (realmId !== null) {
				realmUi.delete(realmId);
				currentHost.root.detach(realmId);
			}
			setState({ kind: 'failed', text });
		};
		const isolated: IsolatedEntry = { id: entry.id, moduleId: entry.moduleId, name: entry.name, isolated: true, ...(entry.firstParty !== undefined ? { firstParty: entry.firstParty } : {}), ...(entry.registryVersion !== undefined ? { registryVersion: entry.registryVersion } : {}) };
		handshake = createHandshake({
			origin,
			isFrameSource: (source) => source !== null && source === frameRef.current?.contentWindow,
			now: () => Date.now(),
			admit: () => {
				const channel = new MessageChannel();
				const endpoint = portEndpoint(channel.port1, () => handshake?.onPortClosed());
				realmId = currentHost.root.attach(isolated, endpoint, { frame: grant, version: getAppVersionOverride(entry.id)?.version ?? entry.registryVersion ?? 1, viewId: entry.id, capabilities: grant.capabilities });
				const id = realmId;
				realmUi.set(id, {
					strip: (item) => setChips((prev) => [...prev.slice(-4), { id: Date.now() + Math.random(), text: `${entry.name}: ${item.text}` }]),
					confirmOpen: (url) =>
						new Promise<boolean>((resolve) => {
							const chip: IChip = { id: Date.now() + Math.random(), text: `${entry.name} wants to open ${new URL(url).host}`, open: { url, resolve } };
							setChips((prev) => [...prev, chip]);
							setTimeout(() => {
								resolve(false);
								setChips((prev) => prev.filter((c) => c !== chip));
							}, 30_000);
						}),
					detached: () => end('This app was closed when the session changed.'),
				});
				const session = currentHost.session();
				let init: BridgeInit;
				try {
					init = currentHost.root.bridgeInit(id, {
						displayName: sessionRef.current.displayName,
						theme: session.theme,
						props: { isConnected: sessionRef.current.isConnected, activeView: entry.id, activeActivity: null, sidePanelOpen: false, theme: session.themeName },
						engineHttpUrl: session.engineHttpUrl,
						proto: 1,
					});
				} catch (err) {
					realmUi.delete(id);
					currentHost.root.detach(id);
					realmId = null;
					throw err;
				}
				recordVisited(origin);
				return { init, port: channel.port2 };
			},
			post: (init, targetOrigin, transfer) => {
				const win = frameRef.current?.contentWindow;
				if (!win) throw new Error('frame gone');
				win.postMessage(init, targetOrigin, transfer as Transferable[]);
			},
			detach: (reason) => end(reason === 'denied' ? 'This app could not be opened.' : 'This app was closed. Reload to open it again.'),
		});
		handshakeRef.current = handshake;
		const onMessage = (e: MessageEvent): void => handshake?.onWindowMessage({ source: e.source, origin: e.origin, data: e.data });
		window.addEventListener('message', onMessage);
		const navigators = openFrames.get(origin) ?? new Set();
		const navigate = (url: string): Promise<void> =>
			new Promise((resolve) => {
				const frame = frameRef.current;
				if (!frame) return resolve();
				const timer = setTimeout(resolve, 2000);
				frame.addEventListener('load', () => (clearTimeout(timer), resolve()), { once: true });
				frame.src = url;
			});
		navigators.add(navigate);
		openFrames.set(origin, navigators);
		return () => {
			if (handshakeRef.current === handshake) handshakeRef.current = null;
			window.removeEventListener('message', onMessage);
			navigators.delete(navigate);
			if (navigators.size === 0) openFrames.delete(origin);
			ended = true;
			if (realmId !== null) {
				realmUi.delete(realmId);
				currentHost.root.detach(realmId);
			}
		};
	}, [state, currentHost, entry.id, entry.moduleId, entry.name, entry.firstParty, entry.registryVersion]);

	if (unknown || !currentHost) return <Tile text="Isolation unavailable — reload the page." onReload={() => window.location.reload()} />;
	if (state.kind === 'failed') return <Tile text={state.text} onReload={reload} />;
	if (state.kind === 'loading')
		return (
			<div style={tileStyle} role="status">
				Opening {entry.name}…
			</div>
		);
	const { attrs } = state;
	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
			{chips.length > 0 && (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 8px' }} aria-live="polite">
					{chips.map((chip) => (
						<span key={chip.id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
							{chip.text}
							{chip.open && (
								<button
									type="button"
									onClick={() => {
										chip.open!.resolve(true);
										setChips((prev) => prev.filter((c) => c !== chip));
									}}
								>
									Open
								</button>
							)}
							<button
								type="button"
								aria-label="Dismiss"
								onClick={() => {
									chip.open?.resolve(false);
									setChips((prev) => prev.filter((c) => c !== chip));
								}}
							>
								×
							</button>
						</span>
					))}
				</div>
			)}
			<iframe ref={frameRef} key={attempt} src={attrs.src} sandbox={attrs.sandbox} allow={attrs.allow} referrerPolicy={attrs.referrerPolicy} title={attrs.title} style={{ border: 0, flex: 1, width: '100%' }} onLoad={() => handshakeRef.current?.onFrameLoad()} />
		</div>
	);
}

/**
 * The descriptor of an isolated app: the frame, never the app's own code.
 *
 * @param entry - The server entry.
 * @returns `{id, name, icon, branding: {}, app}`.
 */
export function isolatedDescriptor(entry: IIsolatedFrameEntry): AppDescriptor {
	const Frame = (props: ShellAppProps): React.ReactElement => <IsolatedAppFrame entry={entry} {...props} />;
	Frame.displayName = `IsolatedAppFrame(${entry.id})`;
	return { id: entry.id, name: entry.name, ...(entry.icon ? { icon: <img src={entry.icon} alt="" /> } : {}), branding: {} as ShellBrandingConfig, app: Frame };
}
