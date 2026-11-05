// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Browser lane (production shell served by the real engine): Vector Explorer's
 * enrichment features, gate GE3. Chrome (installed, channel "chrome"), one
 * fresh context, one template fixture per run (argument; the four supported
 * backends are postgres, rocketride_vector, qdrant and chroma).
 *
 * Fixtures: start_fixtures.py with demo/seed_demo.sh (the demo corpus). On
 * qdrant and chroma also the scope card (SCOPE_FIXTURES; demo/gen_corpus.py
 * --seed-pad 600): 600 one-chunk documents under C:/demo/pad/ in a collection of
 * their own, a scope larger than the sampler's 500-document listing (the demo
 * collection stays as it is, so its samples keep every demo document). On
 * postgres the legacy card (LEGACY_FIXTURE; gen_corpus.py --legacy-card) over
 * vx_legacy_docs (seed_legacy.sh). The lane removes demo
 * documents (the duplicates queue, an outlier) and uploads three files of its
 * own; at the end it uploads the removed demo documents again under their own
 * names (through the store's ingest source) and removes its own uploads, so
 * the corpus is as it was.
 *
 * Steps (each records PASS/FAIL, what it measured, and a screenshot; only an
 * explicit `true` passes; a planned step the run never reached, because it
 * threw first, records FAIL with the error, and so does the run itself, in a
 * 'lane' row). "The page's answer" is the tool answer the page
 * received, read from its WebSocket frames; "the store" is read through the
 * TypeScript client with the fixture's Tools token, never through the page.
 *   clusters (P0-1): the sample was asked with clusters; at least 3 groups of
 *     5 or more; the greenhouse group is labelled 'orchid'; the Clusters tab
 *     lists the folded groups and its rows sum to n; Colour by Cluster is
 *     offered and selectable
 *   clusters: Minimum size 2 lists the node's groups of 2 or more, with no
 *     sample frame; Ask about these scopes the chat to the group's documents
 *   edges (P0-3): Tree draws n minus the kNN graph's components, Neighbours
 *     m=5 at most 5n; hovering a point thickens its edges (the map exposes no
 *     count of them, so the overlay layer's drawn pixels are compared, with
 *     the pointer over a point and away, with the edges on and off); Expand
 *     selected adds that point's kNN edges
 *   colour by ingest date (P1-3): the ramp spans the sampled documents' days
 *   isolate (P1-4): Isolate shows the lasso selection only and the table
 *     lists it; Expand by neighbours grows it; Show all restores n; after
 *     Isolate and after Show all the map frames the points it shows (once
 *     they stop moving, Fit leaves the camera where it is)
 *   text (P1-6): Show full text of a falcon chunk marks 'water' after the
 *     water question, fetched once
 *   recommend (P1-1): + a falcon chunk, - a greenhouse chunk: no greenhouse
 *     chunk in the top 12, a falcon or kestrel chunk first, examples
 *     excluded; Best score is native on Qdrant only
 *   matrix (P1-2): one group of at most 100 points with two chunks of one
 *     document, shown alone and lassoed whole (the lasso selects exactly the
 *     group): the selection's keys are sent (never indices), each a point of
 *     the group; the matrix is symmetric with a unit diagonal, same-document
 *     pairs above 0.5; its CSV (through the map's Export menu) has n rows
 *   export (P0-6): the lasso selection (some of the sample, not all of it)
 *     exports as a CSV whose rows are exactly the Selection tab's points (the
 *     keys its Copy keys puts on the clipboard, read before the export, from
 *     as many documents as its line says), no vector or secret; the map PNG
 *     is over 10 KB, drawn, named after the collection
 *   views (P1-5): a view saved with a selection survives a connection switch;
 *     applying it re-samples with its seed, pins at most 200 keys and says
 *     what it restored
 *   duplicates queue (P0-4): the two planted pairs form two groups; Keep
 *     shortest path keeps falcon_handbook.md; the panel's groups are the
 *     sample's; the slider, moved to the first position below its start at
 *     which the sample's pairs group differently, re-groups to the sample's
 *     groups there (read again after the move), with no sample frame
 *   outliers (P1-8): the OCR junk first with its why; 5 % lists more rows
 *     with no sample frame
 *   charts (P0-7): the long manual is in the top bin of chunks per document;
 *     clicking it scopes the directory to it
 *   scope (P0-2): Folder is under C:/demo/handbooks/: the directory, the
 *     map's sample and the chat's sources stay inside; the status says who
 *     filtered; saved as 'handbooks' and applied again; once it is cleared,
 *     the map, shown again, settles on an unscoped sample asked for after the
 *     Clear, as large as the clusters step's
 *   scope of 600 (qdrant, chroma; the scope card): every scoped document with
 *     a chunk is in the sample
 *   listing (qdrant, chroma; the scope card): an unscoped sample of more than
 *     500 documents says it was drawn from the first 500
 *   search (P0-5, P1-10): Keyword finds KX4471 in ops/memo_q3.txt; the
 *     threshold slider passes fewer at 0.6 than at 0.3; Copy as node setting;
 *     Compare reports the shared results and the map draws two stars (read
 *     on a settled map: its unscoped sample before Show A and B, and both
 *     stars, on that same sample, once it has settled after); the chat column
 *     is 55 % before and after the Search toggle
 *   duplicates to the trash: Move all queued to the trash, Cancel sends no
 *     write, Confirm (nothing to type: a move to the trash can be undone)
 *     moves exactly the queued documents to the trash (soft_delete, batches
 *     of at most 100, no permanent delete); the store reads each as in the
 *     trash, the active stats drop and the trash count grows by them
 *   outlier to the trash: Move to trash, confirmed, moves the OCR junk to the
 *     trash (the same checks)
 *   ingest summary (P1-9): a 3-file drop says '3 added (N chunks)'; Show new
 *     chunks pins at most 200 of them
 *   health (P1-7, postgres): the legacy card lists the chunk-0-less document
 *     and the document with one deleted chunk
 *   restore: the trashed demo documents come back through the Trash view's
 *     Restore (active again, the stats back up, the trash count down); the
 *     lane's own uploads go to the trash and are deleted permanently from
 *     the Trash view (no other document ever goes to a permanent delete);
 *     whatever the page left is then put right through the store (restore,
 *     else the corpus uploaded again; delete), so the next run starts clean
 *   sign-out: saved views and saved filters are gone after signing in again
 *   privacy (B4): over every frame (similarity_matrix rows exempt only at
 *     their own n) and every downloaded file
 *
 * Every lasso is drawn on a fitted map: Fit once the points have stopped
 * moving (no frame drawn for 700 ms), and a second Fit must leave the camera
 * (data-camera) where the first put it. A lasso over part of the canvas must
 * take some of the points drawn but not all; over all of it, every one.
 *
 * A settled map (mapSettledVerdict) is read from the app's own signals, never
 * from a quiet period: the root holds a sample (data-map-state 'ready'), the
 * toolbar shows none of the map's busy wording (mapBusy), the last sample
 * request of the map's own connection (mapCalls: its Tools task token) is
 * answered and is what the map draws whole (data-shown and the legend's
 * "Showing N of …"), and none of the map's embed, project, search or neighbors
 * calls is unanswered.
 *
 * Selectors and wording: UI below (the enrichment's controls), ui.cjs for the
 * console and map controls of the earlier lanes.
 *
 * Usage: node lane_vector_enrich.cjs [base-url] [out-dir] [fixture]
 *   (base-url and out-dir default to ENGINE_URL and OUT_DIR; fixture is one of
 *   the four supported backends, default qdrant).
 * vector-ui:e2e-live may run it as `node lane_vector_enrich.cjs <base-url> <out-dir> <browser> [backends]`:
 * once per backend into <out-dir>/<backend>, every row (with its browser and
 * backend) in <out-dir>/lane_vector_enrich.json; a backend whose run exited
 * non-zero or recorded fewer rows than it planned fails. It drives Google Chrome only.
 */
'use strict';
/* global document, window */
const E = require('../env.cjs');
const C = require('./common.cjs');
const { CONSOLE, MAP } = require('./ui.cjs');
const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RESULTS = 'lane_vector_enrich.json';
/** The browsers vector-ui:e2e-live names (third argument); this lane drives Google Chrome only. */
const RUNNER_BROWSERS = ['chrome', 'firefox', 'webkit'];
/** The supported backends (README "Supported stores"); the lane runs on one per process. */
const BACKENDS = ['postgres', 'rocketride_vector', 'qdrant', 'chroma'];

// ---------------------------------------------------------------------------
// What the lane looks for (the enrichment's controls and wording)
// ---------------------------------------------------------------------------

/** Planted facts of demo/gen_corpus.py (selftest/lane_vector_enrich.test.cjs keeps them equal). */
const CORPUS = {
	keywordToken: 'KX4471',
	keywordFile: 'ops/memo_q3.txt',
	greenhouseFolder: 'greenhouse/',
	greenhouseTerm: 'orchid',
	scopeFolder: 'C:/demo/handbooks/',
	padFolder: 'C:/demo/pad/',
	padDocuments: 600,
	falconFile: 'handbooks/falcon_handbook.md',
	recommendPositive: /(^|\/)handbooks\/falcon_handbook\.md$/,
	recommendFirst: /falcon|kestrel/,
	textWord: 'water',
};

/**
 * The lane's own cards (demo/gen_corpus.py SCOPE_CARDS and LEGACY_CARD; the selftest keeps them equal):
 * the scope cards hold the 600 padding documents in a collection of their own (--seed-pad 600), the
 * legacy card reads the legacy pgvector table (--legacy-card, after seed_legacy.sh).
 */
const SCOPE_FIXTURES = {
	qdrant: { name: 'vx-local Scope 600 (Qdrant)', projectId: '00000000-0000-4000-8000-00000000d1a9' },
	chroma: { name: 'vx-local Scope 600 (Chroma)', projectId: '00000000-0000-4000-8000-00000000d1aa' },
};
const LEGACY_FIXTURE = { name: 'vx-local Legacy (pgvector)', projectId: '00000000-0000-4000-8000-00000000d1a8' };

/** The sampler's listing cap (vx_tools.py SAMPLE_LISTING_MAX) and the pin cap (limits.project_keys_max). */
const LISTING_MAX = 500;
const PIN_MAX = 200;
/** The most keys a similarity matrix takes (limits.matrix_keys_max, vx_defaults.py). */
const MATRIX_MAX = 100;

const UI = {
	map: {
		colourBy: 'Colour by',
		clusterOption: /^Cluster$/,
		ingestDateOption: /^Ingest date$/,
		edges: 'Edges',
		edgesPerPoint: 'Edges per point',
		expandSelected: /^Expand selected$/,
		minClusterSize: 'Minimum size',
		clustersList: 'Clusters by size',
		askCluster: (i) => `Ask about the documents of cluster ${i + 1}`,
		showCluster: (i) => new RegExp(`^Show only cluster ${i + 1}: `),
		clusterRowSize: /([\d,]+) points? · ([\d,]+) documents?/,
		noiseRowSize: /([\d,]+) points? in no group/,
		ramp: /^Colour ramp from .*\((\d{4}-\d{2}-\d{2})\) to .*\((\d{4}-\d{2}-\d{2})\)$/,
		// The toolbar's busy line (a status, beside other status lines such as the Export menu's):
		// the BUSY wording of map/wording.ts.
		busy: /^(?:Sampling|Laying out|Embedding|Placing the query|Finding neighbours)…/,
		isolate: /^Isolate$/,
		expandRing: /^Expand by neighbours$/,
		showAll: /^Show all$/,
		// The Selection tab (a section of this name): its line, and Copy keys,
		// which puts the selection's keys on the clipboard as JSON.
		selectionSection: 'Selected points',
		selectionLine: /([\d,]+) points? selected from ([\d,]+) documents?/,
		copyKeys: /^Copy keys$/,
		listingCap: (documents) =>
			`Sampled from the first ${documents.toLocaleString('en-US')} documents by path; the collection has more`,
		tabs: {
			clusters: /^Clusters$/,
			duplicates: /^Duplicates$/,
			outliers: /^Outliers$/,
			recommend: /^Recommend$/,
			selection: /^Selection$/,
			point: /^Point$/,
		},
		// The map canvas's overlay layer (PointCanvas: the edges layer, the points, then the overlay),
		// where the hovered point's edges are drawn thicker.
		overlay: '.vector-map-canvas > canvas:not([data-layer])',
		// Map root attributes (data-*) the steps read.
		attr: {
			colourBy: 'data-colour-by',
			edgeMode: 'data-edge-mode',
			edgeCount: 'data-edge-count',
			minClusterSize: 'data-min-cluster-size',
			shown: 'data-shown',
			isolated: 'data-isolated',
			queryState: 'data-query-state',
			queryBState: 'data-query-b-state',
		},
		// PointCanvas root attributes each frame writes: its camera
		// (a signature that changes whenever the camera moves) and frames drawn.
		canvasAttr: { camera: 'data-camera', drawCount: 'data-draw-count' },
	},
	dedupe: {
		section: 'Near-duplicate review',
		threshold: 'Near-duplicate similarity threshold',
		policy: 'Which document each group keeps',
		shortestPath: 'shortest-path',
		keep: (p) => `Keep ${p}`,
		showGroup: /^Show group$/,
		trashAll: /^Move all queued to the trash \(/,
	},
	outliers: {
		section: '[data-component="OutliersPanel"]',
		percentile: 'Which share of the sample to review, by lowest density',
		why: /density [\d.]+ vs (?:the )?sample median [\d.]+/,
		trash: /^Move to trash$/,
	},
	inspector: {
		addPositive: 'Add as a positive example for Recommend',
		addNegative: 'Add as a negative example for Recommend',
		showFullText: /^Show full text$/,
		hideFullText: /^Hide full text$/,
	},
	recommend: {
		panel: '[data-component="RecommendPanel"]',
		strategy: 'How the examples are combined',
		bestScore: /^Best score\b/,
		run: /^Run$/,
	},
	// The matrix's Export CSV puts the matrix in the map's Export menu (entry map-matrix).
	matrix: { panel: '[data-component="SimilarityMatrix"]', exportCsv: /^Export CSV$/, exportItem: 'map-matrix' },
	text: { panel: '[data-component="ChunkTextPanel"]' },
	// An entry (data-export-item) holds one button per format (data-export-format).
	export: {
		menu: '[data-component="ExportMenu"]',
		open: /^Export/,
		item: (id) => `[data-export-item="${id}"]`,
		format: (id, format) => `[data-export-item="${id}"] [data-export-format="${format}"]`,
	},
	// The Views menu's panel saves the current view under the name in its box (the Save button's hook).
	views: {
		menu: '[data-component="SavedViewsMenu"]',
		open: /^Views/,
		panel: 'Saved views',
		name: 'View name',
		save: '[data-views-save]',
		apply: (name) => `Apply view ${name}`,
		restored: /([\d,]+) of ([\d,]+) selected points restored(?:; ([\d,]+) drawn hollow)?/,
	},
	scope: {
		add: /^Add condition$/,
		folder: /^Folder is under$/,
		editor: 'Folder is under',
		// The prefix box offers the known folders (a datalist), so its role is combobox: found by its label.
		prefix: 'Folder the paths start with',
		addButton: /^Add$/,
		saveOpen: /^Save…$/,
		saveGroup: 'Save these conditions',
		saveName: 'Name of the saved filter',
		save: /^Save$/,
		saved: /^Saved/,
		applySaved: (name) => `Apply saved filter ${name}`,
		clear: /^Clear$/,
		chip: (prefix) => `Remove condition: folder is under ${prefix}`,
		status: /([\d,]+) (?:document matches|documents match) \(store[^)]*\)|([\d,]+) of ([\d,]+) loaded match \((?:store|filtered here)[^)]*\)/,
	},
	charts: { summary: /^Charts$/, section: 'Collection charts', chunks: 'figure[data-chart="chunks"]' },
	// The shell's account menu (its initials) holds Log out.
	account: { menu: '[aria-haspopup="menu"]', initials: /^[A-Z]{1,3}$/ },
	// The console's right column stacks Add documents (45 %) over the chat (55 %): their heights are compared.
	chat: {
		searchToggle: /^Search$/,
		asking: /Asking about ([\d,]+) documents? only/,
		panel: 'section[aria-label="Chat"]',
		column: 'div[role="region"][aria-label="Chat"]',
		ingestColumn: 'div[role="region"][aria-label="Add documents"]',
	},
	search: {
		panel: '[data-component="SearchPanel"]',
		box: 'Search question',
		boxB: 'Second question (B)',
		// The mode is a radio group (Semantic, Keyword, Hybrid, Auto).
		mode: { semantic: /^Semantic$/, keyword: /^Keyword$/ },
		threshold: 'Threshold',
		run: /^Run(?: A and B)?$/,
		compare: /^Compare$/,
		showBoth: /^Show A .+ and B .+ on the map$/,
		copySetting: /^Copy as node setting$/,
		passing: /At ([\d.]+): ([\d,]+) of ([\d,]+) (?:would )?pass/,
		compareSummary: /A and B share ([\d,]+) of ([\d,]+) results? \(Jaccard ([\d.]+)\)/,
	},
	ingest: {
		root: '[data-component="IngestSummary"]',
		summary: /Drop of ([\d,]+) files?: ([\d,]+) added \(([\d,]+) chunks?\)/,
		showNew: /^Show new chunks on the map$/,
		placed: /([\d,]+) of ([\d,]+) new chunks placed/,
	},
	health: {
		section: 'Document health',
		needsAttention: /^Needs attention \(/,
		flag: (kind) => `[data-flag="${kind}"]`,
	},
};

// ---------------------------------------------------------------------------
// Helpers that need no browser (exported for the selftest)
// ---------------------------------------------------------------------------

/** en-US count words ('1,234') to a number; null when there is none. */
function count(text) {
	return typeof text === 'string' && /^[\d,]+$/.test(text.trim()) ? Number(text.replace(/,/g, '')) : null;
}

/** The document path of sample point i (null when there is none). */
function pathOf(sample, i) {
	const doc = sample && sample.docs ? sample.docs[sample.points.doc[i]] : null;
	return doc ? doc.path : null;
}

/** The objectId of sample point i (null when there is none). */
function objectIdOf(sample, i) {
	const doc = sample && sample.docs ? sample.docs[sample.points.doc[i]] : null;
	return doc ? doc.objectId : null;
}

/** The [objectId, chunkId] key of sample point i. */
function keyOf(sample, i) {
	return [objectIdOf(sample, i), sample.points.chunk[i]];
}

/** 'objectId#chunk' of a key, for set comparisons. */
function keyText(key) {
	return Array.isArray(key) ? `${key[0]}#${key[1]}` : String(key);
}

/** Indices of the sample points whose document path ends with `suffix` (a whole path segment). */
function pointsOf(sample, suffix) {
	const out = [];
	for (let i = 0; i < sample.points.doc.length; i += 1) {
		const p = pathOf(sample, i);
		if (p && (p === suffix || p.endsWith('/' + suffix))) out.push(i);
	}
	return out;
}

/**
 * The node's clusters folded at a minimum size, as the browser folds them: the groups of at
 * least `minSize` points keep their order (largest first), every other point is noise.
 * { rows: [{ cluster, size }], noise, n }.
 */
function foldClusters(sample, minSize) {
	const c = sample && sample.clusters;
	if (!c || !Array.isArray(c.sizes) || !Array.isArray(c.labels)) return null;
	const rows = [];
	c.sizes.forEach((size, cluster) => {
		if (size >= minSize) rows.push({ cluster, size });
	});
	const kept = rows.reduce((a, r) => a + r.size, 0);
	return { rows, noise: c.labels.length - kept, n: c.labels.length };
}

/** The objectIds of the points in node cluster `cluster`. */
function clusterDocuments(sample, cluster) {
	const ids = new Set();
	sample.clusters.labels.forEach((label, i) => {
		if (label === cluster) ids.add(objectIdOf(sample, i));
	});
	ids.delete(null);
	return ids;
}

/**
 * The group the matrix step shows alone and selects: the largest group of at least `minSize` points
 * (as the Clusters tab folds them) with at most `max` points and two points of one document, so its
 * matrix holds same-document pairs. { cluster, size }, or null when no group fits.
 */
function matrixCluster(sample, minSize = 5, max = MATRIX_MAX) {
	const folded = foldClusters(sample, minSize);
	if (!folded) return null;
	for (const row of folded.rows) {
		if (row.size < 2 || row.size > max) continue;
		const seen = new Set();
		let pair = false;
		sample.clusters.labels.forEach((label, i) => {
			if (label !== row.cluster) return;
			const id = objectIdOf(sample, i);
			if (seen.has(id)) pair = true;
			seen.add(id);
		});
		if (pair) return row;
	}
	return null;
}

/**
 * The labelled groups of at least `minSize` points that are mostly (over half their points)
 * documents under `folder`: [{ cluster, size, share, keywords }].
 */
function folderClusters(sample, folder, minSize = 5) {
	const c = sample && sample.clusters;
	if (!c) return [];
	const out = [];
	c.sizes.forEach((size, cluster) => {
		if (size < minSize) return;
		let inside = 0;
		c.labels.forEach((label, i) => {
			const p = label === cluster ? pathOf(sample, i) : null;
			if (p && p.includes(`/${folder}`)) inside += 1;
		});
		if (inside / size > 0.5)
			out.push({
				cluster,
				size,
				share: Math.round((inside / size) * 100) / 100,
				keywords: (c.keywords && c.keywords[cluster]) || [],
			});
	});
	return out;
}

/**
 * The clusters step's verdict: true, or why not. `x` = { input (the sample request's input),
 * sample (its answer), rows (the Clusters tab: [{ size, documents }]), noise (the Noise row's
 * points), colourOffered, colourAfter (data-colour-by after choosing Cluster) }.
 */
function clustersVerdict(x) {
	const { input, sample } = x;
	const cluster = input && input.cluster;
	if (!cluster || cluster.method !== 'knn-components' || cluster.labels !== true)
		return `the sample was not asked for clusters (input.cluster ${JSON.stringify(cluster)})`;
	if (!sample || !sample.clusters) return 'the sample answer carries no clusters';
	const folded = foldClusters(sample, 5);
	if (!folded || folded.rows.length < 3)
		return `${folded ? folded.rows.length : 0} groups of 5 or more points (at least 3 expected on the demo corpus)`;
	const greenhouse = folderClusters(sample, CORPUS.greenhouseFolder);
	if (!greenhouse.length) return 'no group is mostly greenhouse documents';
	if (!greenhouse.some((g) => g.keywords.includes(CORPUS.greenhouseTerm)))
		return (
			`no greenhouse group is labelled '${CORPUS.greenhouseTerm}': ` +
			`${JSON.stringify(greenhouse.map((g) => g.keywords))}`
		);
	if (!Array.isArray(x.rows) || x.rows.length !== folded.rows.length)
		return (
			`the Clusters tab lists ${Array.isArray(x.rows) ? x.rows.length : 'no'} groups, the sample ` +
			`has ${folded.rows.length} of 5 or more`
		);
	const sizes = x.rows.map((r) => r.size);
	if (JSON.stringify(sizes) !== JSON.stringify(folded.rows.map((r) => r.size)))
		return (
			`the rows' sizes ${JSON.stringify(sizes)} ` +
			`are not the groups' ${JSON.stringify(folded.rows.map((r) => r.size))}, largest first`
		);
	if (x.noise !== folded.noise) return `the Noise row has ${x.noise} points, ${folded.noise} expected`;
	if (sizes.reduce((a, b) => a + b, 0) + x.noise !== sample.n)
		return `the rows sum to ${sizes.reduce((a, b) => a + b, 0) + x.noise}, not n = ${sample.n}`;
	if (!x.colourOffered) return 'Colour by offers no enabled Cluster option';
	return x.colourAfter === 'cluster'
		? true
		: `after choosing Cluster the map colours by ${JSON.stringify(x.colourAfter)}`;
}

/** Minimum size: the rows at 5 and at 2 are the node's groups of at least that size, and no sample was asked. */
function minSizeVerdict({ sample, rows5, rows2, samplesSent }) {
	const at5 = foldClusters(sample, 5);
	const at2 = foldClusters(sample, 2);
	if (!at5 || !at2) return 'no clusters in the sample';
	if (rows5 !== at5.rows.length)
		return `${rows5} rows at minimum size 5, the sample has ${at5.rows.length} groups of 5 or more`;
	if (rows2 !== at2.rows.length)
		return `${rows2} rows at minimum size 2, the sample has ${at2.rows.length} groups of 2 or more`;
	if (at2.rows.length > at5.rows.length && !(rows2 > rows5)) return 'Minimum size 2 added no rows';
	return samplesSent === 0 ? true : `changing the minimum size sent ${samplesSent} sample requests`;
}

/** Union-find components of the undirected kNN graph over n points. */
function knnComponents(knn, n) {
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (a) => {
		while (parent[a] !== a) {
			parent[a] = parent[parent[a]];
			a = parent[a];
		}
		return a;
	};
	const offsets = (knn && knn.offsets_row) || [];
	const cols = (knn && knn.cols) || [];
	for (let i = 0; i < n && i + 1 < offsets.length; i += 1) {
		for (let e = offsets[i]; e < offsets[i + 1]; e += 1) {
			const j = cols[e];
			if (Number.isInteger(j) && j >= 0 && j < n && j !== i) {
				const a = find(i);
				const b = find(j);
				if (a !== b) parent[a] = b;
			}
		}
	}
	const roots = new Set();
	for (let i = 0; i < n; i += 1) roots.add(find(i));
	return roots.size;
}

/** Point i's kNN neighbours (distinct, not itself). */
function knnDegree(knn, i) {
	const offsets = (knn && knn.offsets_row) || [];
	if (i + 1 >= offsets.length) return 0;
	return new Set(knn.cols.slice(offsets[i], offsets[i + 1]).filter((j) => j !== i)).size;
}

/**
 * What hovering a point adds to the overlay over its edges: the overlay's drawn pixels with the
 * pointer over the point less those with it away, with the edges on, less the same difference with
 * the edges off (the hover ring is drawn either way; only the thickened edges differ). null when a
 * reading is missing. h = { withEdges: { away, over }, without: { away, over } }.
 */
function hoverEdgePixels(h) {
	const reads =
		h && h.withEdges && h.without ? [h.withEdges.over, h.withEdges.away, h.without.over, h.without.away] : [];
	if (reads.length !== 4 || !reads.every(Number.isFinite)) return null;
	return h.withEdges.over - h.withEdges.away - (h.without.over - h.without.away);
}

/**
 * The edges step's verdict. x = { sample, tree, neighbours5, hovered, expanded, selected }: the map's
 * edge counts (data-edge-count) for Tree and Neighbours m=5, the overlay pixels hovering a point adds
 * over its edges (hoverEdgePixels), and the edges drawn after Expand selected (Edges: None) for the
 * selected point.
 */
function edgesVerdict(x) {
	const { sample } = x;
	if (!sample || !sample.knn) return 'the sample carries no kNN graph';
	const n = sample.n;
	const tree = n - knnComponents(sample.knn, n);
	if (x.tree !== tree) return `Tree drew ${x.tree} edges; the spanning forest of the sample's kNN graph has ${tree}`;
	if (!(x.neighbours5 > 0) || x.neighbours5 > 5 * n)
		return `Neighbours m=5 drew ${x.neighbours5} edges over ${n} points (1 to ${5 * n})`;
	if (!(x.hovered > 0))
		return (
			`hovering a point drew ${x.hovered} more overlay pixels with the edges on than off: ` +
			`its edges are not drawn thicker`
		);
	if (!Number.isInteger(x.selected)) return 'no point was selected for Expand selected';
	const degree = knnDegree(sample.knn, x.selected);
	if (!(degree > 0)) return `the selected point has no kNN neighbours in the sample`;
	return x.expanded === degree
		? true
		: `Expand selected drew ${x.expanded} edges; the point has ${degree} kNN neighbours`;
}

/** The days (YYYY-MM-DD) of the earliest and latest ingest among the documents with an ingest time. */
function ingestDays(items) {
	const days = (items || [])
		.map((it) => (it && typeof it.ingestedAt === 'string' ? Date.parse(it.ingestedAt) : NaN))
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	if (!days.length) return null;
	const day = (t) => new Date(t).toISOString().slice(0, 10);
	return { first: day(days[0]), last: day(days[days.length - 1]) };
}

/** The ramp step's verdict: the legend's ramp names the sampled documents' first and last ingest days. */
function rampVerdict({ label, colourAfter, items }) {
	if (colourAfter !== 'ingest-date')
		return `after choosing Ingest date the map colours by ${JSON.stringify(colourAfter)}`;
	const days = ingestDays(items);
	if (!days) return 'no sampled document carries an ingest time (does this store keep them?)';
	const m = UI.map.ramp.exec(label || '');
	if (!m) return `the legend shows no dated ramp (${JSON.stringify(label)})`;
	return m[1] === days.first && m[2] === days.last
		? true
		: `the ramp runs ${m[1]} to ${m[2]}; the sampled documents were ingested ${days.first} to ${days.last}`;
}

/**
 * Whether the camera the app framed by itself (after Isolate or Show all) is the one Fit gives once
 * the points have stopped moving: { camera, fitted } (data-camera signatures).
 */
function framedVerdict(action, framed) {
	if (!framed || !framed.camera || !framed.fitted) return `the map reports no camera after ${action}`;
	if (framed.camera === framed.fitted) return true;
	return (
		`after ${action} the map's camera is ${framed.camera}; Fit then moves it to ${framed.fitted}: ` +
		`the map was framed on the points where they were before they moved, so it shows them zoomed past ` +
		`the canvas or drawn small`
	);
}

/**
 * Isolate: the shown points follow the selection, the table lists them, Expand grows them, Show all
 * restores n; after Isolate and after Show all the map frames the points it shows (`framing`).
 */
function isolateVerdict({ n, selection, isolated, tableRows, expanded, all, framing }) {
	if (!(selection > 0 && selection < n)) return `the lasso selected ${selection} of ${n} points`;
	if (isolated.shown !== selection || isolated.flag !== '1')
		return `Isolate shows ${isolated.shown} points (isolated ${isolated.flag}), the selection has ${selection}`;
	if (tableRows !== selection) return `the table lists ${tableRows} rows while ${selection} points are isolated`;
	if (!(expanded > selection && expanded <= n))
		return `Expand by neighbours shows ${expanded} points after ${selection}`;
	if (!(all.shown === n && all.flag === '0')) return `Show all shows ${all.shown} of ${n} (isolated ${all.flag})`;
	if (!framing) return 'the camera was not read after Isolate and Show all';
	for (const [action, framed] of [
		['Isolate', framing.isolate],
		['Show all', framing.showAll],
	]) {
		const verdict = framedVerdict(action, framed);
		if (verdict !== true) return verdict;
	}
	return true;
}

/**
 * Fit: the camera a Fit gave ({ camera }) is the one a second Fit gives ({ refit }), so the first was
 * computed over points that had stopped moving (a layout tween after Show only cluster or Show all).
 */
function fitVerdict(fit) {
	if (!fit || !fit.camera || !fit.refit) return 'the map reports no camera after Fit';
	return fit.camera === fit.refit
		? true
		: `the camera after Fit (${fit.camera}) moved on a second Fit (${fit.refit}): ` +
				`the first fit framed points that were still moving`;
}

/**
 * A lasso over the left `share` of the fitted canvas: over part of it (share < 1) it selects some of
 * the points drawn but not all of them; over all of it, every one.
 */
function lassoShareVerdict({ share, selected, shown }) {
	if (!(Number.isInteger(shown) && shown > 0)) return `the map reports ${shown} points drawn`;
	if (!(Number.isInteger(selected) && selected > 0))
		return `the lasso over the left ${Math.round(share * 100)} % of the canvas selected no point (${selected})`;
	if (share >= 1)
		return selected === shown
			? true
			: `the lasso over the whole canvas selected ${selected} of the ${shown} points drawn: ` +
					`the camera does not show all of them`;
	return selected < shown
		? true
		: `the lasso over the left ${Math.round(share * 100)} % of the canvas ` +
				`selected every one of the ${shown} points drawn: the map is not spread across the canvas`;
}

/**
 * The matrix step's lasso: one group shown alone (`shown` = the group's size),
 * the whole canvas lassoed selects exactly it.
 */
function matrixLassoVerdict({ group, shown, selected }) {
	if (!group || !(group.size >= 2)) return `the group holds ${group ? group.size : 'no'} points (a matrix needs 2)`;
	if (shown !== group.size)
		return `Show only cluster ${group.cluster + 1} shows ${shown} points (${group.size} in the group)`;
	return selected === shown
		? true
		: `the lasso over the group shown alone selects ${selected} of the ${shown} points shown`;
}

/** Full text: a mark holds the word, and the chunk's text was fetched once for its key. */
function chunkTextVerdict({ marks, calls, key }) {
	if (!Array.isArray(marks) || !marks.some((m) => m.toLowerCase() === CORPUS.textWord))
		return `no highlighted '${CORPUS.textWord}' among ${JSON.stringify((marks || []).slice(0, 8))}`;
	const fetched = (calls || []).filter(
		(c) => c.object_id === key[0] && c.after_chunk === key[1] - 1 && c.limit === 1
	);
	return fetched.length === 1 ? true : `the chunk's full text was fetched ${fetched.length} times (once expected)`;
}

/**
 * Recommend: the request names the positive and negative example keys; no item is an example,
 * none is a greenhouse chunk, the first is a falcon or kestrel chunk, at most k.
 */
function recommendVerdict({ input, answer, positive, negative }) {
	const has = (list, key) => Array.isArray(list) && list.some((k) => keyText(k) === keyText(key));
	if (!input || !has(input.positive, positive))
		return (
			`the request's positives ${JSON.stringify(input && input.positive)} ` +
			`do not hold the falcon chunk ${keyText(positive)}`
		);
	if (!has(input.negative, negative))
		return (
			`the request's negatives ${JSON.stringify(input.negative)} ` +
			`do not hold the greenhouse chunk ${keyText(negative)}`
		);
	if (!answer || answer.success !== true) return `recommend answered ${JSON.stringify(answer).slice(0, 200)}`;
	const items = Array.isArray(answer.items) ? answer.items : [];
	if (!items.length || items.length > (input.k || 12)) return `${items.length} items for k = ${input.k}`;
	const examples = new Set([...(input.positive || []), ...(input.negative || [])].map(keyText));
	const leaked = items.filter((it) => examples.has(keyText(it.key)));
	if (leaked.length) return `the examples came back: ${leaked.map((it) => keyText(it.key)).join(', ')}`;
	const greenhouse = items.filter((it) => String(it.path || '').includes(`/${CORPUS.greenhouseFolder}`));
	if (greenhouse.length) return `${greenhouse.length} greenhouse chunks among the results (${greenhouse[0].path})`;
	return CORPUS.recommendFirst.test(String(items[0].path || ''))
		? true
		: `the first result is ${items[0].path}, not a falcon or kestrel chunk`;
}

/** Best score: native on a store that flags recommend_best_score, refused UNSUPPORTED elsewhere. */
function bestScoreVerdict({ capability, answer }) {
	if (capability === true)
		return answer && answer.success === true && answer.native === true && answer.strategy_used === 'best_score'
			? true
			: `best_score answered ${JSON.stringify(answer).slice(0, 200)} on a store that flags it`;
	return answer && answer.success === false && answer.code === 'UNSUPPORTED'
		? true
		: `best_score answered ${JSON.stringify(answer).slice(0, 200)} on a store that does not flag it`;
}

/**
 * The matrix step's verdict: the selection's keys were sent (no indices, no sample id), one per
 * selected point and each one of `allowed` (the points the lasso could select); the answer is n x n, symmetric, with a
 * unit diagonal on cosine; pairs of one document average above 0.5.
 */
function matrixVerdict({ input, answer, selected, allowed }) {
	if (!input || !Array.isArray(input.keys))
		return `the request carries no keys (${JSON.stringify(input).slice(0, 160)})`;
	if ('indices' in input || 'sample_id' in input) return 'the request names sample indices or a sample id';
	const sent = new Set(input.keys.map(keyText));
	if (sent.size !== input.keys.length) return 'the request names a key twice';
	if (sent.size !== selected) return `the request's ${sent.size} keys are not the ${selected} selected points`;
	const stray = [...sent].filter((k) => !allowed.has(k));
	if (stray.length) return `${stray.length} keys sent are not points the lasso could select (${stray[0]})`;
	if (!answer || answer.success !== true) return `similarity_matrix answered ${JSON.stringify(answer).slice(0, 200)}`;
	const m = answer.matrix;
	const n = answer.n;
	if (!Array.isArray(m) || m.length !== n || m.some((row) => !Array.isArray(row) || row.length !== n))
		return `the matrix is not ${n} x ${n}`;
	if (n < 2) return `${n} keys resolved (at least 2)`;
	for (let i = 0; i < n; i += 1) {
		if (answer.metric === 'cosine' && Math.abs(m[i][i] - 1) > 0.01) return `the diagonal holds ${m[i][i]} at ${i}`;
		for (let j = 0; j < i; j += 1)
			if (Math.abs(m[i][j] - m[j][i]) > 0.01) return `the matrix is not symmetric at ${i}, ${j}`;
	}
	const keys = Array.isArray(answer.keys) ? answer.keys : input.keys;
	const same = [];
	for (let i = 0; i < n; i += 1)
		for (let j = 0; j < i; j += 1) if (keys[i] && keys[j] && keys[i][0] === keys[j][0]) same.push(m[i][j]);
	if (!same.length) return 'no two keys of one document in the matrix';
	const mean = same.reduce((a, b) => a + b, 0) / same.length;
	return mean > 0.5 ? true : `pairs within one document average ${mean.toFixed(3)} (above 0.5 expected)`;
}

/** The header and rows of a CSV export (blank trailing records dropped). */
function csvTable(text) {
	// The app writes a byte-order mark first, so a spreadsheet reads the file as UTF-8.
	const records = C.csvRecords(String(text || '').replace(/^\uFEFF/, '')).filter(
		(r) => !(r.length === 1 && r[0] === '')
	);
	return { header: records[0] || [], rows: records.slice(1) };
}

/** The export file name the app gives: vector-explorer_<collection>_<kind>_<yyyymmdd-hhmm>.<ext>. */
function exportNameVerdict(name, collection, kind, ext) {
	const want = new RegExp(
		`^vector-explorer_${String(collection).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_${kind}_\\d{8}-\\d{4}\\.${ext}$`
	);
	return want.test(String(name || ''))
		? true
		: `the file is named ${JSON.stringify(name)}, expected ` +
				`vector-explorer_${collection}_${kind}_<yyyymmdd-hhmm>.${ext}`;
}

/** The Selection tab's line ('N points selected from M documents.'): { points, documents }, or null. */
function selectionLine(text) {
	const m = UI.map.selectionLine.exec(String(text ?? ''));
	return m ? { points: count(m[1]), documents: count(m[2]) } : null;
}

/** The keys Copy keys put on the clipboard (JSON: [[objectId, chunkId], ...]); null when the text is not that. */
function copiedKeys(text) {
	let keys;
	try {
		keys = JSON.parse(String(text));
	} catch {
		return null;
	}
	const isKey = (k) =>
		Array.isArray(k) &&
		k.length === 2 &&
		typeof k[0] === 'string' &&
		(typeof k[1] === 'number' || typeof k[1] === 'string');
	return Array.isArray(keys) && keys.every(isKey) ? keys : null;
}

/**
 * The selection CSV's verdict: the lasso took some of the sample but not all of it (otherwise the
 * selection's CSV cannot be told from the sample's); one row per selected point, each key one of
 * the sample's, every key once, the header carrying the point columns; the rows are exactly the
 * Selection tab's points (the keys its Copy keys gave, `selectedKeys`, as many as the canvas
 * counted) from as many documents as its line (`tab`) says; and nothing vector-like or secret in it.
 */
function selectionCsvVerdict({ csv, selection, sampleKeys, dim, secrets, selectedKeys, tab }) {
	const n = sampleKeys.length;
	if (!(Number.isInteger(selection) && selection > 0)) return `the lasso selected no point (${selection}) to export`;
	if (selection >= n)
		return (
			`the lasso selected every point of the sample (${selection} of ${n}): ` +
			`its CSV cannot be told from the sample's`
		);
	const { header, rows } = csvTable(csv);
	for (const col of ['objectId', 'chunkId', 'path'])
		if (!header.includes(col)) return `the CSV has no ${col} column (${header.join(', ')})`;
	if (rows.length !== selection) return `${rows.length} rows for ${selection} selected points`;
	const o = header.indexOf('objectId');
	const c = header.indexOf('chunkId');
	const keys = rows.map((r) => `${r[o]}#${r[c]}`);
	if (new Set(keys).size !== keys.length) return 'a key appears twice';
	const known = new Set(sampleKeys.map(keyText));
	const stray = keys.filter((k) => !known.has(k));
	if (stray.length) return `${stray.length} rows are not points of the sample (${stray[0]})`;
	// The rows must be the points selected, not any of the sample's points of that number.
	if (!Array.isArray(selectedKeys)) return "the Selection tab's keys were not read (Copy keys)";
	const chosen = selectedKeys.map(keyText);
	if (new Set(chosen).size !== chosen.length) return 'Copy keys gave a key twice';
	if (chosen.length !== selection) return `Copy keys gave ${chosen.length} keys for ${selection} selected points`;
	const rowSet = new Set(keys);
	const chosenSet = new Set(chosen);
	const unselected = keys.filter((k) => !chosenSet.has(k));
	const missing = chosen.filter((k) => !rowSet.has(k));
	if (unselected.length || missing.length)
		return (
			`the CSV's rows are not the Selection tab's points: ${unselected.length} rows not selected ` +
			`(${unselected[0] ?? '-'}), ${missing.length} selected points missing (${missing[0] ?? '-'})`
		);
	if (!tab || !Number.isInteger(tab.points) || !Number.isInteger(tab.documents))
		return `the Selection tab's line was not read (${JSON.stringify(tab)})`;
	if (tab.points !== selection)
		return `the Selection tab says ${tab.points} points selected, the canvas ${selection}`;
	const documents = new Set(rows.map((r) => r[o])).size;
	if (tab.documents !== documents)
		return `the Selection tab says ${tab.documents} documents, the CSV's rows come from ${documents}`;
	const leaks = C.downloadVectors(csv, dim, secrets);
	return leaks.length === 0 ? true : `the download holds ${leaks.join('; ')}`;
}

/**
 * A PNG's size, colour type and what a grid of sampled pixels shows: { width, height,
 * colourType, sampled, opaque (alpha > 0), distinct (colours) }. Reads 8-bit RGB and RGBA,
 * non-interlaced (what a canvas writes); null for anything else.
 */
function pngInfo(buffer) {
	const buf = Buffer.from(buffer);
	if (buf.length < 33 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
	let at = 8;
	let width = 0;
	let height = 0;
	let depth = 0;
	let colourType = 0;
	let interlace = 0;
	const idat = [];
	while (at + 8 <= buf.length) {
		const len = buf.readUInt32BE(at);
		const type = buf.toString('latin1', at + 4, at + 8);
		const data = buf.subarray(at + 8, at + 8 + len);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			depth = data[8];
			colourType = data[9];
			interlace = data[12];
		} else if (type === 'IDAT') idat.push(data);
		else if (type === 'IEND') break;
		at += 12 + len;
	}
	const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
	if (!width || !height || depth !== 8 || !channels || interlace !== 0) return null;
	let raw;
	try {
		raw = zlib.inflateSync(Buffer.concat(idat));
	} catch {
		return null;
	}
	const stride = width * channels;
	if (raw.length < height * (stride + 1)) return null;
	const pixels = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y += 1) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let x = 0; x < stride; x += 1) {
			const a = x >= channels ? pixels[y * stride + x - channels] : 0;
			const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
			const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
			let v = line[x];
			if (filter === 1) v += a;
			else if (filter === 2) v += b;
			else if (filter === 3) v += Math.floor((a + b) / 2);
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			pixels[y * stride + x] = v & 0xff;
		}
	}
	let opaque = 0;
	let sampled = 0;
	const colours = new Set();
	const steps = 24;
	for (let gy = 0; gy < steps; gy += 1) {
		for (let gx = 0; gx < steps; gx += 1) {
			const x = Math.floor(((gx + 0.5) * width) / steps);
			const y = Math.floor(((gy + 0.5) * height) / steps);
			const o = y * stride + x * channels;
			const alpha = channels === 4 ? pixels[o + 3] : 255;
			sampled += 1;
			if (alpha > 0) {
				opaque += 1;
				colours.add(`${pixels[o]},${pixels[o + 1]},${pixels[o + 2]}`);
			}
		}
	}
	return { width, height, colourType, sampled, opaque, distinct: colours.size };
}

/**
 * The map PNG's verdict: over 10 KB, a picture with drawn (non-transparent, more than one colour) pixels,
 * named after the collection.
 */
function pngVerdict({ name, bytes, collection }) {
	const named = exportNameVerdict(name, collection, 'map', 'png');
	if (named !== true) return named;
	if (!bytes || bytes.length <= 10 * 1024)
		return `the PNG is ${bytes ? bytes.length : 0} bytes (over 10 KB expected)`;
	const info = pngInfo(bytes);
	if (!info) return 'the download is not an 8-bit RGB(A) PNG';
	if (!(info.opaque > 0)) return `every sampled pixel of the ${info.width} x ${info.height} PNG is transparent`;
	return info.distinct >= 2 ? true : `the sampled pixels hold ${info.distinct} colour (nothing drawn)`;
}

/** Saved views: the apply re-sampled with the view's seed, pinned at most 200 keys and said what it restored. */
function viewsVerdict({ listedAfterSwitch, saved, apply, line }) {
	if (!listedAfterSwitch) return 'the saved view is not listed after switching connections and back';
	if (!apply || !apply.input) return 'applying the view drew no sample';
	if (apply.input.seed !== saved.seed)
		return `the view was saved with seed ${saved.seed}, applied with ${apply.input.seed}`;
	const pinned = Array.isArray(apply.input.include_keys) ? apply.input.include_keys.length : 0;
	if (pinned > PIN_MAX) return `${pinned} keys pinned (at most ${PIN_MAX})`;
	const m = UI.views.restored.exec(line || '');
	if (!m) return `no restore line (${JSON.stringify(String(line || '').slice(0, 120))})`;
	const restored = count(m[1]);
	const of = count(m[2]);
	const hollow = m[3] ? count(m[3]) : 0;
	if (of !== saved.selection)
		return `the line restores ${restored} of ${of}; the view held ${saved.selection} selected points`;
	return restored <= of && hollow <= PIN_MAX ? true : `the line restores ${restored} of ${of} with ${hollow} hollow`;
}

/**
 * The duplicates queue's groups across documents at a threshold, from the sample the page holds:
 * every pair at or above it (the node's duplicate pairs and the kNN edges), joined into connected
 * groups of points, each named by the documents it touches; a group inside one document (repeated
 * text) is left out, as the queue lists it apart. Each group is its paths, sorted; the groups sorted.
 */
function dedupeGroupsAt(sample, threshold) {
	const n = sample && Number.isInteger(sample.n) ? sample.n : 0;
	const parent = new Map();
	const find = (i) => {
		let x = i;
		while ((parent.get(x) ?? x) !== x) x = parent.get(x);
		return x;
	};
	const touched = new Set();
	const add = (i, j, sim) => {
		if (i === j || !(sim >= threshold) || !(i >= 0 && j >= 0 && i < n && j < n)) return;
		touched.add(i);
		touched.add(j);
		const a = find(i);
		const b = find(j);
		if (a !== b) parent.set(a, b);
	};
	for (const pair of (sample && sample.duplicates) || []) add(pair.a, pair.b, pair.sim);
	const knn = (sample && sample.knn) || {};
	const offsets = knn.offsets_row || [];
	for (let i = 0; i < offsets.length - 1 && i < n; i += 1)
		for (let e = offsets[i]; e < offsets[i + 1]; e += 1) add(i, knn.cols[e], knn.sims[e]);
	const members = new Map();
	for (const i of touched) {
		const root = find(i);
		if (!members.has(root)) members.set(root, new Set());
		members.get(root).add(pathOf(sample, i));
	}
	const groups = new Set();
	for (const paths of members.values()) if (paths.size > 1) groups.add([...paths].sort().join('\n'));
	return [...groups].sort().map((g) => g.split('\n'));
}

/** Groups as one comparable text (order inside and across groups ignored). */
function groupsText(groups) {
	return JSON.stringify((groups || []).map((g) => [...g].sort().join('\n')).sort());
}

/**
 * The first position of the duplicates slider below `from` (its grid: `min` up in `step`s) at which
 * the sample's groups across documents differ from those at `from`; null when none does.
 */
function regroupThreshold(sample, from, { min, step }) {
	const start = groupsText(dedupeGroupsAt(sample, from));
	const steps = Math.round((from - min) / step);
	for (let s = steps - 1; s >= 0; s -= 1) {
		const t = Number((min + s * step).toFixed(3));
		if (t < from && groupsText(dedupeGroupsAt(sample, t)) !== start) return t;
	}
	return null;
}

/**
 * The duplicates queue's verdict: each planted pair in one group (two groups), the shortest-path
 * policy keeps falcon_handbook.md and queues the other document of each planted pair (the panel's
 * "queued" marks, which its data-queued count agrees with); the panel's groups at the start are the
 * sample's at that threshold (`expectedBefore`), and moving the slider from `from` to `to` (a
 * position the sample's pairs re-group at) changed them into the sample's groups there
 * (`groupsAfter`, read after the move, against `expectedAfter`), with no sample request.
 */
function dedupeVerdict({
	groups,
	keptPaths,
	queuedPaths,
	queuedCount,
	samplesSent,
	from,
	to,
	thresholdAfter,
	groupsAfter,
	expectedBefore,
	expectedAfter,
}) {
	const planted = E.DEMO_CORPUS.nearDuplicates;
	const holding = planted.map(([a, b]) =>
		(groups || []).findIndex((g) => g.some((p) => p.endsWith('/' + a)) && g.some((p) => p.endsWith('/' + b)))
	);
	if (holding.some((i) => i < 0))
		return `planted pairs in no group: ${JSON.stringify(planted.filter((_, i) => holding[i] < 0))}`;
	if (holding[0] === holding[1]) return 'the two planted pairs share one group';
	if (!(keptPaths || []).some((p) => p.endsWith('/' + CORPUS.falconFile)))
		return `Keep shortest path keeps ${JSON.stringify(keptPaths)}, not ${CORPUS.falconFile}`;
	const queuedList = queuedPaths || [];
	const unqueued = planted.filter((pair) => !pair.some((f) => queuedList.some((p) => p.endsWith('/' + f))));
	if (unqueued.length)
		return (
			`no document of the planted pair ${JSON.stringify(unqueued[0])} is queued ` +
			`(${JSON.stringify(queuedList)})`
		);
	if (queuedList.some((p) => (keptPaths || []).includes(p))) return 'a kept document is also queued';
	if (queuedCount !== queuedList.length)
		return `the panel counts ${queuedCount} queued documents and marks ${queuedList.length}`;
	if (groupsText(groups) !== groupsText(expectedBefore))
		return (
			`at ${from} the panel shows ${(groups || []).length} groups across documents, ` +
			`the sample's pairs give ${(expectedBefore || []).length} (${groupsText(expectedBefore).slice(0, 200)})`
		);
	if (to === null || to === undefined)
		return `no position of the slider below ${from} changes the sample's groups: the step cannot show a re-group`;
	if (thresholdAfter !== String(to)) return `the slider reads ${thresholdAfter} after moving it to ${to}`;
	if (!Array.isArray(groupsAfter)) return `the groups were not read after the slider moved to ${to}`;
	if (groupsText(groupsAfter) === groupsText(groups))
		return (
			`the groups did not change when the slider moved from ${from} to ${to} ` +
			`(the sample's pairs give ${(expectedAfter || []).length} groups there, ${groups.length} at ${from})`
		);
	if (groupsText(groupsAfter) !== groupsText(expectedAfter))
		return (
			`at ${to} the panel shows ${groupsText(groupsAfter).slice(0, 200)}, ` +
			`the sample's pairs give ${groupsText(expectedAfter).slice(0, 200)}`
		);
	return samplesSent === 0 ? true : `moving the slider sent ${samplesSent} sample requests`;
}

/** The distinct object_ids a list of write inputs asked for, sorted. */
function idsAsked(sent) {
	return [...new Set((sent || []).flatMap((s) => (Array.isArray(s.object_ids) ? s.object_ids : [])))].sort();
}

/**
 * Move to the trash: exactly the expected documents went to soft_delete (in batches of at most 100) and
 * no permanent delete went out; the store reads each of them as in the trash, the active stats dropped
 * by them and the trash count (where the store counts it) grew by them.
 */
function trashVerdict({ expected, sent, deleted, before, after, chunks, states }) {
	if ((sent || []).some((s) => Array.isArray(s.object_ids) && s.object_ids.length > 100))
		return 'a move-to-trash batch held more than 100 documents';
	if (deleted) return `the page sent ${deleted} permanent delete requests for a move to the trash`;
	const want = [...new Set(expected)].sort();
	const got = idsAsked(sent);
	if (JSON.stringify(want) !== JSON.stringify(got))
		return `moved ${JSON.stringify(got)} to the trash, expected ${JSON.stringify(want)}`;
	const notTrashed = want.filter((id) => !states || states[id] !== 'trash');
	if (notTrashed.length)
		return `the store reads ${notTrashed[0]} as ${states ? states[notTrashed[0]] : 'nothing'}, not in the trash`;
	if (!before || !after) return 'the store was not read before and after';
	if (after.documents !== before.documents - want.length)
		return (
			`the store holds ${after.documents} active documents after, ${before.documents} before ` +
			`(${want.length} moved to the trash)`
		);
	if (Number.isInteger(chunks) && after.chunks !== before.chunks - chunks)
		return `the store holds ${after.chunks} active chunks after, ${before.chunks} before (${chunks} moved)`;
	if (
		Number.isInteger(before.deleted_documents) &&
		after.deleted_documents !== before.deleted_documents + want.length
	)
		return (
			`the trash holds ${after.deleted_documents} documents after, ${before.deleted_documents} before ` +
			`(${want.length} moved to it)`
		);
	return true;
}

/**
 * Restore: the trashed demo documents went back through the Trash view's Restore (exactly those, none
 * refused), the store reads each as active again, the active stats grew and the trash count (where the
 * store counts it) shrank by them; the lane's own uploads the store held were deleted permanently from
 * the Trash view (exactly those, none refused), no other document ever went to a permanent delete, and
 * the store no longer knows any of the lane's uploads.
 */
function restoreVerdict({
	trashed,
	restoreSent,
	refusedRestore,
	back,
	before,
	after,
	own,
	stored,
	deleteSent,
	refusedDelete,
	ownStates,
}) {
	const want = [...new Set(trashed || [])].sort();
	if (!want.length)
		return 'no demo document was moved to the trash (the trash steps did not run), so nothing was restored';
	if (!(own || []).length)
		return 'the lane uploaded nothing (the ingest summary step did not run), so nothing was deleted';
	const restored = idsAsked(restoreSent);
	if (JSON.stringify(restored) !== JSON.stringify(want))
		return `restored ${JSON.stringify(restored)}, expected ${JSON.stringify(want)}`;
	if ((refusedRestore || []).length)
		return `the page did not restore ${refusedRestore[0]} (restored through the store instead)`;
	const notBack = want.filter((id) => !back || back[id] !== 'active');
	if (notBack.length)
		return `after Restore the store reads ${notBack[0]} as ${back ? back[notBack[0]] : 'nothing'}, not active`;
	if (!before || !after) return 'the store was not read before and after the restores';
	if (after.documents !== before.documents + want.length)
		return (
			`the store holds ${after.documents} active documents after the restores, ${before.documents} before ` +
			`(${want.length} restored)`
		);
	if (
		Number.isInteger(before.deleted_documents) &&
		after.deleted_documents !== before.deleted_documents - want.length
	)
		return (
			`the trash holds ${after.deleted_documents} documents after the restores, ` +
			`${before.deleted_documents} before (${want.length} restored)`
		);
	const deleted = idsAsked(deleteSent);
	const foreign = deleted.filter((id) => !own.includes(id));
	if (foreign.length) return `a permanent delete asked for ${foreign[0]}, not one of the lane's own uploads`;
	const held = [...new Set(stored || [])].sort();
	if (JSON.stringify(deleted) !== JSON.stringify(held))
		return `deleted ${JSON.stringify(deleted)} permanently, expected the stored uploads ${JSON.stringify(held)}`;
	if ((refusedDelete || []).length)
		return `the page did not delete ${refusedDelete[0]} permanently (deleted through the store instead)`;
	const left = own.filter((id) => !ownStates || ownStates[id] !== 'gone');
	return left.length
		? `after Delete permanently the store reads the lane's upload ${left[0]} as ` +
				`${ownStates ? ownStates[left[0]] : 'nothing'} (deleted through the store instead)`
		: true;
}

/**
 * Outliers: the node's first outlier is the OCR junk, the first row names it with its why;
 * 5 % lists more, with no sample request.
 */
function outliersVerdict({ sample, rows1, rows5, samplesSent }) {
	const first = sample && sample.outliers && sample.outliers.length ? pathOf(sample, sample.outliers[0]) : null;
	if (!first || !first.endsWith('/' + E.DEMO_CORPUS.outlier))
		return `the sample's first outlier is ${first}, not ${E.DEMO_CORPUS.outlier}`;
	if (!Array.isArray(rows1) || rows1.length !== sample.outliers.length)
		return `${rows1 ? rows1.length : 'no'} rows at 1 % for the node's ${sample.outliers.length} outliers`;
	if (!rows1[0].includes(first) || !UI.outliers.why.test(rows1[0]))
		return (
			`the first row ${JSON.stringify(String(rows1[0]).slice(0, 120))} ` +
			`does not name ${first} with its density`
		);
	if (!Array.isArray(rows5) || !(rows5.length > rows1.length))
		return `${rows5 ? rows5.length : 'no'} rows at 5 % after ${rows1.length} at 1 %`;
	return samplesSent === 0 ? true : `changing the percentile sent ${samplesSent} sample requests`;
}

/** Charts: the top bin of chunks per document holds the long manual; clicking it scopes the directory to it. */
function chartsVerdict({ topBin, documents, directory, chip }) {
	if (!topBin) return 'the chunks-per-document chart has no bars';
	const manual = (documents || []).find((d) => String(d.path || '').endsWith('/' + E.DEMO_CORPUS.longManual));
	if (!manual) return `the directory rows hold no ${E.DEMO_CORPUS.longManual}`;
	const most = Math.max(...documents.map((d) => d.chunks || 0));
	if (manual.chunks !== most) return `the long manual has ${manual.chunks} chunks, another document ${most}`;
	if (!chip) return 'clicking the top bin added no scope condition';
	if (!directory.length || !directory.some((p) => p.endsWith('/' + E.DEMO_CORPUS.longManual)))
		return 'the scoped directory does not list the long manual';
	const others = directory.filter((p) => (documents.find((d) => d.path === p) || {}).chunks < manual.chunks / 2);
	return others.length === 0
		? true
		: `the scoped directory also lists ${others.length} small documents (${others[0]})`;
}

/**
 * The scope step's verdict: the directory, the sample and the chat stay inside the folder; the
 * status says who filtered (the list_documents answer's filter_applied); the saved filter applies again.
 */
function scopeVerdict({ prefix, listing, status, directory, sampleInput, sample, scopeIds, sources, reapplied }) {
	if (!listing || listing.success !== true)
		return `the scoped list_documents call answered ${JSON.stringify(listing).slice(0, 160)}`;
	const applied = listing.filter_applied;
	if (
		applied === 'server'
			? !/\(store\)/.test(status)
			: applied === 'partial'
				? !/\(store; .* filtered here\)/.test(status)
				: !/filtered here/.test(status)
	)
		return `filter_applied is ${applied} but the status says ${JSON.stringify(status)}`;
	if (!directory.length || directory.some((p) => !p.startsWith(prefix)))
		return (
			`the directory lists ${directory.length} documents, ` +
			`${directory.filter((p) => !p.startsWith(prefix)).length} outside ${prefix}`
		);
	const sent =
		sampleInput && sampleInput.filter && Array.isArray(sampleInput.filter.object_ids)
			? sampleInput.filter.object_ids
			: null;
	if (!sent || sent.length !== scopeIds.length || sent.some((id) => !scopeIds.includes(id)))
		return (
			`the map's sample was not scoped to the ${scopeIds.length} documents ` +
			`(filter ${JSON.stringify(sampleInput && sampleInput.filter).slice(0, 120)})`
		);
	const outside = (sample && sample.docs ? sample.docs : []).filter((d) => !scopeIds.includes(d.objectId));
	if (!sample || !sample.docs || !sample.docs.length || outside.length)
		return `the scoped sample holds ${outside.length} documents outside the scope`;
	if (!Array.isArray(sources) || !sources.length) return 'the scoped chat answer cites no chunk';
	const stray = sources.filter((p) => !p.startsWith(prefix));
	if (stray.length) return `the chat cites ${stray[0]} outside ${prefix}`;
	return reapplied ? true : "the saved filter 'handbooks' did not bring the condition back";
}

/** The 600-document scope: the sample was asked for every scoped id and lists every one (each has a chunk). */
function scope600Verdict({ sampleInput, sample, scopeIds }) {
	if (scopeIds.length !== CORPUS.padDocuments)
		return (
			`the pad scope resolved to ${scopeIds.length} documents ` +
			`(${CORPUS.padDocuments} seeded? gen_corpus.py --seed-pad)`
		);
	const sent = sampleInput && sampleInput.filter ? sampleInput.filter.object_ids : null;
	if (!Array.isArray(sent) || sent.length !== scopeIds.length)
		return `the sample was scoped to ${Array.isArray(sent) ? sent.length : 'no'} documents`;
	const docs = new Set((sample && sample.docs ? sample.docs : []).map((d) => d.objectId));
	const missing = scopeIds.filter((id) => !docs.has(id));
	if (missing.length)
		return (
			`${missing.length} scoped documents are not in the sample ` +
			`(listing ${JSON.stringify(sample && sample.listing)})`
		);
	return [...docs].every((id) => scopeIds.includes(id)) ? true : 'the sample holds documents outside the scope';
}

/**
 * The listing step's verdict: an unscoped sample of a collection above the cap says it stopped at the cap,
 * and the legend says so.
 */
function listingVerdict({ sample, legend, documents }) {
	if (!(documents > LISTING_MAX))
		return `the collection holds ${documents} documents (more than ${LISTING_MAX} needed; seed the padding)`;
	const listing = sample && sample.listing;
	if (!listing || listing.truncated !== true || listing.reason !== 'cap')
		return `the sample's listing is ${JSON.stringify(listing)}, not truncated at the cap`;
	if (!(sample.caveats || []).includes('listing_truncated')) return 'the answer lacks the listing_truncated caveat';
	return String(legend || '').includes(UI.map.listingCap(listing.documents))
		? true
		: `the legend does not say "${UI.map.listingCap(listing.documents)}"`;
}

/** Keyword search: the request is a keyword search for the token, and the planted document is the first result. */
function keywordVerdict({ input, answer, firstRow }) {
	if (!input || input.mode !== 'keyword' || input.query !== CORPUS.keywordToken)
		return `the search request was ${JSON.stringify(input).slice(0, 160)}`;
	if ('vector' in input) return 'a keyword search sent a vector';
	const rows = answer && Array.isArray(answer.results) ? answer.results : [];
	const paths = rows.map((r) => String((r.metadata || {}).parent || r.path || ''));
	if (!paths.length || !paths[0].endsWith('/' + CORPUS.keywordFile))
		return `the first keyword result is ${paths[0]}, not ${CORPUS.keywordFile}`;
	return String(firstRow || '').includes(CORPUS.keywordFile)
		? true
		: `the first row on screen is ${JSON.stringify(String(firstRow).slice(0, 120))}`;
}

/**
 * The threshold slider: at 0.6 fewer rows pass than at 0.3, out of the same rows,
 * and the copied setting is the slider's value.
 */
function thresholdVerdict({ low, high, copied, at = { low: 0.3, high: 0.6 } }) {
	const parse = (t) => {
		const m = UI.search.passing.exec(t || '');
		return m ? { at: Number(m[1]), passing: count(m[2]), of: count(m[3]) } : null;
	};
	const a = parse(low);
	const b = parse(high);
	const lo = at.low.toFixed(2);
	const hi = at.high.toFixed(2);
	if (!a || !b) return `no passing count at both positions (${JSON.stringify([low, high])})`;
	if (a.at.toFixed(2) !== lo || b.at.toFixed(2) !== hi)
		return `the slider read ${a.at} and ${b.at}, not ${lo} and ${hi}`;
	if (a.of !== b.of) return `${a.of} rows at ${lo}, ${b.of} at ${hi}`;
	if (!(b.passing < a.passing)) return `${b.passing} pass at ${hi}, ${a.passing} at ${lo}`;
	return copied === `threshold_search: ${hi}` ? true : `Copy as node setting copied ${JSON.stringify(copied)}`;
}

/**
 * The slider positions the threshold step uses, from the scores the search answered: low passes
 * every row (0.30, or the lowest score's two-decimal floor when a row scores under 0.30), high is the
 * first two-decimal value above the median score and above the lowest, so at least one row fails
 * there. null without a scored row.
 */
function thresholdPositions(scores) {
	const s = (scores || []).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
	if (!s.length) return null;
	// In hundredths (a score of 0.69 is 69, not 68.99...).
	const hundredths = (v) => Math.floor(v * 100 + 1e-6);
	const min = hundredths(s[0]);
	const median = hundredths(s[Math.floor(s.length / 2)]);
	const low = Math.min(30, min) / 100;
	const high = Math.min(100, Math.max(median, min) + 1) / 100;
	return { low, high };
}

/** The map's busy line among the toolbar's status lines ('' while the map is idle). */
function mapBusy(texts) {
	return (Array.isArray(texts) ? texts : [])
		.map((t) => String(t || '').trim())
		.filter((t) => UI.map.busy.test(t))
		.join('; ');
}

/**
 * One connection's map calls in `capture` (the requests sent with its Tools task token; each open
 * connection has a map of its own): the answer to its last sample request ({ index, n, scoped,
 * success, code }, null while that request is unanswered) and its calls still unanswered: that
 * sample request however old, its project, search and neighbors calls sent since frame `since`,
 * and any embed sent since then (the map embeds through another task).
 */
function mapCalls(capture, since, token) {
	if (!token) return { sample: null, pending: [] };
	const tokenOf = (x) =>
		(x.request && ((x.request.arguments && x.request.arguments.token) || x.request.token)) || null;
	const mine = (x) => tokenOf(x) === token;
	const samples = C.exchanges(capture, 'sample').filter(mine);
	const last = samples.length ? samples[samples.length - 1] : null;
	const pending = [
		...C.exchanges(capture, 'embed', since)
			.filter((x) => !x.response)
			.map(() => 'embed'),
		...['project', 'search', 'neighbors'].flatMap((tool) =>
			C.exchanges(capture, tool, since)
				.filter((x) => mine(x) && !x.response)
				.map(() => tool)
		),
	];
	if (last && !last.response) pending.unshift('sample');
	const result = last && last.response ? last.result : null;
	const sample =
		last && last.response
			? {
					index: last.index,
					n: result && typeof result.n === 'number' ? result.n : null,
					scoped: !!(last.input.filter && last.input.filter.object_ids),
					success: !!result && result.success !== false,
					code: (result && result.code) || null,
				}
			: null;
	return { sample, pending };
}

/**
 * Whether the map is settled (a reading of mapReading in the lane): its root says it holds a sample
 * (data-map-state 'ready'), the toolbar shows no busy line, none of the map's calls is in flight,
 * its last sample request was answered and that answer is what it draws whole (data-shown and the
 * legend's "Showing N of …" both its n). `expect` adds what it must hold: `scoped` (true or false),
 * `n` (the unscoped sample's size), `after` (the request was sent after that frame), `sampleIndex`
 * (the same sample request as an earlier reading) and `stars` (both placed, the legend naming B's
 * question). The app's own signals, never a quiet period: true, or why not.
 */
function mapSettledVerdict(r, expect = {}) {
	if (!r) return 'the map was not read';
	if (r.state !== 'ready') return `the map is ${r.state || 'not there'} (data-map-state)`;
	if (r.busy) return `the map is busy: ${r.busy}`;
	if (r.pending && r.pending.length)
		return `the map's ${[...new Set(r.pending)].join(', ')} call is still unanswered`;
	const s = r.sample;
	if (!s) return 'the page asked for no sample';
	if (!s.success || typeof s.n !== 'number') return `the map's last sample request was refused (${s.code || 'no n'})`;
	if (r.shown !== s.n) return `the map shows ${r.shown} points; its last sample answer has ${s.n}`;
	const legend = /Showing ([\d,]+) (?:of [\d,]+ )?chunks/.exec(r.legend || '');
	if (!legend || count(legend[1]) !== s.n)
		return `the legend says ${legend ? legend[0] : 'no sample line'}; the last sample has ${s.n} points`;
	if (expect.scoped === false && s.scoped) return `the map still draws a scoped sample (${s.n} points)`;
	if (expect.scoped === true && !s.scoped) return 'the map draws an unscoped sample';
	if ('n' in expect && typeof expect.n !== 'number')
		return 'no unscoped sample size to compare with (the clusters step drew none)';
	if ('n' in expect && s.n !== expect.n)
		return `the map's sample has ${s.n} points, not the ${expect.n} of the collection's unscoped sample`;
	if ('after' in expect && !(s.index > expect.after))
		return 'the map draws a sample asked for before the scope was cleared';
	if ('sampleIndex' in expect && s.index !== expect.sampleIndex)
		return expect.sampleIndex === null || expect.sampleIndex === undefined
			? 'no earlier sample to hold the stars on'
			: 'the map drew another sample since the earlier reading';
	if (expect.stars) {
		if (r.queryA !== 'placed' || r.queryB !== 'placed') return `the map's stars are A ${r.queryA}, B ${r.queryB}`;
		if (!String(r.legend || '').includes(`Hollow star: "${expect.stars.b}"`))
			return "the legend does not name star B's question";
	}
	return true;
}

/**
 * Compare: the summary's shared count and Jaccard are the two answers', and the map draws both
 * stars, read on a settled map: before Show A and B (the collection's unscoped sample, `n`
 * points) and again once it is settled after it (still both stars, on that same sample).
 */
function compareVerdict({ a, b, summary, starA, starB, before, after, n, questionB }) {
	const keys = (ans) =>
		new Set(
			(ans && Array.isArray(ans.results) ? ans.results : []).map(
				(r) => `${(r.metadata || {}).objectId}#${(r.metadata || {}).chunkId}`
			)
		);
	const ka = keys(a);
	const kb = keys(b);
	if (!ka.size || !kb.size) return `A found ${ka.size}, B ${kb.size}`;
	const shared = [...ka].filter((k) => kb.has(k)).length;
	const jaccard = shared / new Set([...ka, ...kb]).size;
	const m = UI.search.compareSummary.exec(summary || '');
	if (!m) return `no compare summary (${JSON.stringify(String(summary).slice(0, 120))})`;
	if (count(m[1]) !== shared) return `the summary says ${m[1]} shared; the answers share ${shared}`;
	if (Math.abs(Number(m[3]) - jaccard) > 0.006) return `the summary's Jaccard ${m[3]} is not ${jaccard.toFixed(2)}`;
	const ready = mapSettledVerdict(before, { scoped: false, n });
	if (ready !== true) return `before Show A and B: ${ready}`;
	if (starA !== 'placed' || starB !== 'placed') return `the map's stars are A ${starA}, B ${starB}`;
	const settled = mapSettledVerdict(after, { stars: { b: questionB }, sampleIndex: before.sample.index });
	return settled === true ? true : `once the map settled after Show A and B: ${settled}`;
}

/**
 * The console layout: the chat is 55 % of the right column's ingest and chat panels (their heights),
 * before and after the Search toggle.
 */
function layoutVerdict({ before, after }) {
	const ok = (r) => typeof r === 'number' && Math.abs(r - 0.55) <= 0.015;
	if (!ok(before)) return `the chat column is ${before} of the row before the toggle`;
	return ok(after) ? true : `the chat column is ${after} of the row after the toggle`;
}

/** Ingest: the drop summary counts the files and the chunks the store holds for them; the pin is at most 200 keys. */
function ingestVerdict({ summary, files, chunks, project, placed }) {
	const m = UI.ingest.summary.exec(summary || '');
	if (!m) return `no drop summary (${JSON.stringify(String(summary).slice(0, 120))})`;
	if (count(m[1]) !== files || count(m[2]) !== files)
		return `the summary says ${m[1]} files, ${m[2]} added; ${files} were dropped`;
	if (count(m[3]) !== chunks) return `the summary says ${m[3]} chunks; the store holds ${chunks} for them`;
	const keys = project && Array.isArray(project.keys) ? project.keys : null;
	if (!keys || !keys.length) return 'Show new chunks sent no project call with keys';
	if (keys.length > PIN_MAX) return `${keys.length} keys pinned (at most ${PIN_MAX})`;
	if (keys.length !== Math.min(chunks, PIN_MAX)) return `${keys.length} keys pinned of ${chunks} new chunks`;
	if (chunks > PIN_MAX && !UI.ingest.placed.test(placed || ''))
		return 'the capped pin does not say how many of the new chunks were placed';
	return true;
}

/** Health: the legacy listing's chunk-0-less document and the document with one deleted chunk, flagged. */
function healthVerdict({ items, flagged }) {
	const orphan = (items || []).find((it) => it.has_first_chunk === false);
	const deleted = (items || []).find((it) => it.deleted_chunks === 1);
	if (!orphan) return 'the legacy listing has no document without chunk 0 (seed_legacy.sh)';
	if (!deleted)
		return (
			`no document reports deleted_chunks 1 ` +
			`(${JSON.stringify((items || []).map((it) => it.deleted_chunks)).slice(0, 80)})`
		);
	if (!(flagged || []).some((f) => f.path === orphan.path && f.kind === 'no_first_chunk'))
		return `${orphan.path} is not flagged 'no first chunk'`;
	return (flagged || []).some((f) => f.path === deleted.path && f.kind === 'deleted_chunks')
		? true
		: `${deleted.path} is not flagged with its deleted chunk`;
}

/** Each planned step's title (the row name it records): stepsFor's keys to the names main runs them by. */
const STEP_TITLES = {
	clusters:
		'clusters (P0-1): at least 3 groups of 5 or more, the greenhouse group labelled orchid, ' +
		'rows summing to n, Colour by Cluster',
	'min size': 'clusters: Minimum size 2 lists the groups of 2 or more, with no sample frame',
	ask: "clusters: Ask about these scopes the chat to the group's documents",
	edges:
		'edges (P0-3): Tree draws n minus the components, Neighbours m=5 at most 5n, hover thickens, ' +
		"Expand selected adds the point's edges",
	'ingest date': "colour by ingest date (P1-3): the ramp spans the sampled documents' ingest days",
	isolate:
		'isolate (P1-4): Isolate shows the selection only, the table lists it, Expand grows it, Show all restores n',
	text: "text (P1-6): Show full text of a falcon chunk marks 'water', fetched once",
	recommend:
		'recommend (P1-1): + a falcon chunk, - a greenhouse chunk: no greenhouse chunk in the top 12, ' +
		'a falcon or kestrel chunk first',
	'best score': 'recommend: Best score is native where the store flags it and refused elsewhere',
	matrix:
		"matrix (P1-2): a lasso over one group shown alone sends the selection's keys; " +
		'symmetric, unit diagonal, same-document pairs above 0.5; its CSV has n rows',
	'export csv':
		"export (P0-6): the lasso selection's CSV holds exactly the Selection tab's points " +
		'(the keys Copy keys gives, from as many documents as it says) and no vector or secret',
	'export png': 'export: the map PNG is over 10 KB, drawn, named after the collection',
	views:
		'views (P1-5): a saved view survives a connection switch; applying it re-samples with its seed, ' +
		'pins at most 200 keys and says what it restored',
	dedupe:
		'duplicates queue (P0-4): the planted pairs form two groups, Keep shortest path keeps falcon_handbook.md, ' +
		"the slider re-groups (to the sample's own groups below the start) with no sample frame",
	outliers: 'outliers (P1-8): the OCR junk first with its why; 5 % lists more rows with no sample frame',
	charts: 'charts (P0-7): the long manual is in the top bin of chunks per document; clicking it scopes the directory',
	scope:
		"scope (P0-2): folder C:/demo/handbooks/ scopes the directory, the map's sample and the chat; " +
		'the status says who filtered; saved and applied again',
	'scope 600': 'scope of 600 (the scope card): every scoped document with a chunk is in the sample',
	'scope cleared': "scope (P0-2): clearing the scope draws the map's unscoped sample again, all of it",
	listing:
		'listing (the scope card): an unscoped sample of a collection above 500 documents ' +
		'says it was drawn from the first 500',
	keyword: 'search (P0-5): Keyword finds KX4471 in ops/memo_q3.txt as a whole word',
	threshold:
		'search: the threshold slider passes fewer rows above the median score than at the lowest; ' +
		'Copy as node setting copies the value',
	compare: 'search: Compare reports the shared results and the map draws both stars',
	layout: 'search: the chat column is 55 % before and after the Search toggle',
	'dedupe trash':
		'duplicates to the trash: Move all queued to the trash, Cancel sends nothing, ' +
		'Confirm (nothing to type) moves exactly the queued documents to the trash',
	'outlier trash': 'outlier to the trash: Move to trash, confirmed, moves the OCR junk to the trash',
	'ingest summary':
		"ingest summary (P1-9): a 3-file drop says '3 added (N chunks)'; Show new chunks pins at most 200",
	health: 'health (P1-7): the legacy card lists the chunk-0-less document and the document with one deleted chunk',
	restore:
		'restore: the trashed demo documents come back from the Trash under their own names ' +
		"and the lane's own uploads are deleted permanently",
	'sign-out': 'sign-out: saved views and saved filters are gone after signing in again',
	privacy: 'privacy (B4): no full-dimension vector outside vectors and embed answers, none in a download',
};

/**
 * The steps a fixture runs (the scope of 600 and the listing cap on the scope cards: Qdrant and Chroma;
 * health on the legacy pgvector card).
 */
function stepsFor(fixtureKey) {
	const steps = [
		'clusters',
		'min size',
		'ask',
		'edges',
		'ingest date',
		'isolate',
		'text',
		'recommend',
		'best score',
		'matrix',
		'export csv',
		'export png',
		'views',
		'dedupe',
		'outliers',
		'charts',
		'scope',
		'scope cleared',
		'keyword',
		'threshold',
		'compare',
		'layout',
		'dedupe trash',
		'outlier trash',
		'ingest summary',
		'restore',
		'sign-out',
		'privacy',
	];
	if (fixtureKey === 'qdrant' || fixtureKey === 'chroma')
		steps.splice(steps.indexOf('scope cleared') + 1, 0, 'scope 600');
	if (fixtureKey === 'qdrant' || fixtureKey === 'chroma') steps.splice(steps.indexOf('scope 600') + 1, 0, 'listing');
	if (fixtureKey === 'postgres') steps.splice(steps.indexOf('restore'), 0, 'health');
	return steps;
}

/**
 * The FAIL rows a run owes for what it did not record: one for each planned step with no row of
 * its title (the lane stopped before it), and one 'lane' row carrying the error it threw, if any.
 * A run that stops early therefore fails every step it skipped instead of leaving them out.
 */
function unrecordedRows(fixtureKey, planned, recorded, error) {
	const names = new Set((Array.isArray(recorded) ? recorded : []).map((r) => r && r.name));
	const why = error ? String(error && error.message ? error.message : error).split('\n')[0] : null;
	const rows = planned
		.filter((s) => !names.has(STEP_TITLES[s]))
		.map((s) => ({
			fixture: fixtureKey,
			name: STEP_TITLES[s],
			status: 'FAIL',
			detail: why ? `not run: the lane stopped first (${why})` : 'not run: the lane stopped before this step',
		}));
	if (why) rows.push({ fixture: fixtureKey, name: 'lane', status: 'FAIL', detail: why });
	return rows;
}

/**
 * One backend's rows in a vector-ui:e2e-live run, from its child's exit status and result file:
 * the rows it recorded, a FAIL row for each planned step it did not record (all of them when it
 * wrote no list), and, unless it wrote a 'lane' row of its own, a 'lane' FAIL row saying how it
 * ended when it skipped a planned step or exited non-zero with every row passing.
 */
function e2eBackendRows(fixtureKey, status, data) {
	const planned = stepsFor(fixtureKey);
	if (!Array.isArray(data))
		return [
			...unrecordedRows(fixtureKey, planned, [], null),
			{ fixture: fixtureKey, name: 'lane', status: 'FAIL', detail: `the lane wrote no result (exit ${status})` },
		];
	const missing = unrecordedRows(fixtureKey, planned, data, null);
	const rows = [...data, ...missing];
	const ownLaneRow = data.some((r) => r && r.name === 'lane');
	if (!ownLaneRow && missing.length)
		rows.push({
			fixture: fixtureKey,
			name: 'lane',
			status: 'FAIL',
			detail:
				`the lane exited ${status} ` +
				`having recorded ${planned.length - missing.length} of its ${planned.length} planned steps`,
		});
	else if (!ownLaneRow && status !== 0 && rows.every((r) => r.status === 'PASS'))
		rows.push({
			fixture: fixtureKey,
			name: 'lane',
			status: 'FAIL',
			detail: `the lane exited ${status} with every row passing`,
		});
	return rows;
}

/**
 * The lane's arguments: `<base-url> <out-dir> [fixture]` run directly, or
 * `<base-url> <out-dir> <browser> [backends]` from vector-ui:e2e-live.
 */
function laneArgs(args, env) {
	const [base = E.ENGINE_URL, out = E.OUT_DIR, third, fourth] = args;
	if (!RUNNER_BROWSERS.includes(third)) return { base, out, browser: null, fixtures: [third || 'qdrant'] };
	const named = (fourth || env.VECTOR_UI_E2E_BACKENDS || BACKENDS.join(','))
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
	return { base, out, browser: third, fixtures: named };
}

/** The demo corpus as gen_corpus.py writes it: relative path -> text (for the restore step). */
function demoCorpus() {
	const { spawnSync } = require('child_process');
	const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vx-enrich-demo-'));
	try {
		const run = spawnSync('python3', [path.join(__dirname, '..', 'demo', 'gen_corpus.py'), dir], {
			encoding: 'utf8',
		});
		if (run.status !== 0) throw new Error(`gen_corpus.py failed: ${run.stdout}${run.stderr}`);
		const out = {};
		const walk = (d) =>
			fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
			});
		walk(dir);
		return out;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

/**
 * One run on one backend: the planned steps (drive), then a FAIL row for each one it did not
 * record and one for the error it threw (unrecordedRows), written before main settles.
 */
async function main(fixtureKey, base, out) {
	if (!E.FIXTURES[fixtureKey] || !BACKENDS.includes(fixtureKey))
		throw new Error(`unknown fixture ${fixtureKey}; this lane runs on ${BACKENDS.join(', ')}`);
	const planned = stepsFor(fixtureKey);
	const recorder = C.createRecorder(fixtureKey, out, 'vector-enrich');
	let thrown = null;
	try {
		await drive(fixtureKey, base, out, planned, recorder.step);
	} catch (e) {
		thrown = e;
	} finally {
		for (const row of unrecordedRows(fixtureKey, planned, recorder.results, thrown))
			recorder.rec(row.name, false, row.detail);
		recorder.write(RESULTS);
	}
	if (thrown) throw thrown;
}

/** The steps of one run, in order (each records its own row through `step`). */
async function drive(fixtureKey, base, out, planned, step) {
	const { chromium } = E.loadPlaywright();
	const fixture = E.FIXTURES[fixtureKey];
	const run = nodeCrypto.randomBytes(4).toString('hex');
	const store = C.storeClient(base);
	const browser = await chromium.launch({ channel: 'chrome', headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 920 }, acceptDownloads: true });
	await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
	const page = await context.newPage();
	page.setDefaultTimeout(30000);
	const capture = C.captureFrames(page);
	const downloads = [];
	// The demo documents the trash steps moved to the trash (the restore step brings them back).
	const trashedDemo = new Set();
	const ownUploads = [];
	const map = page.locator(MAP.root).filter({ visible: true }).first();
	const canvas = map.locator(MAP.canvas).first();
	const toolbar = map.getByRole('toolbar', { name: MAP.toolbar }).first();
	const inspector = map.getByRole('region', { name: MAP.inspector }).first();

	// --- small page helpers -------------------------------------------------
	const visible = (locator) => locator.filter({ visible: true }).first();
	const attr = (name) => map.getAttribute(name).catch(() => null);
	const attrInt = async (name) => count(String((await attr(name)) ?? ''));
	/** Poll a reading until ok(value) or the timeout; the last value. */
	const poll = async (read, ok, timeout = 15000) => {
		const deadline = Date.now() + timeout;
		for (;;) {
			if (capture.sockets === 0) throw new Error('the page opened no WebSocket');
			const v = await read();
			if (ok(v) || Date.now() > deadline) return v;
			await C.sleep(200);
		}
	};
	const samplesSince = (since) => C.requestsSince(capture, since, (msg) => C.toolOf(msg) === 'sample').length;
	/**
	 * The drawn (non-transparent) pixels of the map's overlay layer (the visible map canvas's last layer),
	 * or null when it cannot be read.
	 */
	const overlayPixels = () =>
		page
			.evaluate((selector) => {
				const layers = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0);
				const layer = layers[layers.length - 1];
				const ctx = layer && layer.width > 0 && layer.height > 0 ? layer.getContext('2d') : null;
				if (!ctx) return null;
				const data = ctx.getImageData(0, 0, layer.width, layer.height).data;
				let drawn = 0;
				for (let i = 3; i < data.length; i += 4) if (data[i] > 0) drawn += 1;
				return drawn;
			}, UI.map.overlay)
			.catch(() => null);
	/** The labels of a select's options. */
	const optionsOf = async (select) => {
		const texts = await select
			.locator('option')
			.allTextContents()
			.catch(() => null);
		return Array.isArray(texts) ? texts.map((t) => String(t).trim()) : [];
	};
	/** Choose the option whose label matches; throws when there is none. */
	const choose = async (select, matches) => {
		const label = (await optionsOf(select)).find((t) => matches.test(t));
		if (!label) throw new Error(`no option matches ${matches} among ${JSON.stringify(await optionsOf(select))}`);
		await select.selectOption({ label });
		return label;
	};
	const combo = (name, scope = map) => visible(scope.getByRole('combobox', { name, exact: true }));
	const button = (name, scope = page) => visible(scope.getByRole('button', { name }));
	const sideTab = (name) => C.switchView(page, name);
	/** Open a fixture's connection and its Map tab; the page's first sample answer there. */
	const openMap = async (target) => {
		const since = capture.frames.length;
		await C.openConnection(page, target);
		await C.switchView(page, CONSOLE.mapTab);
		await canvas.waitFor({ timeout: 90000 });
		return C.waitForExchange(capture, 'sample', { since, timeout: 120000 });
	};
	const openConsole = async () => C.switchView(page, CONSOLE.consoleTab);
	const lassoThrough = async (corners) => {
		await page.mouse.move(corners[0][0], corners[0][1]);
		await page.mouse.down();
		for (const [x, y] of [...corners.slice(1), corners[0]]) await page.mouse.move(x, y, { steps: 10 });
		await page.mouse.up();
	};
	/** The map's camera (data-camera) and frames drawn (data-draw-count), as the last frame wrote them. */
	const frameState = async () => ({
		camera: await C.attrText(canvas, UI.map.canvasAttr.camera),
		draws: await C.attrText(canvas, UI.map.canvasAttr.drawCount),
	});
	/**
	 * Wait until the map draws no new frame for `quiet` ms (a layout tween, which Isolate, Show all and
	 * Show only cluster start, draws a frame each step); its frame state then, or null on the timeout.
	 */
	const settle = async (quiet = 700, timeout = 15000) => {
		const deadline = Date.now() + timeout;
		let last = await frameState();
		let since = Date.now();
		for (;;) {
			await C.sleep(100);
			const now = await frameState();
			if (now.draws !== last.draws || now.camera !== last.camera) {
				last = now;
				since = Date.now();
			} else if (Date.now() - since >= quiet) return now;
			if (Date.now() > deadline) return null;
		}
	};
	/**
	 * What the map in front holds now (judged by mapSettledVerdict): its root's data-map-state, the
	 * toolbar's busy line (mapBusy), its connection's calls (mapCalls, by the Tools task `token`:
	 * the last sample answer and the calls in flight since frame `since`), the points it shows,
	 * both stars and the legend.
	 */
	const mapReading = async (since, token) => {
		const statuses = await toolbar
			.getByRole('status')
			.allTextContents()
			.catch(() => []);
		const calls = mapCalls(capture, since, token);
		return {
			state: await attr('data-map-state'),
			busy: mapBusy(statuses),
			pending: calls.pending,
			sample: calls.sample,
			shown: await attrInt(UI.map.attr.shown),
			queryA: await attr(UI.map.attr.queryState),
			queryB: await attr(UI.map.attr.queryBState),
			legend: await C.textOf(visible(map.getByRole('region', { name: MAP.legend }))),
		};
	};
	/**
	 * Read the demo fixture's map until mapSettledVerdict(reading, expect) holds, or until `timeout`:
	 * { reading, verdict }.
	 */
	const awaitMap = async (expect, since, timeout = 120000) => {
		const deadline = Date.now() + timeout;
		if (capture.sockets === 0) throw new Error('the page opened no WebSocket');
		const token = await store.tokenOf(fixture, 'tools_1');
		for (;;) {
			if (capture.sockets === 0) throw new Error('the page opened no WebSocket');
			const reading = await mapReading(since, token);
			const verdict = mapSettledVerdict(reading, expect);
			if (verdict === true || Date.now() > deadline) return { reading, verdict };
			await C.sleep(250);
		}
	};
	/** A map reading for a step's note (the legend shortened). */
	const brief = (reading) => (reading ? { ...reading, legend: String(reading.legend || '').slice(0, 300) } : null);
	const fitButton = () => toolbar.getByRole('button', { name: MAP.fit }).first();
	/** Fit once the points have stopped moving, then Fit again: the camera of each ({ camera, refit }). */
	const fitMap = async () => {
		await settle();
		await fitButton().click();
		const first = await settle();
		await fitButton().click();
		const second = await settle();
		return { camera: first && first.camera, refit: second && second.camera };
	};
	/**
	 * What the app framed by itself (after Isolate, Show all): its camera once the points stop,
	 * and the one Fit gives then.
	 */
	const framing = async () => {
		const auto = await settle();
		await fitButton().click();
		const fitted = await settle();
		return { camera: auto && auto.camera, fitted: fitted && fitted.camera };
	};
	/**
	 * Lasso the left `share` of the fitted canvas; the canvas's selection count. Throws (the step
	 * fails with the reason) when Fit did not leave the camera fitted, or when the lasso took none of
	 * the points drawn, or all of them over part of the canvas (fewer than all over the whole of it).
	 */
	const lassoLeft = async (share) => {
		const fitted = fitVerdict(await fitMap());
		if (fitted !== true) throw new Error(fitted);
		const box = await canvas.boundingBox();
		if (!box) throw new Error('the map canvas has no size');
		const lasso = toolbar.getByRole('button', { name: MAP.lasso }).first();
		// What the canvas counted before: a reading equal to it may be the earlier selection, not this lasso's.
		const before = await C.attrInt(canvas, MAP.attr.selection);
		await lasso.click();
		// The lasso's corners stay inside the canvas (2 px in).
		const right = box.x + Math.min(box.width * share, box.width - 2);
		await lassoThrough([
			[box.x + 2, box.y + 2],
			[right, box.y + 2],
			[right, box.y + box.height - 2],
			[box.x + 2, box.y + box.height - 2],
		]);
		await poll(
			() => C.attrInt(canvas, MAP.attr.selection),
			(v) => v !== null && v > 0 && v !== before,
			5000
		);
		await C.sleep(300);
		const selected = await C.attrInt(canvas, MAP.attr.selection);
		await lasso.click();
		const took = lassoShareVerdict({ share, selected, shown: await C.attrInt(canvas, MAP.attr.points) });
		if (took !== true) throw new Error(took);
		return selected;
	};
	/**
	 * What the Selection tab holds now: its line ({ points, documents }, null when unread) and the
	 * keys its Copy keys puts on the clipboard (null when unread). The clipboard is emptied first, so
	 * an earlier copy cannot be read as this one.
	 */
	const readSelectionTab = async () => {
		await sideTab(UI.map.tabs.selection);
		const section = visible(map.getByRole('region', { name: UI.map.selectionSection, exact: true }));
		await section.waitFor({ timeout: 15000 });
		const line = selectionLine(await C.textOf(section));
		// These callbacks run in the page, not in Node, so Node's navigator support does not apply.
		// eslint-disable-next-line n/no-unsupported-features/node-builtins
		await page.evaluate(() => navigator.clipboard.writeText('')).catch(() => {});
		await button(UI.map.copyKeys, section).click();
		const text = await poll(
			// eslint-disable-next-line n/no-unsupported-features/node-builtins
			() => page.evaluate(() => navigator.clipboard.readText()).catch(() => null),
			(t) => copiedKeys(t) !== null,
			5000
		);
		return { line, keys: copiedKeys(text) };
	};
	/** Inspect sample point i through the Table alternative (pages of 100). */
	const inspectPoint = async (i) => {
		const table = toolbar.getByRole('button', { name: MAP.table }).first();
		await table.click();
		for (let p = 0; p < Math.floor(i / 100); p += 1)
			await map.getByRole('button', { name: MAP.next }).first().click();
		await map
			.getByRole('button', { name: MAP.inspectPoint(i), exact: true })
			.first()
			.click();
		await table.click();
		return poll(
			() => C.attrInt(canvas, MAP.attr.selected),
			(v) => v === i
		);
	};
	/** Run `action` and keep the file it makes the browser download: { name, bytes }. */
	const download = async (action) => {
		const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), action()]);
		const file = await d.path();
		const got = { name: d.suggestedFilename(), bytes: file ? fs.readFileSync(file) : Buffer.alloc(0) };
		downloads.push(got);
		fs.writeFileSync(path.join(out, `vector-enrich-${fixtureKey}-${got.name}`), got.bytes);
		return got;
	};
	/** Export one item of an ExportMenu (by its IExportItem id) in a format: the download. */
	const exportItem = async (scope, id, format) => {
		const menu = visible(scope.locator(UI.export.menu));
		const opener = visible(menu.getByRole('button', { name: UI.export.open }));
		if ((await C.attrText(opener, 'aria-expanded')) !== 'true') await opener.click();
		const entry = visible(page.locator(UI.export.item(id)));
		if ((await C.attrText(entry, 'data-export-state')) === 'off')
			throw new Error(`the export entry ${id} is off: ${(await C.textOf(entry)).slice(0, 120)}`);
		return download(() => visible(page.locator(UI.export.format(id, format))).click());
	};
	/**
	 * Confirm (or cancel) the move-to-trash or permanent-delete dialog in front. A move to the trash
	 * (action 'trash') can be undone and asks for nothing typed: a typed field there throws. A permanent
	 * delete (action 'delete') types what it asks for: a shared table's name, else `typedCount`.
	 */
	const answerRemoval = async (confirm, { action = 'trash', typedCount = null } = {}) => {
		const dialog = visible(page.getByRole('dialog'));
		await dialog.waitFor({ timeout: 15000 });
		if (!confirm) return button(/^Cancel$/, dialog).click();
		const typedBox = visible(dialog.getByRole('textbox'));
		const asksTyped = await typedBox.isVisible().catch(() => false);
		if (action === 'trash') {
			if (asksTyped) throw new Error('the move to the trash asks for something typed');
			return button(CONSOLE.trashConfirm, dialog).click();
		}
		const table = CONSOLE.typedConfirm.exec(await C.textOf(dialog));
		if (asksTyped) await typedBox.fill(table ? table[1] : String(typedCount));
		return button(CONSOLE.deleteConfirm, dialog).click();
	};
	const stats = async () => {
		const s = await store.tool(fixture, 'stats', { mode: 'full' });
		return s && s.success === true
			? { documents: s.documents, chunks: s.chunks, deleted_documents: s.deleted_documents }
			: null;
	};
	/** Every item of the active listings (list_documents, the Documents view) the page received since frame `since`. */
	const documentItems = (since = 0) =>
		C.exchanges(capture, 'list_documents', since)
			.filter((x) => (x.input.deleted || 'active') === 'active')
			.flatMap((x) => (x.result && Array.isArray(x.result.items) ? x.result.items : []));
	/** Scroll the directory in front to its top or bottom (its rows are drawn for the window only). */
	const scrollDirectory = (where) =>
		page.evaluate((to) => {
			const list = [...document.querySelectorAll('[role="list"][aria-label="Stored documents"]')].find(
				(el) => el.getClientRects().length > 0
			);
			let box = list ? list.parentElement : null;
			while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
			if (box) box.scrollTop = to === 'bottom' ? box.scrollHeight : 0;
		}, where);
	/**
	 * The directory rows drawn in front: { objectId, path (from the page's list_documents answers),
	 * flags (badge words) }.
	 */
	const directoryRows = async () => {
		const rows = await page.evaluate(() =>
			[...document.querySelectorAll('[role="list"][aria-label="Stored documents"] [data-object-id]')]
				.filter((el) => el.getClientRects().length > 0)
				.map((el) => ({
					objectId: el.getAttribute('data-object-id'),
					flags: [...el.querySelectorAll('[data-flag]')].map((f) => (f.textContent || '').trim()),
				}))
		);
		const byId = new Map(documentItems().map((it) => [it.objectId, it.path]));
		return (Array.isArray(rows) ? rows : []).map((r) => ({ ...r, path: byId.get(r.objectId) || null }));
	};
	/** The paths of the directory rows drawn in front. */
	const directoryPaths = async () => (await directoryRows()).map((r) => r.path).filter(Boolean);
	/** Ask the chat a question; the paths of the answer's sources. */
	const askChat = async (question) => {
		await visible(page.getByRole('textbox', { name: CONSOLE.chatBox })).fill(question);
		await button(CONSOLE.askButton).click();
		await page.getByText(E.STUB_LLM_TAG).last().waitFor({ timeout: 120000 });
		const opens = visible(page.getByRole('list', { name: CONSOLE.sources }).last()).getByRole('button', {
			name: CONSOLE.sourceOpen,
		});
		const labels = await opens
			.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') || ''))
			.catch(() => []);
		return (Array.isArray(labels) ? labels : [])
			.map((l) => (CONSOLE.sourceTarget.exec(l) || [])[1])
			.filter(Boolean);
	};
	/**
	 * The duplicates panel as marked: each group's documents (its Keep radios), which are kept and queued,
	 * and its data-queued count.
	 */
	const readQueue = async (section) => {
		const marked = await section.locator('fieldset[data-group]').evaluateAll((sets) =>
			sets.map((fs) =>
				[...fs.querySelectorAll('input[type="radio"]')].map((r) => {
					const label = r.closest('label');
					return {
						path: (r.getAttribute('aria-label') || '').replace(/^Keep /, ''),
						kept: r.checked,
						queued: label
							? [...label.querySelectorAll('span')].some(
									(tag) => (tag.textContent || '').trim() === 'queued'
								)
							: false,
					};
				})
			)
		);
		const all = (Array.isArray(marked) ? marked : []).flat();
		return {
			groups: (Array.isArray(marked) ? marked : []).map((g) => g.map((d) => d.path)).filter((g) => g.length),
			keptPaths: all.filter((d) => d.kept).map((d) => d.path),
			queuedPaths: all.filter((d) => d.queued).map((d) => d.path),
			queuedCount: count(String((await C.attrText(section, 'data-queued')) ?? '')),
		};
	};
	/** Add a Folder is under condition; the list_documents answer the directory asked for with it. */
	const scopeToFolder = async (prefix) => {
		const since = capture.frames.length;
		await button(UI.scope.add).click();
		await visible(page.getByRole('menuitem', { name: UI.scope.folder })).click();
		const editor = visible(page.getByRole('group', { name: UI.scope.editor, exact: true }));
		await visible(editor.getByLabel(UI.scope.prefix, { exact: true })).fill(prefix);
		await button(UI.scope.addButton, editor).click();
		await visible(page.getByRole('button', { name: UI.scope.chip(prefix) })).waitFor({ timeout: 15000 });
		const listing = await C.waitForExchange(capture, 'list_documents', {
			since,
			timeout: 60000,
			where: (x) => x.input.filter && x.input.filter.path_prefix === prefix,
		}).catch(() => null);
		await C.sleep(1500);
		return listing;
	};
	/** The scope's objectIds: the documents under the folder, from what the page listed. */
	const scopeIdsOf = (prefix, since) => [
		...new Set(
			documentItems(since)
				.filter((it) => String(it.path || '').startsWith(prefix))
				.map((it) => it.objectId)
		),
	];

	let sample = null; // the page's current detailed sample answer (demo fixture)
	let demoN = null; // the points of the demo collection's unscoped sample (the clusters step's)
	let sampleInput = null;
	let falconKey = null;
	let greenhouseKey = null;
	let queued = []; // { objectId, path } the duplicates queue would remove
	let savedView = null;
	let savedFilter = false; // the scope step saved 'handbooks' and applied it again
	try {
		await E.signIn(page, base);

		// ------------------------------------------------------------------
		// The map: clusters, edges, colouring, isolation, text, recommend,
		// the matrix, exports and views (nothing is removed here)
		// ------------------------------------------------------------------

		await step(page, STEP_TITLES['clusters'], async (note) => {
			const x = await openMap(fixture);
			sample = x.result;
			sampleInput = x.input;
			demoN = sample && typeof sample.n === 'number' ? sample.n : null;
			await sideTab(UI.map.tabs.clusters);
			const list = visible(map.getByRole('list', { name: UI.map.clustersList }));
			await list.waitFor({ timeout: 15000 });
			const texts = await list.locator('li').allInnerTexts();
			const rows = [];
			let noise = null;
			for (const t of Array.isArray(texts) ? texts : []) {
				const m = UI.map.clusterRowSize.exec(t);
				const nm = UI.map.noiseRowSize.exec(t);
				if (nm) noise = count(nm[1]);
				else if (m) rows.push({ size: count(m[1]), documents: count(m[2]) });
			}
			const colour = combo(UI.map.colourBy, toolbar);
			const option = colour.locator('option', { hasText: UI.map.clusterOption }).first();
			const colourOffered =
				(await option.count().catch(() => 0)) > 0 && (await C.attrText(option, 'disabled')) === null;
			if (colourOffered) await choose(colour, UI.map.clusterOption);
			const colourAfter = await poll(
				() => attr(UI.map.attr.colourBy),
				(v) => v === 'cluster',
				5000
			);
			note({
				n: sample && sample.n,
				clusters:
					sample && sample.clusters
						? {
								count: sample.clusters.count,
								sizes: sample.clusters.sizes.slice(0, 12),
								keywords: (sample.clusters.keywords || []).slice(0, 8),
							}
						: null,
				rows: rows.length,
				noise,
				colourAfter,
			});
			return clustersVerdict({ input: x.input, sample, rows, noise, colourOffered, colourAfter });
		});

		await step(page, STEP_TITLES['min size'], async (note) => {
			if (!sample) return 'no sample (clusters step)';
			const rowsAt = async () =>
				visible(map.getByRole('list', { name: UI.map.clustersList }))
					.locator('li:not([data-cluster="noise"])')
					.count();
			const select = combo(UI.map.minClusterSize);
			const rows5 = await rowsAt();
			const since = capture.frames.length;
			await choose(select, /^2$/);
			await poll(
				() => attr(UI.map.attr.minClusterSize),
				(v) => v === '2',
				5000
			);
			const rows2 = await rowsAt();
			await C.sleep(1000);
			const samplesSent = samplesSince(since);
			await choose(select, /^5$/);
			note({ rows5, rows2, samplesSent });
			return minSizeVerdict({ sample, rows5, rows2, samplesSent });
		});

		await step(page, STEP_TITLES['ask'], async (note) => {
			if (!sample || !sample.clusters) return 'no clusters (clusters step)';
			const docs = clusterDocuments(sample, 0);
			await sideTab(UI.map.tabs.clusters);
			await button(UI.map.askCluster(0), map).click();
			await openConsole();
			const text = await C.bodyText(page);
			const m = UI.chat.asking.exec(text);
			note({ asking: m ? m[0] : null, documents: docs.size });
			// The steps after this one ask about every document (or their own scope).
			await button(/^Ask about all documents$/)
				.click()
				.catch(() => {});
			if (!m) return 'the chat does not say it is asking about some documents only';
			return count(m[1]) === docs.size
				? true
				: `the chat asks about ${m[1]} documents; cluster 1 holds ${docs.size}`;
		});

		await step(page, STEP_TITLES['edges'], async (note) => {
			if (!sample) return 'no sample';
			await C.switchView(page, CONSOLE.mapTab);
			const edges = combo(UI.map.edges, toolbar);
			const read = (mode) =>
				poll(
					async () => ((await attr(UI.map.attr.edgeMode)) === mode ? attrInt(UI.map.attr.edgeCount) : null),
					(v) => v !== null && (mode === 'none' || v > 0),
					10000
				);
			await edges.selectOption('tree');
			const tree = await read('tree');
			await edges.selectOption('neighbours');
			await combo(UI.map.edgesPerPoint, toolbar).selectOption('5');
			const neighbours5 = await read('neighbours');
			// Hover: sweep for a point (the tooltip shows). The map says nothing about the edges it
			// thickens, so the overlay layer's drawn pixels are read with the pointer over the point
			// and away from it, with the edges on (Neighbours m=5) and off (None): what the hover adds
			// over the edges is the difference (the hover ring is drawn in both).
			await toolbar.getByRole('button', { name: MAP.fit }).first().click();
			const box = await canvas.boundingBox();
			let hovered = null;
			let at = null;
			for (let gy = 1; gy < 14 && !at && box; gy += 1) {
				for (let gx = 1; gx < 20 && !at; gx += 1) {
					await page.mouse.move(box.x + (box.width * gx) / 20, box.y + (box.height * gy) / 14);
					await C.sleep(40);
					if (
						await page
							.locator(MAP.tooltip)
							.first()
							.isVisible()
							.catch(() => false)
					)
						at = { x: box.x + (box.width * gx) / 20, y: box.y + (box.height * gy) / 14 };
				}
			}
			let hover = null;
			if (at && box) {
				const away = { x: box.x + 3, y: box.y + 3 };
				const drawnAt = async (where) => {
					await page.mouse.move(where.x, where.y);
					await C.sleep(400);
					return overlayPixels();
				};
				const withEdges = { away: await drawnAt(away), over: await drawnAt(at) };
				await edges.selectOption('none');
				await read('none');
				const without = { away: await drawnAt(away), over: await drawnAt(at) };
				hover = { withEdges, without };
				hovered = hoverEdgePixels(hover);
			}
			// Expand selected: Edges None, select a point that has kNN neighbours (through the Table), Expand selected.
			await edges.selectOption('none');
			await read('none');
			let selected = null;
			let expanded = null;
			const withNeighbours = Array.from({ length: sample.n }, (_, i) => i).find(
				(i) => knnDegree(sample.knn, i) > 0
			);
			if (withNeighbours !== undefined) {
				selected = await inspectPoint(withNeighbours);
				await button(UI.map.expandSelected, toolbar).click();
				expanded = await poll(
					() => attrInt(UI.map.attr.edgeCount),
					(v) => v !== null && v > 0,
					5000
				);
			}
			note({ n: sample.n, tree, neighbours5, hover, hovered, selected, expanded });
			return edgesVerdict({ sample, tree, neighbours5, hovered, expanded, selected });
		});

		await step(page, STEP_TITLES['ingest date'], async (note) => {
			if (!sample) return 'no sample';
			await choose(combo(UI.map.colourBy, toolbar), UI.map.ingestDateOption);
			const colourAfter = await poll(
				() => attr(UI.map.attr.colourBy),
				(v) => v === 'ingest-date',
				5000
			);
			const ramp = visible(map.getByRole('img', { name: /^Colour ramp from/ }));
			const label = await C.attrText(ramp, 'aria-label');
			const ids = new Set(sample.docs.map((d) => d.objectId));
			const items = documentItems().filter((it) => ids.has(it.objectId));
			note({ label, documents: items.length, days: ingestDays(items) });
			await choose(combo(UI.map.colourBy, toolbar), /^Document$/);
			return rampVerdict({ label, colourAfter, items });
		});

		await step(page, STEP_TITLES['isolate'], async (note) => {
			if (!sample) return 'no sample';
			const selection = await lassoLeft(0.35);
			await sideTab(UI.map.tabs.selection);
			await button(UI.map.isolate, map).click();
			const isolatedShown = await poll(
				() => attrInt(UI.map.attr.shown),
				(v) => v === selection,
				5000
			);
			const isolated = { shown: isolatedShown, flag: await attr(UI.map.attr.isolated) };
			// Isolate moves the points (the shown ones fill the layout) and frames them itself:
			// once they stop, Fit must not move the camera.
			const framedIsolate = await framing();
			const table = toolbar.getByRole('button', { name: MAP.table }).first();
			await table.click();
			const m = MAP.tableRows.exec(await C.bodyText(page));
			const tableRows = m ? count(m[3]) : null;
			await table.click();
			await button(UI.map.expandRing, map).click();
			const expanded = await poll(
				() => attrInt(UI.map.attr.shown),
				(v) => v !== null && v > selection,
				5000
			);
			await button(UI.map.showAll, map).click();
			const allShown = await poll(
				() => attrInt(UI.map.attr.shown),
				(v) => v === sample.n,
				5000
			);
			const all = { shown: allShown, flag: await attr(UI.map.attr.isolated) };
			const framedAll = await framing();
			const framingRead = { isolate: framedIsolate, showAll: framedAll };
			note({ n: sample.n, selection, isolated, tableRows, expanded, all, framing: framingRead });
			return isolateVerdict({ n: sample.n, selection, isolated, tableRows, expanded, all, framing: framingRead });
		});

		await step(page, STEP_TITLES['text'], async (note) => {
			if (!sample) return 'no sample';
			// The water question is the active query whose words are marked.
			await toolbar.getByPlaceholder(MAP.queryBox).first().fill(E.WATER_QUESTION);
			const since = capture.frames.length;
			await toolbar.getByRole('button', { name: MAP.run }).first().click();
			await C.waitForExchange(capture, 'search', { since, timeout: 90000 });
			const candidates = pointsOf(sample, CORPUS.falconFile).filter((i) =>
				/water/i.test(String((sample.points.snip || [])[i] || ''))
			);
			if (!candidates.length) return `no sampled chunk of ${CORPUS.falconFile} mentions water in its snippet`;
			const i = candidates[0];
			falconKey = keyOf(sample, i);
			await inspectPoint(i);
			const before = capture.frames.length;
			await button(UI.inspector.showFullText, inspector).click();
			const panel = visible(map.locator(UI.text.panel));
			await panel.waitFor({ timeout: 30000 });
			// The text arrives with its marks: wait for the first, then read them all
			// (none is a finding, not an error).
			await panel
				.locator('mark')
				.first()
				.waitFor({ timeout: 15000 })
				.catch(() => {});
			const marks = await panel.locator('mark').allInnerTexts();
			const shown = (await C.textOf(panel)).slice(0, 160);
			// Hiding and showing it again must not fetch it again.
			await button(UI.inspector.hideFullText, inspector).click();
			await button(UI.inspector.showFullText, inspector).click();
			await panel.waitFor({ timeout: 30000 });
			await C.sleep(1500);
			const calls = C.exchanges(capture, 'chunks', before).map((x) => x.input);
			note({
				key: falconKey,
				marks: (marks || []).slice(0, 10),
				dataMarks: await C.attrText(panel, 'data-marks'),
				shown,
				calls: calls.length,
			});
			return chunkTextVerdict({ marks, calls, key: falconKey });
		});

		await step(page, STEP_TITLES['recommend'], async (note) => {
			if (!sample || !falconKey) return 'no falcon chunk inspected (text step)';
			const gi = sample.points.doc.findIndex((_, i) =>
				String(pathOf(sample, i) || '').includes(`/${CORPUS.greenhouseFolder}`)
			);
			if (gi < 0) return 'no greenhouse chunk in the sample';
			greenhouseKey = keyOf(sample, gi);
			const fi = sample.points.doc.findIndex((_, i) => keyText(keyOf(sample, i)) === keyText(falconKey));
			await inspectPoint(fi);
			await button(UI.inspector.addPositive, inspector).click();
			await inspectPoint(gi);
			await button(UI.inspector.addNegative, inspector).click();
			await sideTab(UI.map.tabs.recommend);
			const panel = visible(map.locator(UI.recommend.panel));
			const since = capture.frames.length;
			await button(UI.recommend.run, panel).click();
			const x = await C.waitForExchange(capture, 'recommend', { since, timeout: 90000 });
			note({
				input: {
					positive: x.input.positive,
					negative: x.input.negative,
					k: x.input.k,
					strategy: x.input.strategy,
				},
				first: x.result && x.result.items && x.result.items[0] ? x.result.items[0].path : null,
				items: x.result && x.result.items ? x.result.items.length : null,
			});
			return recommendVerdict({ input: x.input, answer: x.result, positive: falconKey, negative: greenhouseKey });
		});

		await step(page, STEP_TITLES['best score'], async (note) => {
			if (!greenhouseKey) return 'no recommend examples (recommend step)';
			const dialect = await store.tool(fixture, 'dialect');
			const capability = !!(dialect && dialect.capabilities && dialect.capabilities.recommend_best_score);
			// The store's own answer (the page offers Best score only where it is flagged).
			const answer = await store.tool(fixture, 'recommend', {
				positive: [falconKey],
				negative: [greenhouseKey],
				k: 12,
				strategy: 'best_score',
			});
			let pageNative = null;
			if (capability) {
				const panel = visible(map.locator(UI.recommend.panel));
				await choose(combo(UI.recommend.strategy, panel), UI.recommend.bestScore);
				const since = capture.frames.length;
				await button(UI.recommend.run, panel).click();
				const x = await C.waitForExchange(capture, 'recommend', { since, timeout: 90000 });
				pageNative = x.result ? x.result.native : null;
				if (x.input.strategy !== 'best_score' || pageNative !== true)
					return `the page's best_score run answered native ${pageNative}`;
			}
			note({ capability, native: answer && answer.native, code: answer && answer.code, pageNative });
			return bestScoreVerdict({ capability, answer });
		});

		await step(page, STEP_TITLES['matrix'], async (note) => {
			if (!sample) return 'no sample';
			// A group of at most MATRIX_MAX points holding two chunks of one document: shown alone, then lassoed whole.
			const group = matrixCluster(sample);
			if (!group) return `no group of 5 to ${MATRIX_MAX} points holds two chunks of one document`;
			// Clear the earlier selection first (Escape on the canvas), so the lasso's selection is the group's alone.
			await canvas.focus();
			await page.keyboard.press('Escape');
			await sideTab(UI.map.tabs.clusters);
			await button(UI.map.showCluster(group.cluster), map).click();
			const shown = await poll(
				() => attrInt(UI.map.attr.shown),
				(v) => v === group.size,
				5000
			);
			const since = capture.frames.length;
			// The whole canvas, once fitted to the group shown alone, selects exactly the group.
			let selected = null;
			let lassoed = null;
			try {
				selected = await lassoLeft(1);
				lassoed = matrixLassoVerdict({ group, shown, selected });
			} catch (e) {
				lassoed = String(e && e.message ? e.message : e);
			}
			if (lassoed !== true) {
				note({ group, shown, selected });
				await button(UI.map.showAll, map).click();
				return lassoed;
			}
			await sideTab(UI.map.tabs.selection);
			const panel = visible(map.locator(UI.matrix.panel));
			const x = await C.waitForExchange(capture, 'similarity_matrix', { since, timeout: 60000 });
			// Every key sent must be a point of the group.
			const allowed = new Set();
			sample.clusters.labels.forEach((label, i) => {
				if (label === group.cluster) allowed.add(keyText(keyOf(sample, i)));
			});
			const verdict = matrixVerdict({ input: x.input, answer: x.result, selected, allowed });
			// Export CSV puts the matrix in the map's Export menu.
			await poll(
				() => C.attrText(panel, 'data-state'),
				(v) => v === 'ok',
				30000
			);
			await button(UI.matrix.exportCsv, panel).click();
			const csv = await exportItem(map, UI.matrix.exportItem, 'csv');
			const rows = csvTable(csv.bytes.toString('utf8')).rows.length;
			await button(UI.map.showAll, map).click();
			note({
				group,
				shown,
				selected,
				n: x.result && x.result.n,
				source: x.result && x.result.source,
				csv: csv.name,
				rows,
			});
			if (verdict !== true) return verdict;
			return rows === x.result.n ? true : `the matrix CSV has ${rows} rows for n = ${x.result.n}`;
		});

		await step(page, STEP_TITLES['export csv'], async (note) => {
			if (!sample) return 'no sample';
			const selection = await lassoLeft(0.5);
			// The points the Selection tab holds, read before the export: the CSV's rows must be these.
			const tab = await readSelectionTab();
			const got = await exportItem(map, 'map-selection', 'csv');
			const dim = await store.dimension(fixture);
			const dialect = await store.tool(fixture, 'dialect');
			const sampleKeys = Array.from({ length: sample.n }, (_, i) => keyOf(sample, i));
			const csv = got.bytes.toString('utf8');
			const table = csvTable(csv);
			const o = table.header.indexOf('objectId');
			note({
				name: got.name,
				bytes: got.bytes.length,
				selection,
				rows: table.rows.length,
				rowDocuments: o < 0 ? null : new Set(table.rows.map((r) => r[o])).size,
				tab: tab.line,
				copiedKeys: tab.keys ? tab.keys.length : null,
			});
			const named = exportNameVerdict(got.name, dialect && dialect.collection, 'selection', 'csv');
			if (named !== true) return named;
			return selectionCsvVerdict({
				csv,
				selection,
				sampleKeys,
				dim,
				secrets: {
					'the API key': E.API_KEY,
					'the Tools task token': await store.tokenOf(fixture, 'tools_1').catch(() => ''),
				},
				selectedKeys: tab.keys,
				tab: tab.line,
			});
		});

		await step(page, STEP_TITLES['export png'], async (note) => {
			if (!sample) return 'no sample';
			const got = await exportItem(map, 'map-png', 'png');
			const dialect = await store.tool(fixture, 'dialect');
			const info = pngInfo(got.bytes);
			note({ name: got.name, bytes: got.bytes.length, info });
			return pngVerdict({ name: got.name, bytes: got.bytes, collection: dialect && dialect.collection });
		});

		await step(page, STEP_TITLES['views'], async (note) => {
			if (!sample) return 'no sample';
			const selection = await lassoLeft(0.6);
			const menu = visible(map.locator(UI.views.menu));
			await button(UI.views.open, menu).click();
			const views = visible(page.getByRole('group', { name: UI.views.panel, exact: true }));
			await visible(views.getByRole('textbox', { name: UI.views.name, exact: true })).fill('dupes');
			await visible(views.locator(UI.views.save)).click();
			await visible(page.getByRole('button', { name: UI.views.apply('dupes') })).waitFor({ timeout: 15000 });
			const seed = (exchangesLast(capture, 'sample') || {}).input || {};
			savedView = { seed: seed.seed === undefined ? sampleInput && sampleInput.seed : seed.seed, selection };
			// Another connection and back.
			const other = BACKENDS.filter((k) => k !== fixtureKey).map((k) => E.FIXTURES[k])[0];
			await C.openConnection(page, other);
			await C.openConnection(page, fixture);
			await C.switchView(page, CONSOLE.mapTab);
			await button(UI.views.open, visible(map.locator(UI.views.menu))).click();
			const apply = visible(page.getByRole('button', { name: UI.views.apply('dupes') }));
			const listedAfterSwitch = await apply.isVisible().catch(() => false);
			const since = capture.frames.length;
			if (listedAfterSwitch) await apply.click();
			const x = listedAfterSwitch ? await C.waitForExchange(capture, 'sample', { since, timeout: 120000 }) : null;
			await C.sleep(1500);
			const line = (UI.views.restored.exec(await C.bodyText(page)) || [''])[0];
			if (x && x.result && x.result.success) {
				sample = x.result;
				sampleInput = x.input;
			}
			savedView.listed = listedAfterSwitch;
			note({
				saved: savedView,
				applied: x ? { seed: x.input.seed, include_keys: (x.input.include_keys || []).length } : null,
				line,
			});
			return viewsVerdict({ listedAfterSwitch, saved: savedView, apply: x, line });
		});

		await step(page, STEP_TITLES['dedupe'], async (note) => {
			if (!sample) return 'no sample';
			await sideTab(UI.map.tabs.duplicates);
			const section = visible(map.getByRole('region', { name: UI.dedupe.section }));
			await section.waitFor({ timeout: 15000 });
			await combo(UI.dedupe.policy, section).selectOption(UI.dedupe.shortestPath);
			const { groups, keptPaths, queuedPaths, queuedCount } = await readQueue(section);
			// What Move all queued to the trash must move: the documents the panel queued.
			queued = queuedPaths.map((p) => ({ path: p, objectId: C.objectId(p) }));
			const slider = visible(section.getByRole('slider', { name: UI.dedupe.threshold }));
			const setSlider = (value) =>
				slider.evaluate((el, v) => {
					const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
					set.call(el, v);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				}, value);
			// The slider's start and grid; the first position below the start at which
			// the sample the page holds groups differently.
			const from = await C.attrNum(section, 'data-threshold');
			const grid = {
				min: (await C.attrNum(slider, 'min')) ?? 0.9,
				step: (await C.attrNum(slider, 'step')) ?? 0.005,
			};
			const to = from === null ? null : regroupThreshold(sample, from, grid);
			const expectedBefore = from === null ? null : dedupeGroupsAt(sample, from);
			const expectedAfter = to === null ? null : dedupeGroupsAt(sample, to);
			const since = capture.frames.length;
			let thresholdAfter = null;
			let groupsAfter = null;
			if (to !== null) {
				await setSlider(String(to));
				thresholdAfter = await poll(
					() => section.getAttribute('data-threshold').catch(() => null),
					(v) => v === String(to),
					5000
				);
				// What the panel lists now (read again after the move):
				// it must be the sample's groups at the new threshold.
				const changed = await poll(
					async () => (await readQueue(section)).groups,
					(g) => groupsText(g) !== groupsText(groups),
					5000
				);
				groupsAfter = changed;
			}
			await C.sleep(1000);
			const samplesSent = samplesSince(since);
			if (from !== null) await setSlider(String(from));
			note({
				groups,
				keptPaths,
				queued: queuedPaths,
				queuedCount,
				from,
				to,
				thresholdAfter,
				groupsAfter,
				expectedAfter,
				samplesSent,
			});
			return dedupeVerdict({
				groups,
				keptPaths,
				queuedPaths,
				queuedCount,
				samplesSent,
				from,
				to,
				thresholdAfter,
				groupsAfter,
				expectedBefore,
				expectedAfter,
			});
		});

		await step(page, STEP_TITLES['outliers'], async (note) => {
			if (!sample) return 'no sample';
			await sideTab(MAP.tabs.outliers);
			const list = visible(map.getByRole('list', { name: MAP.outliersList }));
			await list.waitFor({ timeout: 15000 });
			const rows1 = await list.locator('li').allInnerTexts();
			const since = capture.frames.length;
			const percentile = combo(UI.outliers.percentile, map.locator(UI.outliers.section));
			await choose(percentile, /^5\s?%$/);
			await C.sleep(1000);
			const rows5 = await list.locator('li').allInnerTexts();
			const samplesSent = samplesSince(since);
			await choose(percentile, /^1\s?%$/);
			note({
				rows1: Array.isArray(rows1) ? rows1.length : null,
				rows5: Array.isArray(rows5) ? rows5.length : null,
				first: Array.isArray(rows1) && rows1[0] ? rows1[0].slice(0, 160) : null,
				samplesSent,
			});
			return outliersVerdict({ sample, rows1, rows5, samplesSent });
		});

		// ------------------------------------------------------------------
		// The console: charts, scope, search (nothing is removed here)
		// ------------------------------------------------------------------

		await step(page, STEP_TITLES['charts'], async (note) => {
			await openConsole();
			const charts = visible(page.locator('summary', { hasText: UI.charts.summary }));
			await charts.click();
			try {
				const chart = visible(page.locator(UI.charts.chunks));
				await chart.waitFor({ timeout: 15000 });
				const bars = chart.getByRole('button');
				const n = await bars.count();
				const topBin = n > 0 ? await C.attrText(bars.nth(n - 1), 'aria-label') : null;
				if (n > 0) await bars.nth(n - 1).click();
				await C.sleep(2000);
				const chip = await visible(page.getByRole('button', { name: /^Remove condition: / }))
					.isVisible()
					.catch(() => false);
				const directory = await directoryPaths();
				const documents = documentItems();
				note({ bars: n, topBin, chip, directory: directory.slice(0, 5) });
				if (chip) await button(UI.scope.clear).click();
				return chartsVerdict({ topBin, documents, directory, chip });
			} finally {
				// Fold the charts again: open, they take the console's height from the panels below.
				await charts.click().catch(() => {});
			}
		});

		let scopeClearedAt = null; // the frame before the scope step's last Clear
		await step(page, STEP_TITLES['scope'], async (note) => {
			await openConsole();
			const since = capture.frames.length;
			const listing = await scopeToFolder(CORPUS.scopeFolder);
			const statusLine = await C.textOf(visible(page.getByRole('status').filter({ hasText: UI.scope.status })));
			const directory = await directoryPaths();
			const scopeIds = scopeIdsOf(CORPUS.scopeFolder, 0);
			await C.switchView(page, CONSOLE.mapTab);
			const x = await C.waitForExchange(capture, 'sample', {
				since,
				timeout: 120000,
				where: (e) => !!(e.input.filter && e.input.filter.object_ids),
			});
			await openConsole();
			const sources = await askChat(E.WATER_QUESTION);
			await button(UI.scope.saveOpen).click();
			const saving = visible(page.getByRole('group', { name: UI.scope.saveGroup, exact: true }));
			await visible(saving.getByRole('textbox', { name: UI.scope.saveName, exact: true })).fill('handbooks');
			await button(UI.scope.save, saving).click();
			await button(UI.scope.clear).click();
			await button(UI.scope.saved).click();
			await visible(page.getByRole('menuitem', { name: UI.scope.applySaved('handbooks') })).click();
			const reapplied = await visible(page.getByRole('button', { name: UI.scope.chip(CORPUS.scopeFolder) }))
				.isVisible()
				.catch(() => false);
			note({
				filter_applied: listing && listing.result && listing.result.filter_applied,
				status: statusLine,
				directory: directory.length,
				scope: scopeIds.length,
				sampled: x.result && x.result.docs ? x.result.docs.length : null,
				sources,
				reapplied,
			});
			savedFilter = reapplied;
			const verdict = scopeVerdict({
				prefix: CORPUS.scopeFolder,
				listing: listing && listing.result,
				status: statusLine,
				directory,
				sampleInput: x.input,
				sample: x.result,
				scopeIds,
				sources,
				reapplied,
			});
			scopeClearedAt = capture.frames.length;
			await button(UI.scope.clear).click();
			return verdict;
		});

		await step(page, STEP_TITLES['scope cleared'], async (note) => {
			if (scopeClearedAt === null) return 'the scope step did not clear its scope';
			// Shown again, the map must draw the collection's unscoped sample (asked for after the Clear),
			// all of it, and settle.
			await C.switchView(page, CONSOLE.mapTab);
			const { reading, verdict } = await awaitMap(
				{ scoped: false, n: demoN, after: scopeClearedAt },
				scopeClearedAt
			);
			note({ demoN, map: brief(reading) });
			await openConsole();
			return verdict;
		});

		let scopeCleared = null; // the frame before the scope card's scope was cleared
		if (planned.includes('scope 600')) {
			await step(page, STEP_TITLES['scope 600'], async (note) => {
				const since = capture.frames.length;
				await C.openConnection(page, SCOPE_FIXTURES[fixtureKey]);
				await scopeToFolder(CORPUS.padFolder);
				// The directory pages through the whole scope before the map can name it.
				await poll(
					async () => scopeIdsOf(CORPUS.padFolder, since).length,
					(v) => v >= CORPUS.padDocuments,
					120000
				);
				const scopeIds = scopeIdsOf(CORPUS.padFolder, since);
				await C.switchView(page, CONSOLE.mapTab);
				const x = await C.waitForExchange(capture, 'sample', {
					since,
					timeout: 180000,
					where: (e) =>
						!!(
							e.input.filter &&
							Array.isArray(e.input.filter.object_ids) &&
							e.input.filter.object_ids.length >= CORPUS.padDocuments
						),
				});
				note({
					scope: scopeIds.length,
					sent: x.input.filter.object_ids.length,
					sampled: x.result && x.result.docs ? x.result.docs.length : null,
					listing: x.result && x.result.listing,
				});
				await openConsole();
				scopeCleared = capture.frames.length;
				await button(UI.scope.clear).click();
				return scope600Verdict({ sampleInput: x.input, sample: x.result, scopeIds });
			});
		}

		if (planned.includes('listing')) {
			await step(page, STEP_TITLES['listing'], async (note) => {
				const card = SCOPE_FIXTURES[fixtureKey];
				if (scopeCleared === null) {
					await C.openConnection(page, card);
					scopeCleared = capture.frames.length;
				}
				await C.switchView(page, CONSOLE.mapTab);
				// Clearing the scope draws the card's map again, unscoped; without one, another size is asked for.
				const unscoped = (e) => !(e.input.filter && e.input.filter.object_ids);
				let x = await C.waitForExchange(capture, 'sample', {
					since: scopeCleared,
					timeout: 60000,
					where: unscoped,
				}).catch(() => null);
				if (!x) {
					const since = capture.frames.length;
					await choose(visible(toolbar.getByRole('combobox', { name: MAP.samplePicker })), /light/i);
					x = await C.waitForExchange(capture, 'sample', { since, timeout: 120000, where: unscoped });
				}
				await poll(
					async () => C.textOf(visible(map.getByRole('region', { name: MAP.legend }))),
					(t) => /Sampled from/.test(t),
					10000
				);
				const legend = await C.textOf(visible(map.getByRole('region', { name: MAP.legend })));
				const s = await store.tool(card, 'stats', { mode: 'full' });
				note({
					listing: x.result && x.result.listing,
					caveats: x.result && x.result.caveats,
					documents: s && s.documents,
				});
				await C.openConnection(page, fixture);
				return listingVerdict({
					sample: x.result,
					legend,
					documents: s && s.success === true ? s.documents : null,
				});
			});
		}

		/** Show the Search surface in the chat panel (the toggle in its header). */
		const searchPanel = async () => {
			await openConsole();
			const toggle = button(UI.chat.searchToggle, visible(page.locator(UI.chat.panel)));
			if ((await C.attrText(toggle, 'aria-pressed')) !== 'true') await toggle.click();
			const panel = visible(page.locator(UI.search.panel));
			await panel.waitFor({ timeout: 15000 });
			return panel;
		};
		const runSearch = async (panel, mode, question) => {
			await visible(panel.getByRole('radio', { name: mode })).check();
			await visible(panel.getByRole('searchbox', { name: UI.search.box, exact: true })).fill(question);
			const since = capture.frames.length;
			await button(UI.search.run, panel).click();
			return C.waitForExchange(capture, 'search', { since, timeout: 90000 });
		};
		const setSlider = (slider, value) =>
			slider.evaluate((el, v) => {
				const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				set.call(el, v);
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
			}, value);

		await step(page, STEP_TITLES['keyword'], async (note) => {
			const panel = await searchPanel();
			const x = await runSearch(panel, UI.search.mode.keyword, CORPUS.keywordToken);
			await C.sleep(500);
			const firstRow = await C.textOf(visible(panel.getByRole('row').nth(1)));
			note({
				input: x.input,
				results: x.result && x.result.results ? x.result.results.length : null,
				firstRow: firstRow.slice(0, 160),
			});
			return keywordVerdict({ input: x.input, answer: x.result, firstRow });
		});

		await step(page, STEP_TITLES['threshold'], async (note) => {
			const panel = await searchPanel();
			const x = await runSearch(panel, UI.search.mode.semantic, E.WATER_QUESTION);
			// Two positions from the answer's own scores: one every row passes, one above the median.
			const at = thresholdPositions(
				(x.result && Array.isArray(x.result.results) ? x.result.results : []).map((r) => r.score)
			);
			if (!at) return `the search answered no scored rows (${JSON.stringify(x.result).slice(0, 160)})`;
			const slider = visible(panel.getByRole('slider', { name: UI.search.threshold }));
			await setSlider(slider, at.low.toFixed(2));
			const low = (UI.search.passing.exec(await C.textOf(panel)) || [''])[0];
			await setSlider(slider, at.high.toFixed(2));
			const high = (UI.search.passing.exec(await C.textOf(panel)) || [''])[0];
			await button(UI.search.copySetting, panel).click();
			// This callback runs in the page, not in Node, so Node's navigator support does not apply.
			// eslint-disable-next-line n/no-unsupported-features/node-builtins
			const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
			note({ at, low, high, copied });
			return thresholdVerdict({ low, high, copied, at });
		});

		await step(page, STEP_TITLES['compare'], async (note) => {
			const questionB = 'How is the station powered in winter?';
			// The map first, in a known state: the collection's unscoped sample, drawn whole and settled
			// (a sample still being drawn when Search tells it the questions would drop both stars).
			const start = capture.frames.length;
			await C.switchView(page, CONSOLE.mapTab);
			const before = await awaitMap({ scoped: false, n: demoN }, start);
			const panel = await searchPanel();
			const since = capture.frames.length;
			await button(UI.search.compare, panel).click();
			await visible(panel.getByRole('searchbox', { name: UI.search.boxB, exact: true })).fill(questionB);
			await button(UI.search.run, panel).click();
			await poll(
				async () => C.exchanges(capture, 'search', since).filter((x) => x.response).length,
				(v) => v >= 2,
				90000
			);
			const runs = C.exchanges(capture, 'search', since).filter((x) => x.response);
			const summary = (UI.search.compareSummary.exec(await C.textOf(panel)) || [''])[0];
			// The comparison tells the map both questions; the map then places a star for each.
			const shown = capture.frames.length;
			await button(UI.search.showBoth, panel).click();
			await C.switchView(page, CONSOLE.mapTab);
			const starA = await poll(
				() => attr(UI.map.attr.queryState),
				(v) => v === 'placed',
				30000
			);
			const starB = await poll(
				() => attr(UI.map.attr.queryBState),
				(v) => v === 'placed',
				30000
			);
			// Read again once the map has settled: both stars still there, on the sample it held before the click.
			const after = await awaitMap(
				{
					stars: { b: questionB },
					sampleIndex: before.reading && before.reading.sample ? before.reading.sample.index : null,
				},
				shown,
				60000
			);
			// What the map asked for after "Show A and B on the map"
			// (star B needs an embed, a project and a search of B).
			const asked = Object.fromEntries(
				['sample', 'embed', 'project', 'search'].map((tool) => [tool, C.exchanges(capture, tool, shown).length])
			);
			note({
				summary,
				runs: runs.length,
				starA,
				starB,
				askedAfterShow: asked,
				demoN,
				before: brief(before.reading),
				after: brief(after.reading),
			});
			return compareVerdict({
				a: runs[0] && runs[0].result,
				b: runs[1] && runs[1].result,
				summary,
				starA,
				starB,
				before: before.reading,
				after: after.reading,
				n: demoN,
				questionB,
			});
		});

		await step(page, STEP_TITLES['layout'], async (note) => {
			await openConsole();
			const ratio = () =>
				page.evaluate(
					([chatSel, ingestSel]) => {
						const shown = (sel) =>
							[...document.querySelectorAll(sel)].find((el) => el.getClientRects().length > 0);
						const chat = shown(chatSel);
						const ingest = shown(ingestSel);
						if (!chat || !ingest) return null;
						// The right column stacks them: the chat's share is of the two panels' heights.
						const c = chat.getBoundingClientRect().height;
						const i = ingest.getBoundingClientRect().height;
						return c + i > 0 ? Math.round((c / (c + i)) * 1000) / 1000 : null;
					},
					[UI.chat.column, UI.chat.ingestColumn]
				);
			const toggle = button(UI.chat.searchToggle, visible(page.locator(UI.chat.panel)));
			if ((await C.attrText(toggle, 'aria-pressed')) === 'true') await toggle.click();
			const before = await ratio();
			await toggle.click();
			const after = await ratio();
			await toggle.click();
			note({ before, after });
			return layoutVerdict({ before, after });
		});

		// ------------------------------------------------------------------
		// Writes: the duplicates queue, an outlier, a 3-file drop
		// ------------------------------------------------------------------

		await step(page, STEP_TITLES['dedupe trash'], async (note) => {
			if (!queued.length) return 'nothing queued (duplicates queue step)';
			await C.switchView(page, CONSOLE.mapTab);
			await sideTab(UI.map.tabs.duplicates);
			const section = visible(map.getByRole('region', { name: UI.dedupe.section }));
			// The queue belongs to the sample on screen, and the scope steps drew others since:
			// choose the policy again.
			await combo(UI.dedupe.policy, section).selectOption(UI.dedupe.shortestPath);
			const now = await readQueue(section);
			queued = now.queuedPaths.map((p) => ({ path: p, objectId: C.objectId(p) }));
			if (!queued.length || now.queuedCount !== queued.length)
				return (
					`after choosing Keep shortest path again ` +
					`the panel marks ${queued.length} documents queued and counts ${now.queuedCount}`
				);
			const before = await stats();
			const chunksOf = {};
			for (const q of queued) {
				const item = documentItems().find((it) => it.objectId === q.objectId);
				chunksOf[q.objectId] = item ? item.chunks : null;
			}
			let since = capture.frames.length;
			await button(UI.dedupe.trashAll, section).click();
			await answerRemoval(false);
			await C.sleep(1500);
			const cancelled = C.requestsSince(capture, since, (m) => C.WRITE_TOOLS.includes(C.toolOf(m))).length;
			if (cancelled) return `Cancel sent ${cancelled} write requests`;
			since = capture.frames.length;
			await button(UI.dedupe.trashAll, section).click();
			await answerRemoval(true);
			queued.forEach((q) => trashedDemo.add(q.path));
			await poll(
				async () => C.exchanges(capture, 'soft_delete', since).filter((x) => x.response).length,
				(v) => v >= 1,
				60000
			);
			await C.sleep(2000);
			const sent = C.exchanges(capture, 'soft_delete', since).map((x) => x.input);
			const deleted = C.requestsSince(capture, since, (m) => C.toolOf(m) === 'delete').length;
			const after = await stats();
			const states = {};
			for (const q of queued) states[q.objectId] = await store.state(fixture, q.objectId);
			const chunks = Object.values(chunksOf).every(Number.isInteger)
				? Object.values(chunksOf).reduce((a, b) => a + b, 0)
				: null;
			note({ queued: queued.map((q) => q.path), sent, deleted, before, after, chunks, states });
			return trashVerdict({
				expected: queued.map((q) => q.objectId),
				sent,
				deleted,
				before,
				after,
				chunks,
				states,
			});
		});

		await step(page, STEP_TITLES['outlier trash'], async (note) => {
			if (!sample) return 'no sample';
			await sideTab(MAP.tabs.outliers);
			const list = visible(map.getByRole('list', { name: MAP.outliersList }));
			const ocr = DEMO(E.DEMO_CORPUS.outlier);
			const before = await stats();
			const since = capture.frames.length;
			await button(
				UI.outliers.trash,
				list
					.locator('li')
					.filter({ hasText: E.DEMO_CORPUS.outlier.split('/').pop() })
					.first()
			).click();
			await answerRemoval(true);
			trashedDemo.add(ocr);
			await poll(
				async () => C.exchanges(capture, 'soft_delete', since).filter((x) => x.response).length,
				(v) => v >= 1,
				60000
			);
			await C.sleep(1500);
			const sent = C.exchanges(capture, 'soft_delete', since).map((x) => x.input);
			const deleted = C.requestsSince(capture, since, (m) => C.toolOf(m) === 'delete').length;
			const after = await stats();
			const states = { [C.objectId(ocr)]: await store.state(fixture, C.objectId(ocr)) };
			note({ sent, deleted, before, after, states });
			return trashVerdict({ expected: [C.objectId(ocr)], sent, deleted, before, after, chunks: null, states });
		});

		await step(page, STEP_TITLES['ingest summary'], async (note) => {
			await openConsole();
			const files = [1, 2, 3].map((n) => ({
				name: `enrich-${run}-${n}.md`,
				mimeType: 'text/markdown',
				buffer: Buffer.from(
					`# Enrichment note ${n}\n\nThe ${['north', 'south', 'east'][n - 1]} ridge relay was ` +
						`checked by the night watch on run ${run}. ` +
						`${'The battery bank held its charge through the storm. '.repeat(30)}\n`
				),
			}));
			await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(files);
			const rows = await C.waitForUploads(
				page,
				files.map((f) => f.name),
				240000
			);
			for (const r of rows) if (files.some((f) => r.path.endsWith(f.name))) ownUploads.push(r.path);
			const summary = (UI.ingest.summary.exec(await C.textOf(visible(page.locator(UI.ingest.root)))) || [''])[0];
			let chunks = 0;
			for (const p of ownUploads) {
				const answer = await store.tool(fixture, 'chunks', { object_id: C.objectId(p), limit: 200 });
				chunks += answer && Array.isArray(answer.items) ? answer.items.length : 0;
			}
			const since = capture.frames.length;
			await button(UI.ingest.showNew).click();
			const project = await C.waitForExchange(capture, 'project', {
				since,
				timeout: 60000,
				where: (x) => Array.isArray(x.input.keys),
			});
			const placed = (UI.ingest.placed.exec(await C.bodyText(page)) || [''])[0];
			note({ summary, uploads: ownUploads, chunks, pinned: (project.input.keys || []).length, placed });
			return ingestVerdict({ summary, files: files.length, chunks, project: project.input, placed });
		});

		if (planned.includes('health')) {
			await step(page, STEP_TITLES['health'], async (note) => {
				const since = capture.frames.length;
				await C.openConnection(page, LEGACY_FIXTURE);
				await C.sleep(2000);
				// "Needs attention" is the directory's last group.
				await scrollDirectory('bottom');
				await C.sleep(500);
				const items = documentItems(since);
				const flagged = (await directoryRows()).flatMap((r) =>
					r.flags.map((f) => ({
						path: r.path,
						kind: /deleted chunk/.test(f) ? 'deleted_chunks' : /first chunk/.test(f) ? 'no_first_chunk' : f,
					}))
				);
				note({ items: items.length, flagged });
				return healthVerdict({ items, flagged });
			});
		}

		await step(page, STEP_TITLES['restore'], async (note) => {
			const errText = (e) => String(e && e.message ? e.message : e).split('\n')[0];
			const trashed = [...trashedDemo];
			await C.openConnection(page, fixture);
			await openConsole();
			// The directory draws the rows in view only: filter it down to one document at a time.
			const box = visible(page.getByRole('searchbox', { name: 'Filter documents by path' }));
			const rowButton = (name) => visible(page.getByRole('button', { name, exact: true }));
			const showOne = async (p) => {
				await box.fill(p);
				await C.sleep(800);
			};
			// The trashed demo documents come back from the Trash view, one row at a time (Restore asks nothing);
			// one that fails does not keep the others from being tried.
			const before = await stats();
			const sinceRestore = capture.frames.length;
			const refusedRestore = [];
			if (trashed.length) await C.showDirectoryView(page, 'trash');
			for (const p of trashed) {
				try {
					await showOne(p);
					const at = capture.frames.length;
					await rowButton(CONSOLE.restore(p)).click();
					await C.waitForExchange(capture, 'restore', { since: at, timeout: 60000 });
				} catch (e) {
					refusedRestore.push(`${p}: ${errText(e)}`);
				}
			}
			await C.sleep(1500);
			const restoreSent = C.exchanges(capture, 'restore', sinceRestore).map((x) => x.input);
			const back = {};
			for (const p of trashed) back[C.objectId(p)] = await store.state(fixture, C.objectId(p));
			const after = await stats();
			// The lane's own uploads the store holds: to the trash from the Documents view, then deleted
			// permanently from the Trash view (typed on a shared table).
			const stored = [];
			for (const p of ownUploads) if ((await store.state(fixture, C.objectId(p))) === 'active') stored.push(p);
			const refusedDelete = [];
			const refused = (p) => refusedDelete.some((r) => r.startsWith(`${p}: `));
			if (stored.length) await C.showDirectoryView(page, 'active');
			for (const p of stored) {
				try {
					await showOne(p);
					const at = capture.frames.length;
					await rowButton(CONSOLE.trash(p)).click();
					await answerRemoval(true);
					await C.waitForExchange(capture, 'soft_delete', { since: at, timeout: 60000 });
				} catch (e) {
					refusedDelete.push(`${p}: ${errText(e)} (moving it to the trash)`);
				}
			}
			if (stored.length) await C.showDirectoryView(page, 'trash');
			for (const p of stored.filter((q) => !refused(q))) {
				try {
					await showOne(p);
					const at = capture.frames.length;
					await rowButton(CONSOLE.deletePermanently(p)).click();
					await answerRemoval(true, { action: 'delete', typedCount: 1 });
					await C.waitForExchange(capture, 'delete', { since: at, timeout: 60000 });
				} catch (e) {
					refusedDelete.push(`${p}: ${errText(e)}`);
				}
			}
			await C.sleep(1500);
			await box.fill('').catch(() => {});
			await C.showDirectoryView(page, 'active').catch(() => {});
			// Every permanent delete the page sent in this run: only the lane's own uploads may be among them.
			const deleteSent = C.exchanges(capture, 'delete', 0).map((x) => x.input);
			const ownStates = {};
			for (const p of ownUploads) ownStates[C.objectId(p)] = await store.state(fixture, C.objectId(p));
			// What the page left behind is put right through the store, so the next run starts from the corpus
			// as it was (the verdict is the page's): a demo document still in the trash is restored, one gone is
			// uploaded again from the corpus, an upload of the lane's still there is deleted.
			const cleanup = {};
			const stuck = trashed.filter((p) => back[C.objectId(p)] !== 'active');
			if (stuck.length) {
				cleanup.restore = await store
					.tool(fixture, 'restore', { object_ids: stuck.map((p) => C.objectId(p)) })
					.then((a) => (a && a.success === true ? a.object_ids : a && (a.code || a.error)))
					.catch(errText);
				const gone = [];
				for (const p of stuck) if ((await store.state(fixture, C.objectId(p))) === 'gone') gone.push(p);
				if (gone.length) {
					let corpus = {};
					try {
						corpus = demoCorpus();
					} catch (e) {
						cleanup.corpus = errText(e);
					}
					const again = gone
						.map((p) => ({ name: p, text: corpus[p.slice(E.DEMO_PREFIX.length)] }))
						.filter((f) => typeof f.text === 'string');
					cleanup.uploadedAgain = again.map((f) => f.name);
					if (again.length) await store.upload(fixture, again).catch((e) => (cleanup.upload = errText(e)));
				}
			}
			const left = ownUploads.filter((p) => ownStates[C.objectId(p)] !== 'gone');
			if (left.length)
				cleanup.delete = await store
					.tool(fixture, 'delete', { object_ids: left.map((p) => C.objectId(p)) })
					.then((a) => (a && a.success === true ? a.deleted_count : a && (a.code || a.error)))
					.catch(errText);
			note({
				trashed,
				restoreSent,
				refusedRestore,
				back,
				before,
				after,
				ownUploads,
				stored,
				deleteSent,
				refusedDelete,
				ownStates,
				cleanup,
			});
			return restoreVerdict({
				trashed: trashed.map((p) => C.objectId(p)),
				restoreSent,
				refusedRestore,
				back,
				before,
				after,
				own: ownUploads.map((p) => C.objectId(p)),
				stored: stored.map((p) => C.objectId(p)),
				deleteSent,
				refusedDelete,
				ownStates,
			});
		});

		await step(page, STEP_TITLES['sign-out'], async (note) => {
			// Log out is in the shell's account menu (the button with the user's initials).
			await visible(page.locator(UI.account.menu).filter({ hasText: UI.account.initials })).click();
			await visible(page.getByText(CONSOLE.logout, { exact: true })).click();
			await E.signIn(page, base);
			await C.openConnection(page, fixture);
			await openConsole();
			await button(UI.scope.saved).click();
			const filterListed = await visible(page.getByRole('menuitem', { name: UI.scope.applySaved('handbooks') }))
				.isVisible()
				.catch(() => false);
			await page.keyboard.press('Escape');
			await C.switchView(page, CONSOLE.mapTab);
			await canvas.waitFor({ timeout: 90000 });
			await button(UI.views.open, visible(map.locator(UI.views.menu))).click();
			const viewListed = await visible(page.getByRole('button', { name: UI.views.apply('dupes') }))
				.isVisible()
				.catch(() => false);
			note({ filterListed, viewListed });
			if (!savedView || !savedView.listed)
				return 'no view was saved and listed (views step), so its absence proves nothing';
			if (!savedFilter) return 'no filter was saved and applied (scope step), so its absence proves nothing';
			if (filterListed) return "the saved filter 'handbooks' is still listed after signing in again";
			return viewListed ? "the saved view 'dupes' is still listed after signing in again" : true;
		});

		await step(page, STEP_TITLES['privacy'], async (note) => {
			if (!capture.frames.length) return 'no WebSocket frames were captured';
			const dimension = await store.dimension(fixture);
			const violations = C.privacyViolations(capture.frames, dimension);
			const files = downloads
				.filter((d) => !/\.png$/i.test(d.name))
				.map((d) => ({
					name: d.name,
					found: C.downloadVectors(d.bytes.toString('utf8'), dimension, { 'the API key': E.API_KEY }),
				}));
			note({
				dimension,
				frames: capture.frames.length,
				downloads: files.length,
				matrices: C.exchanges(capture, 'similarity_matrix').length,
			});
			if (violations.length) return violations.slice(0, 3).join('; ');
			if (!files.length) return 'no download was checked';
			const dirty = files.filter((f) => f.found.length);
			return dirty.length === 0 ? true : `${dirty[0].name} holds ${dirty[0].found.join('; ')}`;
		});
	} finally {
		await browser.close().catch(() => {});
		await store.close();
	}
}

/** The demo upload name of a corpus path ('scans/x.txt' -> 'C:/demo/scans/x.txt'). */
function DEMO(rel) {
	return E.DEMO_PREFIX + rel;
}

/** The last answered call of `tool` the page made. */
function exchangesLast(capture, tool) {
	const all = C.exchanges(capture, tool).filter((x) => x.response);
	return all.length ? all[all.length - 1] : null;
}

/** node's argv for a child run of this lane: the parent's flags, this file, then `args`. */
function childArgv(execArgv, file, args) {
	return [...execArgv, file, ...args];
}

/**
 * A vector-ui:e2e-live run: the lane once per backend, each in its own process and folder, then
 * every row (with its browser and backend) in <out>/lane_vector_enrich.json. A backend whose
 * child exited non-zero, or recorded fewer rows than it planned (none, say, when sign-in timed
 * out), fails (e2eBackendRows); the exit code is 1 when any row failed.
 * `spawnSync` runs each child (the selftest gives a stand-in).
 */
function runForE2e(args, spawnSync = require('child_process').spawnSync) {
	const rows = [];
	for (const key of args.fixtures) {
		if (args.browser !== 'chrome') {
			rows.push({
				browser: args.browser,
				backend: key,
				fixture: key,
				name: 'lane',
				status: 'FAIL',
				detail: `the enrichment lane drives Google Chrome only, not ${args.browser}`,
			});
			continue;
		}
		const sub = path.join(args.out, key);
		const file = path.join(sub, RESULTS);
		fs.rmSync(file, { force: true });
		const child = spawnSync(process.execPath, childArgv(process.execArgv, __filename, [args.base, sub, key]), {
			stdio: 'inherit',
			env: process.env,
		});
		let data = null;
		try {
			data = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			data = null;
		}
		for (const row of e2eBackendRows(key, child.status, data))
			rows.push({ browser: args.browser, backend: key, ...row });
	}
	fs.mkdirSync(args.out, { recursive: true });
	fs.writeFileSync(path.join(args.out, 'lane_vector_enrich.json'), JSON.stringify(rows, null, 2));
	const failed = rows.filter((r) => r.status !== 'PASS').length;
	console.log(`${rows.length - failed} of ${rows.length} steps passed over ${args.fixtures.join(', ')}`);
	return failed || rows.length === 0 ? 1 : 0;
}

const ARGS = laneArgs(process.argv.slice(2), process.env);

if (require.main === module && ARGS.browser !== null) {
	process.exitCode = runForE2e(ARGS);
} else if (require.main === module) {
	const fixtureKey = ARGS.fixtures[0];
	const out = ARGS.out;
	main(fixtureKey, ARGS.base, out)
		.then(() => {
			const data = JSON.parse(fs.readFileSync(path.join(out, 'lane_vector_enrich.json'), 'utf8'));
			const failed = data.filter((r) => r.status !== 'PASS').length;
			console.log(`${data.length - failed} of ${data.length} steps passed`);
			process.exitCode = failed || data.length === 0 ? 1 : 0;
		})
		.catch((e) => {
			console.error(e);
			const file = path.join(out, RESULTS);
			if (!fs.existsSync(file)) {
				fs.mkdirSync(out, { recursive: true });
				fs.writeFileSync(
					file,
					JSON.stringify(
						[
							{
								fixture: fixtureKey,
								name: 'lane',
								status: 'FAIL',
								detail: String(e && e.message ? e.message : e),
							},
						],
						null,
						2
					)
				);
			}
			process.exitCode = 1;
		});
}

module.exports = {
	CORPUS,
	UI,
	SCOPE_FIXTURES,
	LEGACY_FIXTURE,
	LISTING_MAX,
	PIN_MAX,
	MATRIX_MAX,
	BACKENDS,
	count,
	pathOf,
	keyOf,
	keyText,
	pointsOf,
	foldClusters,
	clusterDocuments,
	folderClusters,
	clustersVerdict,
	minSizeVerdict,
	knnComponents,
	knnDegree,
	matrixCluster,
	hoverEdgePixels,
	edgesVerdict,
	ingestDays,
	rampVerdict,
	isolateVerdict,
	framedVerdict,
	fitVerdict,
	lassoShareVerdict,
	matrixLassoVerdict,
	chunkTextVerdict,
	recommendVerdict,
	bestScoreVerdict,
	matrixVerdict,
	csvTable,
	exportNameVerdict,
	selectionLine,
	copiedKeys,
	selectionCsvVerdict,
	pngInfo,
	pngVerdict,
	viewsVerdict,
	dedupeGroupsAt,
	regroupThreshold,
	dedupeVerdict,
	trashVerdict,
	restoreVerdict,
	outliersVerdict,
	chartsVerdict,
	scopeVerdict,
	scope600Verdict,
	listingVerdict,
	keywordVerdict,
	thresholdVerdict,
	thresholdPositions,
	compareVerdict,
	mapBusy,
	mapCalls,
	mapSettledVerdict,
	layoutVerdict,
	ingestVerdict,
	healthVerdict,
	stepsFor,
	STEP_TITLES,
	unrecordedRows,
	e2eBackendRows,
	runForE2e,
	laneArgs,
	childArgv,
};
