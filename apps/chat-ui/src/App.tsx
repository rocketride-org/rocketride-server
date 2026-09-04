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
import {
	getChatHostCapabilities,
	getEmbeddedClipboardCommand,
	getSanitizedChatPath,
	getSelectedClipboardText,
	isClipboardTextControl,
	selectAllChatContent,
	type EmbeddedClipboardCommand,
} from './clipboardBridge';

const App: React.FC = () => {
	// A top-level webview can use the editor theme directly. Pipeline Chat is a
	// nested HTTP iframe instead, so it uses an explicit marker only for the
	// parent clipboard bridge and keeps the existing RocketRide theme.
	const [{ isVSCode, isEmbeddedVSCode }] = useState(() =>
		getChatHostCapabilities('acquireVsCodeApi' in window, window.location.search)
	);
	const [authToken, setAuthToken] = useState<string | null>(null);

	// Initialize VSCode state
	const [vscodeState, setVscodeState] = useState<VSCodeContextType>(() => {
		if (!isVSCode) {
			// Dummy state for non-VSCode mode
			return {
				theme: null,
				isVSCode: false,
				isEmbeddedVSCode,
				isReady: true,
			};
		} else {
			// VSCode mode - not ready yet
			return {
				theme: null,
				isVSCode: true,
				isEmbeddedVSCode,
				isReady: false,
			};
		}
	});

	// Handle clipboard commands relayed by the VS Code/Cursor extension host.
	useEffect(() => {
		if (!isEmbeddedVSCode) return;

		const selectTranscript = () => {
			const transcript = document.querySelector('[data-chat-transcript]');
			const selection = window.getSelection();
			if (!transcript || !selection) return false;

			const range = document.createRange();
			range.selectNodeContents(transcript);
			selection.removeAllRanges();
			selection.addRange(range);
			return true;
		};

		const runClipboardCommand = (
			command: Exclude<EmbeddedClipboardCommand, 'paste'>,
			preventDefault?: () => void
		) => {
			const activeElement = document.activeElement;
			if (command === 'selectAll') {
				preventDefault?.();
				selectAllChatContent(activeElement, selectTranscript);
				return;
			}

			// ChatInput owns controlled-input mutation for Cut. The App handles
			// transcript Cut as a safe, non-destructive copy.
			if (command === 'cut' && isClipboardTextControl(activeElement)) return;

			const text = getSelectedClipboardText(activeElement, window.getSelection()?.toString() ?? '');
			if (text) {
				preventDefault?.();
				window.parent.postMessage({ type: 'copyText', text }, '*');
			}
		};

		const handleClipboardCommand = (event: MessageEvent) => {
			if (event.source !== window.parent) return;

			const command = event.data?.type === 'clipboardCommand' ? event.data.command : undefined;
			if (command !== 'copy' && command !== 'cut' && command !== 'selectAll') return;
			runClipboardCommand(command);
		};

		const handleClipboardKeyDown = (event: KeyboardEvent) => {
			const command = getEmbeddedClipboardCommand(event);
			if (!command || command === 'paste') return;
			runClipboardCommand(command, () => event.preventDefault());
		};

		window.addEventListener('message', handleClipboardCommand);
		document.addEventListener('keydown', handleClipboardKeyDown);
		return () => {
			window.removeEventListener('message', handleClipboardCommand);
			document.removeEventListener('keydown', handleClipboardKeyDown);
		};
	}, [isEmbeddedVSCode]);

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
		}

		// If we don't have a URI from the .env, use the one from where we loaded the page
		if (!uri) {
			uri = window.location.origin;
		}

		// URL param always wins — it carries the freshly-minted pk for the
		// current task and must not be shadowed by a stale sessionStorage value
		// left over from a previous task on the same origin.
		token = urlParams.get('auth') || '';
		if (token) {
			window.history.replaceState(
				{},
				'',
				getSanitizedChatPath(window.location.pathname, window.location.search)
			);
		} else if (!isVSCode) {
			// Fall back to session storage (skip in VSCode webview - shared storage would mix auth across tabs)
			token = sessionStorage.getItem('auth') || '';
		}
		if (!token && API_CONFIG.devMode && API_CONFIG.ROCKETRIDE_APIKEY) {
			token = API_CONFIG.ROCKETRIDE_APIKEY;
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
			ROCKETRIDE_URI: uri,
		});

		// Start the client with persistent connection
		startClient(token).catch((error) => {
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
						isEmbeddedVSCode,
						isReady: true,
					});
				}
			};

			window.addEventListener('message', handleVSCodeData);

			// Send ready message to parent
			window.parent.postMessage({ type: 'view:ready' }, '*');

			return () => window.removeEventListener('message', handleVSCodeData);
		} else {
			// For non-VSCode environments, add loaded class immediately
			return undefined;
		}
	}, [isEmbeddedVSCode, isVSCode]);

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
