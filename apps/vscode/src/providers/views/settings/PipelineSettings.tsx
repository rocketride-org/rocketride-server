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
// CONSTANTS
// ============================================================================

/** Pipeline TTL choices (seconds → label) offered by the dropdown. */
const TTL_OPTIONS: Array<{ value: number; label: string }> = [
	{ value: 900, label: '15 minutes' },
	{ value: 1800, label: '30 minutes' },
	{ value: 3600, label: '1 hour' },
	{ value: 14400, label: '4 hours' },
	{ value: 28800, label: '8 hours' },
	{ value: 0, label: 'Run forever or until you stop it' },
];

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
 * pipeline-execution settings — restart behavior, idle-timeout (TTL), trace
 * verbosity, task arguments, and debug output — applied to every run via the
 * `.use` call. The Settings surface owns the single Save/Cancel footer.
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

	/** Update the default idle-timeout from the fixed TTL choices (seconds). */
	const handleTtlChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		onSettingsChange({ pipelineTtl: Number(e.target.value) });
	};

	/** Update the default trace verbosity for pipeline execution. */
	const handleTraceLevelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		onSettingsChange({ pipelineTraceLevel: e.target.value as SettingsData['pipelineTraceLevel'] });
	};

	/** Update the additional command-line arguments passed to each pipeline task. */
	const handleTaskArgumentsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ taskArguments: e.target.value });
	};

	/** Toggle full debug output (--trace=debugOut) for pipeline tasks. */
	const handleDebugOutputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		onSettingsChange({ pipelineDebugOutput: e.target.checked });
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
					<div style={S.helpText}>Behavior when a .pipe file changes while the pipeline is running.</div>
				</div>
				<div style={S.formGroup}>
					<label htmlFor="pipelineTtl" style={S.label}>
						Pipeline TTL
					</label>
					<select id="pipelineTtl" value={settings.pipelineTtl} onChange={handleTtlChange}>
						{/* A custom value from hand-edited settings.json still renders instead of a blank select */}
						{!TTL_OPTIONS.some((o) => o.value === settings.pipelineTtl) && <option value={settings.pipelineTtl}>{settings.pipelineTtl} seconds</option>}
						{TTL_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
					<div style={S.helpText}>Default idle timeout before a running pipeline is shut down.</div>
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
				<div style={S.formGroup}>
					<label htmlFor="taskArguments" style={S.label}>
						Task Arguments
					</label>
					<input type="text" id="taskArguments" value={settings.taskArguments} placeholder="--option=value --flag" onChange={handleTaskArgumentsChange} />
					<div style={S.helpText}>Additional command-line arguments passed to each pipeline task.</div>
				</div>
				<div style={S.formGroup}>
					<label htmlFor="pipelineDebugOutput" style={S.label}>
						Pipeline Debug Output
					</label>
					<div>
						<input type="checkbox" id="pipelineDebugOutput" checked={settings.pipelineDebugOutput} onChange={handleDebugOutputChange} style={{ marginRight: 8, verticalAlign: 'middle' }} />
						<label htmlFor="pipelineDebugOutput" style={{ display: 'inline', fontWeight: 'normal', margin: 0, verticalAlign: 'middle', cursor: 'pointer' }}>
							Enable full debug output for pipeline tasks (--trace=debugOut).
						</label>
					</div>
				</div>
			</div>
		</div>
	);
};
