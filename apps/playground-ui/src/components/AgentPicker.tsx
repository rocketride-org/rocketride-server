// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AgentPicker — "+ New connection", or no agent yet: the shared pipe picker
 * (C.16c) in the conversation's place, listing every pipe by its sources.
 * Simple titles it "Choose an agent"; Advanced keeps the developer words.
 */

import React, { type CSSProperties } from 'react';
import { PipePicker } from 'shared/components/pipe-picker';
import type { IPipeChoice } from 'shared/components/pipe-picker';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	landing: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		padding: 32,
		boxSizing: 'border-box',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link AgentPicker}. */
export interface IAgentPickerProps {
	/** Simple view. */
	simple: boolean;
	/** Whether the choice is written into the page URL (the browser app). */
	writeLink: boolean;
	/** Fired with the chosen source's address and the pipe's name. */
	onChoose: (address: string, name: string) => void;
}

/**
 * Renders the picker.
 *
 * @param props - {@link IAgentPickerProps}.
 * @returns The picker.
 */
export const AgentPicker: React.FC<IAgentPickerProps> = ({ simple, writeLink, onChoose }) => (
	<div style={styles.landing}>
		<PipePicker interfaceType="source" interfaceLabel={simple ? 'way in' : 'source'} title={simple ? 'Choose an agent' : 'Choose a pipeline'} subtitle={simple ? 'Agents shared with you, your teams and your organization. Search to find more in the store.' : 'Pipelines published to you, your teams and your organization, or search the store. To try your own Play run, enter its address.'} chooseLabel="Open" writeLink={writeLink} onChoose={(choice: IPipeChoice) => onChoose(choice.address, choice.pipeName)} />
	</div>
);
