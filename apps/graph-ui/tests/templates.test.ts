// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PIPELINE TEMPLATES: tools_1 plus one graph node, execute off, no secrets
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GRAPH_PROVIDERS } from '../src/adapters/explorer';

interface IComponent {
	id: string;
	provider: string;
	name?: string;
	config: Record<string, unknown>;
	control?: Array<{ classType: string; from: string }>;
}

const DIR = path.resolve(__dirname, '..', 'templates');
const FILES = ['age', 'neo4j', 'falkordb'];
const PROVIDER_OF: Record<string, string> = { age: 'rocketride_graph', neo4j: 'graph_neo4j', falkordb: 'graph_falkordb' };

/** Read a template. */
function read(key: string): { components: IComponent[] } {
	return JSON.parse(fs.readFileSync(path.join(DIR, `${key}.pipe`), 'utf8'));
}

test('exactly the three templates exist, and each is valid JSON', () => {
	assert.deepEqual(fs.readdirSync(DIR).sort(), FILES.map((f) => `${f}.pipe`).sort());
	for (const key of FILES) assert.ok(read(key).components.length > 0, key);
});

test('each template is a tools source plus one graph node of the right provider, wired as a tool', () => {
	for (const key of FILES) {
		const { components } = read(key);
		const tools = components.find((c) => c.id === 'tools_1');
		assert.equal(tools?.provider, 'tools');
		assert.equal(tools?.config.mode, 'Source');
		assert.equal(tools?.config.type, 'tools');
		const graphs = components.filter((c) => GRAPH_PROVIDERS.has(c.provider));
		assert.equal(graphs.length, 1, `${key}: exactly one graph node`);
		assert.equal(graphs[0].provider, PROVIDER_OF[key]);
		assert.deepEqual(graphs[0].control, [{ classType: 'tool', from: 'tools_1' }]);
		const others = components.filter((c) => c !== tools && c !== graphs[0]).map((c) => c.provider);
		assert.deepEqual(others, ['annotation'], `${key}: only a note beside the two nodes`);
	}
});

test('writes are off in every template: allow_execute false, and FalkorDB allow_writes false', () => {
	for (const key of FILES) {
		const graph = read(key).components.find((c) => GRAPH_PROVIDERS.has(c.provider))!;
		const settings = graph.config.default as Record<string, unknown>;
		assert.equal(settings.allow_execute, false, key);
		if (key === 'falkordb') assert.equal(settings.allow_writes, false);
	}
});

test('no template holds a password, token, key or a URL with credentials in it', () => {
	for (const key of FILES) {
		const raw = fs.readFileSync(path.join(DIR, `${key}.pipe`), 'utf8');
		const graph = read(key).components.find((c) => GRAPH_PROVIDERS.has(c.provider))!;
		const settings = graph.config.default as Record<string, unknown>;
		for (const name of ['password', 'token', 'url', 'api_key', 'apikey', 'secret']) assert.ok(!(name in settings), `${key} sets ${name}`);
		assert.doesNotMatch(raw, /:\/\/[^\s"/]*:[^\s"/]*@/, `${key} has a URL with credentials`);
		assert.doesNotMatch(raw, /"(password|token|secret|api_?key)"\s*:\s*"[^"]/i, `${key} has a secret value`);
	}
});

test('no template ships a project_id: nothing is shared between everyone who imports one', () => {
	// An id baked into a shared file would be the same for every user, and a task's identity is derived from
	// (owner, project, source). The editor mints a fresh id when a .pipe is created without one
	// (apps/vscode/src/providers/sidebar/pipelineFiles.ts handleFileCreated), so the templates carry none.
	for (const key of FILES) {
		const doc = read(key) as Record<string, unknown>;
		assert.equal('project_id' in doc, false, `${key} has a project_id`);
		assert.doesNotMatch(fs.readFileSync(path.join(DIR, `${key}.pipe`), 'utf8'), /project_?id/i, `${key} mentions a project id`);
	}
});

test('the editor path that gives an imported template its own id still exists (a guard that the premise above holds)', () => {
	// The .pipe watcher moved out of SidebarProvider.ts into sidebar/pipelineFiles.ts (PipelineFiles) with the dev-tool platform.
	const provider = path.resolve(__dirname, '..', '..', 'vscode', 'src', 'providers', 'sidebar', 'pipelineFiles.ts');
	const source = fs.readFileSync(provider, 'utf8');
	const from = source.indexOf('private async handleFileCreated');
	const to = source.indexOf('private async handleFileChanged', from);
	assert.ok(from >= 0 && to > from, `handleFileCreated (followed by handleFileChanged) is in ${provider}; if it moved again, follow it`);
	const created = source.slice(from, to);
	assert.match(created, /if \(!projectId \|\| isDuplicate\)/);
	assert.match(created, /crypto\.randomUUID\(\)/);
});

test('the Neo4j template names a placeholder reader, not the admin default, and its note recommends a read-only role without claiming a guarantee', () => {
	const doc = read('neo4j');
	const graph = doc.components.find((c) => c.provider === 'graph_neo4j')!;
	assert.notEqual((graph.config.default as Record<string, unknown>).user, 'neo4j', 'the admin account is not the template default');
	const text = String(doc.components.find((c) => c.provider === 'annotation')!.config.content);
	assert.match(text, /use a read-only role/i);
	assert.match(text, /a check in the node, not a database guarantee/i);
	assert.match(text, /routing hint/i);
	assert.match(text, /not access control/i);
	assert.doesNotMatch(text, /Nothing here can write/, 'no unconditional claim that nothing can write');
});

test('the AGE and FalkorDB notes say the template cannot write, and every note says how to get Ask', () => {
	for (const key of ['age', 'falkordb']) assert.match(String(read(key).components.find((c) => c.provider === 'annotation')!.config.content), /Nothing here can write/, key);
	for (const key of FILES) assert.match(String(read(key).components.find((c) => c.provider === 'annotation')!.config.content), /add an LLM node/i, key);
});

// The AGE note does not say browsing a missing graph shows an error. The node checks the graph when the pipeline
// starts and does not create it, so a missing graph stops the pipeline instead; on RocketRide's managed database the
// provisioner creates the graph `rocketride` with every database (organization, team or personal).
test('the AGE note says the managed database already has the graph rocketride, and that a missing graph stops the pipeline from starting', () => {
	const doc = read('age');
	const graph = doc.components.find((c) => c.provider === 'rocketride_graph')!;
	assert.equal((graph.config.default as Record<string, unknown>).graph, 'rocketride');
	const text = String(doc.components.find((c) => c.provider === 'annotation')!.config.content);
	assert.match(text, /graph `rocketride` comes with every database/);
	assert.match(text, /stops the pipeline from starting/);
	assert.match(text, /pipeline's log/);
	assert.doesNotMatch(text, /browsing a name that does not exist shows an error/);
});
