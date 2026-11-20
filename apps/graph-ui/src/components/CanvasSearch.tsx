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
// GRAPH-UI - CANVAS SEARCH (find a drawn node by what it shows or holds)
// =============================================================================
//
// An input above the canvas. It looks only at the nodes that are drawn
// (graph/search.ts). The matches are passed up so the canvas can dim the rest;
// Enter selects the current match and centres it, Down and Up move to the next
// and the previous (and centre them), Escape clears the box and hands focus back.
// "/" focuses it from anywhere in the graph view (the view handles that key).
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { searchStatusText } from '../graph/search';

/** Props. */
export interface ICanvasSearchProps {
	value: string;
	onChange(value: string): void;
	/** How many drawn nodes match, or null when nothing was typed. */
	count: number | null;
	/** The current match, zero-based. */
	current: number;
	onStep(delta: 1 | -1): void;
	/** Enter: select the current match. */
	onChoose(): void;
	/** Escape: the box was cleared; give focus back. */
	onLeave(): void;
	inputRef: React.Ref<HTMLInputElement>;
}

const styles = {
	wrap: { display: 'inline-flex', alignItems: 'center', gap: 8 } as CSSProperties,
	input: { fontSize: 12, padding: '3px 8px', minWidth: 170, background: 'var(--rr-bg-input)', color: 'var(--rr-text-primary)', border: '1px solid var(--rr-border-input)', borderRadius: 4 } as CSSProperties,
	status: { fontSize: 12, color: 'var(--rr-text-secondary)', whiteSpace: 'nowrap' } as CSSProperties,
};

/**
 * The search box.
 *
 * @param props - See {@link ICanvasSearchProps}.
 * @returns The box and its status.
 */
export const CanvasSearch: React.FC<ICanvasSearchProps> = ({ value, onChange, count, current, onStep, onChoose, onLeave, inputRef }) => {
	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key === 'Enter') {
			event.preventDefault();
			onChoose();
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			onStep(event.key === 'ArrowDown' ? 1 : -1);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			onChange('');
			onLeave();
		}
	};
	return (
		<span style={styles.wrap}>
			<input ref={inputRef} type="search" style={styles.input} placeholder="Search on canvas (name, label, any property)" aria-label="Search the drawn nodes" aria-keyshortcuts="/" value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} />
			<span style={styles.status} role="status">{count !== null ? searchStatusText(count, current) : ''}</span>
		</span>
	);
};

export default CanvasSearch;
