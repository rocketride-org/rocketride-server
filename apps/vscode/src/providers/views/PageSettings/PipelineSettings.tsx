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

interface PipelineSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
}

export const PipelineSettings: React.FC<PipelineSettingsProps> = ({
	settings,
	onSettingsChange
}) => {
	const handleDefaultPipelinePathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ defaultPipelinePath: e.target.value });
	};

	return (
		<div className="section">
			<div className="section-title">Pipeline Settings</div>
			<div className="section-description">Configure default settings for pipeline creation and management</div>

			<div className="form-grid">
				<div className="form-group">
					<label htmlFor="defaultPipelinePath">Default Pipeline Path</label>
					<input
						type="text"
						id="defaultPipelinePath"
						placeholder="${workspaceFolder}/pipelines"
						value={settings.defaultPipelinePath}
						onChange={handleDefaultPipelinePathChange}
					/>
					<div className="help-text">
						Default directory path for creating new pipeline files (relative to workspace root).
						Examples: "pipelines", "src/pipelines", "workflows"
					</div>
				</div>
			</div>
		</div>
	);
};
