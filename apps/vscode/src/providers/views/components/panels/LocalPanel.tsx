// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * LocalPanel — target panel for Local connection mode.
 *
 * Renders: server version dropdown. Debug output and task arguments are
 * pipeline settings (passed per task via `.use`), not connection options.
 * Used by ConnectionSettings (dev) and DeployTargetSettings (deploy).
 */

import React from 'react';
import LocalIcon from '../../../../assets/local.svg';
import { settingsStyles as S, EngineVersionItem } from '../../Settings/SettingsWebview';

// =============================================================================
// TYPES
// =============================================================================

export interface LocalPanelProps {
	engineVersion: string;
	onVersionChange: (version: string) => void;
	engineVersions: EngineVersionItem[];
	engineVersionsLoading: boolean;
	idPrefix: string;
	simplified?: boolean;
}

// =============================================================================
// HELPERS
// =============================================================================

const displayVersion = (tagName: string): string => tagName.replace(/^server-/, '');

// =============================================================================
// COMPONENT
// =============================================================================

export const LocalPanel: React.FC<LocalPanelProps> = ({ engineVersion, onVersionChange, engineVersions, engineVersionsLoading, idPrefix, simplified }) => {
	const id = (name: string) => `${idPrefix}-${name}`;

	// Simplified: just the description, no config fields
	if (simplified) {
		return (
			<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
				<LocalIcon role="img" aria-label="Local" style={{ width: 48, height: 48, flexShrink: 0 }} />
				<div style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>Run the server locally on your machine. The extension will download and manage the server for you.</div>
			</div>
		);
	}

	return (
		<>
			<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
				<LocalIcon role="img" aria-label="Local" style={{ width: 48, height: 48, flexShrink: 0 }} />
				<div style={{ fontSize: 13, color: 'var(--rr-text-secondary)', lineHeight: 1.5 }}>Run the server locally on your machine. The extension will download and manage the server for you.</div>
			</div>

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
		</>
	);
};
