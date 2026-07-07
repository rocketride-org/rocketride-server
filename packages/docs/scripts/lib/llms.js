/**
 * docs:index — generate the node catalog landing page and the LLM surface.
 *
 *   /nodes            generated catalog of every node page
 *   /llms.txt         per-section index with links to each page's .md sibling
 *   /llms-full.txt    full concatenation of every page's raw markdown
 *
 * Consumes the manifest that docs:gather persists at <contentDir>/.manifest.json.
 */

const path = require('path');
const { exists, readFile, writeFileEnsure } = require('../../../../scripts/lib');
const { sections, sectionFor } = require('./spine');

const SITE_TITLE = 'RocketRide Documentation';
const SITE_DESC = 'Build, run, and ship data + AI pipelines with the RocketRide toolchain.';

// One-line description per node type (category label from gather.js
// NODE_CATEGORIES). Used to annotate each heading in the catalog. A label with
// no entry falls back to a generic line.
const CATEGORY_DESCRIPTIONS = {
	Sources: 'Bring data into a pipeline: webhooks, chat, file and database readers, and cloud connectors.',
	LLMs: 'Call large language models for generation, chat, summarization, and reasoning across many providers.',
	'Vision & Image': 'Analyze and transform images: vision models, OCR, thumbnails, cleanup, and accessibility descriptions.',
	Audio: 'Work with audio: transcription, text-to-speech, and playback.',
	Video: 'Process video: frame extraction, embeddings, and video understanding.',
	Text: 'Operate on text: summarization, extraction, named-entity recognition, and anonymization.',
	Embeddings: 'Turn text, images, or video into vectors for semantic search and retrieval.',
	Rerank: 'Reorder retrieved results by relevance to a query.',
	Search: 'Query external search providers and the web.',
	'Vector Stores': 'Store and query embeddings for retrieval: Qdrant, Pinecone, Milvus, Chroma, and more.',
	Databases: 'Read from and write to relational and graph databases.',
	Memory: 'Persist and recall conversational or working state across runs.',
	Agents: 'Autonomous nodes that plan and call tools to accomplish a goal.',
	Tools: 'Capabilities an agent or pipeline can invoke: HTTP, shell, code execution, and external APIs.',
	Preprocessors: 'Prepare and chunk data before embedding or model calls.',
	Data: 'Extract, shape, and route structured data within the pipeline.',
	Guardrails: 'Validate and constrain inputs and outputs for safety and policy.',
	Outputs: 'Send results out of the pipeline: responses, files, and external systems.',
	Infrastructure: 'Plumbing that supports execution rather than transforming data.',
	Other: 'Nodes that do not fall into a single category above.'
};

// Authored prose that frames the generated catalog. The node list itself is
// generated from the manifest so it never drifts from the shipped nodes.
const OVERVIEW_INTRO = [
	'Nodes are the building blocks of a RocketRide pipeline. A [pipeline](/concepts/pipelines)',
	'is a directed graph, and each node is one component that does one job: call a model,',
	'embed text, query a vector store, parse a document, or run a tool. You wire nodes',
	'together and the [engine](/concepts/runtime-engine) runs them.',
	'',
	'This page explains how a node is structured on disk and how the runtime loads and',
	'executes it, then catalogs every node that ships with the toolchain, grouped by type.'
].join('\n');

const ANATOMY_PROSE = [
	'## Anatomy of a node',
	'',
	'Each built-in node is a directory under `nodes/src/nodes/<name>/`. A node is its',
	'service manifest plus an implementation and its documentation:',
	'',
	'```',
	'nodes/src/nodes/llm_openai/',
	'  services.json     # the manifest: identity, class type, capabilities, config schema',
	'  IGlobal.py        # node-level lifecycle: config validation, dependency loading',
	'  IInstance.py      # per-instance behaviour: what the node does each invocation',
	'  *_client.py       # provider/client implementation detail',
	'  requirements.txt  # Python dependencies, installed on demand',
	'  <name>.svg        # canvas icon',
	'  README.md         # co-located documentation (rendered as this node\'s page)',
	'```',
	'',
	'The **`services.json`** manifest is the contract the engine reads. Its key fields:',
	'',
	'| Field | Purpose |',
	'| --- | --- |',
	'| `title` | Display name on the canvas and in this catalog. |',
	'| `protocol` | The node\'s URL scheme, e.g. `llm_openai://`. |',
	'| `classType` | The kind of work the node does (`llm`, `store`, `tool`, …). Governs how it wires into the graph. |',
	'| `capabilities` | Flags that change engine behaviour, e.g. `invoke`. |',
	'| `register` | How the engine registers the node: `filter` (transforms data in the graph) or `endpoint` (an edge connector). |',
	'| `node` / `path` | The runtime (`python`) and module (`nodes.llm_openai`) the engine instantiates. |',
	'| `prefix` | Prefix swapped when converting between URLs and module paths. |',
	'| `description` | Prose shown in the editor. |',
	'| `config` | The configuration schema: the fields a pipeline author fills in. |',
	'',
	'A node\'s public contract is its `classType`, config schema, and the input/output',
	'lanes it supports. The [pipeline JSON reference](/pipeline-reference) documents how a',
	'node is referenced from a `.pipe` file (`id`, `provider`, `config`, `input`).'
].join('\n');

const RUNTIME_PROSE = [
	'## How the runtime runs a node',
	'',
	'1. **Discovery & registration.** On startup the engine scans every `services*.json`',
	'   and registers a factory keyed by `protocol`/`prefix`. The `register` value decides',
	'   whether the node is a `filter` in the graph or an `endpoint` connector at its edge.',
	'2. **Instantiation.** When a pipeline references a provider, the engine instantiates',
	'   the implementation named by `node` and `path`. `IGlobal` runs once per node',
	'   definition (it validates `config` and loads `requirements.txt` on demand);',
	'   `IInstance` carries the per-invocation behaviour.',
	'3. **Wiring.** The `classType` determines how the node connects. Data nodes exchange',
	'   data through **lanes**; `agent`, `tool`, `llm`, and `memory` nodes participate in',
	'   **control** connections (see [Agents & tools](/concepts/agents-tools-skills)).',
	'4. **Execution.** The engine drives the graph from sources to targets, passing each',
	'   node\'s output along its lanes. `capabilities` flags toggle engine features such as',
	'   `invoke`. See the [execution model](/concepts/execution-model) for how data flows.',
	'',
	'Because behaviour lives in `provider` + `config`, swapping which model or store a',
	'pipeline uses is a config edit, not a code change.'
].join('\n');

/**
 * Escape a value for a Markdown table cell: collapse newlines to spaces and
 * escape pipe characters so a stray `|` or line break in a title/description
 * cannot break the column layout.
 * @param {unknown} value - raw cell value.
 * @return {string} a single-line, pipe-safe string.
 */
function tableCell(value) {
	return String(value ?? '')
		.replace(/\r?\n/g, ' ')
		.replace(/\|/g, '\\|')
		.trim();
}

/**
 * Render the generated node catalog page: authored framing prose followed by a
 * per-category Markdown table of every node (linked title + description).
 * @param {Array<object>} nodes - manifest node entries (title, route, description, category).
 * @return {string} the full Markdown document for the /nodes overview page.
 */
function nodeCatalogMarkdown(nodes) {
	// Title comes from front matter (theme renders it); no body H1 to avoid a
	// duplicate heading. Authored prose frames a catalog that is generated from
	// the manifest and grouped by category to match the sidebar dropdown.
	const lines = ['---', 'title: Overview', 'slug: /nodes', 'sidebar_position: 0', '---', ''];
	if (!nodes.length) {
		lines.push('_No node documentation has been migrated yet._', '');
		return lines.join('\n');
	}
	const groups = new Map(); // category label -> { order, items }
	for (const n of nodes) {
		const label = n.category || 'Other';
		if (!groups.has(label)) groups.set(label, { order: n.categoryOrder ?? 999, items: [] });
		groups.get(label).items.push(n);
	}
	const ordered = [...groups.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));

	lines.push(OVERVIEW_INTRO, '');
	lines.push(ANATOMY_PROSE, '');
	lines.push(RUNTIME_PROSE, '');
	lines.push('## Node types', '');
	lines.push(`${nodes.length} nodes across ${ordered.length} types. Every node declares a`, 'class type in its manifest; the catalog below is grouped by it.', '');
	for (const [label, group] of ordered) {
		lines.push(`### ${label}`, '');
		lines.push(CATEGORY_DESCRIPTIONS[label] || `${label} nodes.`, '');
		lines.push('| Node | Description |');
		lines.push('| --- | --- |');
		for (const n of group.items.sort((a, b) => a.title.localeCompare(b.title))) {
			lines.push(`| [${tableCell(n.title)}](${n.route}) | ${tableCell(n.description)} |`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

/** Order manifest entries by spine section, then by route. */
function ordered(manifest) {
	const order = sections().map((s) => s.label);
	return [...manifest].sort((a, b) => {
		const sa = order.indexOf(sectionFor(a.id));
		const sb = order.indexOf(sectionFor(b.id));
		if (sa !== sb) return sa - sb;
		return a.route.localeCompare(b.route);
	});
}

function llmsIndex(manifest) {
	const lines = [`# ${SITE_TITLE}`, '', `> ${SITE_DESC}`, ''];
	const order = sections().map((s) => s.label);
	const bySection = new Map();
	for (const e of manifest) {
		const sec = sectionFor(e.id);
		if (!bySection.has(sec)) bySection.set(sec, []);
		bySection.get(sec).push(e);
	}
	for (const label of [...order, 'Other']) {
		const entries = bySection.get(label);
		if (!entries || !entries.length) continue;
		lines.push(`## ${label}`, '');
		for (const e of entries.sort((a, b) => a.route.localeCompare(b.route))) {
			lines.push(`- [${e.title}](${e.mdSibling})`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

async function llmsFull(manifest, generated) {
	const parts = [`# ${SITE_TITLE}`, '', `> ${SITE_DESC}`, ''];
	for (const e of ordered(manifest)) {
		let content = generated.get(e.id);
		if (content == null && e.source && (await exists(e.source))) content = await readFile(e.source);
		if (content == null) continue;
		parts.push('', '---', '', `# ${e.title}`, '', `Route: ${e.route}`, '', String(content).trim(), '');
	}
	return parts.join('\n');
}

/**
 * @param {object} args
 * @param {string} args.contentDir
 * @param {string} args.staticDir
 * @param {object} [args.task]
 */
async function buildIndex({ contentDir, staticDir, task }) {
	const manifestPath = path.join(contentDir, '.manifest.json');
	const manifest = (await exists(manifestPath)) ? JSON.parse(await readFile(manifestPath)) : [];

	// Generated content kept in memory so llms-full can include it.
	const generated = new Map();

	// Node catalog -> overwrite the gather placeholder + add to the manifest.
	const nodes = manifest.filter((e) => e.node);
	const catalog = nodeCatalogMarkdown(nodes);
	await writeFileEnsure(path.join(contentDir, 'nodes', 'index.md'), catalog);
	await writeFileEnsure(path.join(staticDir, 'nodes.md'), catalog);
	const withCatalog = manifest.filter((e) => e.id !== 'nodes');
	withCatalog.push({ id: 'nodes', route: '/nodes', title: 'Overview', mdSibling: '/nodes.md' });
	generated.set('nodes', catalog);

	await writeFileEnsure(path.join(staticDir, 'llms.txt'), llmsIndex(withCatalog));
	await writeFileEnsure(path.join(staticDir, 'llms-full.txt'), await llmsFull(withCatalog, generated));

	if (task) task.output = `Indexed ${withCatalog.length} pages (${nodes.length} nodes)`;
}

module.exports = { buildIndex };
