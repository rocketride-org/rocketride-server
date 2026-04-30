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

/**
 * AuthWebview — authentication recovery page.
 *
 * Shown when a connection attempt fails with an AuthenticationException.
 * Renders the appropriate credential form based on connection mode:
 *   - cloud  → CloudPanel (PKCE sign-in)
 *   - onprem → host URL + API key
 *   - docker/service → API key
 *   - local  → informational message
 */

import React, { useState, CSSProperties } from 'react';
import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';
import { useMessaging } from '../hooks/useMessaging';
import { CloudPanel } from '../components/panels/CloudPanel';
import { settingsStyles as S } from '../PageSettings/SettingsWebview';

// =============================================================================
// TYPES
// =============================================================================

/** Messages sent from the extension host to this webview. */
interface IncomingMessage {
	type: string;
	connectionMode?: string;
	errorMessage?: string;
	hostUrl?: string;
	apiKey?: string;
	signedIn?: boolean;
	userName?: string;
	teams?: Array<{ id: string; name: string }>;
	level?: string;
	message?: string;
}

/** Messages sent from this webview to the extension host. */
interface OutgoingMessage {
	type: string;
	apiKey?: string;
	hostUrl?: string;
	teamId?: string;
	[key: string]: unknown;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		maxWidth: 560,
		margin: '40px auto',
		padding: '0 24px',
		display: 'flex',
		flexDirection: 'column',
		gap: 24,
	} as CSSProperties,
	errorBanner: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '12px 16px',
		borderRadius: 6,
		backgroundColor: 'var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1))',
		border: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
		color: 'var(--vscode-errorForeground, #f44336)',
		fontSize: 13,
	} as CSSProperties,
	title: {
		fontSize: 20,
		fontWeight: 600,
		margin: 0,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	saveButton: {
		width: 'auto',
		padding: '10px 24px',
		fontWeight: 600,
		alignSelf: 'flex-start',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

export const PageAuth: React.FC = () => {
	// ── State ────────────────────────────────────────────────────────────────
	const [connectionMode, setConnectionMode] = useState<string>('cloud');
	const [errorMessage, setErrorMessage] = useState<string>('Authentication failed');
	const [hostUrl, setHostUrl] = useState<string>('');
	const [apiKey, setApiKey] = useState<string>('');
	const [showApiKey, setShowApiKey] = useState(false);

	// Cloud auth state
	const [cloudSignedIn, setCloudSignedIn] = useState(false);
	const [cloudUserName, setCloudUserName] = useState('');
	const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
	const [selectedTeamId, setSelectedTeamId] = useState('');

	// ── Messaging ────────────────────────────────────────────────────────────
	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (message) => {
			switch (message.type) {
				case 'init':
					if (message.connectionMode) setConnectionMode(message.connectionMode);
					if (message.errorMessage) setErrorMessage(message.errorMessage);
					if (message.hostUrl) setHostUrl(message.hostUrl);
					if (message.apiKey) setApiKey(message.apiKey);
					break;

				case 'cloud:status':
					setCloudSignedIn(message.signedIn ?? false);
					setCloudUserName(message.userName ?? '');
					break;

				case 'teamsLoaded':
					setTeams(message.teams ?? []);
					break;

				case 'showMessage':
					// Could display inline, for now just log
					console.log(`[Auth] ${message.level}: ${message.message}`);
					break;
			}
		},
	});

	// ── Handlers ─────────────────────────────────────────────────────────────
	const handleCloudSignIn = () => sendMessage({ type: 'cloud:signIn' });
	const handleCloudSignOut = () => sendMessage({ type: 'cloud:signOut' });
	const handleTeamChange = (teamId: string) => {
		setSelectedTeamId(teamId);
		sendMessage({ type: 'setDevelopmentTeam', teamId });
	};

	/** Save credentials and trigger reconnect. */
	const handleSave = () => {
		sendMessage({ type: 'saveCredentials', apiKey, hostUrl });
	};

	// ── Render ───────────────────────────────────────────────────────────────
	return (
		<div style={styles.container}>
			{/* Title */}
			<h2 style={styles.title}>Authentication Required</h2>

			{/* Error banner */}
			<div style={styles.errorBanner}>
				<span style={{ fontSize: 18 }}>&#9888;</span>
				<span>{errorMessage}</span>
			</div>

			{/* Mode-specific credential form */}
			<div style={{ ...S.modeConfigBox, padding: 20 }}>
				{connectionMode === 'cloud' && <CloudPanel idPrefix="auth" cloudSignedIn={cloudSignedIn} cloudUserName={cloudUserName} onCloudSignIn={handleCloudSignIn} onCloudSignOut={handleCloudSignOut} teams={teams} selectedTeamId={selectedTeamId} onTeamChange={handleTeamChange} />}

				{connectionMode === 'onprem' && (
					<>
						<div style={S.sectionDescription}>Update your server URL and API key to reconnect.</div>

						{/* Host URL */}
						<div style={S.formGroup}>
							<label htmlFor="auth-hostUrl" style={S.label}>
								Host URL
							</label>
							<input type="text" id="auth-hostUrl" placeholder="your-server:5565" value={hostUrl} onChange={(e) => setHostUrl(e.target.value)} />
							<div style={S.helpText}>Base URL of your hosted RocketRide server</div>
						</div>

						{/* API Key */}
						{renderApiKeyField()}

						{/* Save button */}
						<button type="button" onClick={handleSave} style={styles.saveButton}>
							Save &amp; Connect
						</button>
					</>
				)}

				{(connectionMode === 'docker' || connectionMode === 'service') && (
					<>
						<div style={S.sectionDescription}>Update your API key to reconnect.</div>

						{/* API Key */}
						{renderApiKeyField()}

						{/* Save button */}
						<button type="button" onClick={handleSave} style={styles.saveButton}>
							Save &amp; Connect
						</button>
					</>
				)}

				{connectionMode === 'local' && <div style={S.sectionDescription}>Local mode authentication failed unexpectedly. Try restarting the local engine or check the Output panel (RocketRide: Extension) for details.</div>}
			</div>
		</div>
	);

	// ── Helpers ──────────────────────────────────────────────────────────────

	/** Renders the API key input with show/hide toggle. */
	function renderApiKeyField() {
		return (
			<div style={S.formGroup}>
				<label htmlFor="auth-apiKey" style={S.label}>
					API Key
				</label>
				<div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
					<input type={showApiKey ? 'text' : 'password'} id="auth-apiKey" placeholder="Enter your API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ flex: 1 }} />
					<button
						type="button"
						onClick={() => setShowApiKey(!showApiKey)}
						title={showApiKey ? 'Hide API key' : 'Show API key'}
						style={{
							backgroundColor: 'var(--vscode-button-secondaryBackground)',
							color: 'var(--vscode-button-secondaryForeground)',
							border: '1px solid var(--rr-border-input)',
							padding: '8px 12px',
							borderRadius: 4,
							cursor: 'pointer',
							fontSize: 20,
							minWidth: 44,
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
						}}
					>
						{showApiKey ? '\u{1F648}' : '\u{1F50D}'}
					</button>
				</div>
				<div style={S.helpText}>API key is saved securely.</div>
			</div>
		);
	}
};
