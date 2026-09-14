// Copyright (c) 2026 Aparavi Software AG. MIT License.
import React, { useState } from 'react';
import type { OcGateAsk } from '../../services/agentTypes';

/** Props for {@link GatePrompt}. */
export interface GatePromptProps {
	/** The pending present_gate ask. */
	ask: OcGateAsk;
	/** Answers the gate; resolves once rocket-agent has recorded the choice. */
	onAnswer: (id: string, option: string) => Promise<void>;
}

/** Inline choice chips rendered in the chat input row when the agent calls present_gate. */
export function GatePrompt({ ask, onAnswer }: GatePromptProps): React.JSX.Element {
	const [busy, setBusy] = useState(false);
	// A /gate or follow-up-send failure must not become a silent unhandled rejection: surface it
	// and leave the chips actionable (finally clears busy) so the user can retry.
	const run = (option: string) => {
		setBusy(true);
		void onAnswer(ask.id, option)
			.catch((err: unknown) => console.error('[rr-agent] gate answer failed', err))
			.finally(() => setBusy(false));
	};
	return (
		<div role="group" aria-label="Agent gate request" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
			<span>{ask.brief}</span>
			{ask.options.map((option) => (
				<button key={option} disabled={busy} onClick={() => run(option)}>
					{option}
				</button>
			))}
		</div>
	);
}
