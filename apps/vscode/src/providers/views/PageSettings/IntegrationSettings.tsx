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

import React from 'react';
import { SettingsData } from './PageSettings';

interface IntegrationSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
}

type BooleanKeys<T> = { [K in keyof T]: T[K] extends boolean ? K : never }[keyof T];

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

export const IntegrationSettings: React.FC<IntegrationSettingsProps> = ({ settings, onSettingsChange }) => {
	return (
		<div className="section">
			<div className="section-title">Integrations</div>
			<div className="section-description">Enable integrations with AI coding assistants</div>

			<div className="form-grid">
				<div className="form-group">
					<div className="checkbox-group">
						<label>
							<input type="checkbox" checked={!!settings.autoAgentIntegration} onChange={(e) => onSettingsChange({ autoAgentIntegration: e.target.checked })} aria-describedby="autoAgentIntegration-help" />
							<span>Automatic Agent Integration</span>
						</label>
						<div id="autoAgentIntegration-help" className="help-text">
							Automatically detect and install RocketRide documentation for coding agents on startup
						</div>

						{INTEGRATIONS.map(({ key, label, description }) => (
							<React.Fragment key={key}>
								<label>
									<input type="checkbox" checked={!!settings[key]} onChange={(e) => onSettingsChange({ [key]: e.target.checked })} aria-describedby={`${key}-help`} />
									<span>{label}</span>
								</label>
								<div id={`${key}-help`} className="help-text">
									{description}
								</div>
							</React.Fragment>
						))}
					</div>
				</div>
			</div>
		</div>
	);
};
