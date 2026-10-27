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
// GRAPH-UI - SPLIT DIVIDER (the separator between the editor and the results)
// =============================================================================
//
// A WAI-ARIA window splitter: role="separator", horizontal, focusable, with the
// editor's height as its value (graph/splitPane.ts). Tab reaches it; ArrowUp and
// ArrowDown move it 24 px; Home hides the editor and End shows it again; a
// double click hides or shows the editor. The surface keeps it mounted while the
// editor is hidden, so the focus stays on it after Home.
//
// A pointer drag captures the pointer (setPointerCapture) and moves only the
// divider's line while the button is down. The editor's new height is applied
// once, on release, so the results below (the canvas) resize once and refit
// once, and nothing below unmounts while dragging.
//
// Keys are this element's own onKeyDown: no document or window listener.
// =============================================================================

import React, { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { EDITOR_MIN, editorMax, splitAfterDrag, splitAfterKey, splitAria, splitToggled } from '../graph/splitPane';
import type { IEditorSplit } from '../graph/splitPane';

/** Props. */
export interface ISplitDividerProps {
	split: IEditorSplit;
	/** The space the editor and the results share, in pixels; null before it is measured. */
	available: number | null;
	onChange(split: IEditorSplit): void;
	/** What the separator separates, for its accessible name. */
	label: string;
	/** The id of the editor region it sizes. */
	controls?: string;
	/**
	 * Pixels the bar may sit over the row above (the workbench's tab row while the editor is hidden: its bottom pixels
	 * are borders, not controls), so it costs that much less height. Its 9 px hit area stays.
	 */
	overlap?: number;
}

const styles = {
	bar: (focused: boolean, offset: number, dragging: boolean, overlap: number): CSSProperties => ({
		flex: '0 0 auto',
		height: 9,
		margin: overlap > 0 ? `-${overlap}px 24px 0` : '2px 24px 0',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		cursor: 'row-resize',
		touchAction: 'none',
		outline: focused ? '2px solid var(--rr-border-focus)' : 'none',
		outlineOffset: -1,
		borderRadius: 3,
		transform: offset === 0 ? undefined : `translateY(${offset}px)`,
		position: dragging || overlap > 0 ? 'relative' : undefined,
		zIndex: dragging ? 30 : overlap > 0 ? 1 : undefined,
	}),
	grip: (active: boolean): CSSProperties => ({
		width: '100%',
		height: active ? 3 : 1,
		borderRadius: 2,
		background: active ? 'var(--rr-border-focus)' : 'var(--rr-border)',
	}),
};

/**
 * Whether an element got the focus the way that shows a ring (the keyboard), as :focus-visible says.
 *
 * @param el - The focused element.
 * @returns True for keyboard focus; true too where the browser cannot say.
 */
function keyboardFocus(el: HTMLElement): boolean {
	try {
		return el.matches(':focus-visible');
	} catch {
		return true;
	}
}

/**
 * The divider.
 *
 * @param props - See {@link ISplitDividerProps}.
 * @returns The separator.
 */
export const SplitDivider: React.FC<ISplitDividerProps> = ({ split, available, onChange, label, controls, overlap = 0 }) => {
	const [focused, setFocused] = useState(false);
	const [hovered, setHovered] = useState(false);
	// The pointer's travel while the button is down (null: no drag). Only the line moves until release.
	const [offset, setOffset] = useState<number | null>(null);
	const start = useRef<{ y: number; pointer: number } | null>(null);
	const aria = splitAria(split, available);
	const from = split.collapsed ? EDITOR_MIN : split.height;

	/** The travel a drag may cover: down to one editor line, up to the most the editor may take. */
	const clampTravel = (dy: number): number => Math.min(editorMax(available) - from, Math.max(EDITOR_MIN - from, dy));

	const finish = (apply: boolean): void => {
		const travel = offset ?? 0;
		start.current = null;
		setOffset(null);
		if (apply && travel !== 0) onChange(splitAfterDrag(split, travel, available));
	};

	return (
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-label={label}
			aria-controls={controls}
			aria-valuenow={aria.now}
			aria-valuemin={aria.min}
			aria-valuemax={Number.isFinite(aria.max) ? aria.max : undefined}
			aria-valuetext={aria.text}
			tabIndex={0}
			title={split.collapsed ? 'Drag to resize; double-click to show the editor' : 'Drag to resize; double-click to hide the editor'}
			style={styles.bar(focused, offset ?? 0, offset !== null, overlap)}
			onFocus={(event) => setFocused(keyboardFocus(event.currentTarget))}
			onBlur={() => setFocused(false)}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onKeyDown={(event) => {
				const next = splitAfterKey(split, event.key, available);
				if (next === null) return;
				event.preventDefault();
				onChange(next);
			}}
			onDoubleClick={() => onChange(splitToggled(split))}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.currentTarget.setPointerCapture(event.pointerId);
				start.current = { y: event.clientY, pointer: event.pointerId };
				setOffset(0);
			}}
			onPointerMove={(event) => {
				if (start.current === null || event.pointerId !== start.current.pointer) return;
				setOffset(clampTravel(event.clientY - start.current.y));
			}}
			onPointerUp={(event) => {
				if (start.current === null || event.pointerId !== start.current.pointer) return;
				event.currentTarget.releasePointerCapture(event.pointerId);
				finish(true);
			}}
			onPointerCancel={() => finish(false)}
			onLostPointerCapture={() => {
				if (start.current !== null) finish(true);
			}}
		>
			<div style={styles.grip(focused || hovered || offset !== null)} />
		</div>
	);
};

export default SplitDivider;
