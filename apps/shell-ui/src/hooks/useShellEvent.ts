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
// USE SHELL EVENT — typed event subscription with automatic cleanup
// =============================================================================

import { useEffect, useRef } from 'react';
import type { ShellConnectionEventMap } from 'shared';
import { ConnectionManager } from '../connection/connection';

/**
 * Subscribe to a typed shell event with automatic cleanup on unmount.
 *
 * Replaces the common pattern of manually calling `cm.on()` in a useEffect
 * and returning the unsubscribe function. The handler is stable — it always
 * calls the latest version without needing it in the dependency array.
 *
 * @param event   - The event name from ShellConnectionEventMap.
 * @param handler - Callback invoked when the event fires.
 *
 * @example
 * ```tsx
 * useShellEvent('shell:event', ({ event }) => {
 *     console.log('Server pushed:', event);
 * });
 * ```
 */
export function useShellEvent<K extends keyof ShellConnectionEventMap>(
	event: K,
	handler: (payload: ShellConnectionEventMap[K]) => void,
): void {
	// Use a ref to always call the latest handler without resubscribing
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	useEffect(() => {
		const cm = ConnectionManager.getInstance();
		// Subscribe with a stable wrapper that delegates to the current ref
		const unsub = cm.on(event, (payload) => {
			handlerRef.current(payload);
		});
		return unsub;
	}, [event]);
}
