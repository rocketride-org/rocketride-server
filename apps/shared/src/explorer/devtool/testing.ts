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
// EXPLORER DEV TOOL — TEST SUPPORT (the real platform, wired for node:test)
// =============================================================================
//
// NOT part of any app bundle (nothing outside tests imports it). The one
// module of the deep entry that imports shell SOURCE, by relative path: the
// bus peers, the op lane, the channel and the retained registry are the REAL
// shell modules (none of them pulls React), so a test exercises what the
// hosts run, never a fake that encodes what its author believes busPeer does.
// The bus is wired exactly as the shell's own busPeer.test.ts wires it: a
// realm port over the real retained registry plus an `emitOp` recorder.
//
// THE JSON WIRE. A VS Code webview carries every bus payload through
// postMessage, as JSON: `undefined` vanishes, a Date becomes a string, a Map
// becomes `{}`. With `json: true` (the harness default) every publish and
// signal crosses as its JSON image, and every payload JSON would change is
// recorded in `violations`, so a test sees an R4 violation end to end the way
// a VS Code user would. `{ json: false }` models rocket-ui's single realm,
// where objects cross by reference.
//
// The fake REALMS (a VS Code webview realm, a rocket-ui realm) stand in for
// the ConnectionManager, which cannot load without an SDK client. Each rule
// they follow cites the source line it copies.
//
// No Node types here: apps/shared compiles this file with the browser libs.
// =============================================================================

import { createRetainedRegistry, localRetainedPort } from '../../../../../packages/shell/src/ops/retained';
import type { IRetainedRegistry } from '../../../../../packages/shell/src/ops/retained';
import { createFrameBusPeer, createSidebarBusPeer } from '../../../../../packages/shell/src/components/workspace/busPeer';
import type { IBusPeerBus } from '../../../../../packages/shell/src/components/workspace/busPeer';
import { createToolChannel } from '../../../../../packages/shell/src/components/workspace/toolChannel';
import { createToolController, createToolOpServer } from '../../../../../packages/shell/src/components/workspace/toolOps';
import { HOST_CONNECTION_TOPIC } from '../../../../../packages/shell/src/components/workspace/toolRelay';
import { GRID_CONFIG_CLEAR, GRID_CONFIG_GET, GRID_CONFIG_SET, createMessageGridPersistence } from '../../../../../packages/shell/src/components/data-grid/gridConfigChannel';
import type { IGridConfigClearDetail, IGridConfigGetDetail, IGridConfigSetDetail } from '../../../../../packages/shell/src/components/data-grid/gridConfigChannel';
import type { IDataGridPersistence } from '../../../../../packages/shell/src/components/data-grid/persistence';
import type { DevToolPeer } from './realm';

// =============================================================================
// THE REAL PROTOCOL
// =============================================================================

/** The shell's real protocol primitives, for injection into the dev-tool modules. */
export const shellProtocol = {
	createToolChannel,
	createToolController,
	createToolOpServer,
	createSidebarBusPeer,
	createFrameBusPeer,
	HOST_CONNECTION_TOPIC,
};

// =============================================================================
// TIME
// =============================================================================

/**
 * Let the bus deliver: retained and signal delivery is one setTimeout(0) task
 * per hop (retained.ts), and a round trip is several hops.
 *
 * @param turns - Macrotask turns to wait.
 * @returns When they have passed.
 */
export async function settle(turns = 12): Promise<void> {
	for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/** A clock a test sets by hand (for `now` injection; timers stay real). */
export interface IManualNow {
	/** The current epoch ms. */
	now: () => number;
	/** Jump to an absolute time. */
	set(ms: number): void;
	/** Move forward. */
	advance(ms: number): void;
}

/**
 * Create a manual clock.
 *
 * @param start - The starting epoch ms.
 * @returns The clock.
 */
export function manualNow(start = 1_000_000): IManualNow {
	let current = start;
	return {
		now: () => current,
		set: (ms) => { current = ms; },
		advance: (ms) => { current += ms; },
	};
}

// =============================================================================
// JSON SAFETY (R4)
// =============================================================================

/**
 * Fail with a located message.
 *
 * @param path - Where.
 * @param why - What.
 */
function unsafe(path: string, why: string): never {
	throw new Error(`${path} is not JSON-safe: ${why}.`);
}

/**
 * Compare an original with its JSON round trip, strictly.
 *
 * @param original - The value.
 * @param copy - `JSON.parse(JSON.stringify(value))` at the same path.
 * @param path - Where we are.
 */
function compareJson(original: unknown, copy: unknown, path: string): void {
	switch (typeof original) {
		case 'string':
		case 'boolean':
			if (copy !== original) unsafe(path, 'it changes in a JSON round trip');
			return;
		case 'number':
			if (!Number.isFinite(original)) unsafe(path, `${String(original)} becomes null`);
			if (!Object.is(original, copy)) unsafe(path, '-0 becomes 0');
			return;
		case 'undefined':
			unsafe(path, 'undefined is dropped (or becomes null in an array)');
			return;
		case 'function':
			unsafe(path, 'a function is dropped');
			return;
		case 'bigint':
			unsafe(path, 'a bigint cannot be serialised');
			return;
		case 'symbol':
			unsafe(path, 'a symbol is dropped');
			return;
		default:
			break;
	}
	if (original === null) {
		if (copy !== null) unsafe(path, 'null changes');
		return;
	}
	if (Array.isArray(original)) {
		if (!Array.isArray(copy) || copy.length !== original.length) unsafe(path, 'the array changes length');
		for (let i = 0; i < original.length; i += 1) {
			if (!(i in original)) unsafe(`${path}[${i}]`, 'a hole in a sparse array becomes null');
			compareJson(original[i], (copy as unknown[])[i], `${path}[${i}]`);
		}
		return;
	}
	const proto = Object.getPrototypeOf(original) as object | null;
	if (proto !== Object.prototype && proto !== null) {
		const name = (original as { constructor?: { name?: string } }).constructor?.name ?? 'object';
		unsafe(path, `a ${name} is not a plain object (only plain objects and arrays survive)`);
	}
	if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) unsafe(path, 'the object changes shape');
	const keys = Object.keys(original as object);
	for (const key of keys) compareJson((original as Record<string, unknown>)[key], (copy as Record<string, unknown>)[key], `${path}.${key}`);
	if (Object.keys(copy as object).length !== keys.length) unsafe(path, 'its keys change');
}

/**
 * Assert a value survives `JSON.parse(JSON.stringify(x))` and deep-equals the
 * original (R4). Rejects Maps, Sets, functions, class instances (Date, Error,
 * typed arrays, …), undefined anywhere, holes, non-finite numbers and -0.
 *
 * @param value - The op argument, op result, Reply or state snapshot.
 * @param label - Names the value in the error.
 * @throws Error naming the first offending path.
 */
export function assertJsonSafe(value: unknown, label = 'value'): void {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		unsafe(label, error instanceof Error ? error.message : String(error));
	}
	if (text === undefined) unsafe(label, 'JSON.stringify drops it entirely');
	compareJson(value, JSON.parse(text as string) as unknown, label);
}

// =============================================================================
// THE BUS AND THE PEERS (real modules)
// =============================================================================

/** A payload JSON would have changed, and where it was sent. */
export interface IJsonViolation {
	/** The bus topic it was published or signalled on. */
	topic: string;
	/** What assertJsonSafe said about it. */
	message: string;
}

/** A realm bus over the real retained registry, recording summons. */
export interface IRecordingBus {
	/** The bus verbs busPeer takes. */
	bus: IBusPeerBus;
	/** The registry behind it (publish here to act as a host). */
	registry: IRetainedRegistry;
	/** Every `emitOp` (the sidebar peer's summon). */
	emitted: Array<{ op: string; params: unknown }>;
	/** With the JSON wire on: every payload JSON changed on its way (empty means R4 held). */
	violations: IJsonViolation[];
}

/** The shell envelope's own OPTIONAL fields (toolChannel.ts / toolOps.ts): absent is a legal value. */
const ENVELOPE_OPTIONAL_FIELDS = ['payload', 'args', 'result', 'error'];

/**
 * What of a bus payload is the tool's data: a shell envelope
 * (`{ __rrtool, … }`) without its own optional fields when they are undefined
 * (a payload-less event, an argument-less call, a void reply). What those
 * fields hold is judged in full.
 *
 * @param payload - The bus payload.
 * @returns The value to judge.
 */
function envelopeData(payload: unknown): unknown {
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { __rrtool?: unknown }).__rrtool !== 'string') return payload;
	const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
	for (const field of ENVELOPE_OPTIONAL_FIELDS) {
		if (field in copy && copy[field] === undefined) delete copy[field];
	}
	return copy;
}

/** How the bus carries payloads. */
export interface IBusOptions {
	/** Carry the JSON image of every publish and signal payload (VS Code postMessage). */
	json?: boolean;
}

/**
 * A realm bus, wired as packages/shell/src/components/workspace/busPeer.test.ts wires it.
 *
 * @param registry - A registry to share (default: a fresh one).
 * @param opts - `json`: carry each payload's JSON image (default false here; the harness defaults it on).
 * @returns The bus.
 */
export function makeBus(registry: IRetainedRegistry = createRetainedRegistry(), opts: IBusOptions = {}): IRecordingBus {
	const port = localRetainedPort(registry);
	const emitted: Array<{ op: string; params: unknown }> = [];
	const violations: IJsonViolation[] = [];
	const cross = (topic: string, payload: unknown): unknown => {
		// undefined is the registry's own "retract" value, never a payload.
		if (!opts.json || payload === undefined) return payload;
		try {
			assertJsonSafe(envelopeData(payload), topic);
		} catch (error) {
			violations.push({ topic, message: error instanceof Error ? error.message : String(error) });
		}
		const text = JSON.stringify(payload);
		return text === undefined ? undefined : (JSON.parse(text) as unknown);
	};
	const bus: IBusPeerBus = {
		publish: (topic, snapshot) => port.publish(topic, cross(topic, snapshot)),
		signal: (topic, payload) => port.signal(topic, cross(topic, payload)),
		subscribe: port.subscribe,
		read: port.read,
		emitOp: (op, params) => { emitted.push({ op, params }); },
	};
	return { bus, registry, emitted, violations };
}

/** One write on a tool topic (or host:connection), as the registry saw it. */
export interface IWireEntry {
	/** The topic. */
	topic: string;
	/** The value written. */
	value: unknown;
	/** True for a signal (nothing retained). */
	transient: boolean;
}

/** One tool's peers over one realm bus. */
export interface IDevToolHarness extends IRecordingBus {
	/** The tool's app id. */
	appId: string;
	/** The tool's sidebar peer: ONE per realm, as both hosts create it. */
	sidebarPeer: DevToolPeer;
	/** A new frame peer (one per frame mount). */
	newFramePeer(): DevToolPeer;
	/** Publish `host:connection` as the hosts do (DevToolMount.tsx, extension.ts). */
	setHostConnection(connected: boolean): void;
	/** Every write on this tool's topics and on host:connection, in order. */
	wire: IWireEntry[];
}

/**
 * Build a tool's sidebar peer and frame-peer factory over the real modules.
 *
 * @param appId - The tool's app id.
 * @param opts - `json` (default TRUE): carry payloads as VS Code does; false models rocket-ui.
 * @returns The harness.
 */
export function createDevToolHarness(appId = 'tool.test', opts: IBusOptions = {}): IDevToolHarness {
	const recording = makeBus(createRetainedRegistry(), { json: opts.json ?? true });
	const wire: IWireEntry[] = [];
	recording.registry.onChange((topic, value, transient) => {
		if (topic === HOST_CONNECTION_TOPIC || topic.startsWith(`tool:${appId}:`)) wire.push({ topic, value, transient });
	});
	return {
		...recording,
		appId,
		sidebarPeer: createSidebarBusPeer(appId, recording.bus),
		newFramePeer: () => createFrameBusPeer(appId, recording.bus),
		setHostConnection: (connected) => recording.registry.publish(HOST_CONNECTION_TOPIC, { connected }),
		wire,
	};
}

/** A peer wrapper that counts what crosses it. */
export interface IPeerSpy {
	/** The wrapped peer (hand this to the code under test). */
	peer: DevToolPeer;
	/** Everything posted. */
	posts: unknown[];
	/** How many times it was subscribed. */
	subscribes: number;
	/** Subscriptions not yet unsubscribed. */
	active: number;
}

/**
 * Wrap a peer to count its posts and subscriptions.
 *
 * @param peer - The real peer.
 * @returns The spy.
 */
export function spyPeer(peer: DevToolPeer): IPeerSpy {
	const spy: IPeerSpy = {
		posts: [],
		subscribes: 0,
		active: 0,
		peer: {
			post: (message) => {
				spy.posts.push(message);
				peer.post(message);
			},
			subscribe: (cb) => {
				spy.subscribes += 1;
				spy.active += 1;
				const off = peer.subscribe(cb);
				let done = false;
				return () => {
					if (done) return;
					done = true;
					spy.active -= 1;
					off();
				};
			},
		},
	};
	return spy;
}

// =============================================================================
// LANE GUARDS (quirk 1: the sidebar peer keeps ONE live subscriber)
// =============================================================================

/**
 * Assert a mounted controller left exactly TWO live subscriptions on the
 * sidebar peer: its channel, then its op server. Nothing can stop a third at
 * runtime (busPeer.ts hands the live slot to whoever subscribed last, so a
 * channel built in a render after the effect silently takes every call), so
 * each lane pins it in its own mount test:
 *
 *   const spy = spyPeer(h.sidebarPeer);
 *   const channel = shellProtocol.createToolChannel(spy.peer);   // as the host does
 *   <mount the lane's controller wiring over spy.peer and channel>
 *   assertSidebarSubscribers(spy, 'graph sidebar');
 *
 * @param spy - The spied sidebar peer the mount used.
 * @param label - Names the mount in the error.
 * @throws Error unless `spy.active === 2`.
 */
export function assertSidebarSubscribers(spy: IPeerSpy, label = 'controller mount'): void {
	if (spy.active === 2) return;
	throw new Error(`${label}: the sidebar peer has ${spy.active} live subscribers; a mounted controller must leave exactly 2 (its channel, then its op server). `
		+ 'Any other subscriber takes the op server\'s live slot (busPeer.ts), and every call then goes unanswered.');
}

/** The protocol factories every app must import in ONE wiring module. */
const TOOL_FACTORIES = ['createToolChannel', 'createToolOpServer', 'createToolController'];

/** `createToolChannel|createToolOpServer|createToolController` as a whole word. */
const FACTORY_NAME = /\b(?:createToolChannel|createToolOpServer|createToolController)\b/;

/** The 'shell' module specifier, in either quote style. */
const SHELL = `(?:'shell'|"shell")`;

/**
 * The names a `{ … }` import or export clause brings in (aliases resolved to
 * the original name; `type` members skipped).
 *
 * @param clause - The text between the braces.
 * @returns The original names.
 */
function clauseNames(clause: string): string[] {
	return clause.split(',')
		.map((part) => part.trim())
		.filter((part) => part !== '' && !/^type\s/.test(part))
		.map((part) => part.split(/\s+as\s+/)[0].trim());
}

/**
 * The files that can reach a protocol factory (createToolChannel,
 * createToolOpServer, createToolController) from 'shell' at RUNTIME. A lane's
 * source-reading test asserts the list is exactly its one wiring module, so
 * no view builds a stray subscriber (see {@link assertSidebarSubscribers}).
 *
 * An ACCIDENT GUARD, not a security boundary: it reads text with regular
 * expressions. It reports a file that
 *   - imports a factory by name (`import { createToolChannel } from 'shell'`,
 *     aliased or not, single or double quotes);
 *   - re-exports one (`export { createToolOpServer } from 'shell'`) or
 *     re-exports everything (`export * from 'shell'`);
 *   - imports the module whole (`import * as s`, a default import, or
 *     `import('shell')`) AND names a factory anywhere in its text.
 * Type-only imports and exports are ignored.
 *
 * @param files - Each source file's path and text (the test reads them; this module has no fs).
 * @returns The paths that can reach one, in the order given.
 */
export function findToolFactoryImports(files: ReadonlyArray<{ path: string; text: string }>): string[] {
	const named = new RegExp(`\\b(?:import|export)\\s+(?!type\\b)\\{([^}]*)\\}\\s*from\\s*${SHELL}`, 'g');
	const mixed = new RegExp(`\\bimport\\s+(?!type\\b)[A-Za-z_$][\\w$]*\\s*,\\s*\\{([^}]*)\\}\\s*from\\s*${SHELL}`, 'g');
	const starExport = new RegExp(`\\bexport\\s+\\*\\s*(?:as\\s+[\\w$]+\\s*)?from\\s*${SHELL}`);
	const wholeModule = new RegExp(`\\bimport\\s+(?!type\\b)(?:\\*\\s*as\\s+[\\w$]+|[A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{[^}]*\\}\\s*)?from\\s*${SHELL}|\\bimport\\s*\\(\\s*${SHELL}\\s*\\)`);
	const found: string[] = [];
	for (const { path, text } of files) {
		let hit = starExport.test(text) || (wholeModule.test(text) && FACTORY_NAME.test(text));
		for (const pattern of [named, mixed]) {
			pattern.lastIndex = 0;
			let match: RegExpExecArray | null;
			while (!hit && (match = pattern.exec(text)) !== null) {
				if (clauseNames(match[1]).some((name) => TOOL_FACTORIES.includes(name))) hit = true;
			}
		}
		if (hit) found.push(path);
	}
	return found;
}

// =============================================================================
// FAKE REALMS (stand-ins for a realm's ConnectionManager)
// =============================================================================

/**
 * A ConnectResult-shaped account, as the server sends it.
 *
 * @param userId - The user id.
 * @param orgId - The organization id.
 * @param devTeam - The development team (also the organization's one team, holding task.data).
 * @param organization - Extra organization fields (e.g. `permissions`).
 * @returns The account.
 */
export function account(userId: string, orgId = 'org-1', devTeam = 'team-1', organization: Record<string, unknown> = {}): Record<string, unknown> {
	return { userId, devTeam, organization: { id: orgId, teams: [{ id: devTeam, permissions: ['task.data'] }], ...organization } };
}

/** The ConnectionManager surface the fakes offer (a superset of the dev-tool buses). */
export interface IFakeRealmCm {
	on(event: string, handler: (payload: never) => void): () => void;
	isConnected(): boolean;
	getAccountInfo(): unknown;
	getClient(): unknown;
	subscribe(topic: string, cb: (snapshot: unknown) => void): () => void;
	read(topic: string): Promise<unknown>;
	request(op: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
	/** Shell-event listeners plus topic subscriptions currently registered (leak checks). */
	listenerCount(): number;
}

/** The shell-event side of a fake manager (connection.ts on/emit: synchronous, per-event sets). */
function eventHub() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const log: string[] = [];
	return {
		log,
		on(event: string, handler: (payload: never) => void): () => void {
			const set = listeners.get(event) ?? new Set();
			set.add(handler as (payload: unknown) => void);
			listeners.set(event, set);
			return () => { set.delete(handler as (payload: unknown) => void); };
		},
		emit(event: string, payload: unknown): void {
			log.push(event);
			for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
		},
		count(): number {
			let n = 0;
			for (const set of listeners.values()) n += set.size;
			return n;
		},
	};
}

/**
 * Count a port's subscriptions.
 *
 * @param port - The realm port.
 * @returns A subscribe that counts, and the counter.
 */
function countedSubscribe(port: ReturnType<typeof localRetainedPort>) {
	const state = { active: 0 };
	const subscribe = (topic: string, cb: (snapshot: unknown) => void): (() => void) => {
		state.active += 1;
		const off = port.subscribe(topic, cb);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			state.active -= 1;
			off();
		};
	};
	return { subscribe, state };
}

/** A VS Code webview realm and the extension host root that mirrors into it. */
export interface IFakeSocketlessRealm {
	/** The realm's manager. */
	cm: IFakeRealmCm;
	/** The root registry (shared by the root and the realm). */
	registry: IRetainedRegistry;
	/** Every shell event the realm emitted, in order. */
	events: string[];
	/** Emit a shell event in the realm directly. */
	emit(event: string, payload: unknown): void;
	/** The root (extension host) side. */
	root: {
		/** The root connected with this account: status, then account (busHost.ts startMirrors). */
		connect(account: unknown): void;
		/** The root lost its connection: status false, then the account it no longer has (null). */
		disconnect(): void;
		/** The root's account changed (an account push, or a sign-out to null). */
		accountChanged(account: unknown): void;
		/** Only the status drops; the account is untouched (and so never republished). */
		dropStatusOnly(): void;
	};
}

/**
 * A socketless realm: no client, liveness and account mirrored from the root.
 * The realm side follows connection.ts installMirrorSubscriptions; the root
 * side follows apps/vscode/src/providers/toolhost/busHost.ts startMirrors.
 *
 * @param registry - The root registry (default: fresh).
 * @returns The realm.
 */
export function createFakeSocketlessRealm(registry: IRetainedRegistry = createRetainedRegistry()): IFakeSocketlessRealm {
	const hub = eventHub();
	const port = localRetainedPort(registry);
	const counted = countedSubscribe(port);
	let mirrorConnected: boolean | null = null;
	let accountInfo: unknown;

	// connection.ts isConnected(): the mirror answers in a socketless realm; with no client, false otherwise.
	const isConnected = (): boolean => mirrorConnected ?? false;

	// connection.ts installMirrorSubscriptions, 'shell:status'.
	port.subscribe('shell:status', (snapshot) => {
		const mirror = snapshot as { connected?: boolean; status?: unknown } | undefined;
		if (!mirror || mirror.connected === undefined || mirror.status === undefined) return;
		const wasConnected = isConnected();
		mirrorConnected = mirror.connected;
		hub.emit('shell:statusChange', mirror.status);
		if (mirror.connected && !wasConnected) hub.emit('shell:connected', undefined);
		else if (!mirror.connected && wasConnected) hub.emit('shell:disconnected', { reason: 'root disconnected', hasError: false });
	});
	// connection.ts installMirrorSubscriptions, 'shell:account': a falsy snapshot is IGNORED.
	port.subscribe('shell:account', (snapshot) => {
		if (!snapshot) return;
		accountInfo = snapshot;
		hub.emit('shell:accountUpdate', accountInfo);
	});

	const cm: IFakeRealmCm = {
		on: hub.on,
		isConnected,
		getAccountInfo: () => accountInfo,
		getClient: () => null,
		subscribe: counted.subscribe,
		read: port.read,
		request: async () => { throw new Error('Not connected to server'); },
		listenerCount: () => hub.count() + counted.state.active,
	};

	// busHost.ts startMirrors: status first, then the account, which crosses only when it changed.
	let lastAccount = '';
	const pushStatus = (connected: boolean): void => registry.publish('shell:status', { connected, status: { state: connected ? 'connected' : 'disconnected' } });
	const pushAccount = (value: unknown): void => {
		const sig = value ? JSON.stringify(value) : '';
		if (sig === lastAccount) return;
		lastAccount = sig;
		registry.publish('shell:account', value ? value : null);
	};

	return {
		cm,
		registry,
		events: hub.log,
		emit: hub.emit,
		root: {
			connect: (value) => { pushStatus(true); pushAccount(value); },
			disconnect: () => { pushStatus(false); pushAccount(null); },
			accountChanged: (value) => pushAccount(value),
			dropStatusOnly: () => pushStatus(false),
		},
	};
}

/** A rocket-ui realm: the realm owns the SDK client. */
export interface IFakeClientRealm {
	/** The realm's manager. */
	cm: IFakeRealmCm;
	/** Every shell event emitted, in order. */
	events: string[];
	/** Every bus request / emitOp the code under test made. */
	requests: Array<{ op: string; params: unknown }>;
	/** Emit a shell event directly. */
	emit(event: string, payload: unknown): void;
	/** A foreground sign-in: login, then connected. */
	login(user: unknown): void;
	/** The socket dropped (the SDK clears its account). */
	drop(): void;
	/** A background reconnect: the handshake sets the SDK account; NO shell:login. */
	reconnect(handshake: unknown): void;
	/**
	 * A connection whose client is NOT authenticated, reporting `stale` as its
	 * account. The shell never publishes this today (an anonymous attach sets
	 * no account and emits no shell:connected); it exists to pin the
	 * fail-closed rule.
	 */
	anonymousConnect(stale: unknown): void;
	/** An `apaext_account` push (the SDK account changes). */
	accountUpdate(value: unknown): void;
	/** An `apaext_org_changed` push. */
	orgChanged(orgId?: string): void;
	/** Sign-out: logout, then disconnect. */
	logout(): void;
	/** A tool's sidebar tab was selected. */
	activate(appId: string): void;
	/** A tool's sidebar tab was left. */
	deactivate(appId: string): void;
}

/**
 * A realm with its own client. Rules: connection.ts getAccountInfo (:1254),
 * finishConnect (:819-820), publishConnected (:905-921), onDisconnected
 * (:436-445), apaext_account (:378-380), logout (:1180-1192); client-typescript client.ts _connectResult.
 *
 * @returns The realm.
 */
export function createFakeClientRealm(): IFakeClientRealm {
	const hub = eventHub();
	const port = localRetainedPort(createRetainedRegistry());
	const counted = countedSubscribe(port);
	const requests: Array<{ op: string; params: unknown }> = [];
	let connected = false;
	let authenticated = false;
	let sdkAccount: unknown;
	let managerAccount: unknown;
	const client = { getAccountInfo: (): unknown => sdkAccount, isAuthenticated: (): boolean => authenticated };

	const cm: IFakeRealmCm = {
		on: hub.on,
		isConnected: () => connected,
		getAccountInfo: () => managerAccount ?? sdkAccount,
		getClient: () => client,
		subscribe: counted.subscribe,
		read: port.read,
		request: async (op, params) => {
			requests.push({ op, params });
			throw new Error('Not connected to server');
		},
		listenerCount: () => hub.count() + counted.state.active,
	};

	return {
		cm,
		events: hub.log,
		requests,
		emit: hub.emit,
		login(user) {
			sdkAccount = user;
			managerAccount = user;
			authenticated = true;
			hub.emit('shell:login', { user });
			connected = true;
			hub.emit('shell:connected', {});
		},
		drop() {
			sdkAccount = undefined;
			authenticated = false;
			connected = false;
			hub.emit('shell:disconnected', { reason: 'socket closed', hasError: true });
		},
		reconnect(handshake) {
			sdkAccount = handshake;
			authenticated = handshake !== undefined && handshake !== null;
			connected = true;
			hub.emit('shell:connected', {});
		},
		anonymousConnect(stale) {
			sdkAccount = stale;
			authenticated = false;
			connected = true;
			hub.emit('shell:connected', {});
		},
		accountUpdate(value) {
			sdkAccount = value;
			hub.emit('shell:accountUpdate', value);
		},
		orgChanged(orgId = '') {
			hub.emit('shell:orgChanged', { orgId });
		},
		logout() {
			managerAccount = undefined;
			sdkAccount = undefined;
			authenticated = false;
			hub.emit('shell:logout', {});
			connected = false;
			hub.emit('shell:disconnected', { reason: 'Disconnected by request', hasError: false });
		},
		activate(appId) {
			hub.emit('shell:toolSidebarActivated', { appId });
		},
		deactivate(appId) {
			hub.emit('shell:toolSidebarDeactivated', { appId });
		},
	};
}

// =============================================================================
// GRID LAYOUTS (gridPersistence.ts)
// =============================================================================

/**
 * What Tabulator's sort module does to a persisted sorter list it is handed:
 * it swaps each field for its live column (cyclic, as the real one is).
 *
 * @param sorters - The list the grid was handed.
 */
export function tabulatorSetSort(sorters: unknown): void {
	const column = { field: 'name', table: {} as Record<string, unknown>, element: { tag: 'div' } };
	column.table.columns = [column];
	for (const item of sorters as Array<{ column: unknown }>) item.column = column;
}

/** A host's workspace prefs, as far as the grid config channel reads them. */
export interface IGridHostPrefs {
	/** Layout blobs by tableId, then by type. */
	tableLayouts: Record<string, Record<string, unknown>>;
}

/** An installed {@link installHostGridBridge}. */
export interface IHostGridBridge {
	/** The host's prefs (mutable; what a workspace save would write). */
	prefs: IGridHostPrefs;
	/** The shell's bare channel adapter: what a grid with no `persistence` gets. */
	bareChannel(): IDataGridPersistence;
	/** Put `document` and the 'shell' stub back exactly as they were. */
	uninstall(): void;
}

/**
 * The web shell's grid config bridge (WorkspaceContext) on a stand-in
 * `document`: a get answers with the stored layout BY REFERENCE, and a set
 * keeps the blob it is given. While installed, the test runner's 'shell' stub
 * also carries the real channel factory, so an env that makes its channel on
 * first use (`() => createMessageGridPersistence()`) gets the real one.
 *
 * An app's full-app persistence keeps the channel it made first, and that
 * channel's per-table cache, for the rest of the process: give each full-app
 * test its own tableIds.
 *
 * @param shell - The test runner's 'shell' module (the apps' stub-shell object).
 * @returns The bridge.
 */
export function installHostGridBridge(shell: Record<string, unknown>): IHostGridBridge {
	const prefs: IGridHostPrefs = { tableLayouts: {} };
	const doc = new EventTarget();
	doc.addEventListener(GRID_CONFIG_GET, (event) => {
		const detail = (event as CustomEvent<IGridConfigGetDetail>).detail;
		detail.reply(prefs.tableLayouts[detail.tableId]);
	});
	doc.addEventListener(GRID_CONFIG_SET, (event) => {
		const detail = (event as CustomEvent<IGridConfigSetDetail>).detail;
		prefs.tableLayouts[detail.tableId] = { ...prefs.tableLayouts[detail.tableId], [detail.type]: detail.blob };
	});
	doc.addEventListener(GRID_CONFIG_CLEAR, (event) => {
		delete prefs.tableLayouts[(event as CustomEvent<IGridConfigClearDetail>).detail.tableId];
	});
	const global = globalThis as { document?: unknown };
	const hadDocument = 'document' in global;
	const document = global.document;
	global.document = doc;
	const hadFactory = 'createMessageGridPersistence' in shell;
	const factory = shell.createMessageGridPersistence;
	shell.createMessageGridPersistence = createMessageGridPersistence;
	return {
		prefs,
		bareChannel: () => createMessageGridPersistence(),
		uninstall() {
			if (hadDocument) global.document = document;
			else delete global.document;
			if (hadFactory) shell.createMessageGridPersistence = factory;
			else delete shell.createMessageGridPersistence;
		},
	};
}
