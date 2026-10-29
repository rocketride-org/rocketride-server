// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Toast store — the framework-free queue behind showToast(). Kept separate
 * from the React viewport so the queue rules (ids, newest-last ordering, the
 * visible cap, default durations) are unit-testable on their own.
 */

// =============================================================================
// TYPES
// =============================================================================

/** Visual + semantic variant of a toast. `error` is announced assertively. */
export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

/** What a caller passes to showToast(). */
export interface IToastOptions {
	/** Main text. */
	message: string;
	/** Optional bold first line. */
	title?: string;
	/** Variant. Defaults to `'info'`. */
	variant?: ToastVariant;
	/** Auto-dismiss delay in ms; 0 keeps it until dismissed. Defaults to 5000 (8000 for errors). */
	duration?: number;
	/** Optional single action, e.g. Undo or Retry. Clicking it also dismisses. */
	action?: { label: string; onClick: () => void };
}

/** A queued toast: the options plus its id and resolved defaults. */
export interface IToast extends IToastOptions {
	id: string;
	variant: ToastVariant;
	duration: number;
}

/** The store's public surface. */
export interface IToastStore {
	/** Queues a toast and returns its id. */
	add: (options: IToastOptions) => string;
	/** Removes a toast by id (no-op when already gone). */
	remove: (id: string) => void;
	/** Removes every toast. */
	clear: () => void;
	/** The current toasts, oldest first. Stable between changes. */
	getSnapshot: () => readonly IToast[];
	/** Subscribes to changes; returns the unsubscribe function. */
	subscribe: (listener: () => void) => () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** At most this many toasts are kept; the oldest is dropped first. */
export const MAX_TOASTS = 4;

/** Default auto-dismiss delay. */
export const DEFAULT_TOAST_DURATION = 5000;

/** Errors stay longer so they can be read. */
export const ERROR_TOAST_DURATION = 8000;

// =============================================================================
// STORE
// =============================================================================

/**
 * Creates an independent toast queue.
 *
 * @returns A new {@link IToastStore}.
 */
export function createToastStore(): IToastStore {
	let toasts: readonly IToast[] = [];
	let nextId = 1;
	const listeners = new Set<() => void>();

	/** Replaces the list and notifies subscribers. */
	function commit(next: readonly IToast[]): void {
		toasts = next;
		for (const listener of listeners) listener();
	}

	/** Resolves the default duration for a variant. */
	function resolveDuration(options: IToastOptions, variant: ToastVariant): number {
		if (options.duration !== undefined) return Math.max(0, options.duration);
		if (variant === 'error') return ERROR_TOAST_DURATION;
		return DEFAULT_TOAST_DURATION;
	}

	return {
		add(options: IToastOptions): string {
			const id = `rr-toast-${nextId}`;
			nextId += 1;
			const variant = options.variant ?? 'info';
			const toast: IToast = { ...options, id, variant, duration: resolveDuration(options, variant) };
			commit([...toasts, toast].slice(-MAX_TOASTS));
			return id;
		},
		remove(id: string): void {
			if (!toasts.some((toast) => toast.id === id)) return;
			commit(toasts.filter((toast) => toast.id !== id));
		},
		clear(): void {
			if (toasts.length === 0) return;
			commit([]);
		},
		getSnapshot(): readonly IToast[] {
			return toasts;
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
