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
import { SettingsData, settingsStyles as S } from './SettingsWebview';

// ============================================================================
// TYPES
// ============================================================================

/** Props for the Pipeline settings page. */
interface PipelineSettingsProps {
	settings: SettingsData;
	onSettingsChange: (settings: Partial<SettingsData>) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Pipeline settings page (flat, card-less). Holds the default file path plus the
 * three pipeline-execution settings — restart behavior, idle-timeout (TTL), and
 * trace verbosity — applied to every run. The Settings surface owns the single
 * Save/Cancel footer.
 */
export const PipelineSettings: React.FC<PipelineSettingsProps> = ({ settings, onSettingsChange }) => {
	/** Update the default directory new pipeline files are created under. */
	const handleDefaultPipelinePathChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ defaultPipelinePath: e.target.value });
	};

	/** Update how a running pipeline reacts when its .pipe file changes. */
	const handleRestartBehaviorChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		onSettingsChange({ pipelineRestartBehavior: e.target.value as 'auto' | 'manual' | 'prompt' });
	};

	/**
	 * Update the default idle-timeout (seconds). A blank field resets to the
	 * 900s default; transient non-numeric input (e.g. "-") is ignored and
	 * negative values clamp to 0 (the no-timeout sentinel is the floor).
	 */
	const handleTtlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const raw = e.target.value;
		if (raw === '') {
			onSettingsChange({ pipelineTtl: 900 });
			return;
		}
		const parsed = Number(raw);
		if (Number.isNaN(parsed)) return;
		onSettingsChange({ pipelineTtl: Math.max(0, Math.floor(parsed)) });
	};

	/** Update the default trace verbosity for pipeline execution. */
	const handleTraceLevelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		onSettingsChange({ pipelineTraceLevel: e.target.value as SettingsData['pipelineTraceLevel'] });
	};

	return (
		<div style={S.pageBody}>
			<div style={S.pageHeader}>
				<h2 style={S.pageTitle}>Pipeline</h2>
			</div>
			<div style={S.sectionDescription}>Configure defaults for pipeline creation and execution</div>
			<div style={S.formGrid}>
				<div style={S.formGroup}>
					<label htmlFor="defaultPipelinePath" style={S.label}>
						Default Pipeline Path
					</label>
					<input type="text" id="defaultPipelinePath" placeholder="${workspaceFolder}/pipelines" value={settings.defaultPipelinePath} onChange={handleDefaultPipelinePathChange} />
					<div style={S.helpText}>Default directory path for creating new pipeline files (relative to workspace root). Examples: "pipelines", "src/pipelines", "workflows"</div>
				</div>
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
				<div style={S.formGroup}>
					<label htmlFor="pipelineTtl" style={S.label}>
						Pipeline TTL
					</label>
					<input type="number" id="pipelineTtl" min={0} value={settings.pipelineTtl} onChange={handleTtlChange} />
					<div style={S.helpText}>Default idle timeout in seconds before a running pipeline is shut down (0 = no timeout).</div>
				</div>
				<div style={S.formGroup}>
					<label htmlFor="pipelineTraceLevel" style={S.label}>
						Pipeline Trace Level
					</label>
					<select id="pipelineTraceLevel" value={settings.pipelineTraceLevel} onChange={handleTraceLevelChange}>
						<option value="none">none</option>
						<option value="metadata">metadata</option>
						<option value="summary">summary</option>
						<option value="full">full</option>
					</select>
					<div style={S.helpText}>Controls tracing verbosity for pipeline execution.</div>
				</div>
			</div>
		</div>
	);
};
