// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Toasts — brief, non-blocking notifications ("Pipeline saved", "Copied",
 * "Deploy failed — Retry").
 *
 * Call showToast() from anywhere; no provider is needed. The first call
 * mounts a viewport into document.body on its own React root, and every app
 * in the shell shares that one queue (the shell module is a federation
 * singleton). A host that wants the stack somewhere specific can render
 * <ToastViewport /> itself; while one is mounted, no auto viewport is made.
 *
 * Each toast auto-dismisses after its duration, pauses while hovered or
 * focused, and is announced politely (errors assertively). Keep messages to
 * one line; anything the user must act on belongs in a Modal or a Banner.
 *
 * Built on `.rr-toast` from components.css.
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { CLOSE_GLYPH } from '../modal/Modal';
import { createToastStore, IToast, IToastOptions } from './toastStore';

// =============================================================================
// STATE
// =============================================================================

/** The one shared queue. */
const toastStore = createToastStore();

/** Number of mounted viewports (host-placed or auto). */
let mountedViewports = 0;

/** Whether the auto viewport has been created. */
let hasAutoViewport = false;

// =============================================================================
// API
// =============================================================================

/**
 * Shows a toast.
 *
 * @param options - Message, optional title, variant, duration and action.
 * @returns The toast id, for {@link dismissToast}.
 */
export function showToast(options: IToastOptions): string {
	ensureViewport();
	return toastStore.add(options);
}

/**
 * Dismisses a toast early.
 *
 * @param id - The id returned by {@link showToast}.
 */
export function dismissToast(id: string): void {
	toastStore.remove(id);
}

/** Mounts the auto viewport on first use when no host placed one. */
function ensureViewport(): void {
	if (mountedViewports > 0 || hasAutoViewport) return;
	if (typeof document === 'undefined') return;
	hasAutoViewport = true;
	const container = document.createElement('div');
	container.setAttribute('data-rr-toast-root', '');
	document.body.appendChild(container);
	createRoot(container).render(<ToastViewport />);
}

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * One toast row with its own dismiss timer, paused on hover and focus.
 *
 * @param props - The toast.
 * @returns The toast element.
 */
function ToastItem({ toast }: { toast: IToast }): React.ReactElement {
	const [isPaused, setIsPaused] = useState(false);
	const remainingRef = useRef(toast.duration);

	useEffect(() => {
		if (toast.duration === 0 || isPaused) return undefined;
		const startedAt = Date.now();
		const timer = setTimeout(() => dismissToast(toast.id), remainingRef.current);
		return () => {
			clearTimeout(timer);
			remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
		};
	}, [toast.id, toast.duration, isPaused]);

	let role = 'status';
	if (toast.variant === 'error') role = 'alert';

	return (
		<div
			role={role}
			className={`rr-toast rr-toast--${toast.variant}`}
			onMouseEnter={() => setIsPaused(true)}
			onMouseLeave={() => setIsPaused(false)}
			onFocus={() => setIsPaused(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsPaused(false);
			}}
		>
			<span className="rr-toast__icon" aria-hidden="true" />
			<div className="rr-toast__body">
				{toast.title && <div className="rr-toast__title">{toast.title}</div>}
				<div>{toast.message}</div>
			</div>
			{toast.action && (
				<button
					type="button"
					className="rr-btn rr-btn--ghost rr-btn--sm"
					onClick={() => {
						toast.action?.onClick();
						dismissToast(toast.id);
					}}
				>
					{toast.action.label}
				</button>
			)}
			<button type="button" className="rr-icon-btn rr-icon-btn--sm" aria-label="Dismiss notification" onClick={() => dismissToast(toast.id)}>
				{CLOSE_GLYPH}
			</button>
		</div>
	);
}

/**
 * The toast stack: a fixed, labeled region in the bottom-right corner.
 * Render it only to place the stack yourself; showToast() mounts one
 * automatically otherwise.
 *
 * @returns The viewport element.
 */
export function ToastViewport(): React.ReactElement {
	const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);

	useEffect(() => {
		mountedViewports += 1;
		return () => {
			mountedViewports -= 1;
		};
	}, []);

	return (
		<section className="rr-toast-viewport" aria-label="Notifications">
			{toasts.map((toast) => (
				<ToastItem key={toast.id} toast={toast} />
			))}
		</section>
	);
}
