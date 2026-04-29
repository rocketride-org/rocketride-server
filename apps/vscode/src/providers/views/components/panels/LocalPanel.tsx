// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * LocalPanel — target panel for Local connection mode.
 *
 * Renders: server version dropdown, debug output checkbox, server arguments input.
 * Used by ConnectionSettings (dev) and DeployTargetSettings (deploy).
 */

import React from 'react';
import { settingsStyles as S, EngineVersionItem } from '../../PageSettings/SettingsWebview';

// =============================================================================
// TYPES
// =============================================================================

export interface LocalPanelProps {
	engineVersion: string;
	onVersionChange: (version: string) => void;
	engineVersions: EngineVersionItem[];
	engineVersionsLoading: boolean;
	debugOutput: boolean;
	onDebugOutputChange: (checked: boolean) => void;
	engineArgs: string;
	onEngineArgsChange: (args: string) => void;
	idPrefix: string;
}

// =============================================================================
// HELPERS
// =============================================================================

const displayVersion = (tagName: string): string => tagName.replace(/^server-/, '');

// =============================================================================
// COMPONENT
// =============================================================================

export const LocalPanel: React.FC<LocalPanelProps> = ({ engineVersion, onVersionChange, engineVersions, engineVersionsLoading, debugOutput, onDebugOutputChange, engineArgs, onEngineArgsChange, idPrefix }) => {
	const id = (name: string) => `${idPrefix}-${name}`;

	return (
		<>
			<div style={S.modeConfigDesc}>Run the server locally on your machine. The extension will download and manage the server for you.</div>

			{/* Server version */}
			<div style={S.formGroup}>
				<label htmlFor={id('serverVersion')} style={S.label}>
					Server Version
				</label>
				<select id={id('serverVersion')} value={engineVersion} onChange={(e) => onVersionChange(e.target.value)} disabled={engineVersionsLoading}>
					<optgroup label="Recommended">
						<option value="latest">&lt;Latest&gt;</option>
						<option value="prerelease">&lt;Prerelease&gt;</option>
					</optgroup>
					<optgroup label={engineVersionsLoading ? 'Loading versions...' : 'All versions'}>
						{engineVersions.map((v) => (
							<option key={v.tag_name} value={v.tag_name}>
								{displayVersion(v.tag_name)}
							</option>
						))}
					</optgroup>
				</select>
				<div style={S.helpText}>Choose which server version to download. &lt;Latest&gt; gets the newest stable release.</div>
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

			{/* Server arguments */}
			<div style={S.formGroup}>
				<label htmlFor={id('engineArgs')} style={S.label}>
					Server Arguments
				</label>
				<input type="text" id={id('engineArgs')} value={engineArgs} placeholder="--option=value --flag" onChange={(e) => onEngineArgsChange(e.target.value)} />
				<div style={S.helpText}>Additional command-line arguments passed to the server</div>
			</div>
		</>
	);
};
