// =============================================================================
// useMessaging — VS Code webview + browser iframe communication hook
// =============================================================================
//
// Detects context at runtime:
//   - VS Code webview: acquireVsCodeApi() is available → uses vscode postMessage
//   - Browser iframe:  no VS Code API → falls back to window.parent.postMessage
//
// Both contexts use window.addEventListener('message', ...) for receiving.
// =============================================================================

import { useState, useEffect, useCallback } from 'react';

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
	debug?: boolean;
	onMessage?: MessageHandler<TIncoming>;
	readyMessage?: TOutgoing;
}

export interface UseMessagingReturn<TOutgoing, TIncoming, TState = unknown> {
	vscodeApi: VSCodeAPI | null;
	isReady: boolean;
	sendMessage: (message: TOutgoing) => void;
	getState: () => TState | null;
	setState: (state: TState) => void;
	lastMessage: TIncoming | null;
	error: string | null;
}

// =============================================================================
// VS CODE API ACQUISITION
// =============================================================================

let globalVscodeApi: VSCodeAPI | null = null;
let apiAcquisitionError: string | null = null;

try {
	const win = window as unknown as Record<string, unknown>;
	if (typeof window !== 'undefined' && typeof win.acquireVsCodeApi === 'function') {
		globalVscodeApi = (win.acquireVsCodeApi as () => VSCodeAPI)();
	}
} catch (err) {
	apiAcquisitionError = `Failed to acquire VS Code API: ${err}`;
	console.error(`[useMessaging] ${apiAcquisitionError}`);
}

// =============================================================================
// HOOK
// =============================================================================

export const useMessaging = <TOutgoing, TIncoming, TState = unknown>(options?: UseMessagingOptions<TOutgoing, TIncoming>): UseMessagingReturn<TOutgoing, TIncoming, TState> => {
	const { debug = false, onMessage, readyMessage = { type: 'view:ready' } as TOutgoing } = options || {};

	const [isReady, setIsReady] = useState<boolean>(false);
	const [lastMessage, setLastMessage] = useState<TIncoming | null>(null);

	const log = useCallback(
		(...args: unknown[]) => {
			if (debug) console.log('[useMessaging]', ...args);
		},
		[debug]
	);

	// --- Auto-ready on mount --------------------------------------------------

	useEffect(() => {
		setIsReady(true);
		if (globalVscodeApi) {
			globalVscodeApi.postMessage(readyMessage);
		} else {
			window.parent.postMessage(readyMessage, '*');
		}
	}, []);

	// --- Send -----------------------------------------------------------------

	const sendMessage = useCallback(
		(message: TOutgoing) => {
			log('Sending message:', message);
			if (globalVscodeApi) {
				try {
					globalVscodeApi.postMessage(message);
				} catch (err) {
					console.error('[useMessaging] Error sending message:', err, message);
				}
			} else {
				window.parent.postMessage(message, '*');
			}
		},
		[log]
	);

	// --- Receive --------------------------------------------------------------

	useEffect(() => {
		if (!onMessage) return;

		const handleMessage = (event: MessageEvent) => {
			if (!event.data || typeof event.data !== 'object' || typeof event.data.type !== 'string') return;
			const message = event.data as TIncoming;
			log('Received message:', message);
			setLastMessage(message);
			try {
				onMessage(message, event);
			} catch (err) {
				console.error('[useMessaging] Error in message handler:', err);
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, [onMessage, log]);

	// --- State (VS Code only; no-op in browser) -------------------------------

	const getState = useCallback((): TState | null => {
		if (globalVscodeApi) {
			try {
				return globalVscodeApi.getState() as TState;
			} catch {
				return null;
			}
		}
		return null;
	}, []);

	const setState = useCallback((state: TState) => {
		if (globalVscodeApi) {
			try {
				globalVscodeApi.setState(state);
			} catch {
				/* ignore */
			}
		}
	}, []);

	return { vscodeApi: globalVscodeApi, isReady, sendMessage, getState, setState, lastMessage, error: apiAcquisitionError };
};
