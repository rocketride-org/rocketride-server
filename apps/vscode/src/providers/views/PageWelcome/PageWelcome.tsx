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

import React, { useState } from 'react';
import { useMessaging } from '../../../shared/util/useMessaging';

import '../../styles/vscode.css';
import '../../styles/app.css';
import './styles.css';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface WelcomeSettings {
	connectionMode: 'cloud' | 'onprem' | 'local';
	hostUrl: string;
	apiKey: string;
	hasApiKey: boolean;
	autoConnect: boolean;
	localEngineVersion: string;
}

interface EngineVersionItem {
	tag_name: string;
	prerelease: boolean;
}

interface MessageData {
	level: 'success' | 'error' | 'info' | 'warning';
	message: string;
}

type IncomingMessage =
	| { type: 'settingsLoaded'; settings: WelcomeSettings; logoDarkUri?: string; logoLightUri?: string }
	| { type: 'showMessage'; level: 'success' | 'error' | 'info' | 'warning'; message: string }
	| { type: 'engineVersionsLoaded'; versions: EngineVersionItem[] };

type OutgoingMessage =
	| { type: 'ready' }
	| { type: 'saveAndConnect'; settings: WelcomeSettings }
	| { type: 'dismiss' }
	| { type: 'testConnection'; settings: WelcomeSettings }
	| { type: 'openSettings' }
	| { type: 'openExternal'; url: string }
	| { type: 'fetchEngineVersions' };

// ============================================================================
// MODE DESCRIPTIONS
// ============================================================================

const MODE_DESCRIPTIONS: Record<string, string> = {
	cloud: 'Connect to RocketRide.ai cloud. Requires an API key from your account dashboard.',
	onprem: 'Connect to your own hosted RocketRide server.',
	local: 'Run the engine locally on your machine. The extension will download and manage the engine for you.'
};

// ============================================================================
// COMPONENT
// ============================================================================

export const PageWelcome: React.FC = () => {
	const [settings, setSettings] = useState<WelcomeSettings>({
		connectionMode: 'local',
		hostUrl: 'http://localhost:5565',
		apiKey: '',
		hasApiKey: false,
		autoConnect: true,
		localEngineVersion: 'prerelease',
	});

	const [logoLightUri, setLogoLightUri] = useState<string | undefined>();
	const [showApiKey, setShowApiKey] = useState(false);
	const [message, setMessage] = useState<MessageData | null>(null);
	const [engineVersions, setEngineVersions] = useState<EngineVersionItem[]>([]);
	const [engineVersionsLoading, setEngineVersionsLoading] = useState(false);

	const { sendMessage } = useMessaging<OutgoingMessage, IncomingMessage>({
		onMessage: (msg) => {
			switch (msg.type) {
				case 'settingsLoaded':
					setSettings(msg.settings);
					if (msg.logoLightUri) setLogoLightUri(msg.logoLightUri);
					if (msg.settings.connectionMode === 'local') {
						setEngineVersionsLoading(true);
						sendMessage({ type: 'fetchEngineVersions' });
					}
					break;

				case 'showMessage': {
					const data = { level: msg.level, message: msg.message };
					setMessage(data);
					if (msg.level === 'success') {
						setTimeout(() => setMessage(null), 5000);
					}
					break;
				}

				case 'engineVersionsLoaded':
					setEngineVersions(msg.versions);
					setEngineVersionsLoading(false);
					break;
			}
		}
	});

	// ========================================================================
	// HANDLERS
	// ========================================================================

	const handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const mode = e.target.value as WelcomeSettings['connectionMode'];
		const updates: Partial<WelcomeSettings> = { connectionMode: mode };

		if (mode === 'cloud') {
			updates.hostUrl = 'https://cloud.rocketride.ai';
		} else if (mode === 'onprem') {
			if (!settings.hostUrl || settings.hostUrl === 'https://cloud.rocketride.ai' || settings.hostUrl.startsWith('http://localhost')) {
				updates.hostUrl = '';
			}
		} else if (mode === 'local') {
			if (!settings.hostUrl || !settings.hostUrl.startsWith('http://localhost')) {
				updates.hostUrl = 'http://localhost:5565';
			}
			updates.autoConnect = true;
			setEngineVersionsLoading(true);
			sendMessage({ type: 'fetchEngineVersions' });
		}

		setSettings(prev => ({ ...prev, ...updates }));
	};

	const localPort = (() => {
		if (settings.connectionMode !== 'local' || !settings.hostUrl) return '5565';
		try {
			const u = new URL(settings.hostUrl);
			if (u.hostname === 'localhost' && u.port) return u.port;
			return u.port || '5565';
		} catch {
			return '5565';
		}
	})();

	const handleLocalPortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const port = e.target.value.trim();
		if (port === '' || /^\d+$/.test(port)) {
			setSettings(prev => ({
				...prev,
				hostUrl: port ? `http://localhost:${port}` : 'http://localhost:5565'
			}));
		}
	};

	const handleVersionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		setSettings(prev => ({ ...prev, localEngineVersion: e.target.value }));
	};

	const displayVersion = (tagName: string): string => tagName.replace(/^server-/, '');

	const handleSaveAndConnect = () => {
		sendMessage({ type: 'saveAndConnect', settings });
	};

	const handleTestConnection = () => {
		sendMessage({ type: 'testConnection', settings });
	};

	const isCloud = settings.connectionMode === 'cloud';
	const needsApiKey = settings.connectionMode === 'onprem';

	// ========================================================================
	// RENDER
	// ========================================================================

	return (
		<div className="welcome-container">
			{/* LEFT PANEL — Branding */}
			<div className="welcome-left">
				<div className="welcome-logo">
					{logoLightUri ? <img src={logoLightUri} alt="RocketRide" /> : '\u{1F680}'}
				</div>
				<div className="welcome-brand-name">RocketRide</div>
				<div className="welcome-tagline">
					High-performance data processing<br />
					with AI/ML integration
				</div>

				<ul className="welcome-features">
					<li><span className="welcome-feature-icon">&#9670;</span> Visual pipeline editor</li>
					<li><span className="welcome-feature-icon">&#9670;</span> High-performance C++ engine</li>
					<li><span className="welcome-feature-icon">&#9670;</span> 50+ pipeline nodes with AI/ML</li>
					<li><span className="welcome-feature-icon">&#9670;</span> Multi-agent workflows</li>
					<li><span className="welcome-feature-icon">&#9670;</span> Tool and model agnostic</li>
					<li><span className="welcome-feature-icon">&#9670;</span> TypeScript, Python &amp; MCP SDKs</li>
				</ul>

				<div className="welcome-divider" />

				<div className="welcome-links">
					<a href="#" onClick={(e) => { e.preventDefault(); sendMessage({ type: 'openExternal', url: 'https://docs.rocketride.org' }); }}>Documentation</a>
					<a href="#" onClick={(e) => { e.preventDefault(); sendMessage({ type: 'openExternal', url: 'https://discord.gg/9hr3tdZmEG' }); }}>Discord</a>
				</div>
			</div>

			{/* RIGHT PANEL — Configuration */}
			<div className="welcome-right">
				<h2>Get Started</h2>
				<div className="welcome-subtitle">Configure your connection to start building pipelines.</div>

				{/* Connection Mode */}
				<div className="welcome-form-group">
					<label htmlFor="connectionMode">Connection Mode</label>
					<select
						id="connectionMode"
						value={settings.connectionMode}
						onChange={handleModeChange}
					>
						<option value="cloud">Cloud (RocketRide.ai)</option>
						<option value="onprem">On-prem (your hosted server)</option>
						<option value="local">Local (your machine)</option>
					</select>
					<div className="welcome-mode-desc">
						{MODE_DESCRIPTIONS[settings.connectionMode]}
					</div>
				</div>

				{/* Coming Soon — Cloud */}
				{isCloud && (
					<div className="welcome-coming-soon">
						<div className="welcome-coming-soon-icon">&#9729;</div>
						<div className="welcome-coming-soon-title">Coming Soon</div>
						<div className="welcome-coming-soon-text">
							RocketRide Cloud is under active development.<br />
							Stay tuned for managed cloud hosting with zero setup.
						</div>
					</div>
				)}


				{/* API Key — On-prem */}
				{needsApiKey && (
					<div className="welcome-form-group">
						<label htmlFor="apiKey">API Key</label>
						<div className="welcome-password-row">
							<input
								type={showApiKey ? 'text' : 'password'}
								id="apiKey"
								placeholder="Enter your API key"
								value={settings.apiKey}
								onChange={(e) => setSettings(prev => ({
									...prev,
									apiKey: e.target.value,
									hasApiKey: e.target.value.trim().length > 0
								}))}
							/>
							<button
								type="button"
								className="secondary small"
								onClick={() => setShowApiKey(!showApiKey)}
							>
								{showApiKey ? 'Hide' : 'Show'}
							</button>
						</div>
						<div className="welcome-help">
							Get your API key from <a href="https://cloud.rocketride.ai" target="_blank" rel="noopener">cloud.rocketride.ai</a>
						</div>
					</div>
				)}

				{/* Host URL — On-prem */}
				{settings.connectionMode === 'onprem' && (
					<div className="welcome-form-group">
						<label htmlFor="hostUrl">Host URL</label>
						<input
							type="text"
							id="hostUrl"
							placeholder="your-server:5565"
							value={settings.hostUrl}
							onChange={(e) => setSettings(prev => ({ ...prev, hostUrl: e.target.value }))}
						/>
						<div className="welcome-help">Base URL of your hosted RocketRide server</div>
					</div>
				)}

				{/* Port — Local */}
				{settings.connectionMode === 'local' && (
					<>
						<div className="welcome-form-group">
							<label htmlFor="localPort">Port</label>
							<input
								type="text"
								inputMode="numeric"
								id="localPort"
								placeholder="5565"
								value={localPort}
								onChange={handleLocalPortChange}
								style={{ width: 120 }}
							/>
							<div className="welcome-help">Local engine port (default: 5565)</div>
						</div>

						<div className="welcome-form-group">
							<label htmlFor="engineVersion">Engine Version</label>
							<select
								id="engineVersion"
								value={settings.localEngineVersion}
								onChange={handleVersionChange}
								disabled={engineVersionsLoading}
							>
								<option value="latest">&lt;Latest&gt;</option>
								<option value="prerelease">&lt;Prerelease&gt;</option>
								{engineVersions.length > 0 && (
									<option disabled>{'────────────────'}</option>
								)}
								{engineVersionsLoading && (
									<option disabled>Loading versions...</option>
								)}
								{engineVersions.map(v => (
									<option key={v.tag_name} value={v.tag_name}>
										{displayVersion(v.tag_name)}{v.prerelease ? ' (pre)' : ''}
									</option>
								))}
							</select>
							<div className="welcome-help">Choose which engine version to download.</div>
						</div>
					</>
				)}

				{/* Auto-connect — on-prem only */}
				{settings.connectionMode === 'onprem' && (
					<div className="welcome-form-group welcome-checkbox-row">
						<input
							type="checkbox"
							id="autoConnect"
							checked={settings.autoConnect}
							onChange={(e) => setSettings(prev => ({ ...prev, autoConnect: e.target.checked }))}
						/>
						<label htmlFor="autoConnect">Auto-connect on startup</label>
					</div>
				)}

				{/* Message area */}
				{message && (
					<div className={`welcome-message ${message.level}`}>
						{message.message}
					</div>
				)}

				{/* Action buttons */}
				<div className="welcome-button-row">
					<button onClick={handleSaveAndConnect} disabled={isCloud}>
						Save &amp; Connect
					</button>
					{settings.connectionMode === 'onprem' && (
						<button className="secondary" onClick={handleTestConnection}>
							Test Connection
						</button>
					)}
				</div>

				{/* Footer links */}
				<div className="welcome-footer-links">
					<a href="#" onClick={(e) => { e.preventDefault(); sendMessage({ type: 'openSettings' }); }}>
						Advanced Settings
					</a>
					<a href="#" className="welcome-dismiss" onClick={(e) => { e.preventDefault(); sendMessage({ type: 'dismiss' }); }}>
						Dismiss
					</a>
				</div>

				<div className="welcome-version">v1.0.0</div>
			</div>
		</div>
	);
};
