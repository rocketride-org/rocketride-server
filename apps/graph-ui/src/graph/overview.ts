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
// GRAPH - OVERVIEW MODEL (pure: what the Overview shows, from the loaded schema)
// =============================================================================
//
// Everything the Overview draws comes from the schema the last load returned (an
// `ISchemaView`), so opening it sends nothing. This module decides the words and the
// geometry; the components only paint them.
//
// What it may claim follows the evidence (graph/schema.ts): an estimated count reads
// "about N", an absent one "not reported", and a total is shown only when every item
// has a count. An empty graph is said only for a fresh, successful read with no
// labels and no relationship types: an old node's empty answer, or a failed read, is
// not an empty graph. Relationship endpoints are sampled, so the picture is captioned
// "observed patterns" by its component.
// =============================================================================

import { labelPreview } from '../cypher/recipes';
import { engineText } from './dialect';
import type { IGraphDialect } from './dialect';
import { labelColors } from './colors';
import { sizeText, unreadSchemaText } from './connections';
import { ageText, schemaStatusText } from './schema';
import type { ISchemaEndpoint, ISchemaProperty, ISchemaView } from './schema';
import type { IConnectionStyle } from './userData';

// =============================================================================
// TYPES
// =============================================================================

/** What the Overview is showing. */
export type OverviewState = 'loading' | 'ready' | 'empty' | 'unavailable' | 'unknown';

/** What the model is built from. */
export interface IOverviewInput {
	/** The loaded schema; null before a load has completed (a frame until the view arrives). */
	view: ISchemaView | null;
	dialect: IGraphDialect | null;
	/** The connection's stored colours. */
	style: IConnectionStyle;
	/** False until the style has loaded: labels are then drawn in a neutral colour, so none shows a default and then shifts. */
	ready: boolean;
	/** The connection's chips, in the words the cards use (graph/connections.ts `connectionChips`). */
	chipLabels: readonly string[];
	endpoint: { nodeName: string; pipelineName: string };
	/** The current time (ms since the epoch), for the schema's age. */
	now: number;
}

/** One count tile. */
export interface IOverviewTile {
	id: 'nodes' | 'relationships' | 'labels' | 'types' | 'keys';
	label: string;
	value: string;
	/** A short qualifier under the value, or ''. */
	note: string;
}

/** A property as the cards list it. */
export interface IOverviewProperty {
	name: string;
	/** The observed types, upper-case, joined by ` | `. */
	types: string;
}

/** A label card. */
export interface IOverviewLabel {
	name: string;
	/** Display text: `about 2`, `5` or `not reported`. */
	count: string;
	/** The colour (a CSS value). */
	fill: string;
	properties: IOverviewProperty[];
	/** Hover text naming the label. */
	title: string;
	/** `MATCH (n:Label) RETURN n LIMIT 25`, or null when the engine cannot take the name. */
	cypher: string | null;
	/** Why there is no query, or null. */
	refusal: string | null;
}

/** One start and end pair of a relationship type. */
export interface IOverviewPattern extends ISchemaEndpoint {
	/** True when the picture draws it (both labels are listed). */
	drawn: boolean;
}

/** A row of the relationship table. */
export interface IOverviewType {
	type: string;
	patterns: IOverviewPattern[];
	count: string;
	/** `since INTEGER, role STRING`, or ''. */
	properties: string;
}

/** A circle of the schema graph. */
export interface IGraphNodeShape {
	label: string;
	x: number;
	y: number;
	r: number;
	fill: string;
	/** `Person (about 22)`. */
	caption: string;
}

/** An arrow of the schema graph. */
export interface IGraphEdgeShape {
	id: string;
	type: string;
	from: string;
	to: string;
	/** False for a pattern the node inferred rather than saw. */
	observed: boolean;
	loop: boolean;
	/** SVG path data. */
	path: string;
	/** Where the type's name sits. */
	labelX: number;
	labelY: number;
}

/** The drawn schema graph, or the reason it is a list. */
export type OverviewGraph =
	| { kind: 'drawn'; width: number; height: number; nodes: IGraphNodeShape[]; edges: IGraphEdgeShape[]; /** Patterns left out because a label is not listed. */ undrawn: number }
	| { kind: 'list'; labels: number };

/** The Overview, ready to paint. */
export interface IOverviewModel {
	state: OverviewState;
	headline: string;
	/** A sentence under the headline (the evidence, or what is wrong), or ''. */
	notice: string;
	/** The database's own text when a read failed, or ''. */
	detail: string;
	/** `Neo4j 5.26.31 Community · database neo4j · via ... · schema refreshed 4 minutes ago`. */
	subtitle: string;
	/** The size line, in the words the cards and the drawer use (`60 nodes (per label) · 92 relationships`), or ''. */
	size: string;
	tiles: IOverviewTile[];
	chips: string[];
	graph: OverviewGraph | null;
	labels: IOverviewLabel[];
	types: IOverviewType[];
}

// =============================================================================
// WORDS
// =============================================================================

/** Past this many labels the schema graph is a list (a circle of more than this has no room for names). */
export const MAX_DRAWN_LABELS = 30;

/**
 * A count as the Overview says it.
 *
 * @param count - The count, or null when the engine did not report one.
 * @param estimated - Whether it is a catalogue estimate.
 * @returns `about 1,200`, `1,200` or `not reported`.
 */
export function countLabel(count: number | null, estimated: boolean): string {
	if (count === null) return 'not reported';
	return `${estimated ? 'about ' : ''}${count.toLocaleString('en-US')}`;
}

/**
 * The total of some counts, claimed only when every item has one.
 *
 * @param items - Counts and whether each is an estimate.
 * @returns The text for a tile.
 */
function total(items: ReadonlyArray<{ count: number | null; countEstimated: boolean }>, truncated: boolean): string {
	if (items.some((item) => item.count === null)) return 'not reported';
	const sum = items.reduce((acc, item) => acc + (item.count ?? 0), 0);
	// A listing the node cut short gives lower bounds.
	return `${truncated ? 'at least ' : ''}${countLabel(sum, items.some((item) => item.countEstimated))}`;
}

/**
 * Properties as `name TYPE | TYPE` items.
 *
 * @param properties - The schema's properties.
 * @returns One item per property.
 */
function propertyItems(properties: readonly ISchemaProperty[]): IOverviewProperty[] {
	return properties.map((p) => ({ name: p.name, types: p.types.map((t) => t.toUpperCase()).join(' | ') }));
}

/**
 * The caption saying what the counts are and that property keys are sampled.
 *
 * @param view - The schema.
 * @returns A sentence.
 */
function caption(view: ISchemaView): string {
	const items = [...view.labels, ...view.relationshipTypes];
	let counts = '';
	if (items.length > 0) {
		const reported = items.filter((i) => i.count !== null);
		if (reported.length === 0) counts = 'This engine does not report counts';
		else {
			const estimated = reported.some((i) => i.countEstimated);
			const missing = reported.length < items.length;
			if (estimated) counts = `Counts are estimates (shown as "about")${missing ? '; some are not reported' : ''}`;
			else counts = missing ? 'Some counts are not reported' : 'Counts are exact';
		}
	}
	const sampled = view.sampled ? 'property keys are sampled from a few nodes per label' : '';
	if (counts && sampled) return `${counts}; ${sampled}.`;
	return counts ? `${counts}.` : sampled ? `${sampled.charAt(0).toUpperCase()}${sampled.slice(1)}.` : '';
}

// =============================================================================
// THE SCHEMA GRAPH
// =============================================================================

/** A label's colour before its connection's style has loaded. */
const NEUTRAL_FILL = 'var(--rr-grey-400)';

const WIDTH = 560;
const HEIGHT = 380;

/**
 * Round to one decimal, so the path data stays short and stable.
 *
 * @param n - A number.
 * @returns The rounded number.
 */
function r1(n: number): number {
	return Math.round(n * 10) / 10;
}

/**
 * Place the labels on a circle and route one arrow per pattern between them.
 *
 * @param view - The schema.
 * @param fills - Each label's colour.
 * @returns The drawing.
 */
function drawGraph(view: ISchemaView, fills: ReadonlyMap<string, string>): OverviewGraph {
	const names = view.labels.map((l) => l.name);
	const n = names.length;
	const cx = WIDTH / 2;
	const cy = HEIGHT / 2 - 6;
	const ring = n <= 1 ? 0 : Math.min(WIDTH, HEIGHT) / 2 - 78;
	const radius = n <= 8 ? 26 : n <= 16 ? 20 : 14;
	const at = new Map<string, { x: number; y: number; ox: number; oy: number }>();
	const nodes: IGraphNodeShape[] = view.labels.map((label, i) => {
		const angle = n <= 1 ? -Math.PI / 2 : -Math.PI / 2 + (2 * Math.PI * i) / n;
		const ox = Math.cos(angle);
		const oy = Math.sin(angle);
		const x = r1(cx + ring * ox);
		const y = r1(cy + ring * oy);
		at.set(label.name, { x, y, ox, oy });
		return { label: label.name, x, y, r: radius, fill: fills.get(label.name) ?? 'var(--rr-grey-400)', caption: label.count === null ? label.name : `${label.name} (${countLabel(label.count, label.countEstimated)})` };
	});

	// Patterns between the same two labels take different bows; loops stack outward.
	const slots = new Map<string, number>();
	const sizes = new Map<string, number>();
	const wanted: Array<{ type: string; endpoint: ISchemaEndpoint }> = [];
	let undrawn = 0;
	for (const type of view.relationshipTypes) {
		for (const endpoint of type.endpoints) {
			if (!at.has(endpoint.start) || !at.has(endpoint.end)) {
				undrawn += 1;
				continue;
			}
			wanted.push({ type: type.type, endpoint });
			const key = endpoint.start === endpoint.end ? `loop|${endpoint.start}` : [endpoint.start, endpoint.end].sort().join('|');
			sizes.set(key, (sizes.get(key) ?? 0) + 1);
		}
	}
	const edges: IGraphEdgeShape[] = wanted.map(({ type, endpoint }, index) => {
		const a = at.get(endpoint.start) as { x: number; y: number; ox: number; oy: number };
		const b = at.get(endpoint.end) as { x: number; y: number; ox: number; oy: number };
		const loop = endpoint.start === endpoint.end;
		const key = loop ? `loop|${endpoint.start}` : [endpoint.start, endpoint.end].sort().join('|');
		const k = slots.get(key) ?? 0;
		slots.set(key, k + 1);
		const id = `${index}:${type}`;
		if (loop) {
			// Out from the circle's far side from the centre, a little larger for each further loop.
			const ox = n <= 1 ? 0 : a.ox;
			const oy = n <= 1 ? -1 : a.oy;
			const reach = radius + 40 + 22 * k;
			const px = -oy;
			const py = ox;
			const sx = a.x + (ox * Math.cos(0.5) - oy * Math.sin(0.5)) * radius;
			const sy = a.y + (oy * Math.cos(0.5) + ox * Math.sin(0.5)) * radius;
			const ex = a.x + (ox * Math.cos(-0.5) - oy * Math.sin(-0.5)) * (radius + 5);
			const ey = a.y + (oy * Math.cos(-0.5) + ox * Math.sin(-0.5)) * (radius + 5);
			const spread = 18 + 8 * k;
			const c1x = a.x + ox * reach + px * spread;
			const c1y = a.y + oy * reach + py * spread;
			const c2x = a.x + ox * reach - px * spread;
			const c2y = a.y + oy * reach - py * spread;
			return { id, type, from: endpoint.start, to: endpoint.end, observed: endpoint.observed, loop, path: `M ${r1(sx)} ${r1(sy)} C ${r1(c1x)} ${r1(c1y)} ${r1(c2x)} ${r1(c2y)} ${r1(ex)} ${r1(ey)}`, labelX: r1(a.x + ox * (radius + 36 + 22 * k)), labelY: r1(a.y + oy * (radius + 36 + 22 * k)) };
		}
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const length = Math.hypot(dx, dy) || 1;
		const ux = dx / length;
		const uy = dy / length;
		// The bow is measured from one fixed direction between the pair, so A to B and B to A never share a curve.
		const forward = endpoint.start < endpoint.end ? 1 : -1;
		const px = -uy * forward;
		const py = ux * forward;
		const m = sizes.get(key) ?? 1;
		const bow = (k - (m - 1) / 2) * 44;
		const mx = (a.x + b.x) / 2 + px * bow;
		const my = (a.y + b.y) / 2 + py * bow;
		// Leave and arrive along the line to the control point, at the circle's edge.
		const sx0 = mx - a.x;
		const sy0 = my - a.y;
		const sl = Math.hypot(sx0, sy0) || 1;
		const ex0 = mx - b.x;
		const ey0 = my - b.y;
		const el = Math.hypot(ex0, ey0) || 1;
		const sx = a.x + (sx0 / sl) * radius;
		const sy = a.y + (sy0 / sl) * radius;
		const ex = b.x + (ex0 / el) * (radius + 5);
		const ey = b.y + (ey0 / el) * (radius + 5);
		return { id, type, from: endpoint.start, to: endpoint.end, observed: endpoint.observed, loop, path: `M ${r1(sx)} ${r1(sy)} Q ${r1(mx)} ${r1(my)} ${r1(ex)} ${r1(ey)}`, labelX: r1(0.25 * sx + 0.5 * mx + 0.25 * ex), labelY: r1(0.25 * sy + 0.5 * my + 0.25 * ey) };
	});
	return { kind: 'drawn', width: WIDTH, height: HEIGHT, nodes, edges, undrawn };
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Build the Overview from the loaded schema.
 *
 * @param input - The schema, engine, colours and the connection's names.
 * @returns The model to paint.
 */
export function buildOverview(input: IOverviewInput): IOverviewModel {
	const { view, dialect, endpoint } = input;
	const base: IOverviewModel = { state: 'loading', headline: 'The schema has not been loaded', notice: 'Refresh the schema to read it.', detail: '', subtitle: '', size: '', tiles: [], chips: [], graph: null, labels: [], types: [] };
	const where = dialect ? (dialect.graph ? `graph ${dialect.graph}` : dialect.database ? `database ${dialect.database}` : '') : '';
	const subtitle = [dialect ? engineText(dialect) : '', where, `via ${endpoint.pipelineName} / ${endpoint.nodeName}`, view?.refreshedAt ? `schema ${ageText(view.refreshedAt, input.now)}` : ''].filter((part) => part !== '').join(' · ');
	if (view === null) return { ...base, subtitle };

	const status = schemaStatusText(view, input.now);
	if (view.evidence === 'incapable' || view.evidence === 'error') {
		return { ...base, state: 'unavailable', headline: unreadSchemaText(view) ?? 'The schema is not available', notice: status, detail: view.error ? [view.error.headline, view.error.detail].filter((part) => part !== '').join('\n') : '', subtitle };
	}
	const nothing = view.labels.length === 0 && view.relationshipTypes.length === 0;
	if (nothing && view.evidence === 'fresh') {
		const who = dialect ? engineText(dialect) : 'The node';
		return { ...base, state: 'empty', headline: 'This graph is empty', notice: `${who} reports no labels and no relationship types for ${dialect?.graph ?? dialect?.database ?? endpoint.nodeName}. This is an empty graph, not a failed schema read.`, subtitle };
	}
	if (nothing && view.evidence === 'unknown') {
		return { ...base, state: 'unknown', headline: unreadSchemaText(view) ?? 'The node does not say what the graph holds', notice: status, subtitle };
	}

	const colors = labelColors(input.style, view.labels.map((l) => l.name));
	// Neutral until the style is ready, as the sidebar's dots are.
	const fills = new Map([...colors].map(([name, color]) => [name, input.ready ? color.fill : NEUTRAL_FILL]));
	const engine = dialect ? { dialect: dialect.dialect, version: dialect.engineVersion } : null;
	const keys = new Set<string>();
	for (const item of [...view.labels, ...view.relationshipTypes]) for (const p of item.properties) keys.add(p.name);
	const labelNames = new Set(view.labels.map((l) => l.name));

	const tiles: IOverviewTile[] = [];
	const nodesTotal = total(view.labels, view.truncated);
	tiles.push({ id: 'nodes', label: 'Nodes', value: nodesTotal, note: nodesTotal === 'not reported' || dialect?.dialect === 'age' || view.labels.length === 0 ? '' : 'per label; a node with two labels counts twice' });
	tiles.push({ id: 'relationships', label: 'Relationships', value: total(view.relationshipTypes, view.truncated), note: '' });
	tiles.push({ id: 'labels', label: 'Labels', value: view.labels.length.toLocaleString('en-US'), note: view.truncated ? 'the list was cut' : '' });
	tiles.push({ id: 'types', label: 'Relationship types', value: view.relationshipTypes.length.toLocaleString('en-US'), note: view.truncated ? 'the list was cut' : '' });
	tiles.push({ id: 'keys', label: 'Property keys', value: keys.size.toLocaleString('en-US'), note: view.sampled ? 'sampled' : '' });

	const chips: string[] = [...input.chipLabels];
	const sentence = caption(view);
	if (sentence) chips.push(sentence);

	return {
		state: 'ready',
		headline: '',
		notice: view.evidence === 'stale' || view.evidence === 'unknown' ? status : '',
		detail: '',
		subtitle,
		size: sizeText(view),
		tiles,
		chips,
		graph: view.labels.length === 0 ? null : view.labels.length > MAX_DRAWN_LABELS ? { kind: 'list', labels: view.labels.length } : drawGraph(view, fills),
		labels: view.labels.map((label) => {
			const recipe = engine ? labelPreview(engine, label.name) : null;
			return {
				name: label.name,
				count: countLabel(label.count, label.countEstimated),
				fill: fills.get(label.name) ?? 'var(--rr-grey-400)',
				properties: propertyItems(label.properties),
				title: label.name,
				cypher: recipe && 'cypher' in recipe ? recipe.cypher : null,
				refusal: recipe && 'refusal' in recipe ? recipe.refusal : engine ? null : 'The engine is not known yet.',
			};
		}),
		types: view.relationshipTypes.map((type) => ({
			type: type.type,
			patterns: type.endpoints.map((e) => ({ ...e, drawn: labelNames.has(e.start) && labelNames.has(e.end) })),
			count: countLabel(type.count, type.countEstimated),
			properties: propertyItems(type.properties).map((p) => `${p.name} ${p.types}`.trim()).join(', '),
		})),
	};
}
