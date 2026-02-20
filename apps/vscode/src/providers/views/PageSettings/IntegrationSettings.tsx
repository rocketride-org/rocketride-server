// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

export const IntegrationSettings: React.FC<IntegrationSettingsProps> = ({
	settings,
	onSettingsChange
}) => {
	const handleCopilotIntegrationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ copilotIntegration: e.target.checked });
	};

	const handleCursorIntegrationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ cursorIntegration: e.target.checked });
	};

	return (
		<div className="section" id="integrationSection">
			<div className="section-title">Integrations</div>
			<div className="section-description">
				Enable integration with AI coding assistants. The extension's documentation files are automatically 
				synced to your workspace at startup, when workspace folders change, and when you save these settings.
			</div>

			<div className="form-grid">
				<div className="form-group checkbox-group">
					<label>
						<input
							type="checkbox"
							checked={settings.copilotIntegration ?? false}
							onChange={handleCopilotIntegrationChange}
						/>
						<span>GitHub Copilot Integration</span>
					</label>
					<div className="help-text">
						Setup and integrate with Copilot.
					</div>
				</div>

				<div className="form-group checkbox-group">
					<label>
						<input
							type="checkbox"
							checked={settings.cursorIntegration ?? false}
							onChange={handleCursorIntegrationChange}
						/>
						<span>Cursor Integration</span>
					</label>
					<div className="help-text">
						Setup and integrate with Cursor.
					</div>
				</div>
			</div>
		</div>
	);
};

