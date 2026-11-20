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
// VECTOR-UI — PointInspector (the selected chunk, its neighbours, and actions)
// =============================================================================
//
// What the selected point is (path, chunk of N, length, text), how similar it
// is to the active query (and the pipeline's own score when known), its 12
// nearest chunks in the whole collection, and the actions that land back in the
// console: Open document, Find similar, Move to trash (gated; when it is not
// available the reason is shown as text). Beside them:
//
//   - Add as example (+) / (−): the point becomes a Recommend example;
//   - Show full text: the chunk's whole text with the query's words marked
//     (ChunkTextPanel), fetched once per key, stepping through the document;
//   - with Tree edges drawn, the point's neighbours in the spanning tree.
//
// The inspector itself holds no state (the text section does), so its
// buttons can be pressed in the tests by calling it.
// =============================================================================

import React from 'react';
import type { ExamplePolarity, PointInspectorProps as ContractPointInspectorProps, VectorKey } from '../contract/types';
import { documentOf, pointKey } from '../map/model';
import { MAP_STYLES } from '../map/styles';
import { num } from '../map/wording';
import { ChunkTextSection, chunkTextScope } from './ChunkTextPanel';
import type { LoadChunkText } from './ChunkTextPanel';
import { NeighbourList } from './NeighbourList';

/** Props: the frozen ones plus what the map fetched and holds. */
export interface PointInspectorProps extends ContractPointInspectorProps {
	/** Full chunk text (light mode fetches it through `chunks`), or null. */
	text?: string | null;
	/** The pipeline's own score of this chunk for the query, when known. */
	score?: number | null;
	/** A busy line while neighbours or text load. */
	busy?: string | null;
	/** Why the neighbours could not be loaded. */
	error?: string | null;
	/** A neighbour row was chosen (select it on the map); defaults to Find similar. */
	onSelectNeighbour?(key: VectorKey): void;
	/** Fetch a chunk's full text (the map binds `fetchChunkText` to its channel); offers Show full text. */
	loadText?: LoadChunkText;
	/** The connection the sample was drawn from: the full texts are kept per connection and sample. */
	connectionKey?: string;
	/** The active query's text, whose words the full text marks. */
	query?: string | null;
	/** The side this point is on as a Recommend example, or null. */
	examplePolarity?: ExamplePolarity | null;
}

/**
 * The inspector.
 *
 * @param props - Sample, point, neighbours, query similarity, write availability, actions.
 * @returns The panel.
 */
export function PointInspector(props: PointInspectorProps): React.ReactElement {
	const { sample, index } = props;
	if (index === null || index < 0 || index >= sample.result.n) {
		return <p style={MAP_STYLES.note}>Click a point or use the arrow keys to inspect a chunk. Enter selects, Escape clears.</p>;
	}
	const result = sample.result;
	const doc = documentOf(result, index);
	const [objectId, chunkId] = pointKey(result, index);
	const key: VectorKey = [objectId, chunkId];
	const snippet = props.text ?? result.points.snip?.[index] ?? null;
	const removed = sample.removed.includes(objectId);
	const path = doc?.path ?? objectId;
	const select = props.onSelectNeighbour ?? props.onFindSimilar;
	const tree = props.treeNeighbours ?? [];
	return (
		<section aria-label="Selected chunk">
			<h3 style={MAP_STYLES.heading}>{path}</h3>
			<p style={MAP_STYLES.small}>
				Chunk {num(chunkId)}
				{doc?.chunks !== null && doc?.chunks !== undefined ? ` of ${num(doc.chunks)}` : ''} · {num(result.points.len[index] ?? 0)} characters
				{result.points.pinned[index] ? <span style={MAP_STYLES.tag}>pinned</span> : null}
				{removed ? <span style={MAP_STYLES.tag}>removed</span> : null}
				{props.examplePolarity ? <span style={MAP_STYLES.tag}>{props.examplePolarity} example</span> : null}
			</p>
			{props.querySim !== null ? (
				<p style={MAP_STYLES.small}>
					Similarity to the query {props.querySim.toFixed(3)}
					{props.score !== null && props.score !== undefined ? ` · pipeline score ${props.score.toFixed(3)}` : ''}
				</p>
			) : null}
			{snippet ? <p style={{ ...MAP_STYLES.text, whiteSpace: 'pre-wrap', margin: '6px 0' }}>{snippet}</p> : <p style={MAP_STYLES.note}>This sample carries no text for its points (light mode).</p>}
			{props.loadText || props.onShowText ? <ChunkTextSection key={chunkTextScope(props.connectionKey, sample.sampleId)} connectionKey={props.connectionKey} sampleId={sample.sampleId} chunkKey={key} label={`${path} #${chunkId}`} chunks={doc?.chunks ?? null} query={props.query ?? null} loadText={props.loadText} onShowText={props.onShowText} hostText={props.text ?? null} /> : null}
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
				<button type="button" style={MAP_STYLES.button} onClick={() => props.onOpenDocument(objectId, chunkId)}>
					Open document
				</button>
				<button type="button" style={MAP_STYLES.button} onClick={() => props.onFindSimilar([objectId, chunkId])}>
					Find similar
				</button>
				<button type="button" style={MAP_STYLES.button} disabled={!props.writes.enabled || removed} onClick={() => props.onRemoveDocument(objectId)}>
					Move to trash
				</button>
			</div>
			{props.onAddExample ? (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '0 0 8px' }}>
					<button type="button" style={MAP_STYLES.button} aria-label="Add as a positive example for Recommend" aria-pressed={props.examplePolarity === 'positive'} onClick={() => props.onAddExample?.(key, 'positive')}>
						Add as example (+)
					</button>
					<button type="button" style={MAP_STYLES.button} aria-label="Add as a negative example for Recommend" aria-pressed={props.examplePolarity === 'negative'} onClick={() => props.onAddExample?.(key, 'negative')}>
						Add as example (−)
					</button>
				</div>
			) : null}
			{!props.writes.enabled && props.writes.reason ? <p style={MAP_STYLES.note}>{props.writes.reason}</p> : null}
			{props.busy ? (
				<p style={MAP_STYLES.note} role="status">
					{props.busy}
				</p>
			) : null}
			{props.error ? <p style={MAP_STYLES.note}>{props.error}</p> : null}
			{tree.length > 0 ? (
				<>
					<h4 style={{ ...MAP_STYLES.heading, fontSize: 12 }}>Tree neighbours</h4>
					<ol aria-label="Neighbours in the spanning tree" style={MAP_STYLES.list}>
						{tree.map((nb) => {
							const nbKey = pointKey(result, nb.i);
							return (
								<li key={nb.i} style={MAP_STYLES.row}>
									<button type="button" style={MAP_STYLES.linkButton} onClick={() => select(nbKey)}>
										{documentOf(result, nb.i)?.path ?? nbKey[0]} #{nbKey[1]}
									</button>
									<span style={MAP_STYLES.small}> similarity {nb.sim.toFixed(3)}</span>
								</li>
							);
						})}
					</ol>
				</>
			) : null}
			{props.neighbours ? (
				<>
					<h4 style={{ ...MAP_STYLES.heading, fontSize: 12 }}>{num(props.neighbours.items.length)} nearest in the collection</h4>
					<NeighbourList items={props.neighbours.items} onSelect={(k) => select(k)} />
				</>
			) : null}
		</section>
	);
}

export default PointInspector;
