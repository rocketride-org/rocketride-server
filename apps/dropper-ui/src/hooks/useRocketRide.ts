/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { RocketRideClient } from 'rocketride';
import { getClient, subscribeToClient } from './clientSingleton';

/**
 * useRocketRideClient - React hook for accessing shared RocketRide WebSocket client
 *
 * This hook provides a React-friendly interface to the RocketRide client singleton,
 * ensuring a single, persistent WebSocket connection across the entire application.
 *
 * @param onConnected - Called when WebSocket connects (setup pipelines here)
 * @param onDisconnected - Called when WebSocket disconnects (cleanup here)
 * @param onStatusChange - Called for transient status updates
 *
 * @returns Object with connection state and client reference
 */
export const useRocketRideClient = (
	onConnected?: (client: RocketRideClient) => void | Promise<void>,
	onDisconnected?: (reason: string, hasError: boolean) => void | Promise<void>,
	onStatusChange?: (message: string | null) => void
) => {
	const [isConnected, setIsConnected] = useState(false);

	const isMountedRef = useRef(true);
	const onConnectedRef = useRef(onConnected);
	const onDisconnectedRef = useRef(onDisconnected);
	const onStatusChangeRef = useRef(onStatusChange);

	useEffect(() => {
		onConnectedRef.current = onConnected;
		onDisconnectedRef.current = onDisconnected;
		onStatusChangeRef.current = onStatusChange;
	}, [onConnected, onDisconnected, onStatusChange]);

	const handleConnected = useCallback(async (connectedClient: RocketRideClient) => {
		if (!isMountedRef.current) return;

		setIsConnected(true);

		if (onConnectedRef.current) {
			try {
				await onConnectedRef.current(connectedClient);
			} catch (error) {
				console.error('Error in onConnected callback:', error);
			}
		}
	}, []);

	const handleDisconnected = useCallback(async (reason: string, hasError: boolean) => {
		if (!isMountedRef.current) return;

		setIsConnected(false);

		if (onDisconnectedRef.current) {
			try {
				await onDisconnectedRef.current(reason, hasError);
			} catch (error) {
				console.error('Error in onDisconnected callback:', error);
			}
		}
	}, []);

	const handleStatusChange = useCallback((message: string | null) => {
		if (!isMountedRef.current) return;

		if (onStatusChangeRef.current) {
			onStatusChangeRef.current(message);
		}
	}, []);

	const handleEvent = useCallback(async (_message: any) => {
		// Events are logged in the singleton
	}, []);

	useEffect(() => {
		isMountedRef.current = true;

		const unsubscribe = subscribeToClient({
			onEvent: handleEvent,
			onConnected: handleConnected,
			onDisconnected: handleDisconnected,
			onStatusChange: handleStatusChange,
		});

		const c = getClient();

		if (c) {
			const connected = c.isConnected();
			setIsConnected(connected);

			if (connected && onConnectedRef.current) {
				Promise.resolve(onConnectedRef.current(c)).catch((error: Error) => {
					console.error('Error in onConnected callback:', error);
				});
			}
		}

		return () => {
			isMountedRef.current = false;
			unsubscribe();
		};
	}, [handleEvent, handleConnected, handleDisconnected, handleStatusChange]);

	return {
		isConnected,
		client: getClient(),
	};
};
