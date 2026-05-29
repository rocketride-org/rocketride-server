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
import OnPremIcon from '../../../../assets/onprem.svg';
import { MessageData, settingsStyles as S } from '../../Settings/SettingsWebview';
import { MessageDisplay } from '../../Settings/MessageDisplay';

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
	onTestConnection?: (hostUrl: string, apiKey: string) => void;
	testMessage?: MessageData | null;
	idPrefix: string;
	simplified?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const OnPremPanel: React.FC<OnPremPanelProps> = ({ hostUrl, onHostUrlChange, apiKey, onApiKeyChange, onClearApiKey, debugOutput, onDebugOutputChange, onTestConnection, testMessage, idPrefix, simplified }) => {
	const [showApiKey, setShowApiKey] = useState(false);
	const [passwordToggleHover, setPasswordToggleHover] = useState(false);
	const id = (name: string) => `${idPrefix}-${name}`;

	return (
		<>
			<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
				<OnPremIcon role="img" aria-label="On-prem" style={{ width: 48, height: 48, flexShrink: 0 }} />
				<div style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>Connect directly to a RocketRide server using a host address and API key.</div>
			</div>

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
							fontSize: 12,
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
						{showApiKey ? 'Hide' : 'Show'}
					</button>
					{apiKey.trim() && onClearApiKey && (
						<button type="button" onClick={onClearApiKey} title="Clear stored API key" style={{ padding: '6px 12px', fontSize: 12 }}>
							Clear
						</button>
					)}
				</div>
				<div style={S.helpText}>API key is saved securely when you save settings.</div>
			</div>

			{/* Debug output (hidden in simplified/welcome mode) */}
			{!simplified && (
				<div style={S.formGroup}>
					<div>
						<input type="checkbox" id={id('debugOutput')} checked={debugOutput} onChange={(e) => onDebugOutputChange(e.target.checked)} style={{ marginRight: 8, verticalAlign: 'middle' }} />
						<label htmlFor={id('debugOutput')} style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
							Full debug output
						</label>
					</div>
					<div style={S.helpText}>Enable detailed server trace logging (see Output&#8594;RocketRide: Console)</div>
				</div>
			)}

			{/* Test connection */}
			{onTestConnection && (
				<div style={{ ...S.formGroup, alignItems: 'flex-end' }}>
					<button
						type="button"
						onClick={() => onTestConnection(hostUrl, apiKey)}
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
