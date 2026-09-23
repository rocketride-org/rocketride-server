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
	// Any non-idle state blocks activation: engine.start is idle-only, so a
	// card clicked while aborting would log a phantom "Running scenario"
	// event and then silently do nothing.
	const isRunning = engineState !== 'idle';

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
					// Keyboard access: cards act as buttons (Enter/Space = click),
					// dropped from the tab order while a run is active.
					role="button"
					tabIndex={isRunning ? -1 : 0}
					aria-disabled={isRunning}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							if (!isRunning) engine.runScenario(scenario);
						}
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
