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
import { SettingsData, settingsStyles as S } from './PageSettings';

// ============================================================================
// TYPES
// ============================================================================

interface DebuggingSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export const DebuggingSettings: React.FC<DebuggingSettingsProps> = ({ settings, onSettingsChange }) => {
	const handleRestartBehaviorChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		onSettingsChange({ pipelineRestartBehavior: e.target.value as 'auto' | 'manual' | 'prompt' });
	};

	return (
		<div style={S.card}>
			<div style={S.cardHeader}>Debugging Settings</div>
			<div style={S.cardBody}>
				<div style={S.sectionDescription}>Configure debugging and pipeline restart behavior</div>
				<div style={S.formGrid}>
					<div style={S.formGroup}>
						<label htmlFor="pipelineRestartBehavior" style={S.label}>
							Pipeline Restart Behavior
						</label>
						<select id="pipelineRestartBehavior" value={settings.pipelineRestartBehavior} onChange={handleRestartBehaviorChange}>
							<option value="auto">Automatically restart when .pipe changes</option>
							<option value="manual">Do not automatically restart</option>
							<option value="prompt">Prompt to restart when .pipe changes</option>
						</select>
						<div style={S.helpText}>Choose what happens when a .pipe file changes while the pipeline is running</div>
					</div>
				</div>
			</div>
		</div>
	);
};
