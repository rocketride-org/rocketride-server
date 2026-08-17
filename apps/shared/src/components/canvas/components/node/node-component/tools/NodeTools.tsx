// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

/**
 * NodeTools — Invoke source type labels rendered inside the node body.
 *
 * Displays a row of labels (e.g. "LLM", "Memory", "Tool") above the
 * invoke source diamond handles on the bottom edge. These labels help
 * users identify which invocation channels the node exposes without
 * having to hover over the diamond handles.
 *
 * Returns null when the node has no invoke sources.
 */

import { ReactElement } from 'react';

// =============================================================================
// Styles
// =============================================================================

/** Label text color — resolved via CSS custom property. */
const labelColor = 'var(--rr-text-disabled)';

// =============================================================================
// Types
// =============================================================================

/**
 * Props for the NodeTools component.
 */
interface INodeToolsProps {
	/** Invoke source channel keys (e.g. ["llm", "memory", "tool"]). */
	invokeSourceKeys: string[];
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders invoke source type labels inside the node body.
 *
 * @param props - The invoke source keys to display as labels.
 * @returns A row of capitalised labels, or null if no invoke sources exist.
 */
export default function NodeTools({ invokeSourceKeys }: INodeToolsProps): ReactElement | null {
	// No invoke sources means nothing to label
	if (invokeSourceKeys.length === 0) return null;

	return (
		<div
			style={{
				display: 'flex',
				justifyContent: 'center',
				gap: '40px',
				backgroundColor: 'var(--rr-bg-surface)',
				padding: '0.3rem 0.6rem 0.4rem',
			}}
		>
			{invokeSourceKeys.map((key) => (
				<span
					key={key}
					style={{
						fontSize: '0.5rem',
						lineHeight: 1,
						color: labelColor,
						userSelect: 'none',
						whiteSpace: 'nowrap',
					}}
				>
					{/* "llm" is an acronym — render as uppercase; others get title case */}
					{key === 'llm' ? 'LLM' : key.charAt(0).toUpperCase() + key.slice(1)}
				</span>
			))}
		</div>
	);
}
