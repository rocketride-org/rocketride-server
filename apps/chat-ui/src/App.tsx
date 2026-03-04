/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import React, { useEffect, useState } from 'react';
import { ThemeProvider } from './hooks/useTheme';
import { VSCodeProvider, VSCodeContextType } from './hooks/useVSCode';
import { ChatContainer } from './components/ChatContainer';
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
		// Handle authentication
		const urlParams = new URLSearchParams(window.location.search);

		// Init
		let uri = '';
		let token = '';

		// If we are in dev mode and we have the host address specified
		// in the .env put there by rsbuild, then use that
		if (API_CONFIG.devMode && API_CONFIG.ROCKETRIDE_URI) {
			// The uri was overridden by our .devMode = true and it being specified
			// in the .env file
			uri = API_CONFIG.ROCKETRIDE_URI;
			console.log('Got URI from API_CONFIG', uri);
		}

		// If we don't have a URI from the .env, use the one from where we loaded the page
		if (!uri) {
			uri = window.location.origin;
			console.log('Got URI from origin', uri);
		}

		// Try to get the token from session storage (skip in VSCode webview - shared storage would mix auth across tabs)
		if (!isVSCode) {
			token = sessionStorage.getItem('auth') || '';
			if (token) {
				console.log('Got token from session', token);
			}
		}

		// If we don't have a token yet
		if (!token) {
			// See if we can get from the .env if we are in dev mode
			if (API_CONFIG.devMode && API_CONFIG.ROCKETRIDE_APIKEY) {
				token = API_CONFIG.ROCKETRIDE_APIKEY;
				console.log('Got token from API_CONFIG', token);
			}
		}

		// If still do not have a token...
		if (!token) {
			// It has to be in the query string
			token = urlParams.get('auth') || '';

			// If we got it from the query string...
			if (token) {
				// Remove it so the user doesn't see it in the URL
				window.history.replaceState({}, "", window.location.pathname);
				console.log('Got token from urlParams', token);
			}
		}

		// Check these
		if (!uri) {
			throw new Error('Failed to start RocketRide client: No uri found');
		}
		if (!token) {
			throw new Error('Failed to start RocketRide client: No token found');
		}

		// Set the config
		setAPIConfig({
			ROCKETRIDE_APIKEY: token,
			ROCKETRIDE_URI: uri
		});

		// Start the client with persistent connection
		startClient(token).catch(error => {
			console.error('Failed to start client:', error);
		});

		// Save the token in session storage (skip in VSCode) and our state
		if (!isVSCode) {
			sessionStorage.setItem('auth', token);
		}
		setAuthToken(token);

		// Handle VSCode integration
		if (isVSCode) {
			// Listen for combined host and theme data from parent
			const handleVSCodeData = (event: MessageEvent) => {
				const message = event.data;

				if (message.type === 'vscodeData') {
					// Validate that we have both host and theme
					if (!message.theme) {
						console.error('[App] Invalid VSCode data - missing host or theme');
						return;
					}

					// Update VSCode state with received data
					setVscodeState({
						theme: message.theme,
						isVSCode: true,
						isReady: true
					});
				}
			};

			window.addEventListener('message', handleVSCodeData);

			// Send ready message to parent
			window.parent.postMessage({ type: 'ready' }, '*');

			return () => window.removeEventListener('message', handleVSCodeData);
		} else {
			// For non-VSCode environments, add loaded class immediately
			return undefined;
		}
	}, [isVSCode]);

	// CRITICAL: Absolutely do not render anything until ready
	if (!vscodeState.isReady) {
		return null;
	}

	return (
		<VSCodeProvider value={vscodeState}>
			<ThemeProvider>
				<ChatContainer authToken={authToken} />
			</ThemeProvider>
		</VSCodeProvider>
	);
};

export default App;
