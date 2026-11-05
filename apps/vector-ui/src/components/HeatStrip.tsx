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
// VECTOR-UI — HeatStrip (per-chunk similarity of one document to the active query)
// =============================================================================
//
// One cell per chunk in reading order; the bar height is the similarity (so
// colour is not the only carrier) and every cell speaks it ("Chunk 3:
// similarity 0.412"). A chunk with no score is a flat, empty cell. One tab
// stop for the whole strip: arrow keys, Home and End move between chunks,
// Enter or a click selects one.
// =============================================================================

import React, { useState } from 'react';
import type { HeatStripProps } from '../contract/types';
import { ACCENT_TOKEN, OUTLINE_TOKEN } from '../map/tokens';

export type { HeatStripProps };

/**
 * The heat strip.
 *
 * @param props - Chunk count, scores, focused chunk, handler, accessible name.
 * @returns A toolbar of chunk cells.
 */
export function HeatStrip(props: HeatStripProps): React.ReactElement {
	const count = Math.max(0, Math.floor(props.chunks));
	const byChunk = new Map<number, number>();
	for (const s of props.scores) byChunk.set(s.chunkId, s.sim);
	let lo = Infinity;
	let hi = -Infinity;
	for (const v of byChunk.values()) {
		lo = Math.min(lo, v);
		hi = Math.max(hi, v);
	}
	const [cursor, setCursor] = useState<number>(props.focused ?? 0);
	const active = Math.min(Math.max(0, props.focused ?? cursor), Math.max(0, count - 1));
	const move = (to: number, target: HTMLElement): void => {
		const next = Math.min(Math.max(0, to), count - 1);
		setCursor(next);
		const cell = target.parentElement?.querySelectorAll('button')[next] as HTMLButtonElement | undefined;
		cell?.focus();
	};
	const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
		const keys: Record<string, number> = { ArrowRight: active + 1, ArrowLeft: active - 1, Home: 0, End: count - 1 };
		if (event.key in keys) {
			event.preventDefault();
			move(keys[event.key] as number, event.currentTarget);
		}
	};
	return (
		<div role="toolbar" aria-label={props.label} style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 36, overflowX: 'auto', padding: '2px 0' }}>
			{Array.from({ length: count }, (_, c) => {
				const sim = byChunk.get(c);
				const height = sim === undefined ? 2 : 6 + 26 * (hi > lo ? (sim - lo) / (hi - lo) : 1);
				const focused = props.focused === c;
				return (
					<button
						key={c}
						type="button"
						tabIndex={c === active ? 0 : -1}
						aria-current={focused ? true : undefined}
						aria-label={sim === undefined ? `Chunk ${c}: no similarity` : `Chunk ${c}: similarity ${sim.toFixed(3)}`}
						title={sim === undefined ? `Chunk ${c}` : `Chunk ${c}: ${sim.toFixed(3)}`}
						onClick={() => props.onSelectChunk(c)}
						onKeyDown={onKeyDown}
						style={{
							flex: '0 0 auto',
							width: Math.max(4, Math.min(14, Math.floor(600 / Math.max(1, count)))),
							height,
							padding: 0,
							border: focused ? `2px solid var(${OUTLINE_TOKEN})` : `1px solid var(${OUTLINE_TOKEN})`,
							background: sim === undefined ? 'transparent' : `var(${ACCENT_TOKEN})`,
							cursor: 'pointer',
						}}
					/>
				);
			})}
		</div>
	);
}

export default HeatStrip;
