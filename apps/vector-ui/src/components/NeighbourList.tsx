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
// VECTOR-UI — NeighbourList (the nearest chunks of the WHOLE collection)
// =============================================================================
//
// The live `neighbors` answer for the selected point: path, chunk, similarity
// (recomputed by the store's metric, the same for every visual), the driver's
// own score, and whether it is below the store's floor. Each row selects that
// chunk on the map (or projects it in when it is outside the sample).
// =============================================================================

import React from 'react';
import type { NeighbourListProps as ContractNeighbourListProps } from '../contract/types';
import { MAP_STYLES } from '../map/styles';

/** Props (frozen). */
export type NeighbourListProps = ContractNeighbourListProps;

/**
 * The neighbour list.
 *
 * @param props - Items and the select handler.
 * @returns An ordered list of buttons.
 */
export function NeighbourList(props: NeighbourListProps): React.ReactElement {
	if (props.items.length === 0) return <p style={MAP_STYLES.note}>The store returned no neighbours for this chunk.</p>;
	return (
		<ol aria-label="Nearest chunks in the collection" style={{ ...MAP_STYLES.list }}>
			{props.items.map((item, rank) => (
				<li key={`${item.key[0]}#${item.key[1]}`} style={MAP_STYLES.row}>
					<button type="button" style={MAP_STYLES.linkButton} onClick={() => props.onSelect(item.key)}>
						{rank + 1}. {item.path} #{item.chunkId}
					</button>
					<div style={MAP_STYLES.small}>
						similarity {item.sim.toFixed(3)}
						{item.score !== null && item.score !== item.sim ? ` · score ${item.score.toFixed(3)}` : ''}
						{item.below_floor ? <span style={MAP_STYLES.tag}>below floor</span> : null}
					</div>
					{item.preview ? <div style={{ ...MAP_STYLES.small, marginTop: 2 }}>{item.preview}</div> : null}
				</li>
			))}
		</ol>
	);
}

export default NeighbourList;
