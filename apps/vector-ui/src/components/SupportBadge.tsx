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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// VECTOR-UI — SUPPORT BADGE (Experimental stores)
// =============================================================================

import React from 'react';
import { StatusBadge } from 'shell';
import type { SupportLevel } from '../contract/types';
import { EXPERIMENTAL_BADGE } from '../vector/support';

/** Props for the {@link SupportBadge} component. */
export interface ISupportBadgeProps {
	support: SupportLevel;
}

/**
 * "Experimental" for a store this build checked against stand-ins only; nothing for a supported one.
 *
 * @param props - {@link ISupportBadgeProps}.
 * @returns The badge, or null.
 */
export function SupportBadge({ support }: ISupportBadgeProps): React.ReactElement | null {
	if (support !== 'experimental') return null;
	return (
		<span title={EXPERIMENTAL_BADGE.tooltip}>
			<StatusBadge variant="warning">{EXPERIMENTAL_BADGE.label}</StatusBadge>
		</span>
	);
}

export default SupportBadge;
