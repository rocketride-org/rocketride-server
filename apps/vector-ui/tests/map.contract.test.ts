// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP CONTRACT: no raw vectors in src/map, the query vector's only uses, no writes
// =============================================================================
//
// Raw vectors leave a store node only through `vectors` (at most two keys) and
// `embed`. The map never calls `vectors`; the one query vector `embed` returns is
// held by the view (views/MapView.tsx) and sent, unchanged, only to `project`,
// `search` and `neighbors` (scope scores). No module under src/map ever receives
// it. Writes are asked of the console (actions.requestRemove), never called here.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SRC = path.resolve(__dirname, '..', 'src');
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const read = (rel: string): string => strip(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const mapFiles = fs.readdirSync(path.join(SRC, 'map')).filter((f) => /\.tsx?$/.test(f));
const MAP_COMPONENTS = ['MapToolbar', 'PointCanvas', 'PointInspector', 'NeighbourList', 'DuplicatesPanel', 'OutliersPanel', 'PointsTable', 'Legend', 'HeatStrip'];

test('no module under src/map receives a raw vector: no vectors or embed answer types, no vector-valued fields', () => {
	assert.ok(mapFiles.length >= 20, `${mapFiles.length} map modules`);
	for (const file of mapFiles) {
		const text = read(`map/${file}`);
		assert.doesNotMatch(text, /\bIVectorItem\b|\bIVectorsResult\b|\bIEmbedResult\b|\bIEmbedInput\b/, `${file} names a vector-bearing wire type`);
		assert.doesNotMatch(text, /\.values\b(?!\s*\()|\.vectors\b(?!\s*\()|\bvectors\s*:/, `${file} reads a vector field`);
		assert.doesNotMatch(text, /'embed'|'vectors'/, `${file} calls a vector-returning tool`);
	}
	for (const name of MAP_COMPONENTS) {
		const text = read(`components/${name}.tsx`);
		assert.doesNotMatch(text, /\bIEmbedResult\b|\bIVectorItem\b|\.vectors\b|'embed'|'vectors'/, `${name} touches a vector`);
	}
});

/** Every callTool call in a source: the tool and the text of its input object. */
function toolCalls(text: string): Array<{ tool: string; input: string }> {
	const out: Array<{ tool: string; input: string }> = [];
	const re = /callTool(?:<[^>]*>)?\(\s*[\w.?]+\s*,\s*'([a-z_]+)'\s*,\s*|call(Recommend|SimilarityMatrix)\(\s*[\w.?]+\s*,\s*/g;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		// The input runs to the comma that closes it at depth 0.
		let depth = 0;
		let end = re.lastIndex;
		for (; end < text.length; end += 1) {
			const c = text[end];
			if (c === '{' || c === '(' || c === '[') depth += 1;
			else if (c === '}' || c === ')' || c === ']') depth -= 1;
			else if (c === ',' && depth === 0) break;
		}
		const tool = m[1] ?? (m[2] === 'Recommend' ? 'recommend' : 'similarity_matrix');
		out.push({ tool, input: text.slice(re.lastIndex, end) });
	}
	return out;
}

test('the view calls embed at one place, never vectors, and sends a query vector only to project, search, neighbors and recommend', () => {
	const view = read('views/MapView.tsx');
	const calls = toolCalls(view);
	const tools = calls.map((c) => c.tool);
	assert.equal(tools.filter((t) => t === 'embed').length, 1, `tools called: ${tools.join(', ')}`);
	assert.ok(!tools.includes('vectors'));
	for (const required of ['sample', 'project', 'search', 'neighbors', 'chunks', 'recommend']) assert.ok(tools.includes(required), `the view calls ${required}`);
	const carrying = calls.filter((c) => /\bvector\b|queryVector/.test(c.input));
	assert.ok(carrying.length >= 3, 'the query vector is sent somewhere');
	for (const c of carrying) assert.ok(['project', 'search', 'neighbors', 'recommend'].includes(c.tool), `${c.tool} receives the query vector`);
	// Recommend carries the query vector the view holds (or none), never another vector.
	const recommend = calls.find((c) => c.tool === 'recommend');
	assert.match(recommend?.input ?? '', /vector: request\.withQuery \? queryVector\.current : null/);
	// The vector is taken from the embed answer as it came (no rounding or copying into a map module).
	assert.match(view, /\.vectors\[0\]/);
	assert.doesNotMatch(view, /vectors\[0\]\.map\(|toFixed\([^)]*\)[^;]*vector/);
});

test('the map never calls a write tool: removals are asked of the console, which confirms them', () => {
	const sources = [...mapFiles.map((f) => read(`map/${f}`)), read('views/MapView.tsx'), ...MAP_COMPONENTS.map((n) => read(`components/${n}.tsx`))];
	for (const text of sources) assert.doesNotMatch(text, /'remove_document'|'delete'|'soft_delete'|'restore'|'upsert'/);
	assert.match(read('views/MapView.tsx'), /actions\.requestRemove\(/);
});

test('components keep their frozen export names and extend the frozen props in their own files', () => {
	for (const name of [...MAP_COMPONENTS, 'MapView']) {
		const file = name === 'MapView' ? 'views/MapView.tsx' : `components/${name}.tsx`;
		const text = read(file);
		assert.match(text, new RegExp(`export function ${name}\\(`), `${file} exports ${name}`);
		assert.match(text, new RegExp(`export default ${name};`), `${file} default-exports ${name}`);
		assert.doesNotMatch(text, /data-placeholder/, `${file} is still the placeholder`);
	}
	assert.match(read('components/PointCanvas.tsx'), /export interface PointCanvasProps extends ContractPointCanvasProps/);
	assert.match(read('views/MapView.tsx'), /export function MapView\(props: MapViewProps\)/);
});

test('map/calls.ts forwards a call\'s input untouched: it never reads a field of it, so it never reads the query vector it carries', () => {
	const calls = read('map/calls.ts');
	assert.match(calls, /channel\.invoke<T>\(tool, input, /);
	assert.doesNotMatch(calls, /\binput\s*(\.|\[)|\bvector\b/, 'calls.ts reads the input');
	// The view's own header says what is true: the vector passes through calls.ts, no map module reads or keeps it.
	assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'views', 'MapView.tsx'), 'utf8'), /nothing under src\/map receives it/);
});
