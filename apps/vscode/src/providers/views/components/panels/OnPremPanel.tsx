// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * OnPremPanel — target panel for On-prem connection mode.
 *
 * Renders: host URL, API key with show/hide toggle, optional test-connection
 * button, debug output checkbox.
 * Used by ConnectionSettings (dev) and DeployTargetSettings (deploy).
 */

import React, { useState } from 'react';
import { MessageData, settingsStyles as S } from '../../PageSettings/SettingsWebview';
import { MessageDisplay } from '../../PageSettings/MessageDisplay';

// =============================================================================
// TYPES
// =============================================================================

export interface OnPremPanelProps {
	hostUrl: string;
	onHostUrlChange: (url: string) => void;
	apiKey: string;
	onApiKeyChange: (key: string) => void;
	onClearApiKey?: () => void;
	debugOutput: boolean;
	onDebugOutputChange: (checked: boolean) => void;
	onTestConnection?: () => void;
	testMessage?: MessageData | null;
	idPrefix: string;
	simplified?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const OnPremPanel: React.FC<OnPremPanelProps> = ({ hostUrl, onHostUrlChange, apiKey, onApiKeyChange, onClearApiKey, debugOutput, onDebugOutputChange, onTestConnection, testMessage, idPrefix }) => {
	const [showApiKey, setShowApiKey] = useState(false);
	const [passwordToggleHover, setPasswordToggleHover] = useState(false);
	const id = (name: string) => `${idPrefix}-${name}`;

	return (
		<>
			<div style={S.modeConfigDesc}>Connect to your own hosted RocketRide server.</div>

			{/* Host URL */}
			<div style={S.formGroup}>
				<label htmlFor={id('hostUrl')} style={S.label}>
					Host URL
				</label>
				<input type="text" id={id('hostUrl')} placeholder="your-server:5565" value={hostUrl} onChange={(e) => onHostUrlChange(e.target.value)} />
				<div style={S.helpText}>Base URL of your hosted RocketRide server (e.g. myserver:5565)</div>
			</div>

			{/* API key */}
			<div style={S.formGroup} id={id('apiKeyGroup')}>
				<label htmlFor={id('apiKey')} style={S.label}>
					API Key
				</label>
				<div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
					<input type={showApiKey ? 'text' : 'password'} id={id('apiKey')} placeholder="Enter your API key" value={apiKey} onChange={(e) => onApiKeyChange(e.target.value)} style={{ flex: 1 }} />
					<button
						type="button"
						onClick={() => setShowApiKey(!showApiKey)}
						title={showApiKey ? 'Hide API key' : 'Show API key'}
						onMouseEnter={() => setPasswordToggleHover(true)}
						onMouseLeave={() => setPasswordToggleHover(false)}
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
							transition: 'all 0.2s',
							...(passwordToggleHover
								? {
										backgroundColor: 'var(--vscode-button-secondaryHoverBackground)',
										borderColor: 'var(--rr-border-focus)',
									}
								: {}),
						}}
					>
						{showApiKey ? '\u{1F648}' : '\u{1F50D}'}
					</button>
					{apiKey.trim() && onClearApiKey && (
						<button type="button" onClick={onClearApiKey} title="Clear stored API key" style={{ padding: '6px 12px', fontSize: 12 }}>
							Clear
						</button>
					)}
				</div>
				<div style={S.helpText}>API key is saved securely when you save settings.</div>
			</div>

			{/* Debug output */}
			<div style={S.formGroup}>
				<div>
					<input type="checkbox" id={id('debugOutput')} checked={debugOutput} onChange={(e) => onDebugOutputChange(e.target.checked)} style={{ marginRight: 8, verticalAlign: 'middle' }} />
					<label htmlFor={id('debugOutput')} style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
						Full debug output
					</label>
				</div>
				<div style={S.helpText}>Enable detailed server trace logging (see Output&#8594;RocketRide: Console)</div>
			</div>

			{/* Test connection */}
			{onTestConnection && (
				<div style={{ ...S.formGroup, alignItems: 'flex-end' }}>
					<button
						type="button"
						onClick={onTestConnection}
						title="Test connection to the server"
						style={{
							width: 'auto',
							backgroundColor: 'var(--vscode-button-secondaryBackground)',
							color: 'var(--vscode-button-secondaryForeground)',
						}}
					>
						Test connection
					</button>
					<div style={S.helpText}>Verify the server URL and credentials</div>
				</div>
			)}
			{testMessage && <MessageDisplay message={testMessage} inline />}
		</>
	);
};
