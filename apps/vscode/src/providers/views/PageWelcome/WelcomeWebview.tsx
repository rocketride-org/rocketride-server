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

import React, { useState, CSSProperties } from 'react';
import { useMessaging } from '../hooks/useMessaging';

import 'shared/themes/rocketride-default.css';
import 'shared/themes/rocketride-vscode.css';
import '../../styles/root.css';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

interface WelcomeSettings {
	connectionMode: 'cloud' | 'onprem' | 'local';
	hostUrl: string;
	apiKey: string;
	hasApiKey: boolean;
	autoAgentIntegration: boolean;
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

type IncomingMessage = { type: 'settingsLoaded'; settings: WelcomeSettings; logoDarkUri?: string; logoLightUri?: string } | { type: 'showMessage'; level: 'success' | 'error' | 'info' | 'warning'; message: string } | { type: 'engineVersionsLoaded'; versions: EngineVersionItem[] };

type OutgoingMessage = { type: 'view:ready' } | { type: 'saveAndConnect'; settings: WelcomeSettings } | { type: 'dismiss' } | { type: 'testConnection'; settings: WelcomeSettings } | { type: 'openSettings' } | { type: 'openExternal'; url: string } | { type: 'fetchEngineVersions' };

// =============================================================================
// MODE DESCRIPTIONS
// =============================================================================

const MODE_DESCRIPTIONS: Record<string, string> = {
	cloud: 'Connect to RocketRide.ai cloud. Requires an API key from your account dashboard.',
	onprem: 'Connect to your own hosted RocketRide server.',
	local: 'Run the server locally on your machine. The extension will download and manage the server for you.',
};

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	formGroup: {
		marginBottom: 20,
	} as CSSProperties,
	label: {
		display: 'block',
		fontSize: 12,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		marginBottom: 6,
	} as CSSProperties,
	help: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 4,
	} as CSSProperties,
	featureItem: {
		padding: '6px 0',
		color: 'rgba(255, 255, 255, 0.9)',
		fontSize: 12.5,
		display: 'flex',
		alignItems: 'center',
		gap: 10,
	} as CSSProperties,
	featureIcon: {
		color: 'rgba(255, 255, 255, 0.9)',
		fontSize: 14,
		width: 18,
		textAlign: 'center',
		flexShrink: 0,
	} as CSSProperties,
};

// =============================================================================
// MESSAGE STYLES
// =============================================================================

const MESSAGE_STYLES: Record<string, CSSProperties> = {
	success: {
		background: 'rgba(76, 175, 80, 0.15)',
		border: '1px solid rgba(76, 175, 80, 0.3)',
		color: '#4caf50',
	},
	error: {
		backgroundColor: 'var(--vscode-inputValidation-errorBackground)',
		color: 'var(--vscode-inputValidation-errorForeground)',
		border: '1px solid var(--vscode-inputValidation-errorBorder)',
	},
	info: {
		backgroundColor: 'var(--vscode-inputValidation-infoBackground)',
		color: 'var(--vscode-inputValidation-infoForeground)',
		border: '1px solid var(--vscode-inputValidation-infoBorder)',
	},
	warning: {
		backgroundColor: 'var(--vscode-inputValidation-warningBackground)',
		color: 'var(--vscode-inputValidation-warningForeground)',
		border: '1px solid var(--vscode-inputValidation-warningBorder)',
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

export const PageWelcome: React.FC = () => {
	const [settings, setSettings] = useState<WelcomeSettings>({
		connectionMode: 'local',
		hostUrl: 'http://localhost:5565',
		apiKey: '',
		hasApiKey: false,
		autoAgentIntegration: true,
		localEngineVersion: 'latest',
	});

	const [logoLightUri, setLogoLightUri] = useState<string | undefined>();
	const [showApiKey, setShowApiKey] = useState(false);
	const [message, setMessage] = useState<MessageData | null>(null);
	const [engineVersions, setEngineVersions] = useState<EngineVersionItem[]>([]);
	const [engineVersionsLoading, setEngineVersionsLoading] = useState(false);

	// Hover states for interactive elements
	const [hoveredLink, setHoveredLink] = useState<string | null>(null);

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
		},
	});

	// =========================================================================
	// HANDLERS
	// =========================================================================

	const handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const mode = e.target.value as WelcomeSettings['connectionMode'];
		const updates: Partial<WelcomeSettings> = { connectionMode: mode };

		if (mode === 'cloud') {
			updates.hostUrl = 'https://cloud.rocketride.ai';
		} else if (mode === 'onprem') {
			if (!settings.hostUrl || settings.hostUrl === 'https://cloud.rocketride.ai' || settings.hostUrl.startsWith('http://localhost:5565')) {
				updates.hostUrl = '';
			}
		} else if (mode === 'local') {
			setEngineVersionsLoading(true);
			sendMessage({ type: 'fetchEngineVersions' });
		}

		setSettings((prev) => ({ ...prev, ...updates }));
	};

	const handleVersionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		setSettings((prev) => ({ ...prev, localEngineVersion: e.target.value }));
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

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div
			style={{
				display: 'flex',
				maxWidth: 860,
				width: '100%',
				margin: '40px auto',
				border: '1px solid var(--rr-border)',
				borderRadius: 8,
				overflow: 'hidden',
				background: 'var(--rr-bg-default)',
			}}
		>
			{/* LEFT PANEL — Branding */}
			<div
				style={{
					width: 280,
					minWidth: 280,
					background: 'linear-gradient(180deg, #1a1a3a 0%, #252545 100%)',
					padding: '40px 30px',
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					borderRight: '1px solid var(--rr-border)',
				}}
			>
				<div
					style={{
						width: 100,
						height: 100,
						marginBottom: 20,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						fontSize: 56,
					}}
				>
					{logoLightUri ? <img src={logoLightUri} alt="RocketRide" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : '\u{1F680}'}
				</div>
				<div style={{ fontSize: 22, fontWeight: 700, color: '#ffffff', letterSpacing: 0.5, marginBottom: 4 }}>RocketRide</div>
				<div style={{ fontSize: 13, color: 'rgba(255, 255, 255, 0.75)', textAlign: 'center', marginBottom: 30, lineHeight: 1.6 }}>
					High-performance data processing
					<br />
					with AI/ML integration
				</div>

				<ul style={{ listStyle: 'none', width: '100%', margin: '0 0 30px', padding: 0 }}>
					<li style={styles.featureItem}>
						<span style={styles.featureIcon}>&#9670;</span> Visual pipeline editor
					</li>
					<li style={styles.featureItem}>
						<span style={styles.featureIcon}>&#9670;</span> High-performance C++ engine
					</li>
					<li style={styles.featureItem}>
						<span style={styles.featureIcon}>&#9670;</span> 50+ pipeline nodes with AI/ML
					</li>
					<li style={styles.featureItem}>
						<span style={styles.featureIcon}>&#9670;</span> Multi-agent workflows
					</li>
					<li style={styles.featureItem}>
						<span style={styles.featureIcon}>&#9670;</span> Tool and model agnostic
					</li>
					<li style={styles.featureItem}>
						<span style={styles.featureIcon}>&#9670;</span> TypeScript, Python &amp; MCP SDKs
					</li>
				</ul>

				<div style={{ width: '100%', height: 1, background: 'rgba(255, 255, 255, 0.2)', margin: '10px 0 20px' }} />

				<div style={{ display: 'flex', gap: 20, marginTop: 'auto' }}>
					<a
						href="#"
						style={{
							color: hoveredLink === 'docs' ? '#ffffff' : 'rgba(255, 255, 255, 0.75)',
							textDecoration: hoveredLink === 'docs' ? 'underline' : 'none',
							fontSize: 12,
						}}
						onMouseEnter={() => setHoveredLink('docs')}
						onMouseLeave={() => setHoveredLink(null)}
						onClick={(e) => {
							e.preventDefault();
							sendMessage({ type: 'openExternal', url: 'https://docs.rocketride.org' });
						}}
					>
						Documentation
					</a>
					<a
						href="#"
						style={{
							color: hoveredLink === 'discord' ? '#ffffff' : 'rgba(255, 255, 255, 0.75)',
							textDecoration: hoveredLink === 'discord' ? 'underline' : 'none',
							fontSize: 12,
						}}
						onMouseEnter={() => setHoveredLink('discord')}
						onMouseLeave={() => setHoveredLink(null)}
						onClick={(e) => {
							e.preventDefault();
							sendMessage({ type: 'openExternal', url: 'https://discord.gg/9hr3tdZmEG' });
						}}
					>
						Discord
					</a>
				</div>
			</div>

			{/* RIGHT PANEL — Configuration */}
			<div style={{ flex: 1, padding: '40px 36px', display: 'flex', flexDirection: 'column' }}>
				<h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--rr-text-primary)', margin: '0 0 6px' }}>Get Started</h2>
				<div style={{ fontSize: 12.5, color: 'var(--rr-text-secondary)', marginBottom: 28 }}>Configure your connection to start building pipelines.</div>

				{/* Connection Mode */}
				<div style={styles.formGroup}>
					<label htmlFor="connectionMode" style={styles.label}>
						Connection Mode
					</label>
					<select id="connectionMode" value={settings.connectionMode} onChange={handleModeChange}>
						<option value="cloud">Cloud (RocketRide.ai)</option>
						<option value="onprem">On-prem (your hosted server)</option>
						<option value="local">Local (your machine)</option>
					</select>
				</div>

				{/* Config box — description + mode-specific fields */}
				<div style={{ border: '1px solid var(--rr-border)', borderRadius: 6, padding: 16, marginBottom: 20 }}>
					<div style={{ fontSize: 11.5, color: 'var(--rr-text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>{MODE_DESCRIPTIONS[settings.connectionMode]}</div>

					{/* Coming Soon — Cloud */}
					{isCloud && (
						<div style={{ textAlign: 'center', padding: '24px 20px' }}>
							<div style={{ fontSize: 40, marginBottom: 12, opacity: 0.6 }}>&#9729;</div>
							<div style={{ fontSize: 16, fontWeight: 600, color: 'var(--rr-text-primary)', marginBottom: 8, letterSpacing: 0.5 }}>Coming Soon</div>
							<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.6 }}>
								RocketRide Cloud is under active development.
								<br />
								Stay tuned for managed cloud hosting with zero setup.
							</div>
						</div>
					)}

					{/* API Key — On-prem */}
					{needsApiKey && (
						<div style={styles.formGroup}>
							<label htmlFor="apiKey" style={styles.label}>
								API Key
							</label>
							<div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
								<input
									type={showApiKey ? 'text' : 'password'}
									id="apiKey"
									placeholder="Enter your API key"
									value={settings.apiKey}
									style={{ flex: 1 }}
									onChange={(e) =>
										setSettings((prev) => ({
											...prev,
											apiKey: e.target.value,
											hasApiKey: e.target.value.trim().length > 0,
										}))
									}
								/>
								<button type="button" className="secondary small" onClick={() => setShowApiKey(!showApiKey)}>
									{showApiKey ? 'Hide' : 'Show'}
								</button>
							</div>
							<div style={styles.help}>
								Get your API key from{' '}
								<a href="https://cloud.rocketride.ai" target="_blank" rel="noopener" style={{ color: 'var(--rr-text-link)', textDecoration: 'none' }}>
									cloud.rocketride.ai
								</a>
							</div>
						</div>
					)}

					{/* Host URL — On-prem */}
					{settings.connectionMode === 'onprem' && (
						<div style={styles.formGroup}>
							<label htmlFor="hostUrl" style={styles.label}>
								Host URL
							</label>
							<input type="text" id="hostUrl" placeholder="your-server:5565" value={settings.hostUrl} onChange={(e) => setSettings((prev) => ({ ...prev, hostUrl: e.target.value }))} />
							<div style={styles.help}>Base URL of your hosted RocketRide server</div>
						</div>
					)}

					{/* Server Version — Local */}
					{settings.connectionMode === 'local' && (
						<div style={{ marginBottom: 0 }}>
							<label htmlFor="engineVersion" style={styles.label}>
								Server Version
							</label>
							<select id="engineVersion" value={settings.localEngineVersion} onChange={handleVersionChange} disabled={engineVersionsLoading}>
								<option value="latest">&lt;Latest&gt;</option>
								<option value="prerelease">&lt;Prerelease&gt;</option>
								{engineVersions.length > 0 && <option disabled>{'────────────────'}</option>}
								{engineVersionsLoading && <option disabled>Loading versions...</option>}
								{engineVersions.map((v) => (
									<option key={v.tag_name} value={v.tag_name}>
										{displayVersion(v.tag_name)}
										{v.prerelease ? ' (pre)' : ''}
									</option>
								))}
							</select>
							<div style={styles.help}>Choose which server version to download.</div>
						</div>
					)}
				</div>

				{/* Agent integration */}
				<div style={{ ...styles.formGroup, display: 'flex', alignItems: 'center', gap: 8 }}>
					<input type="checkbox" id="autoAgentIntegration" checked={settings.autoAgentIntegration} style={{ width: 'auto', margin: 0 }} onChange={(e) => setSettings((prev) => ({ ...prev, autoAgentIntegration: e.target.checked }))} />
					<label htmlFor="autoAgentIntegration" style={{ fontWeight: 400, marginBottom: 0, fontSize: 12.5, color: 'var(--rr-text-primary)' }}>
						Automatic Agent Integration
					</label>
				</div>
				<div style={{ ...styles.help, marginTop: -8, marginBottom: 12 }}>Automatically install RocketRide documentation for detected coding agents (Copilot, Claude Code, Cursor, Windsurf)</div>

				{/* Message area */}
				{message && (
					<div
						style={{
							marginTop: 12,
							padding: '8px 12px',
							borderRadius: 4,
							fontSize: 12,
							...MESSAGE_STYLES[message.level],
						}}
					>
						{message.message}
					</div>
				)}

				{/* Action buttons */}
				<div style={{ display: 'flex', gap: 10, marginTop: 24, alignItems: 'center' }}>
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
				<div style={{ display: 'flex', gap: 24, marginTop: 20 }}>
					<a
						href="#"
						style={{
							color: 'var(--rr-text-link)',
							textDecoration: hoveredLink === 'settings' ? 'underline' : 'none',
							fontSize: 12,
						}}
						onMouseEnter={() => setHoveredLink('settings')}
						onMouseLeave={() => setHoveredLink(null)}
						onClick={(e) => {
							e.preventDefault();
							sendMessage({ type: 'openSettings' });
						}}
					>
						Advanced Settings
					</a>
					<a
						href="#"
						style={{
							color: 'var(--rr-text-secondary)',
							textDecoration: hoveredLink === 'dismiss' ? 'underline' : 'none',
							fontSize: 12,
						}}
						onMouseEnter={() => setHoveredLink('dismiss')}
						onMouseLeave={() => setHoveredLink(null)}
						onClick={(e) => {
							e.preventDefault();
							sendMessage({ type: 'dismiss' });
						}}
					>
						Dismiss
					</a>
				</div>

				<div style={{ fontSize: 11, color: 'var(--rr-text-secondary)', marginTop: 'auto', paddingTop: 16, textAlign: 'right' }}>v1.0.0</div>
			</div>
		</div>
	);
};
