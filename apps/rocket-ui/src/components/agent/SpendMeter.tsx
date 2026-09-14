// Copyright (c) 2026 Aparavi Software AG. MIT License.
import React from 'react';
import type { SpendState } from '../../hooks/useAgentSession';

/** Props for {@link SpendMeter}. */
export interface SpendMeterProps {
	/** Running spend for the attached session. */
	spend: SpendState;
}

/** Session spend from OpenCode usage fields; falls back to token counts × static prices, labeled "estimate" (P4-V1). */
export function SpendMeter({ spend }: SpendMeterProps): React.JSX.Element {
	const t = spend.tokens;
	const label = `$${spend.costUsd.toFixed(4)}${spend.estimated ? ' (estimate)' : ''}`;
	const detail = `${(t.input + t.cache.read + t.cache.write).toLocaleString()} in · ${t.output.toLocaleString()} out`;
	return (
		<span title={detail} aria-label={`Session spend ${label}, ${detail}`} data-estimated={spend.estimated}>
			{label} <small>({detail})</small>
		</span>
	);
}
