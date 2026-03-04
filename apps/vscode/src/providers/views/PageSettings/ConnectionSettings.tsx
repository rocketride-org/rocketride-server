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
import { MessageData, SettingsData, EngineVersionItem } from './PageSettings';

interface ConnectionSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
	onClearCredentials: () => void;
	onTestDevelopmentConnection: () => void;
	onTestDeployEndpoint: () => void;
	developmentTestMessage: MessageData | null;
	deployTestMessage: MessageData | null;
	engineVersions: EngineVersionItem[];
	engineVersionsLoading: boolean;
}

export const ConnectionSettings: React.FC<ConnectionSettingsProps> = ({
	settings,
	onSettingsChange,
	onClearCredentials,
	onTestDevelopmentConnection,
	onTestDeployEndpoint,
	developmentTestMessage,
	deployTestMessage,
	engineVersions,
	engineVersionsLoading
}) => {
	const [showApiKey, setShowApiKey] = useState(false);

	const handleConnectionModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const mode = e.target.value as 'cloud' | 'onprem' | 'local';
		const updates: Partial<SettingsData> = { connectionMode: mode };

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
		}

		onSettingsChange(updates);
	};

	const handleHostUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ hostUrl: e.target.value });
	};

	const handleLocalPortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const port = e.target.value.trim();
		if (port === '' || /^\d+$/.test(port)) {
			onSettingsChange({ hostUrl: port ? `http://localhost:${port}` : 'http://localhost:5565' });
		}
	};

	// Derive local port from hostUrl for display (e.g. http://localhost:5565 -> 5565)
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

	const handleDeployUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ deployUrl: e.target.value });
	};

	const handleAutoConnectChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ autoConnect: e.target.checked });
	};

	// Engine version and arguments handlers (local mode)
	const handleVersionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		onSettingsChange({ localEngineVersion: e.target.value });
	};

	const displayVersion = (tagName: string): string => {
		return tagName.replace(/^server-/, '');
	};

	const handleArgChange = (index: number, value: string) => {
		const newArgs = [...settings.localEngineArgs];
		newArgs[index] = value;
		onSettingsChange({ localEngineArgs: newArgs });
	};

	const addArgument = () => {
		onSettingsChange({
			localEngineArgs: [...settings.localEngineArgs, '']
		});
	};

	const removeArgument = (index: number) => {
		const newArgs = settings.localEngineArgs.filter((_, i) => i !== index);
		onSettingsChange({ localEngineArgs: newArgs });
	};

	const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({
			apiKey: e.target.value,
			hasApiKey: e.target.value.trim().length > 0
		});
	};

	const toggleApiKeyVisibility = () => {
		setShowApiKey(!showApiKey);
	};

	const needsApiKey = settings.connectionMode === 'cloud' || settings.connectionMode === 'onprem';
	const showAccountWarning = needsApiKey && !settings.apiKey.trim();

	return (
		<>
			{/* RocketRide account – one login for development (cloud) and deployment */}
			<div className={`section ${showAccountWarning ? 'warning' : ''}`} id="accountSection">
				<div className="section-title">RocketRide account</div>
				<div className="section-description">
					Log in to your RocketRide.ai account. This key is used for development (Cloud and On-prem) and for deployment.
				</div>
				<div className="form-grid">
					<div className="form-group" id="apiKeyGroup">
						<label htmlFor="apiKey">API Key</label>
						<div className="password-input-container">
							<input
								type={showApiKey ? 'text' : 'password'}
								id="apiKey"
								placeholder="Enter your API key"
								value={settings.apiKey}
								onChange={handleApiKeyChange}
							/>
							<button
								type="button"
								className="password-toggle"
								onClick={toggleApiKeyVisibility}
								title={showApiKey ? 'Hide API key' : 'Show API key'}
							>
								{showApiKey ? '🙈' : '👁'}
							</button>
							{settings.apiKey.trim() && (
								<button
									type="button"
									onClick={onClearCredentials}
									className="small"
									title="Clear stored API key"
								>
									Clear
								</button>
							)}
						</div>
						<div className="help-text">
							API key is saved securely when you save settings. Required for cloud development and for deployment.
						</div>
					</div>
				</div>
			</div>

			{/* Development – where you run and debug (local or remote) */}
			<div className="section" id="developmentSection">
				<div className="section-title">Development connection</div>
				<div className="section-description">
					Where the extension connects to run and debug pipelines. Can be a local engine or a remote RocketRide server.
				</div>
				<div className="form-grid">
					<div className="form-group">
						<label htmlFor="connectionMode">Connection mode</label>
						<select
							id="connectionMode"
							value={settings.connectionMode}
							onChange={handleConnectionModeChange}
						>
							<option value="cloud">Cloud (RocketRide.ai cloud)</option>
							<option value="onprem">On-prem (your own hosted server)</option>
							<option value="local">Local (your local machine)</option>
						</select>
						<div className="help-text">Choose where your engine runs for development</div>
					</div>
						{settings.connectionMode === 'onprem' && (
						<div className="form-group">
							<label htmlFor="hostUrl">Host URL</label>
							<input
								type="text"
								id="hostUrl"
								placeholder="your-server:5565"
								value={settings.hostUrl}
								onChange={handleHostUrlChange}
							/>
							<div className="help-text">Base URL of your hosted RocketRide server (e.g. myserver:5565)</div>
						</div>
					)}
					{settings.connectionMode === 'local' && (
						<>
							<div className="form-group">
								<label htmlFor="localPort">Port</label>
								<input
									type="text"
									inputMode="numeric"
									id="localPort"
									placeholder="5565"
									value={localPort}
									onChange={handleLocalPortChange}
								/>
								<div className="help-text">Port to connect to on your local machine (e.g. 5565)</div>
							</div>
							<div className="form-group">
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
								<div className="help-text">Choose which engine version to download. &lt;Latest&gt; gets the newest stable release.</div>
							</div>
							<div className="form-group">
								<label>Engine Arguments</label>
								<div className="args-container">
									{settings.localEngineArgs.map((arg, index) => (
										<div key={index} className="arg-item">
											<input
												type="text"
												value={arg}
												placeholder="--argument"
												onChange={(e) => handleArgChange(index, e.target.value)}
											/>
											<button
												type="button"
												className="secondary small"
												onClick={() => removeArgument(index)}
											>
												Remove
											</button>
										</div>
									))}
								</div>
								<button
									onClick={addArgument}
									className="secondary small"
								>
									Add Argument
								</button>
								<div className="help-text">Additional command-line arguments for the engine</div>
							</div>
						</>
					)}
					{settings.connectionMode !== 'local' && (
						<div className="form-group">
							<label htmlFor="autoConnect">Auto-connect on startup</label>
							<div>
								<input
									type="checkbox"
									id="autoConnect"
									checked={settings.autoConnect}
									onChange={handleAutoConnectChange}
								/>
								<label htmlFor="autoConnect">Automatically connect when VS Code starts</label>
							</div>
							<div className="help-text">Enable to connect automatically on startup</div>
						</div>
					)}
					{settings.connectionMode !== 'local' && (
						<>
							<div className="form-group form-group-test">
								<button
									type="button"
									className="secondary"
									onClick={onTestDevelopmentConnection}
									title="Test connection to the development server"
								>
									Test connection
								</button>
								<div className="help-text">Verify the development server URL and credentials</div>
							</div>
							{developmentTestMessage && (
								<div className={`message message-inline ${developmentTestMessage.level}`}>
									{developmentTestMessage.message}
								</div>
							)}
						</>
					)}
				</div>
			</div>

			{/* Deployment – where pipelines are sent when you deploy */}
			<div className="section" id="deploymentSection">
				<div className="section-title">Deployment connection</div>
				<div className="section-description">
					You can deploy to RocketRide.ai cloud or on-prem using Docker. Set the endpoint URL for deployment (can differ from the development connection).
				</div>
				<div className="form-grid">
					<div className="form-group">
						<label htmlFor="deployUrl">Deploy API URL</label>
						<input
							type="text"
							id="deployUrl"
							placeholder="https://cloud.rocketride.ai"
							value={settings.deployUrl ?? ''}
							onChange={handleDeployUrlChange}
						/>
						<div className="help-text">Base URL of the deploy API (usually RocketRide cloud)</div>
					</div>
					<div className="form-group form-group-test">
						<button
							type="button"
							className="secondary"
							onClick={onTestDeployEndpoint}
							title="Test connection to the deploy endpoint"
						>
							Test deploy endpoint
						</button>
						<div className="help-text">Verify the deploy endpoint and account access</div>
					</div>
					{deployTestMessage && (
						<div className={`message message-inline ${deployTestMessage.level}`}>
							{deployTestMessage.message}
						</div>
					)}
				</div>
			</div>
		</>
	);
};
