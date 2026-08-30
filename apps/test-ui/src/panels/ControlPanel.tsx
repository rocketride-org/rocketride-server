// =============================================================================
// ControlPanel — Configuration controls for concurrency, chaos, and payloads
// =============================================================================

import React from 'react';
import type { TestConfig, EngineState } from '../types';
import { styles } from '../styles';

interface Props {
	config: TestConfig;
	onChange: (config: TestConfig) => void;
	engineState: EngineState;
}

const ControlPanel: React.FC<Props> = ({ config, onChange, engineState }) => {
	const isRunning = engineState === 'running';
	const isPaused = engineState === 'paused';
	const isActive = isRunning || isPaused;

	function set<K extends keyof TestConfig>(key: K, value: TestConfig[K]) {
		onChange({ ...config, [key]: value });
	}

	return (
		<div style={styles.controlPanel}>
			{/* Concurrency */}
			<div style={styles.controlGroup}>
				<div style={styles.controlGroupTitle}>Concurrency</div>
				<div style={styles.controlRow}>
					<span style={styles.controlLabel}>Pipelines</span>
					<input type="number" style={styles.controlInput} value={config.pipelines} min={0} max={256} disabled={isActive} onChange={(e) => set('pipelines', Number(e.target.value))} />
				</div>
				<div style={styles.controlRow}>
					<span style={styles.controlLabel}>Sends/pipe</span>
					<input type="number" style={styles.controlInput} value={config.sendsPerPipeline} min={0} max={10000} disabled={isActive} onChange={(e) => set('sendsPerPipeline', Number(e.target.value))} />
				</div>
				<div style={styles.controlRow}>
					<span style={styles.controlLabel}>Ramp-up</span>
					<select style={styles.controlSelect} value={config.rampUp} disabled={isActive} onChange={(e) => set('rampUp', e.target.value as TestConfig['rampUp'])}>
						<option value="instant">Instant (all at once)</option>
						<option value="linear">Linear (1/sec)</option>
						<option value="exponential">Exponential</option>
						<option value="burst">Random burst</option>
					</select>
				</div>
			</div>

			{/* Chaos Controls */}
			<div style={styles.controlGroup}>
				<div style={styles.controlGroupTitle}>Chaos Controls</div>
				<div style={styles.controlRow}>
					<span style={styles.controlLabel}>Random delay</span>
					<input type="number" style={styles.controlInput} value={config.randomDelay} min={0} max={5000} disabled={isActive} onChange={(e) => set('randomDelay', Number(e.target.value))} />
					<span style={styles.controlUnit}>ms</span>
				</div>
				<div style={styles.controlRow}>
					<span style={styles.controlLabel}>Kill prob.</span>
					<input type="number" style={styles.controlInput} value={config.killProbability} min={0} max={100} disabled={isActive} onChange={(e) => set('killProbability', Number(e.target.value))} />
					<span style={styles.controlUnit}>%</span>
				</div>
				<div style={styles.controlRow}>
					<span style={styles.controlLabel}>Corruption</span>
					<select style={styles.controlSelect} value={config.corruptionLevel} disabled={isActive} onChange={(e) => set('corruptionLevel', e.target.value as TestConfig['corruptionLevel'])}>
						<option value="off">Off</option>
						<option value="occasional">Occasional (5%)</option>
						<option value="frequent">Frequent (25%)</option>
						<option value="extreme">Extreme (50%)</option>
					</select>
				</div>
			</div>

			{/* Data Payload */}
			<div style={styles.controlGroup}>
				<div style={styles.controlGroupTitle}>Data Payload</div>
				<div style={styles.controlRow}>
					<span style={styles.controlLabel}>Size</span>
					<select style={styles.controlSelect} value={config.payloadSize} disabled={isActive} onChange={(e) => set('payloadSize', e.target.value as TestConfig['payloadSize'])}>
						<option value="tiny">Tiny (100B)</option>
						<option value="medium">Medium (10KB)</option>
						<option value="large">Large (1MB)</option>
						<option value="huge">Huge (100MB)</option>
						<option value="mixed">Mixed random</option>
					</select>
				</div>
				<div style={styles.controlRow}>
					<span style={styles.controlLabel}>Type</span>
					<select style={styles.controlSelect} value={config.payloadType} disabled={isActive} onChange={(e) => set('payloadType', e.target.value as TestConfig['payloadType'])}>
						<option value="text">Text/UTF-8</option>
						<option value="binary">Binary random</option>
						<option value="mixed">Mixed</option>
						<option value="malformed">Malformed JSON</option>
						<option value="empty">Empty payloads</option>
					</select>
				</div>
			</div>
		</div>
	);
};

export default ControlPanel;
