// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP WIRING: rules pinned by reading the source (no React DOM harness)
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SRC = path.resolve(__dirname, '..', 'src');
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (rel: string): string => strip(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const MAP_COMPONENTS = ['MapToolbar', 'PointCanvas', 'PointInspector', 'NeighbourList', 'DuplicatesPanel', 'OutliersPanel', 'PointsTable', 'Legend', 'HeatStrip'];
const files = [...fs.readdirSync(path.join(SRC, 'map')).map((f) => `map/${f}`), ...MAP_COMPONENTS.map((n) => `components/${n}.tsx`), 'views/MapView.tsx'];

test('no map file stops event propagation or listens for keys above the map (shell drawers and dialogs keep their keys)', () => {
	for (const file of files) {
		const text = read(file);
		assert.doesNotMatch(text, /stopPropagation|stopImmediatePropagation/, `${file} stops propagation`);
		assert.doesNotMatch(text, /(window|document)\.addEventListener\(\s*'key/, `${file} listens for keys on ${'window/document'}`);
		assert.doesNotMatch(text, /from 'three'|from 'react-window'|crypto\.subtle/, `${file} uses a dependency the app may not`);
	}
});

test('the canvas observes its size, follows devicePixelRatio, redraws when revealed, and exposes data-points', () => {
	const canvas = read('components/PointCanvas.tsx');
	assert.match(canvas, /new ResizeObserver\(/);
	assert.match(canvas, /devicePixelRatio/);
	assert.match(canvas, /data-points=\{visibleCount\}/);
	assert.match(canvas, /role="application"/);
	assert.match(canvas, /tabIndex=\{0\}/);
	assert.match(canvas, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
	assert.match(canvas, /props\.visible !== false/);
	assert.match(canvas, /createWebglRenderer\(canvas, \(\) => requestDraw\(\)\) \?\? createCanvas2dRenderer\(canvas\)/);
	const gl = read('map/renderer.webgl.ts');
	assert.match(gl, /ALIASED_POINT_SIZE_RANGE/);
	assert.match(gl, /'webglcontextlost'/);
	assert.match(gl, /'webglcontextrestored'/);
});

test('the view re-reads the theme tokens when the shell switches theme, and honours reduced motion (Safari 13 listeners too)', () => {
	const view = read('views/MapView.tsx');
	assert.match(view, /new MutationObserver\(/);
	assert.match(view, /getComputedStyle\(document\.documentElement\)/);
	assert.match(view, /prefers-reduced-motion: reduce/);
	assert.match(view, /addListener\(/);
});

test('the view samples on first open with the node\'s default size, sends neighbour calls through the newest-wins queue, and lays out in the worker', () => {
	const view = read('views/MapView.tsx');
	assert.match(view, /limits\.sample_default/);
	assert.match(view, /createLatestQueue/);
	assert.match(view, /createLayoutClient\(\{ createWorker: spawnLayoutWorker \}\)/);
	assert.match(view, /overlap < [\w.]*pcaOverlap/, 'the neighbour layout is kept only when it is at least as good as PCA');
	assert.match(view, /forgetCameras\(\)/, 'a reset to no connection forgets the cameras');
	assert.match(view, /data-knn-overlap=/);
	assert.match(view, /data-pca-overlap=/);
});

test('the browser lanes can read the map\'s state: tooltip, query, rays, layout, points', () => {
	const view = read('views/MapView.tsx');
	assert.match(view, /data-query-state=/);
	assert.match(view, /data-rays=\{rays\.length\}/);
	assert.match(view, /data-layout-state=\{layoutState\}/);
	assert.match(read('components/PointCanvas.tsx'), /data-map-tooltip/);
});

test('light samples are dithered within their 2-decimal rounding on PCA, so no lattice is drawn', () => {
	assert.match(read('views/MapView.tsx'), /sample\.mode === 'light' \? ditherRounded\(pca, 0\.01, /);
});

test('the Selection tab is wired to the console unchanged: every selected document goes to requestRemove (no cap here)', () => {
	const view = read('views/MapView.tsx');
	assert.match(view, /<SelectionTab[\s\S]*?onRemove=\{\(ids\) => actions\.requestRemove\(ids\)\}/);
	assert.doesNotMatch(view, /requestRemove\([^)]*\.slice\(|\.slice\(0, limits\.write_ids_max\)/, 'the map never truncates a removal to write_ids_max');
});

test('the view gives the canvas the layout shown, the lasso count and the overlaps, so its root carries the lanes\' attribute table', () => {
	const view = read('views/MapView.tsx');
	assert.match(view, /<PointCanvas[\s\S]*?layout=\{layout\}[\s\S]*?selectionCount=\{lassoKeys\.length > 0 \? lassoKeys\.length : null\}[\s\S]*?overlap=\{quality \? \{ layout: quality\.overlap, pca: quality\.pcaOverlap \} : null\}/);
	assert.match(view, /setLayoutState\('running'\);[\s\S]{0,200}setQuality\(null\)/, 'a new run clears the previous overlaps');
	const canvas = read('components/PointCanvas.tsx');
	// Written by each frame from what it drew; React never renders them (it would overwrite the frame's values).
	assert.match(canvas, /Object\.assign\(el\.dataset, overlayDataset\(drawn\)\)/);
	assert.match(canvas, /el\.dataset\.drawCount = /);
	assert.match(canvas, /el\.dataset\.camera = cameraSignature\(camera\)/);
	assert.doesNotMatch(canvas, /data-(star|rays|links|chunk-path|draw-count|camera)=\{/);
	// The hover box is a tooltip for the lanes and assistive tech, and keeps the perf lane's attribute.
	assert.match(canvas, /<div role="tooltip" data-map-tooltip=\{tooltip\.index\}/);
});

test('the Lasso toggle stays pressed after a selection (the next outline selects again); Lasso, L or Escape turn it off', () => {
	const view = read('views/MapView.tsx');
	const onLasso = /const onLasso = useCallback\(([\s\S]*?)\n\t\t\[sample/.exec(view);
	assert.ok(onLasso, 'onLasso found');
	assert.doesNotMatch(onLasso[1] as string, /setLasso\(/, 'a finished lasso leaves the toggle as the user set it');
	assert.match(view, /onToggleLasso=\{\(\) => setLasso\(\(on\) => !on\)\}/);
	assert.match(view, /action === 'lasso'\) setLasso\(\(on\) => !on\)/);
});

test('sign-out forgets that the map sampled, so the same connection samples again on its next first open', () => {
	const view = read('views/MapView.tsx');
	const reset = /if \(state\.connectionKey === null\) \{([\s\S]*?)\n\t\t\}/.exec(view);
	assert.ok(reset, 'the reset-to-no-connection branch');
	assert.match(reset[1] as string, /autoSampled\.current = null/);
	assert.match(reset[1] as string, /forgetCameras\(\)/);
});

test('neighbour ends outside the sample survive SAMPLE_EXPIRED: the sample is drawn again (keeping the clicked key) and the point inspected again, once', () => {
	const view = read('views/MapView.tsx');
	const quiet = /const pinKeysQuiet = async \(([\s\S]*?)\n\t\};/.exec(view);
	assert.ok(quiet, 'pinKeysQuiet');
	assert.match(quiet[1] as string, /isExpired\(/);
	assert.match(quiet[1] as string, /repick\.current = \{ key: keyString\(key\[0\], key\[1\]\), drawnAt: sampleModel\.receivedAt \}/);
	assert.match(quiet[1] as string, /resample\(\[/);
	assert.match(quiet[1] as string, /!retried/, 'the second inspection does not re-sample again');
	assert.match(view, /void onPick\(index, true\)/);
	// The re-drawn sample is recognised by its arrival (a new model), not by its answer object or id: the same seed
	// and keys give the same sample id, and pinning a point also makes a new model with the same receivedAt.
	assert.match(view, /if \(pending === null \|\| !sampleModel \|\| sampleModel\.receivedAt === pending\.drawnAt\) return;/);
	assert.match(view, /void onPick\(index, true\);[\s\S]{0,120}\}, \[sampleModel\]\);/);
});

test('a chat highlight embeds the question the chat told the map, keeps a star already placed for it, and otherwise drops the map query for the sources\' centre', () => {
	const view = read('views/MapView.tsx');
	assert.match(view, /const plan = chatQueryPlan\(\{ told: state\.query, mapQuery: query\?\.text \?\? null, embedReady \}\);/);
	assert.doesNotMatch(view, /if \(state\.query && model\.embed\.enabled[^\n]*runQuery\(state\.query/, 'the old rule re-embedded the last MAP query');
	// 'run': the star of another question must not stand in while the new one is embedded (or if embedding fails).
	const run = /if \(plan === 'run'\) \{([\s\S]*?)\n\t\t\t\}/.exec(view);
	assert.ok(run, "the 'run' branch");
	assert.ok((run[1] as string).indexOf('clearQuery()') >= 0 && (run[1] as string).indexOf('clearQuery()') < (run[1] as string).indexOf('void runQuery(state.query as string, false)'), 'cleared, then embedded');
	// 'centroid': the map query is dropped, and the selection forgets it.
	const centroid = /else if \(plan === 'centroid' && \(query !== null \|\| state\.query !== null\)\) \{([\s\S]*?)\n\t\t\t\}/.exec(view);
	assert.ok(centroid, "the 'centroid' branch");
	assert.match(centroid[1] as string, /clearQuery\(\);/);
	assert.match(centroid[1] as string, /selection\.setQuery\(null\)/);
	// While the question is placed there is no star; the centre appears only if placing it fails.
	assert.match(run[1] as string, /setPlacingAnswer\(true\);/);
	assert.match(run[1] as string, /void runQuery\(state\.query as string, false\)\.finally\(\(\) => setPlacingAnswer\(false\)\);/);
	const star = /const star: IStar \| null = useMemo\(\(\) => \{([\s\S]*?)\n\t\}, \[([^\]]*)\]\);/.exec(view);
	assert.ok(star, 'the star memo');
	assert.match(star[1] as string, /if \(highlight\?\.source === 'chat'\) \{\s*if \(placingAnswer\) return null;/);
	assert.match(star[2] as string, /\bplacingAnswer\b/);
	// 'keep' changes nothing: no branch of its own.
	assert.doesNotMatch(view, /plan === 'keep'/);
	assert.match(view, /queryBlocker\(/);
});

test('a light sample on PCA says its positions are spread within their 0.01 rounding step', () => {
	const view = read('views/MapView.tsx');
	assert.match(view, /sample\?\.mode === 'light' && layout === 'pca' \? \[LIGHT_POSITIONS\]/);
});

test('a map mounted hidden holds no WebGL context: the renderer is created on the first reveal and let go only on unmount', () => {
	const canvas = read('components/PointCanvas.tsx');
	const create = /useEffect\(\(\) => \{\s*ensureMapStyle\(\);([\s\S]*?)\n\t\}, \[([^\]]*)\]\);/.exec(canvas);
	assert.ok(create, 'the renderer effect');
	assert.match(create[1] as string, /if \(!canvas \|\| !wanted \|\| rendererRef\.current !== null\) return/, 'no context while hidden, and only one');
	assert.match(create[2] as string, /\bwanted\b/, 'the effect runs again on reveal');
	assert.match(canvas, /const wanted = props\.visible !== false;/);
	assert.match(canvas, /useEffect\(\s*\(\) => \(\) => \{[\s\S]*?rendererRef\.current\?\.destroy\(\);[\s\S]*?\},\s*\[\],?\s*\);/, 'destroyed on unmount only');
	assert.match(canvas, /rendererKind === 'none' \?/, 'the no-canvas note is for a browser that cannot draw, not for a map not shown yet');
});

test('a press keeps working when the browser refuses pointer capture (the gesture starts either way)', () => {
	const canvas = read('components/PointCanvas.tsx');
	const down = /const onDown = \(event: PointerEvent\): void => \{([\s\S]*?)\n\t\t\};/.exec(canvas);
	assert.ok(down, 'onDown');
	const body = down[1] as string;
	assert.match(body, /try \{[\s\S]*?el\.setPointerCapture\(event\.pointerId\);[\s\S]*?\} catch \{/);
	assert.ok(body.indexOf('gesture.down(') > body.indexOf('} catch {'), 'gesture.down runs after (outside) the try/catch');
});

test('the Table alternative hides the canvas instead of replacing it (the lanes read data-points / data-selected while the table shows; no WebGL context per toggle)', () => {
	const view = read('views/MapView.tsx');
	const column = /<div style=\{MAP_STYLES\.canvasColumn\}>([\s\S]*?)<Legend /.exec(view);
	assert.ok(column, 'the canvas column');
	const body = column[1] as string;
	assert.match(body, /<PointsTable /);
	assert.match(body, /<PointCanvas\s/);
	assert.doesNotMatch(body, /\)\s*:\s*\(\s*<PointCanvas|:\s*<PointCanvas/, 'PointCanvas is not the other branch of the table toggle');
	assert.match(body, /\{table \? \(\s*<div[^>]*>\s*<PointsTable /, 'the table is shown only while toggled on');
	assert.match(body, /<div style=\{\{ display: table \? 'none' : 'flex', [^}]*\}\}>\s*<PointCanvas\s/, 'the canvas wrapper is hidden, not removed, under the table');
	assert.match(body, /<PointCanvas[\s\S]*?visible=\{visible && !table\}/, 'nothing is drawn (and no context created) while the table shows');
	assert.match(view, /useState\(initialTable === true\)/, 'initialTable only sets where the toggle starts');
});

test("the Heat strip tab reads the store's scope scores through heatScores: a chunk the store does not hold has no similarity, not 0", () => {
	const view = read('views/MapView.tsx');
	assert.match(view, /import \{ heatScores \} from '\.\.\/vector\/heat';/);
	assert.match(view, /scores: heatScores\(ids, answer\.value\.scores\)/);
	assert.doesNotMatch(view, /sim: scores\[t\] as number/, 'a null score was drawn as a similarity');
});

// -----------------------------------------------------------------------------
// Clusters, edges, star B, isolation, the PNG's snapshot, no browser storage
// -----------------------------------------------------------------------------

/** The body of a `const name = useCallback(...)` in a source (to its dependency list). */
function callbackBody(text: string, name: string): string {
	const at = text.indexOf(`const ${name} = useCallback(`);
	assert.ok(at >= 0, `${name} found`);
	const end = text.indexOf('\n\t);', at);
	const close = text.indexOf('}, [', at);
	return text.slice(at, Math.min(end > 0 ? end : Infinity, close > 0 ? close : Infinity));
}

test('controls over data the browser holds never sample: Minimum size, colour, edges, Expand selected, isolation', () => {
	const view = read('views/MapView.tsx');
	for (const name of ['onMinSize', 'onColourBy', 'onEdges', 'onEdgesM', 'onExpandSelected', 'onSlowEdges', 'isolate', 'onShowAll', 'onExpandIsolation']) {
		const body = callbackBody(view, name);
		assert.doesNotMatch(body, /drawSample|resample|callTool|callRecommend|channel\.invoke/, `${name} calls the store`);
	}
	// Clusters are asked only of a node that offers them, and a scope travels with the sample.
	assert.match(view, /model\.capabilities\.clusters === true \? \{ cluster: \{ method: 'knn-components' as const, labels: true \} \}/);
	assert.match(view, /scopeRef\.current \? \{ filter: \{ object_ids: \[\.\.\.scopeRef\.current\] \} \}/);
});

test('the slow-frame rule drops to 3 edges per point only while edgesAutoDegrade is on (the perf lane turns it off)', () => {
	const view = read('views/MapView.tsx');
	const body = callbackBody(view, 'onSlowEdges');
	assert.match(body, /if \(!edgesAutoDegrade \|\| edges !== 'neighbours' \|\| edgesPerPoint <= 3\) return;/);
	assert.match(view, /const edgesAutoDegrade = props\.edgesAutoDegrade !== false;/);
	const canvas = read('components/PointCanvas.tsx');
	assert.match(canvas, /if \(edgesDrawn && ended - started > SLOW_FRAME_MS\)/, 'only frames that drew edges count');
	assert.match(canvas, /cache\.slow >= 2 && !cache\.fired/, 'twice, then once per edge set');
});

test('Search\'s Compare places two stars: the highlight runs the compare plan, B is embedded through the one embed call and drawn hollow with its own rays', () => {
	const view = read('views/MapView.tsx');
	assert.match(view, /const compare = comparePlan\(\{ told: state\.query, toldB: state\.queryB, mapQuery: query\?\.text \?\? null, mapQueryB: queryB\?\.text \?\? null, embedReady \}\);/);
	assert.match(view, /if \(compare\.runB\) void runQueryB\(state\.queryB as string\);/);
	assert.match(view, /<PointCanvas[\s\S]*?starB=\{starB\}[\s\S]*?raysB=\{raysB\}/);
	const runB = /const runQueryB = async \(text: string\): Promise<void> => \{([\s\S]*?)\n\t\};/.exec(view);
	assert.ok(runB, 'runQueryB');
	assert.match(runB[1] as string, /await embedQuestion\(text\)/);
	// A question typed on the map drops the compared pair.
	assert.match(view, /if \(ownQuery\) clearCompare\(\);/);
	const canvas = read('components/PointCanvas.tsx');
	assert.match(canvas, /Object\.assign\(el\.dataset, extrasDataset\(extras\)\)/);
});

test('the edge layer is drawn on its own canvas only when the camera, the size or the edge set changes, and the frame says what it drew', () => {
	const canvas = read('components/PointCanvas.tsx');
	assert.match(canvas, /if \(!rebuild && key === cache\.drawnKey\) return false;/);
	assert.match(canvas, /el\.dataset\.edges = String\(cache\.segments\)/);
	assert.match(canvas, /edgeTransform2d\(camera, vp, size\.dpr\)/, '2D strokes the cached paths through the camera transform');
	assert.doesNotMatch(canvas, /data-edges=\{/);
});

test('the PNG copies the edge layer, then the points through the renderer\'s snapshot, then the overlay', () => {
	const canvas = read('components/PointCanvas.tsx');
	const copy = /report\(\(\): HTMLCanvasElement \| null => \{([\s\S]*?)\n\t\t\}\);/.exec(canvas);
	assert.ok(copy, 'the snapshotter');
	const body = copy[1] as string;
	const edges = body.indexOf('target.drawImage(edgeRef.current');
	const points = body.indexOf('renderer.snapshot(target)');
	const overlay = body.indexOf('target.drawImage(overlayRef.current');
	assert.ok(edges >= 0 && points > edges && overlay > points, 'edges, points, overlay');
	const view = read('views/MapView.tsx');
	assert.match(view, /const source = snap\(\);/, 'the map\'s PNG goes through the snapshot');
});

test('nothing on the map is kept in browser storage; Recommend examples live in the per-connection cache the registry clears', () => {
	const sources = [...fs.readdirSync(path.join(SRC, 'map')).map((f) => `map/${f}`), 'views/MapView.tsx', ...['MapToolbar', 'PointCanvas', 'PointsTable', 'Legend', 'ClustersPanel'].map((n) => `components/${n}.tsx`)];
	for (const file of sources) assert.doesNotMatch(read(file), /localStorage|sessionStorage|indexedDB/, file);
	const view = read('views/MapView.tsx');
	assert.match(view, /recommendExamples\.set\(model\.connectionKey, next\)/);
	assert.match(view, /recommendExamples\.get\(model\.connectionKey\) \?\? NO_EXAMPLES/);
});
