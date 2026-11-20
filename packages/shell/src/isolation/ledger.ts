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
// LEDGER — what one realm owns, keyed by the opaque values it was handed
// =============================================================================
//
// Per realm: run handles (`rh_`) mapped to the real `tk_`/`pk_`, the run's
// real project and its `rp_` alias, the task id and its alias, the pipes
// opened on it, and its completion time; store handles; monitor refcounts.
// The real values never leave the root. A completed run stays addressable
// for 120 s after the first `completed`/`final`, then is forgotten.
// Not exported from `src/index.ts`/`api.ts`.
// =============================================================================

/** How long a completed run stays owned. */
export const COMPLETED_GRACE_MS = 120_000;

/** One run the realm started. */
export interface IRunEntry {
	handle: string;
	token: string;
	publicToken: string;
	projectId: string;
	projectAlias: string;
	source: string;
	taskId: string;
	taskIdAlias: string;
	pipeIds: Set<number>;
	completedAt?: number;
	/** Bumped by every restart: a status answer to a request sent before it describes the earlier run. */
	generation: number;
}

/** One store handle the realm opened. */
export interface IFsEntry {
	handle: string;
	mode: 'r' | 'w';
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
	let out = '';
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = ((value << 8) | byte) & 0xffff;
		bits += 8;
		while (bits >= 6) {
			out += B64URL[(value >>> (bits - 6)) & 63];
			bits -= 6;
		}
	}
	if (bits > 0) out += B64URL[(value << (6 - bits)) & 63];
	return out;
}

/** `rh_` plus 22 base64url characters. */
export function mintHandle(random: (n: number) => Uint8Array): string {
	return `rh_${base64url(random(16)).slice(0, 22)}`;
}

/** `rp_` plus 22 base64url characters. */
export function mintProjectAlias(random: (n: number) => Uint8Array): string {
	return `rp_${base64url(random(16)).slice(0, 22)}`;
}

/** A version-4 UUID from the injected randomness. */
export function uuid4(random: (n: number) => Uint8Array): string {
	const b = random(16);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What a quota counts. */
export type QuotaKind = 'runs' | 'pipes' | 'fsHandles' | 'monitorKeys';

/** The per-realm ledger. */
export interface ILedger {
	/** Live count plus slots reserved by requests still waiting on the engine. */
	used(kind: QuotaKind): number;
	/** Reserves `n` slots until the returned release runs (idempotent). */
	reserve(kind: QuotaKind, n?: number): () => void;
	/** Records a started run under a fresh handle. */
	addRun(fields: Omit<IRunEntry, 'handle' | 'projectAlias' | 'taskIdAlias' | 'pipeIds' | 'completedAt' | 'generation'> & { projectAlias?: string }): IRunEntry;
	/** The live run for a handle (expired runs are dropped here). */
	run(handle: string): IRunEntry | undefined;
	/** The live run holding a real token. */
	runByToken(token: string): IRunEntry | undefined;
	/** The live run whose project alias this is. */
	runByAlias(alias: string): IRunEntry | undefined;
	/** Marks a run complete (first time only). */
	complete(handle: string): void;
	dropRun(handle: string): void;
	runs(): IRunEntry[];
	addFs(handle: string, mode: 'r' | 'w'): void;
	fs(handle: string): IFsEntry | undefined;
	dropFs(handle: string): void;
	fsHandles(): IFsEntry[];
	/** Monitor refcounts: run handle → event type → count. */
	monitors: Map<string, Map<string, number>>;
	/**
	 * Direct subscriptions made with `rrext_monitor` (replace semantics: the
	 * last call's types), keyed `<handle>:<pipeId>`.
	 */
	directMonitors: Map<string, { handle: string; pipeId?: number; types: string[] }>;
	/**
	 * Runs whose execute answer was lost (the engine call threw): minted
	 * project → source. They may still start, so they count toward the run
	 * quota until they are found and ended.
	 */
	lostRuns: Map<string, string>;
	/** Real tokens and public tokens held (for the outbound backstop). */
	secrets(): string[];
	clear(): void;
}

/**
 * Creates one realm's ledger.
 *
 * @param deps - Clock and randomness (injected for tests).
 * @returns The ledger.
 */
export function createLedger(deps: { now(): number; random(n: number): Uint8Array }): ILedger {
	const runsByHandle = new Map<string, IRunEntry>();
	const fsByHandle = new Map<string, IFsEntry>();
	const monitors = new Map<string, Map<string, number>>();
	const directMonitors = new Map<string, { handle: string; pipeId?: number; types: string[] }>();
	const lostRuns = new Map<string, string>();
	const pending: Record<QuotaKind, number> = { runs: 0, pipes: 0, fsHandles: 0, monitorKeys: 0 };

	const dropRun = (handle: string): void => {
		runsByHandle.delete(handle);
		monitors.delete(handle);
		for (const [k, d] of directMonitors) if (d.handle === handle) directMonitors.delete(k);
	};
	const live = (entry: IRunEntry | undefined): IRunEntry | undefined => {
		if (!entry) return undefined;
		if (entry.completedAt !== undefined && deps.now() - entry.completedAt > COMPLETED_GRACE_MS) {
			dropRun(entry.handle);
			return undefined;
		}
		return entry;
	};
	const liveRuns = (): IRunEntry[] => [...runsByHandle.values()].filter((e) => live(e) !== undefined);

	const liveCount = (kind: QuotaKind): number => {
		switch (kind) {
			case 'runs':
				return liveRuns().length + lostRuns.size;
			case 'pipes':
				return liveRuns().reduce((n, e) => n + e.pipeIds.size, 0);
			case 'fsHandles':
				return fsByHandle.size;
			case 'monitorKeys':
				return [...monitors.values()].reduce((n, types) => n + types.size, 0) + [...directMonitors.values()].reduce((n, d) => n + d.types.length, 0);
		}
	};

	return {
		used: (kind) => liveCount(kind) + pending[kind],
		reserve(kind, n = 1) {
			pending[kind] += n;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				pending[kind] -= n;
			};
		},
		addRun(fields) {
			let handle = mintHandle(deps.random);
			while (runsByHandle.has(handle)) handle = mintHandle(deps.random);
			const entry: IRunEntry = {
				...fields,
				handle,
				projectAlias: fields.projectAlias ?? mintProjectAlias(deps.random),
				taskIdAlias: `${handle.slice(3, 11)}.${fields.source}`,
				pipeIds: new Set(),
				generation: 0,
			};
			runsByHandle.set(handle, entry);
			return entry;
		},
		run: (handle) => live(runsByHandle.get(handle)),
		runByToken: (token) => liveRuns().find((e) => e.token === token),
		runByAlias: (alias) => liveRuns().find((e) => e.projectAlias === alias),
		complete(handle) {
			const entry = runsByHandle.get(handle);
			if (entry && entry.completedAt === undefined) entry.completedAt = deps.now();
		},
		dropRun,
		runs: liveRuns,
		addFs: (handle, mode) => void fsByHandle.set(handle, { handle, mode }),
		fs: (handle) => fsByHandle.get(handle),
		dropFs: (handle) => void fsByHandle.delete(handle),
		fsHandles: () => [...fsByHandle.values()],
		monitors,
		directMonitors,
		lostRuns,
		secrets: () => [...runsByHandle.values()].flatMap((e) => [e.token, e.publicToken]).filter((s) => typeof s === 'string' && s !== ''),
		clear() {
			runsByHandle.clear();
			fsByHandle.clear();
			monitors.clear();
			directMonitors.clear();
			lostRuns.clear();
		},
	};
}
