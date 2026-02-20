/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

import React, { useEffect, useState } from 'react';
import { ThemeProvider } from './hooks/useTheme';
import { VSCodeProvider, VSCodeContextType } from './hooks/useVSCode';
import { DropperContainer } from './components/DropperContainer';
import { API_CONFIG, setAPIConfig } from './config/apiConfig';
import { startClient } from './hooks/clientSingleton';

const App: React.FC = () => {
	const [isVSCode] = useState(() => window.parent !== window);
	const [authToken, setAuthToken] = useState<string | null>(null);

	// Initialize VSCode state
	const [vscodeState, setVscodeState] = useState<VSCodeContextType>(() => {
		if (!isVSCode) {
			// Dummy state for non-VSCode mode
			return {
				theme: null,
				isVSCode: false,
				isReady: true
			};
		} else {
			// VSCode mode - not ready yet
			return {
				theme: null,
				isVSCode: true,
				isReady: false
			};
		}
	});

	useEffect(() => {
		const urlParams = new URLSearchParams(window.location.search);
		let uri = '';
		let token = '';

		if (API_CONFIG.devMode && API_CONFIG.ROCKETRIDE_URI) {
			uri = API_CONFIG.ROCKETRIDE_URI;
		}
		if (!uri) {
			uri = window.location.origin;
		}

		if (!isVSCode) {
			token = sessionStorage.getItem('auth') || '';
		}
		if (!token && API_CONFIG.devMode && API_CONFIG.ROCKETRIDE_APIKEY) {
			token = API_CONFIG.ROCKETRIDE_APIKEY;
		}
		if (!token) {
			token = urlParams.get('auth') || '';
			if (token && window.location.search.includes('auth=')) {
				window.history.replaceState({}, '', window.location.pathname);
			}
		}

		if (!uri) {
			throw new Error('Failed to start RocketRide client: No uri found');
		}
		if (!token) {
			throw new Error('Failed to start RocketRide client: No token found');
		}

		setAPIConfig({
			ROCKETRIDE_APIKEY: token,
			ROCKETRIDE_URI: uri
		});

		startClient(token).catch(error => {
			console.error('Failed to start client:', error);
		});

		if (!isVSCode) {
			sessionStorage.setItem('auth', token);
		}
		setAuthToken(token);

		if (isVSCode) {
			const handleVSCodeData = (event: MessageEvent) => {
				const message = event.data;
				if (message.type === 'vscodeData' && message.theme) {
					setVscodeState({
						theme: message.theme,
						isVSCode: true,
						isReady: true
					});
				}
			};
			window.addEventListener('message', handleVSCodeData);
			window.parent.postMessage({ type: 'ready' }, '*');
			return () => window.removeEventListener('message', handleVSCodeData);
		}
		return undefined;
	}, [isVSCode]);

	// CRITICAL: Absolutely do not render anything until ready
	if (!vscodeState.isReady) {
		return null;
	}

	return (
		<VSCodeProvider value={vscodeState}>
			<ThemeProvider>
				<DropperContainer authToken={authToken} />
			</ThemeProvider>
		</VSCodeProvider>
	);
};

export default App;
