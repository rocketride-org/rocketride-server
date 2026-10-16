// MIT License
//
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
// TOASTS — the app's own transient confirmations
// =============================================================================
//
// The shell surface has no toast primitive (Banner is in-flow, the status bar
// is the shell's), and the UX spec asks for a toast on every save, start, stop
// and restart — with the failure reason on it. So the app owns one: a provider
// at the root, a `useToast()` hook anywhere below it.
//
// Accessibility: the stack is an `aria-live="assertive"` region, so a screen
// reader announces the outcome without focus moving, and each toast carries a
// keyboard-reachable Dismiss button — the pointer path (click the toast) and
// the keyboard path (tab to Dismiss) both exist.
// =============================================================================

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** How a toast reads: a confirmation or a failure. */
export type ToastTone = 'success' | 'error';

/** One live toast. */
interface Toast {
	/** Monotonic id — the React key and the dismiss handle. */
	id: number;
	/** The message shown to the user. */
	message: string;
	/** Visual and semantic tone. */
	tone: ToastTone;
}

/** What {@link useToast} hands back. */
export interface ToastApi {
	/** Show a confirmation. */
	success: (message: string) => void;
	/** Show a failure, reason included. */
	error: (message: string) => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** How long a toast stays up before it retires itself (ms). */
const TOAST_TTL_MS = 6000;

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Fixed bottom-right stack, above app content, below shell overlays. */
	stack: {
		position: 'fixed',
		right: 20,
		bottom: 44,
		zIndex: 40,
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		maxWidth: 420,
		pointerEvents: 'none',
	} as CSSProperties,

	/** One toast card. */
	toast: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: 12,
		padding: '10px 12px',
		borderRadius: 'var(--radius-md)',
		border: '1px solid var(--line)',
		backgroundColor: 'var(--surface)',
		boxShadow: 'var(--shadow-pop)',
		fontFamily: 'var(--font-sans)',
		fontSize: 13,
		lineHeight: 1.45,
		color: 'var(--ink)',
		pointerEvents: 'auto',
	} as CSSProperties,

	/** Tone stripe on the leading edge. */
	dot: {
		flexShrink: 0,
		width: 8,
		height: 8,
		marginTop: 6,
		borderRadius: '50%',
	} as CSSProperties,

	/** The message column. */
	body: {
		flex: 1,
		minWidth: 0,
		wordBreak: 'break-word',
	} as CSSProperties,

	/** Keyboard-reachable dismiss control. */
	dismiss: {
		flexShrink: 0,
		padding: '2px 6px',
		border: 'none',
		borderRadius: 5,
		backgroundColor: 'transparent',
		color: 'var(--ink-muted)',
		fontFamily: 'inherit',
		fontSize: 12,
		cursor: 'pointer',
	} as CSSProperties,
};

// =============================================================================
// CONTEXT
// =============================================================================

/** No-op fallback so a component rendered outside the provider never crashes. */
const NO_TOASTS: ToastApi = { success: () => {}, error: () => {} };

const ToastContext = createContext<ToastApi>(NO_TOASTS);

/**
 * Read the toast API.
 *
 * @returns Handles for showing a confirmation or a failure.
 */
export function useToast(): ToastApi {
	return useContext(ToastContext);
}

// =============================================================================
// PROVIDER
// =============================================================================

/**
 * Mounts the toast stack and provides {@link useToast} to everything below.
 *
 * @param props.children - The app tree.
 * @returns The children plus the live toast stack.
 */
export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const nextId = useRef(1);
	// Live retirement timers, so none of them outlives the provider.
	const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

	/** Remove one toast by id (the timer's target and the Dismiss handler). */
	const dismiss = useCallback((id: number) => {
		const timer = timers.current.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.current.delete(id);
		}
		setToasts((prev) => prev.filter((t) => t.id !== id));
	}, []);

	/** Push a toast and arm its retirement timer. */
	const push = useCallback(
		(message: string, tone: ToastTone) => {
			const id = nextId.current++;
			setToasts((prev) => [...prev, { id, message, tone }]);
			timers.current.set(
				id,
				setTimeout(() => dismiss(id), TOAST_TTL_MS)
			);
		},
		[dismiss]
	);

	// An unmount mid-toast must not leave a timer holding a setState.
	useEffect(
		() => () => {
			for (const timer of timers.current.values()) clearTimeout(timer);
			timers.current.clear();
		},
		[]
	);

	const api = useMemo<ToastApi>(
		() => ({
			success: (message: string) => push(message, 'success'),
			error: (message: string) => push(message, 'error'),
		}),
		[push]
	);

	return (
		<ToastContext.Provider value={api}>
			{children}
			{/* role="alert", not role="status": the toast reports the outcome of
			    something the user just did, so it must interrupt rather than wait
			    for a pause — and `alert` is the role whose implicit politeness IS
			    assertive. `status` would have contradicted the aria-live here. */}
			<div style={styles.stack} role="alert" aria-live="assertive">
				{toasts.map((toast) => (
					<div key={toast.id} style={styles.toast}>
						<span
							style={{
								...styles.dot,
								backgroundColor: toast.tone === 'error' ? 'var(--bad)' : 'var(--ok)',
							}}
						/>
						<span style={styles.body}>{toast.message}</span>
						<button type="button" style={styles.dismiss} onClick={() => dismiss(toast.id)} aria-label={`Dismiss message: ${toast.message}`}>
							Dismiss
						</button>
					</div>
				))}
			</div>
		</ToastContext.Provider>
	);
};
