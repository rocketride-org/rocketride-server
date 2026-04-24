// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useMessaging — VS Code webview communication hook.
 *
 * Handles all postMessage communication between the webview (browser) and the
 * VS Code extension host. Uses acquireVsCodeApi() for sending and
 * window message events for receiving.
 */

import { useEffect, useCallback } from 'react';

// =============================================================================
// TYPES
// =============================================================================

interface VSCodeAPI {
	postMessage: (message: unknown) => void;
	getState: () => unknown;
	setState: (state: unknown) => void;
}

export type MessageHandler<TIncoming> = (message: TIncoming, event: MessageEvent) => void;

export interface UseMessagingOptions<TOutgoing, TIncoming> {
	/** Handler called for each incoming message from the extension host. */
	onMessage?: MessageHandler<TIncoming>;
	/** Message sent automatically on mount to signal readiness. Defaults to { type: 'view:ready' }. */
	readyMessage?: TOutgoing;
}

export interface UseMessagingReturn<TOutgoing, TState = unknown> {
	/** Send a typed message to the extension host. */
	sendMessage: (message: TOutgoing) => void;
	/** Whether the webview has sent its ready message. Always true after mount. */
	isReady: boolean;
	/** Retrieve persisted webview state (survives tab switches). */
	getState: () => TState | null;
	/** Persist webview state (survives tab switches). */
	setState: (state: TState) => void;
}

// =============================================================================
// VS CODE API ACQUISITION
// =============================================================================

let vscodeApi: VSCodeAPI | null = null;

try {
	const win = window as unknown as Record<string, unknown>;
	if (typeof window !== 'undefined' && typeof win.acquireVsCodeApi === 'function') {
		vscodeApi = (win.acquireVsCodeApi as () => VSCodeAPI)();
	}
} catch (err) {
	console.error('[useMessaging] Failed to acquire VS Code API:', err);
}

// =============================================================================
// HOOK
// =============================================================================

export const useMessaging = <TOutgoing, TIncoming, TState = unknown>(options?: UseMessagingOptions<TOutgoing, TIncoming>): UseMessagingReturn<TOutgoing, TState> => {
	const { onMessage, readyMessage = { type: 'view:ready' } as TOutgoing } = options || {};

	// --- Send ready on mount -------------------------------------------------

	useEffect(() => {
		if (vscodeApi) {
			vscodeApi.postMessage(readyMessage);
		}
	}, []);

	// --- Send ----------------------------------------------------------------

	const sendMessage = useCallback((message: TOutgoing) => {
		if (vscodeApi) {
			try {
				vscodeApi.postMessage(message);
			} catch (err) {
				console.error('[useMessaging] Error sending message:', err, message);
			}
		}
	}, []);

	// --- Receive -------------------------------------------------------------

	useEffect(() => {
		if (!onMessage) return;

		const handleMessage = (event: MessageEvent) => {
			if (!event.data || typeof event.data !== 'object' || typeof event.data.type !== 'string') return;
			try {
				onMessage(event.data as TIncoming, event);
			} catch (err) {
				console.error('[useMessaging] Error in message handler:', err);
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, [onMessage]);

	// --- State (VS Code webview persistence) ---------------------------------

	const getState = useCallback((): TState | null => {
		if (!vscodeApi) return null;
		try {
			return vscodeApi.getState() as TState;
		} catch {
			return null;
		}
	}, []);

	const setState = useCallback((state: TState) => {
		if (!vscodeApi) return;
		try {
			vscodeApi.setState(state);
		} catch {
			/* ignore */
		}
	}, []);

	return { sendMessage, isReady: true, getState, setState };
};
