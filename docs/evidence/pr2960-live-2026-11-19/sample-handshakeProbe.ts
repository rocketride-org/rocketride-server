// Disposable diagnostic only. No credentials, product policy changes, or automatic sends.
export type ProbeStatus = 'IDLE' | 'WAITING' | 'REPLY_OBSERVED' | 'TIMEOUT' | 'TIMER_EARLY' | 'SEND_ERROR' | 'NO_OPENER' | 'OPENER_CLOSED' | 'INTERRUPTED';

export interface ProbeRecord {
	attempt: number;
	attemptId: string;
	status: ProbeStatus;
	elapsedMs: number;
	sendReturned: boolean;
	openerPresent: boolean | null;
	openerClosed: boolean | null;
	readySeen: boolean;
	readySourceIsDebug: boolean | null;
	readyOriginMatches: boolean | null;
	authSeen: boolean;
	authSourceIsOpener: boolean | null;
	authOriginMatches: boolean | null;
	tokenPresent: boolean | null;
	errorClass: string | null;
	interruption: 'repeat' | 'document' | null;
}

export interface HandshakeProbe {
	version: 'EDIT_D';
	isForTarget: (candidate: unknown) => boolean;
	getSnapshot: () => ProbeRecord;
	subscribe: (listener: (record: ProbeRecord) => void) => () => void;
	start: () => void;
}

type TargetWindow = Window & typeof globalThis & { __rr2960ProbeLastResult?: ProbeRecord; __rr2960ProbeController?: HandshakeProbe };
type ActiveAttempt = { record: ProbeRecord; startedAt: number; timeout: number | null; ticker: number | null; opener: Window; authListener: (event: MessageEvent) => void; readyListener: (event: MessageEvent) => void; pagehideListener: () => void };

function emptyRecord(): ProbeRecord {
	return { attempt: 0, attemptId: '', status: 'IDLE', elapsedMs: 0, sendReturned: false, openerPresent: null, openerClosed: null, readySeen: false, readySourceIsDebug: null, readyOriginMatches: null, authSeen: false, authSourceIsOpener: null, authOriginMatches: null, tokenPresent: null, errorClass: null, interruption: null };
}

function safeErrorClass(error: unknown): string {
	const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name?: unknown }).name) : '';
	return ['Error', 'EvalError', 'TypeError', 'SyntaxError', 'ReferenceError', 'SecurityError'].includes(name) ? name : 'UnknownError';
}

/** One controller per rendered Window, independent of React remounts.
 * No work is sent until start() is called by the user's button click. */
export function getHandshakeProbe(target: TargetWindow): HandshakeProbe {
	const existing = target.__rr2960ProbeController;
	if (existing?.version === 'EDIT_D' && existing.isForTarget(target)) return existing;
	let current: ProbeRecord = emptyRecord();
	let active: ActiveAttempt | null = null;
	const subscribers = new Map<(record: ProbeRecord) => void, number>();
	const emit = (notify = true): void => {
		// These records contain only our own fixed-schema booleans/timing/ids.
		// MessageEvent/data/token objects are never retained.
		target.__rr2960ProbeLastResult = { ...current };
		if (notify) for (const listener of subscribers.keys()) listener({ ...current });
	};
	const elapsed = (attempt: ActiveAttempt): number => Math.max(0, Math.round(target.performance.now() - attempt.startedAt));
	const clear = (attempt: ActiveAttempt): void => {
		if (attempt.timeout !== null) target.clearTimeout(attempt.timeout);
		if (attempt.ticker !== null) target.clearInterval(attempt.ticker);
		target.removeEventListener('message', attempt.authListener);
		target.removeEventListener('pagehide', attempt.pagehideListener);
		try { attempt.opener.removeEventListener('message', attempt.readyListener); } catch { /* opener navigated or closed */ }
		if (active === attempt) active = null;
	};
	const interrupt = (reason: 'repeat' | 'document', notify: boolean): void => {
		if (!active) return;
		const attempt = active;
		current = { ...attempt.record, status: 'INTERRUPTED', elapsedMs: elapsed(attempt), interruption: reason };
		clear(attempt);
		emit(notify);
	};
	emit();
	const controller: HandshakeProbe = {
		version: 'EDIT_D',
		isForTarget: (candidate: unknown): boolean => candidate === target,
		getSnapshot: (): ProbeRecord => ({ ...current }),
		subscribe: (listener: (record: ProbeRecord) => void): (() => void) => {
			subscribers.set(listener, (subscribers.get(listener) ?? 0) + 1);
			listener({ ...current });
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				const remaining = (subscribers.get(listener) ?? 1) - 1;
				if (remaining > 0) subscribers.set(listener, remaining); else subscribers.delete(listener);
			};
		},
		start: (): void => {
			interrupt('repeat', false);
			const startedAt = target.performance.now();
			const number = current.attempt + 1;
			const attemptId = `rr2960-${Math.round(target.performance.timeOrigin)}-${number}-${startedAt.toFixed(3)}`;
			current = { ...emptyRecord(), attempt: number, attemptId, status: 'WAITING' };
			const record = current;
			const opener = target.opener as Window | null;
			record.openerPresent = opener !== null;
			record.openerClosed = opener ? opener.closed : null;
			if (!opener || record.openerClosed) {
				current = { ...record, status: !opener ? 'NO_OPENER' : 'OPENER_CLOSED' };
				emit();
				return;
			}
			const origin = target.location.origin;
			const isCurrent = (): boolean => active?.record.attemptId === attemptId && current.attemptId === attemptId && current.status === 'WAITING';
			const authListener = (event: MessageEvent): void => {
				if (!isCurrent()) return;
				const data = event.data as { type?: string; token?: unknown } | undefined;
				if (data?.type !== 'rrdev:auth') return;
				record.authSeen = true;
				record.authSourceIsOpener = event.source === opener;
				record.authOriginMatches = event.origin === origin;
				record.tokenPresent = typeof data.token === 'string' && data.token.length > 0;
				record.elapsedMs = elapsed(attempt);
				if (record.authSourceIsOpener && record.authOriginMatches && typeof data.token === 'string') {
					record.status = 'REPLY_OBSERVED';
					clear(attempt);
				}
				current = { ...record };
				emit();
			};
			const readyListener = (event: MessageEvent): void => {
				if (!isCurrent()) return;
				const data = event.data as { type?: string; rr2960ProbeAttempt?: string } | undefined;
				if (data?.type !== 'shell:devReady' || data.rr2960ProbeAttempt !== attemptId) return;
				record.readySeen = true;
				record.readySourceIsDebug = event.source === target;
				record.readyOriginMatches = event.origin === origin;
				record.elapsedMs = elapsed(attempt);
				current = { ...record };
				emit();
			};
			const pagehideListener = (): void => { if (isCurrent()) interrupt('document', true); };
			const attempt: ActiveAttempt = { record, startedAt, timeout: null, ticker: null, opener, authListener, readyListener, pagehideListener };
			active = attempt;
			try {
				target.addEventListener('message', authListener);
				target.addEventListener('pagehide', pagehideListener);
				opener.addEventListener('message', readyListener);
				attempt.timeout = target.setTimeout(() => {
					if (!isCurrent()) return;
					record.elapsedMs = elapsed(attempt);
					record.status = record.elapsedMs >= 5000 ? 'TIMEOUT' : 'TIMER_EARLY';
					current = { ...record };
					clear(attempt);
					emit();
				}, 5000);
				attempt.ticker = target.setInterval(() => {
					if (!isCurrent()) return;
					if (target.closed) { interrupt('document', false); return; }
					if (opener.closed) {
						record.status = 'OPENER_CLOSED'; record.openerClosed = true; record.elapsedMs = elapsed(attempt);
						current = { ...record }; clear(attempt); emit(); return;
					}
					record.elapsedMs = elapsed(attempt);
					current = { ...record };
					emit();
				}, 100);
				emit();
				// The extra inert attempt tag is observed passively; the actual
				// Builder handler is unchanged and does not echo a correlation id.
				const sendReady = target.Function('attemptId', 'window.opener?.postMessage({ type: "shell:devReady", rr2960ProbeAttempt: attemptId }, window.location.origin);');
				sendReady(attemptId);
				if (current.attemptId === attemptId) {
					record.sendReturned = true;
					current = { ...record };
					emit();
				}
			} catch (error) {
				if (current.attemptId !== attemptId) return;
				record.status = 'SEND_ERROR';
				record.elapsedMs = elapsed(attempt);
				record.errorClass = safeErrorClass(error);
				current = { ...record };
				clear(attempt);
				emit();
			}
		},
	};
	target.__rr2960ProbeController = controller;
	return controller;
}
