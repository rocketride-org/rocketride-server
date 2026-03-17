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
	developmentTestMessage: MessageData | null;
	engineVersions: EngineVersionItem[];
	engineVersionsLoading: boolean;
}

export const ConnectionSettings: React.FC<ConnectionSettingsProps> = ({
	settings,
	onSettingsChange,
	onClearCredentials,
	onTestDevelopmentConnection,
	developmentTestMessage,
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
			updates.autoConnect = true;
		}

		onSettingsChange(updates);
	};

	const handleHostUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ hostUrl: e.target.value });
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

	const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({
			apiKey: e.target.value,
			hasApiKey: e.target.value.trim().length > 0
		});
	};

	const toggleApiKeyVisibility = () => {
		setShowApiKey(!showApiKey);
	};

	const showAccountWarning = settings.connectionMode === 'onprem' && !settings.apiKey.trim();

	return (
		<>
			{/* Development – where you run and debug (local or remote) */}
			<div className={`section ${showAccountWarning ? 'warning' : ''}`} id="developmentSection">
				<div className="section-title">Development connection</div>
				<div className="section-description">
					Where the extension connects to run and debug pipelines. Cloud and On-prem modes require a RocketRide API key.
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
						<div className="help-text">Choose where your server runs for development</div>
					</div>

					{/* Config box — description + mode-specific fields */}
					<div className="mode-config-box">

						{/* Cloud — Coming Soon */}
						{settings.connectionMode === 'cloud' && (
							<>
								<div className="mode-config-desc">Connect to RocketRide.ai cloud. Requires an API key from your account dashboard.</div>
								<div className="mode-coming-soon">
									<div className="mode-coming-soon-icon">&#9729;</div>
									<div className="mode-coming-soon-title">Coming Soon</div>
									<div className="mode-coming-soon-text">
										RocketRide Cloud is under active development.<br />
										Stay tuned for managed cloud hosting with zero setup.
									</div>
								</div>
							</>
						)}

						{/* On-prem */}
						{settings.connectionMode === 'onprem' && (
							<>
								<div className="mode-config-desc">Connect to your own hosted RocketRide server.</div>
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
											{showApiKey ? '🙈' : '🔍'}
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
								<div className="form-group">
									<label htmlFor="autoConnect">Auto-connect on startup</label>
									<div>
										<input
											type="checkbox"
											id="autoConnect"
											checked={settings.autoConnect}
											onChange={handleAutoConnectChange}
										/>
										<label htmlFor="autoConnect">Automatically connect when extension starts</label>
									</div>
									<div className="help-text">Enable to connect automatically on startup</div>
								</div>
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

						{/* Local */}
						{settings.connectionMode === 'local' && (
							<>
								<div className="mode-config-desc">Run the server locally on your machine. The extension will download and manage the server for you.</div>
								<div className="form-group">
									<label htmlFor="serverVersion">Server Version</label>
									<select
										id="serverVersion"
										value={settings.localEngineVersion}
										onChange={handleVersionChange}
										disabled={engineVersionsLoading}
									>
										<optgroup label="Recommended">
											<option value="latest">&lt;Latest&gt;</option>
											<option value="prerelease">&lt;Prerelease&gt;</option>
										</optgroup>
										<optgroup label={engineVersionsLoading ? 'Loading versions...' : 'All versions'}>
											{engineVersions.map(v => (
												<option key={v.tag_name} value={v.tag_name}>
													{displayVersion(v.tag_name)}
												</option>
											))}
										</optgroup>
									</select>
									<div className="help-text">Choose which server version to download. &lt;Latest&gt; gets the newest stable release.</div>
								</div>
								</>
						)}
					</div>

					{/* Debug — shown for local and on-prem modes */}
					{(settings.connectionMode === 'local' || settings.connectionMode === 'onprem') && (
						<div className="mode-config-box">
							<div className="form-group">
								<div>
									<input
										type="checkbox"
										id="localDebugOutput"
										checked={settings.localDebugOutput}
										onChange={(e) => onSettingsChange({ localDebugOutput: e.target.checked })}
									/>
									<label htmlFor="localDebugOutput">Full debug output</label>
								</div>
								<div className="help-text">Enable detailed server trace logging (see Output&#8594;RocketRide: Console)</div>
							</div>
							{settings.connectionMode === 'local' && (
								<div className="form-group">
									<label htmlFor="engineArgs">Server Arguments</label>
									<input
										type="text"
										id="engineArgs"
										value={settings.localEngineArgs}
										placeholder="--option=value --flag"
										onChange={(e) => onSettingsChange({ localEngineArgs: e.target.value })}
									/>
									<div className="help-text">Additional command-line arguments passed to the server</div>
								</div>
							)}
						</div>
					)}
				</div>
			</div>

		</>
	);
};
