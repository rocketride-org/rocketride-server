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

import { useState, useEffect, useCallback } from 'react';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * VS Code API interface
 */
interface VSCodeAPI {
	postMessage: (message: unknown) => void;
	getState: () => unknown;
	setState: (state: unknown) => void;
}

/**
 * Message handler function type for discriminated unions
 */
export type MessageHandler<TIncoming> = (message: TIncoming, event: MessageEvent) => void;

/**
 * Hook configuration options
 */
export interface UseMessagingOptions<TOutgoing, TIncoming> {
	/** Whether to enable debug logging (default: false) */
	debug?: boolean;
	/** Message handler for incoming messages */
	onMessage?: MessageHandler<TIncoming>;
	/** Custom ready message (default will use first type from TOutgoing) */
	readyMessage?: TOutgoing;
}

/**
 * Hook return type
 */
export interface UseMessagingReturn<TOutgoing, TIncoming, TState = unknown> {
	/** VS Code API instance (null if not available) */
	vscodeApi: VSCodeAPI | null;
	/** Whether the VS Code API is available and ready */
	isReady: boolean;
	/** Send a message to the VS Code extension */
	sendMessage: (message: TOutgoing) => void;
	/** Get persistent state from VS Code */
	getState: () => TState | null;
	/** Set persistent state in VS Code */
	setState: (state: TState) => void;
	/** Last received message (useful for debugging) */
	lastMessage: TIncoming | null;
	/** Error state if API acquisition fails */
	error: string | null;
}

// ============================================================================
// GLOBAL VS CODE API ACQUISITION
// ============================================================================

let globalVscodeApi: VSCodeAPI | null = null;
let apiAcquisitionError: string | null = null;

// Acquire the API immediately when the module loads
try {
	const win = window as unknown as Record<string, unknown>;
	if (typeof window !== 'undefined' && typeof win.acquireVsCodeApi === 'function') {
		globalVscodeApi = (win.acquireVsCodeApi as () => VSCodeAPI)();
	} else if (typeof window !== 'undefined') {
		apiAcquisitionError = 'VS Code API not available - acquireVsCodeApi is not a function';
	}
} catch (err) {
	apiAcquisitionError = `Failed to acquire VS Code API: ${err}`;
	console.error(`[useMessaging] ${apiAcquisitionError}`);
}

// ============================================================================
// CUSTOM HOOK
// ============================================================================

/**
 * useMessaging - Simple React hook for VS Code webview communication
 * 
 * Provides a clean, type-safe interface for VS Code webview communication with:
 * - Support for discriminated union message types
 * - Automatic ready message on initialization
 * - JSON object only communication
 * - Persistent state management
 * - Error handling and debugging
 * 
 * @template TOutgoing Messages sent to VS Code extension (discriminated union)
 * @template TIncoming Messages received from VS Code extension (discriminated union)
 * @template TState Type for persistent state
 * 
 * @param options Configuration options
 * 
 * @example
 * ```typescript
 * // Define your discriminated union types
 * type OutgoingMessages = 
 *   | { type: 'ready' }
 *   | { type: 'openExternal'; url: string };
 * 
 * type IncomingMessages = 
 *   | { type: 'update'; taskStatus: TaskStatus }
 *   | { type: 'error'; message: string };
 * 
 * // Use the hook - automatically handles ALL types from your discriminated union
 * const { sendMessage, isReady } = useMessaging<OutgoingMessages, IncomingMessages>({
 *   debug: true,
 *   onMessage: (message) => {
 *     // TypeScript knows about all possible message types
 *     switch (message.type) {
 *       case 'update':
 *         // TypeScript knows message.taskStatus exists
 *         setData(message.taskStatus);
 *         break;
 *       case 'error':
 *         // TypeScript knows message.message exists
 *         setError(message.message);
 *         break;
 *     }
 *   }
 * });
 * ```
 */
export const useMessaging = <
	TOutgoing,
	TIncoming,
	TState = unknown
>(options?: UseMessagingOptions<TOutgoing, TIncoming>): UseMessagingReturn<TOutgoing, TIncoming, TState> => {
	const {
		debug = false,
		onMessage,
		readyMessage = { type: 'ready' } as TOutgoing
	} = options || {};

	// ========================================================================
	// STATE
	// ========================================================================

	const [isReady, setIsReady] = useState<boolean>(false);
	const [lastMessage, setLastMessage] = useState<TIncoming | null>(null);

	// ========================================================================
	// LOGGING UTILITY
	// ========================================================================

	const log = useCallback((...args: unknown[]) => {
		if (debug) {
			console.log('[useMessaging]', ...args);
		}
	}, [debug]);

	// ========================================================================
	// AUTO READY MESSAGE
	// ========================================================================

	useEffect(() => {
		if (globalVscodeApi) {
			log('VS Code API available, sending ready message:', readyMessage);
			setIsReady(true);
			globalVscodeApi.postMessage(readyMessage);
		} else {
			if (apiAcquisitionError) {
				console.warn(`[useMessaging] ${apiAcquisitionError}`);
			}
			log('VS Code API not available');
		}
	}, []);

	// ========================================================================
	// MESSAGE SENDING
	// ========================================================================

	const sendMessage = useCallback((message: TOutgoing) => {
		log('Sending message:', message);

		if (globalVscodeApi) {
			try {
				globalVscodeApi.postMessage(message);
			} catch (err) {
				console.error('[useMessaging] Error sending message:', err, message);
			}
		} else {
			console.warn('[useMessaging] Cannot send message - VS Code API not available:', message);
		}
	}, [log]);

	// ========================================================================
	// MESSAGE HANDLING
	// ========================================================================

	useEffect(() => {
		if (!onMessage) return;

		const handleMessage = (event: MessageEvent) => {
			log('Received message event:', {
				data: event.data,
				dataType: typeof event.data,
				origin: event.origin,
				source: event.source === window ? 'SAME_WINDOW' : 'EXTERNAL'
			});

			// Only accept JSON objects
			if (!event.data || typeof event.data !== 'object' || typeof event.data.type !== 'string') {
				log('Filtering out message - not a valid JSON object with type property');
				return;
			}

			const message = event.data as TIncoming;

			log('Processing incoming message:', message);
			setLastMessage(message);

			// Call the message handler
			try {
				onMessage(message, event);
			} catch (err) {
				console.error('[useMessaging] Error in message handler:', err);
			}
		};

		log('Setting up message listener');
		window.addEventListener('message', handleMessage);

		return () => {
			log('Removing message listener');
			window.removeEventListener('message', handleMessage);
		};
	}, [onMessage, log]);

	// ========================================================================
	// STATE MANAGEMENT
	// ========================================================================

	const getState = useCallback((): TState | null => {
		if (globalVscodeApi) {
			try {
				const state = globalVscodeApi.getState();
				log('Getting state:', state);
				return state;
			} catch (err) {
				console.error('[useMessaging] Error getting state:', err);
				return null;
			}
		}
		log('Cannot get state - VS Code API not available');
		return null;
	}, [log]);

	const setState = useCallback((state: TState) => {
		if (globalVscodeApi) {
			try {
				log('Setting state:', state);
				globalVscodeApi.setState(state);
			} catch (err) {
				console.error('[useMessaging] Error setting state:', err);
			}
		} else {
			log('Cannot set state - VS Code API not available');
		}
	}, [log]);

	// ========================================================================
	// RETURN INTERFACE
	// ========================================================================

	return {
		vscodeApi: globalVscodeApi,
		isReady,
		sendMessage,
		getState,
		setState,
		lastMessage,
		error: apiAcquisitionError
	};
};

// ============================================================================
// CONVENIENCE HOOKS
// ============================================================================

/**
 * Hook with debug logging enabled
 */
export const useMessagingDebug = <TOutgoing, TIncoming, TState = unknown>(
	options?: UseMessagingOptions<TOutgoing, TIncoming>
) => {
	return useMessaging<TOutgoing, TIncoming, TState>({ ...options, debug: true });
};
