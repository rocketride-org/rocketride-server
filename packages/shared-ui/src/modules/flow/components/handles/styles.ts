// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Shared CSS styles for ReactFlow connection handles (ports).
 *
 * Defines the outer hit-area dimensions common to both data-lane
 * handles (circular) and invoke handles (diamond).
 */

import { CSSProperties } from '@mui/styles';

/** Base CSS styles for ReactFlow node connection handles. Defines the outer hit-area dimensions. */
export const handleStyles: CSSProperties = {
	width: '18px',
	height: '18px',
	border: 'none',
	background: 'transparent',
};
