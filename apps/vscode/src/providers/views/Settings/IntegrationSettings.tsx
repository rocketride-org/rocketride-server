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

import React, { CSSProperties } from 'react';
import { commonStyles } from 'shared/themes/styles';
import { SettingsData, settingsStyles as S, SettingsCardHeader } from './SettingsWebview';

// ============================================================================
// TYPES
// ============================================================================

interface IntegrationSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
	onSave: () => void;
	onCancel?: () => void;
	dirty?: boolean;
	saved?: boolean;
}

type BooleanKeys<T> = { [K in keyof T]: T[K] extends boolean ? K : never }[keyof T];

// ============================================================================
// CONSTANTS
// ============================================================================

const INTEGRATIONS: { key: BooleanKeys<SettingsData>; label: string; description: string }[] = [
	{
		key: 'integrationCopilot',
		label: 'GitHub Copilot',
		description: 'Enable RocketRide integration with GitHub Copilot',
	},
	{
		key: 'integrationClaudeCode',
		label: 'Claude Code',
		description: 'Enable RocketRide integration with Claude Code',
	},
	{
		key: 'integrationCursor',
		label: 'Cursor',
		description: 'Enable RocketRide integration with Cursor',
	},
	{
		key: 'integrationWindsurf',
		label: 'Windsurf',
		description: 'Enable RocketRide integration with Windsurf',
	},
	{
		key: 'integrationClaudeMd',
		label: 'Generic CLAUDE.md',
		description: 'Install RocketRide instructions to CLAUDE.md at the repo root',
	},
	{
		key: 'integrationAgentsMd',
		label: 'Generic AGENTS.md',
		description: 'Install RocketRide instructions to AGENTS.md at the repo root',
	},
];

const clearSecretButtonStyle: CSSProperties = {
	...commonStyles.buttonSecondarySmall,
	alignSelf: 'flex-start',
	marginTop: 6,
};

// ============================================================================
// COMPONENT
// ============================================================================

export const IntegrationSettings: React.FC<IntegrationSettingsProps> = ({ settings, onSettingsChange, onSave, onCancel, dirty, saved }) => {
	const updateVoiceBuilder = (voiceBuilder: Partial<SettingsData['voiceBuilder']>) => {
		onSettingsChange({ voiceBuilder } as Partial<SettingsData>);
	};

	return (
		<>
			<div style={S.card}>
				<SettingsCardHeader title="Integrations" onSave={onSave} onCancel={onCancel} dirty={dirty} saved={saved} />
				<div style={S.cardBody}>
					<div style={S.sectionDescription}>Enable integrations with AI coding assistants</div>
					<div style={S.formGrid}>
						<div style={S.formGroup}>
							<div style={S.checkboxGroup}>
								<label style={S.checkboxLabel}>
									<input type="checkbox" checked={!!settings.autoAgentIntegration} onChange={(e) => onSettingsChange({ autoAgentIntegration: e.target.checked })} aria-describedby="autoAgentIntegration-help" style={S.checkboxInput} />
									<span style={S.checkboxSpan}>Automatic Agent Integration</span>
								</label>
								<div id="autoAgentIntegration-help" style={S.checkboxHelpText}>
									Automatically detect and install RocketRide documentation for coding agents on startup
								</div>

								{INTEGRATIONS.map(({ key, label, description }) => (
									<React.Fragment key={key}>
										<label style={S.checkboxLabel}>
											<input type="checkbox" checked={!!settings[key]} onChange={(e) => onSettingsChange({ [key]: e.target.checked })} aria-describedby={`${key}-help`} style={S.checkboxInput} />
											<span style={S.checkboxSpan}>{label}</span>
										</label>
										<div id={`${key}-help`} style={S.checkboxHelpText}>
											{description}
										</div>
									</React.Fragment>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>
			<div style={S.card}>
				<SettingsCardHeader title="Voice Builder" onSave={onSave} onCancel={onCancel} dirty={dirty} saved={saved} />
				<div style={S.cardBody}>
					<div style={S.sectionDescription}>Configure push-to-talk pipeline editing from the canvas toolbar</div>
					<div style={S.formGrid}>
						<div style={S.checkboxGroup}>
							<label style={S.checkboxLabel}>
								<input type="checkbox" checked={settings.voiceBuilder.enabled} onChange={(e) => updateVoiceBuilder({ enabled: e.target.checked })} style={S.checkboxInput} />
								<span style={S.checkboxSpan}>Enable Voice Builder</span>
							</label>
						</div>
						<div style={S.formGroup}>
							<label htmlFor="voiceBuilderDeepgramApiKey" style={S.label}>
								Deepgram API Key
							</label>
							<input id="voiceBuilderDeepgramApiKey" type="password" value={settings.voiceBuilder.deepgramApiKey} placeholder={settings.voiceBuilder.hasDeepgramApiKey ? 'Stored key' : 'Enter Deepgram API key'} onChange={(e) => updateVoiceBuilder({ deepgramApiKey: e.target.value, hasDeepgramApiKey: e.target.value.trim().length > 0 })} />
							{settings.voiceBuilder.hasDeepgramApiKey && !settings.voiceBuilder.deepgramApiKey && (
								<button type="button" style={clearSecretButtonStyle} aria-label="Clear stored Deepgram API key" onClick={() => updateVoiceBuilder({ deepgramApiKey: '', hasDeepgramApiKey: false })}>
									Clear stored key
								</button>
							)}
						</div>
						<div style={S.formGroup}>
							<label htmlFor="voiceBuilderPlannerApiKey" style={S.label}>
								Planner API Key
							</label>
							<input id="voiceBuilderPlannerApiKey" type="password" value={settings.voiceBuilder.plannerApiKey} placeholder={settings.voiceBuilder.hasPlannerApiKey ? 'Stored key' : 'Enter planner API key'} onChange={(e) => updateVoiceBuilder({ plannerApiKey: e.target.value, hasPlannerApiKey: e.target.value.trim().length > 0 })} />
							{settings.voiceBuilder.hasPlannerApiKey && !settings.voiceBuilder.plannerApiKey && (
								<button type="button" style={clearSecretButtonStyle} aria-label="Clear stored planner API key" onClick={() => updateVoiceBuilder({ plannerApiKey: '', hasPlannerApiKey: false })}>
									Clear stored key
								</button>
							)}
						</div>
						<div style={S.formGroup}>
							<label htmlFor="voiceBuilderPlannerBaseUrl" style={S.label}>
								Planner Base URL
							</label>
							<input id="voiceBuilderPlannerBaseUrl" type="url" value={settings.voiceBuilder.plannerBaseUrl} onChange={(e) => updateVoiceBuilder({ plannerBaseUrl: e.target.value })} />
						</div>
						<div style={S.formGroup}>
							<label htmlFor="voiceBuilderPlannerModel" style={S.label}>
								Planner Model
							</label>
							<input id="voiceBuilderPlannerModel" type="text" value={settings.voiceBuilder.plannerModel} onChange={(e) => updateVoiceBuilder({ plannerModel: e.target.value })} />
						</div>
					</div>
				</div>
			</div>
		</>
	);
};
