// =============================================================================
// ScenarioList — Pre-built chaos scenario cards
// =============================================================================

import React from 'react';
import { SCENARIOS } from '../scenarios';
import type { TestEngine, EngineState } from '../types';
import { styles } from '../styles';

interface Props {
	engine: TestEngine;
	engineState: EngineState;
}

const ScenarioList: React.FC<Props> = ({ engine, engineState }) => {
	const isRunning = engineState === 'running' || engineState === 'paused';

	return (
		<div style={styles.scenarioList}>
			{SCENARIOS.map((scenario) => (
				<div
					key={scenario.id}
					style={{
						...styles.scenario,
						opacity: isRunning ? 0.5 : 1,
						cursor: isRunning ? 'default' : 'pointer',
					}}
					onClick={() => {
						if (!isRunning) engine.runScenario(scenario);
					}}
				>
					<div style={styles.scenarioTitle}>{scenario.name}</div>
					<div style={styles.scenarioDesc}>{scenario.description}</div>
					<div style={styles.scenarioTags}>
						{scenario.tags.map((tag) => (
							<span key={tag.label} style={styles.scenarioTag(tag.color)}>{tag.label}</span>
						))}
					</div>
				</div>
			))}
		</div>
	);
};

export default ScenarioList;
