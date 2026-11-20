// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PIPELINE TEMPLATES: the nine Vector Explorer shapes, writes only on store_1, no secrets
// =============================================================================
//
// Every template is the "VX shape": an ingest (dropper), a chat and a tools
// source; parse -> chunk -> embed -> store_1 on the data lane; the chat path
// through embed_1 -> store_2 -> llm_1 -> response_answers, with store_2's
// documents to response_documents; tools_1 controlling store_1 and embed_1.
// The write default comes from tests/fixtures/defaults.json (generated from
// vx_defaults.py), so reversing the default is one line and this test follows.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { VECTOR_PROVIDERS } from '../src/adapters/explorer';

interface IComponent {
	id: string;
	provider: string;
	name?: string;
	config: Record<string, unknown>;
	input?: Array<{ lane: string; from: string }>;
	control?: Array<{ classType: string; from: string }>;
}

const DIR = path.resolve(__dirname, '..', 'templates');
const NODES = path.resolve(__dirname, '..', '..', '..', 'nodes', 'src', 'nodes');
const FIXTURES = path.resolve(__dirname, 'fixtures');
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'defaults.json'), 'utf8')) as { VECTOR_ALLOW_WRITES_DEFAULT: boolean };
const CHUNKING = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'chunking.json'), 'utf8')) as { calibrated: boolean; chunk_1: { provider: string; config: Record<string, unknown> } };

/** Template file -> the store provider it is for. */
const PROVIDER_OF: Record<string, string> = {
	postgres: 'postgres',
	rocketride_vector: 'rocketride_vector',
	qdrant: 'qdrant',
	chroma: 'chroma',
	milvus: 'milvus',
	weaviate: 'weaviate',
	pinecone: 'pinecone',
	astra: 'astra_db',
	atlas: 'mongodb+srv',
};
const FILES = Object.keys(PROVIDER_OF);

/** Read a template. */
function read(key: string): { components: IComponent[] } {
	return JSON.parse(fs.readFileSync(path.join(DIR, `${key}.pipe`), 'utf8'));
}

/** The component with this id. */
function byId(components: IComponent[], id: string): IComponent {
	const found = components.find((c) => c.id === id);
	assert.ok(found, `no component ${id}`);
	return found;
}

/** The active profile's settings of a component (`config[config.profile]`), where the node reads its fields. */
function settings(component: IComponent): Record<string, unknown> {
	const profile = component.config.profile;
	assert.equal(typeof profile, 'string', `${component.id} has a profile`);
	const values = component.config[profile as string];
	assert.ok(values && typeof values === 'object', `${component.id} has settings for its profile ${String(profile)}`);
	return values as Record<string, unknown>;
}

/** The value the node will use for allow_writes: what the template says, else the build's default. */
function effectiveAllowWrites(component: IComponent): boolean {
	const value = settings(component).allow_writes;
	return value === undefined ? DEFAULTS.VECTOR_ALLOW_WRITES_DEFAULT : value === true;
}

/** Strip // comments from a services.json (they are JSON with comments), leaving strings alone. */
function parseServices(file: string): Record<string, unknown> {
	const text = fs.readFileSync(file, 'utf8');
	let out = '';
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === '\\') {
				out += text[i + 1];
				i += 1;
			} else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
		} else if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i += 1;
			out += '\n';
		} else out += ch;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

test('exactly the nine templates exist, and each is valid JSON', () => {
	assert.deepEqual(fs.readdirSync(DIR).sort(), FILES.map((f) => `${f}.pipe`).sort());
	for (const key of FILES) assert.ok(read(key).components.length > 0, key);
});

test('the app opens exactly the providers the vector store nodes declare, and never Elasticsearch or OpenSearch', () => {
	const declared = new Set<string>();
	for (const folder of fs.readdirSync(NODES)) {
		const file = path.join(NODES, folder, 'services.json');
		if (!fs.existsSync(file)) continue;
		const services = parseServices(file);
		const classType = services.classType as string[] | undefined;
		if (!Array.isArray(classType) || !classType.includes('store')) continue;
		declared.add(String(services.protocol).replace(/:\/\/$/, ''));
	}
	assert.deepEqual([...VECTOR_PROVIDERS].sort(), [...declared].sort());
	assert.deepEqual([...VECTOR_PROVIDERS].sort(), Object.values(PROVIDER_OF).sort(), 'one template per provider');
	for (const other of ['elasticsearch', 'opensearch']) assert.equal(VECTOR_PROVIDERS.has(other), false, other);
	const es = parseServices(path.join(NODES, 'store_elasticsearch', 'services.elasticsearch.json'));
	assert.equal(es.protocol, 'elasticsearch://', 'the premise: Elasticsearch is a store node the app leaves out');
});

test('three sources: ingest_1 (dropper), chat_1 (chat) and tools_1 (tools)', () => {
	for (const key of FILES) {
		const { components } = read(key);
		for (const [id, provider] of [
			['ingest_1', 'dropper'],
			['chat_1', 'chat'],
			['tools_1', 'tools'],
		]) {
			const source = byId(components, id);
			assert.equal(source.provider, provider, `${key}: ${id}`);
			assert.equal(source.config.mode, 'Source', `${key}: ${id} is a source`);
			assert.equal(source.config.type, provider, `${key}: ${id} type`);
		}
		const sources = components.filter((c) => c.config.mode === 'Source').map((c) => c.id);
		assert.deepEqual(sources.sort(), ['chat_1', 'ingest_1', 'tools_1'], `${key}: no other source`);
	}
});

test('store_1 and embed_1 are controlled by tools_1, and nothing else is', () => {
	for (const key of FILES) {
		const { components } = read(key);
		const tool = [{ classType: 'tool', from: 'tools_1' }];
		assert.deepEqual(byId(components, 'store_1').control, tool, `${key}: store_1`);
		assert.deepEqual(byId(components, 'embed_1').control, tool, `${key}: embed_1`);
		const controlled = components.filter((c) => (c.control ?? []).length > 0).map((c) => c.id);
		assert.deepEqual(controlled.sort(), ['embed_1', 'store_1'], `${key}: only store_1 and embed_1 take tool calls`);
		assert.equal(byId(components, 'store_1').provider, PROVIDER_OF[key], `${key}: provider`);
	}
});

test('the data lane: ingest -> parse (text and table lanes only) -> chunk -> embed -> store_1', () => {
	for (const key of FILES) {
		const { components } = read(key);
		assert.deepEqual(byId(components, 'parse_1').input, [{ lane: 'tags', from: 'ingest_1' }], `${key}: parse_1`);
		assert.deepEqual(byId(components, 'chunk_1').input, [
			{ lane: 'text', from: 'parse_1' },
			{ lane: 'table', from: 'parse_1' },
		]);
		const fromParse = components.flatMap((c) => (c.input ?? []).filter((edge) => edge.from === 'parse_1').map((edge) => edge.lane));
		assert.deepEqual(fromParse.sort(), ['table', 'text'], `${key}: the parser's other lanes (images, audio) go nowhere`);
		assert.deepEqual(byId(components, 'store_1').input, [{ lane: 'documents', from: 'embed_1' }], `${key}: store_1`);
		assert.ok(
			byId(components, 'embed_1').input?.some((e) => e.lane === 'documents' && e.from === 'chunk_1'),
			`${key}: embed_1 takes the chunks`
		);
	}
});

test('the chat path: embed_1 -> store_2 (same provider and collection as store_1) -> llm_1 -> response_answers, documents -> response_documents', () => {
	for (const key of FILES) {
		const { components } = read(key);
		const store1 = byId(components, 'store_1');
		const store2 = byId(components, 'store_2');
		assert.equal(store2.provider, store1.provider, `${key}: same provider`);
		assert.equal(store2.config.profile, store1.config.profile, `${key}: same profile`);
		assert.equal(settings(store2).collection, settings(store1).collection, `${key}: same collection`);
		assert.ok(typeof settings(store1).collection === 'string' && (settings(store1).collection as string).length > 0, `${key}: a collection is named`);
		assert.ok(
			byId(components, 'embed_1').input?.some((e) => e.lane === 'questions' && e.from === 'chat_1'),
			`${key}: questions are embedded`
		);
		assert.deepEqual(store2.input, [{ lane: 'questions', from: 'embed_1' }], `${key}: store_2 takes the questions`);
		assert.deepEqual(byId(components, 'llm_1').input, [{ lane: 'questions', from: 'store_2' }], `${key}: llm_1 reads store_2`);
		const answers = components.filter((c) => c.provider === 'response_answers');
		const documents = components.filter((c) => c.provider === 'response_documents');
		assert.equal(answers.length, 1, `${key}: response_answers`);
		assert.equal(documents.length, 1, `${key}: response_documents`);
		assert.deepEqual(answers[0].input, [{ lane: 'answers', from: 'llm_1' }]);
		assert.deepEqual(documents[0].input, [{ lane: 'documents', from: 'store_2' }]);
	}
});

test('no agent and no tool node on the chat path: only the stores answer tool calls there', () => {
	const classTypes = new Map<string, string[]>();
	for (const folder of fs.readdirSync(NODES)) {
		const file = path.join(NODES, folder, 'services.json');
		if (!fs.existsSync(file)) continue;
		const services = parseServices(file);
		classTypes.set(String(services.protocol).replace(/:\/\/$/, ''), (services.classType as string[] | undefined) ?? []);
	}
	assert.ok(classTypes.get('qdrant')?.includes('tool'), 'the premise: the stores are tool nodes');
	for (const key of FILES) {
		for (const c of read(key).components) {
			assert.doesNotMatch(c.provider, /^agent|^tool_|^mcp/, `${key}: ${c.id} (${c.provider})`);
			if ((classTypes.get(c.provider) ?? []).includes('tool')) assert.equal(c.provider, PROVIDER_OF[key], `${key}: ${c.id} (${c.provider}) is a tool node`);
		}
	}
});

test('allow_writes: true on store_1 only, read where the node reads it (config[config.profile]); the default comes from defaults.json', () => {
	assert.equal(typeof DEFAULTS.VECTOR_ALLOW_WRITES_DEFAULT, 'boolean', 'the premise: the generated default is there');
	for (const key of FILES) {
		const { components } = read(key);
		assert.equal(effectiveAllowWrites(byId(components, 'store_1')), true, `${key}: store_1 can remove documents`);
		assert.equal(effectiveAllowWrites(byId(components, 'store_2')), false, `${key}: store_2 (the chat's store) cannot, whatever the default`);
		for (const c of components) {
			if (c.id === 'store_1') continue;
			const profile = typeof c.config.profile === 'string' ? (c.config[c.config.profile] as Record<string, unknown> | undefined) : undefined;
			assert.notEqual(profile?.allow_writes, true, `${key}: ${c.id} sets allow_writes`);
			assert.notEqual(c.config.allow_writes, true, `${key}: ${c.id} sets allow_writes at the top level`);
		}
	}
});

test('rocketride_vector: both stores expose their tools, and only store_1 has write tools', () => {
	// The node's outer gate (#2631): expose_tools and allow_write are off by default, so the
	// template sets them itself. allow_write is the one barrier against agent writes on this
	// node, so store_2 (the chat's, on the public Chat source's pipe) keeps it off: its write
	// tools do not exist, for agents or DAP callers.
	const { components } = read('rocketride_vector');
	const store1 = settings(byId(components, 'store_1'));
	const store2 = settings(byId(components, 'store_2'));
	assert.deepEqual([store1.expose_tools, store1.allow_write, store1.allow_writes], [true, true, true]);
	assert.deepEqual([store2.expose_tools, store2.allow_write, store2.allow_writes], [true, false, false]);
});

/** The repository root (driver sources are read from it). */
const REPO = path.resolve(__dirname, '..', '..', '..');

/** The cosine similarity every template's retrieval threshold stands for. */
const RETRIEVAL_COSINE = 0.3;

/**
 * How each provider's store node turns a cosine match into the `score` its
 * threshold is compared with (the drivers' scoreInfo, contract page section 3),
 * and where the driver says so. pgvector and Pinecone report the cosine
 * similarity itself; the others rescale it to (1 + cosine) / 2, so the same
 * cut is a different number there. `metric` is where cosine comes from: the
 * template's own `similarity`, or the driver's default when the template sets none.
 */
const SCORE_SCALE: Record<string, { driver: string; formula: string; metric: string; toScore: (cosine: number) => number }> = {
	postgres: { driver: 'packages/ai/src/ai/common/store/pgvector/driver.py', formula: "'cosine': {'formula': '1 - cosine_distance'", metric: 'template', toScore: (c) => c },
	rocketride_vector: { driver: 'packages/ai/src/ai/common/store/pgvector/driver.py', formula: "'cosine': {'formula': '1 - cosine_distance'", metric: 'template', toScore: (c) => c },
	pinecone: { driver: 'nodes/src/nodes/store_pinecone/pinecone.py', formula: "'cosine similarity (raw)'", metric: "config.get('similarity', 'cosine')", toScore: (c) => c },
	qdrant: { driver: 'nodes/src/nodes/store_qdrant/qdrant.py', formula: "'(1 + cosine_similarity) / 2'", metric: "config.get('similarity', 'Cosine')", toScore: (c) => (1 + c) / 2 },
	chroma: { driver: 'nodes/src/nodes/store_chroma/chroma.py', formula: "'(2 - cosine_distance) / 2'", metric: "config.get('similarity', 'cosine')", toScore: (c) => (1 + c) / 2 },
	milvus: { driver: 'nodes/src/nodes/store_milvus/milvus.py', formula: "'(1 + cosine similarity) / 2'", metric: "config.get('similarity', 'COSINE')", toScore: (c) => (1 + c) / 2 },
	weaviate: { driver: 'nodes/src/nodes/store_weaviate/weaviate.py', formula: "'1 - cosine distance / 2'", metric: "config.get('similarity', 'cosine')", toScore: (c) => (1 + c) / 2 },
	astra: { driver: 'nodes/src/nodes/store_astra/astra_db.py', formula: "'(1 + cosine similarity) / 2'", metric: "config.get('similarity', 'cosine')", toScore: (c) => (1 + c) / 2 },
	atlas: { driver: 'nodes/src/nodes/store_atlas/atlas.py', formula: "'(1 + cosine similarity) / 2'", metric: "config.get('similarity', 'cosine')", toScore: (c) => (1 + c) / 2 },
};

test("the retrieval threshold is the same cosine cut on every store's own score scale", () => {
	assert.deepEqual(Object.keys(SCORE_SCALE).sort(), [...FILES].sort(), 'every template has its scale');
	for (const key of FILES) {
		const scale = SCORE_SCALE[key];
		const source = fs.readFileSync(path.join(REPO, scale.driver), 'utf8');
		assert.ok(source.includes(scale.formula), `${key}: the driver still scores cosine as ${scale.formula}`);
		const { components } = read(key);
		const expected = scale.toScore(RETRIEVAL_COSINE);
		for (const id of ['store_1', 'store_2']) {
			const values = settings(byId(components, id));
			if (scale.metric === 'template') assert.equal(values.similarity, 'cosine', `${key}: ${id} names cosine`);
			else {
				assert.equal(values.similarity, undefined, `${key}: ${id} leaves the metric to the driver`);
				assert.ok(source.includes(scale.metric), `${key}: the driver defaults to cosine (${scale.metric})`);
			}
			// A threshold of 0.3 on a (1 + cosine) / 2 scale would be a cosine of -0.4: every chunk would pass.
			assert.equal(typeof values.score, 'number', `${key}: ${id} sets a threshold`);
			assert.ok(Math.abs((values.score as number) - expected) < 1e-9, `${key}: ${id} score ${String(values.score)} is cosine ${RETRIEVAL_COSINE} on this store's scale (${expected})`);
		}
	}
});

/** Template file -> the folder of its live captures (tests/fixtures/v1/live), for the templates that have them. */
const CAPTURED_AS: Record<string, string> = { postgres: 'pgvector', rocketride_vector: 'rocketride_vector', qdrant: 'qdrant', chroma: 'chroma' };

test("the live dialect captures report the template's current threshold (regenerate them when a threshold changes)", () => {
	// The captures are taken from these templates (nodes/test/vector_wire_fixtures.py); a template edit
	// without a regeneration only shows up in the live suite, so the threshold they echo is checked here too.
	for (const [key, folder] of Object.entries(CAPTURED_AS)) {
		const expected = settings(byId(read(key).components, 'store_1')).score;
		for (const kind of ['', '.legacy']) {
			const file = path.join(FIXTURES, 'v1', 'live', folder, `dialect${kind}.json`);
			const dialect = JSON.parse(fs.readFileSync(file, 'utf8')) as { score?: { threshold?: unknown } };
			assert.equal(dialect.score?.threshold, expected, `${folder}/dialect${kind}.json reports threshold ${String(dialect.score?.threshold)}, ${key}.pipe sets ${String(expected)}: regenerate the captures`);
		}
	}
});

test('the parser refuses files over 50 MB in every template', () => {
	for (const key of FILES) {
		const parse = byId(read(key).components, 'parse_1');
		assert.equal((parse.config.index as Record<string, unknown>).maxFileSize, 52428800, key);
	}
});

test('the LLM carries the placeholder key and no base URL', () => {
	for (const key of FILES) {
		const llm = byId(read(key).components, 'llm_1');
		const values = settings(llm);
		assert.equal(values.apikey, 'replace-with-your-key', key);
		assert.equal(values.base_url, '', key);
	}
});

test('chunking: every template carries the calibrated chunk_1 settings', (t) => {
	if (!CHUNKING.calibrated) {
		t.skip('NOT RUN: chunking not calibrated');
		return;
	}
	for (const key of FILES) {
		const chunk = byId(read(key).components, 'chunk_1');
		assert.equal(chunk.provider, CHUNKING.chunk_1.provider, key);
		assert.deepEqual(chunk.config, CHUNKING.chunk_1.config, key);
	}
});

test('no template ships a project_id, a password, a token or a URL with credentials', () => {
	for (const key of FILES) {
		const raw = fs.readFileSync(path.join(DIR, `${key}.pipe`), 'utf8');
		const doc = read(key) as unknown as Record<string, unknown>;
		assert.equal('project_id' in doc, false, `${key} has a project_id`);
		assert.doesNotMatch(raw, /project_?id/i, `${key} mentions a project id`);
		assert.doesNotMatch(raw, /:\/\/[^\s"/]*:[^\s"/]*@/, `${key} has a URL with credentials`);
		// Every secret-like field is empty, except the LLM key's documented placeholder.
		for (const match of raw.matchAll(/"(password|token|secret|api_?key|apikey)"\s*:\s*"([^"]*)"/gi)) {
			assert.ok(match[2] === '' || match[2] === 'replace-with-your-key', `${key}: ${match[1]} is "${match[2]}"`);
		}
	}
});
