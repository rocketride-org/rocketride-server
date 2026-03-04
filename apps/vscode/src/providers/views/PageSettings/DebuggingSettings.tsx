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

interface DebuggingSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
}

export const DebuggingSettings: React.FC<DebuggingSettingsProps> = ({
	settings,
	onSettingsChange
}) => {
	const handleRestartBehaviorChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		onSettingsChange({ pipelineRestartBehavior: e.target.value as 'auto' | 'manual' | 'prompt' });
	};

	return (
		<div className="section">
			<div className="section-title">Debugging Settings</div>
			<div className="section-description">Configure debugging and pipeline restart behavior</div>

			<div className="form-grid">
				<div className="form-group">
					<label htmlFor="pipelineRestartBehavior">Pipeline Restart Behavior</label>
					<select
						id="pipelineRestartBehavior"
						value={settings.pipelineRestartBehavior}
						onChange={handleRestartBehaviorChange}
					>
						<option value="auto">Automatically restart when .pipe changes</option>
						<option value="manual">Do not automatically restart</option>
						<option value="prompt">Prompt to restart when .pipe changes</option>
					</select>
					<div className="help-text">
						Choose what happens when a .pipe file changes while the pipeline is running
					</div>
				</div>
			</div>
		</div>
	);
};
