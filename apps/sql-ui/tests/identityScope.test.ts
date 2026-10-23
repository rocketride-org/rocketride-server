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
// IDENTITY SCOPE — a change of account closes the previous account's tabs
// =============================================================================
//
// When the signed-in user, organization or team changes without a reload,
// the open workbench, query, table, designer, diagram and connection-editor
// tabs, and the schema snapshots, belonged to the previous account and must go
// with it, so its results are never shown to the next one. An identity nobody
// can vouch for (signed out, connection dropped) forgets the schemas and keeps
// the tabs (R9; the frames follow the same rule through the dev-tool
// library's identity guard, see devtool.identity.test.ts).
//
// The tabs are checked against a structural fake of the shell's document
// model (FakeDocs below) that keeps editor groups and the active group, so a
// closed editor is proven gone from its group and its document released. App
// tests do not import the shell's sources. SqlApp has no DOM harness here, so
// its wiring is checked against the source.
//
// Port of 98277843b (tests/identityScope.test.ts), on the R9 rule; this app
// has no Connections landing, and its schema store holds no sessions (the
// engine core's endpoint store does, and forgets them on an identity change).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Document, DocumentsState, Editor } from 'shell';
import type { IExplorerClient } from 'shared/explorer/types';
import type { ConnectionDocsHost } from '../src/docs';
import { closeConnectionDocuments, connectionEditorUri, connectionUri, designUri, diagramUri, nextQueryDoc, tableDataUri } from '../src/docs';
import { createIdentityScope, forgetConnectionScope, sqlIdentityScope } from '../src/identityScope';
import { refreshSchema, schemaSnapshot } from '../src/schema/schemaStore';
import { createSqlSession } from '../src/connect/session';
import type { SqlSession } from '../src/connect';
import { describeEndpoint, registerEndpoint, sqlEndpoints } from './support';

// =============================================================================
// HELPERS
// =============================================================================

/** The part of the shell's document state the fake keeps, in the shell's own types. */
type FakeDocsState = Pick<DocumentsState, 'documents' | 'editors' | 'groups' | 'activeGroupId'>;

/**
 * A structural fake of the shell's `Documents`, with the semantics these tests
 * rely on and nothing more:
 *
 * - `openStaticDocument` focuses an editor that already shows the URI, in any
 *   group; otherwise it adds one to the active group and makes it active.
 * - `splitGroupWithDocument` adds a group, made active, holding a second editor
 *   on the split group's active document (that document then has two editors).
 * - `closeEditor` removes the editor from its group and releases its document
 *   with the last clean editor. A group it empties is removed unless it is the
 *   last one, and the last remaining group becomes active if the removed group
 *   was.
 * - Every change replaces the state, so a caller still iterating an earlier
 *   `getState()` is not disturbed.
 *
 * It keeps every group and the active group, so a `closeConnectionDocuments`
 * that closed only the active group's editors would leave tabs open in the
 * other group and fail.
 */
class FakeDocs implements ConnectionDocsHost {
	private state: FakeDocsState = {
		documents: {},
		editors: {},
		groups: { 'group-1': { id: 'group-1', editorIds: [], activeEditorIndex: -1 } },
		activeGroupId: 'group-1',
	};

	private editorSeq = 0;

	private groupSeq = 1;

	/**
	 * The current state (replaced, never mutated, on every change).
	 *
	 * @returns The state.
	 */
	getState(): FakeDocsState {
		return this.state;
	}

	/**
	 * Open a static document, or focus the editor that already shows it.
	 *
	 * @param uri - The document URI.
	 * @param label - The tab label.
	 * @param content - The static payload.
	 */
	openStaticDocument(uri: string, label: string, content?: unknown): void {
		const s = this.state;
		for (const group of Object.values(s.groups)) {
			const index = group.editorIds.findIndex((id) => s.editors[id]?.documentUri === uri);
			if (index !== -1) {
				this.state = { ...s, groups: { ...s.groups, [group.id]: { ...group, activeEditorIndex: index } }, activeGroupId: group.id };
				return;
			}
		}
		const group = s.groups[s.activeGroupId];
		assert.ok(group, 'the active group exists');
		const editor = this.newEditor(uri, label);
		const document: Document = { uri, content: content ?? null, dirty: false, version: 1, editorCount: 1, isNew: false, static: true };
		const editorIds = [...group.editorIds, editor.id];
		this.state = {
			...s,
			documents: { ...s.documents, [uri]: document },
			editors: { ...s.editors, [editor.id]: editor },
			groups: { ...s.groups, [group.id]: { ...group, editorIds, activeEditorIndex: editorIds.length - 1 } },
		};
	}

	/**
	 * Split a group: a new active group with an editor on the group's active document.
	 *
	 * @param groupId - The group to split.
	 * @returns The new group's id.
	 */
	splitGroupWithDocument(groupId: string): string {
		const s = this.state;
		const group = s.groups[groupId];
		assert.ok(group, `group ${groupId} exists`);
		const id = `group-${++this.groupSeq}`;
		const activeId = group.editorIds[group.activeEditorIndex];
		const active = activeId !== undefined ? s.editors[activeId] : undefined;
		const shown = active !== undefined ? s.documents[active.documentUri] : undefined;
		if (active === undefined || shown === undefined) {
			this.state = { ...s, groups: { ...s.groups, [id]: { id, editorIds: [], activeEditorIndex: -1 } }, activeGroupId: id };
			return id;
		}
		const editor = this.newEditor(active.documentUri, active.label);
		this.state = {
			documents: { ...s.documents, [shown.uri]: { ...shown, editorCount: shown.editorCount + 1 } },
			editors: { ...s.editors, [editor.id]: editor },
			groups: { ...s.groups, [id]: { id, editorIds: [editor.id], activeEditorIndex: 0 } },
			activeGroupId: id,
		};
		return id;
	}

	/**
	 * Close one editor (an unknown id is ignored, as the shell does).
	 *
	 * @param editorId - The editor to close.
	 */
	closeEditor(editorId: string): void {
		const s = this.state;
		const editor = s.editors[editorId];
		if (editor === undefined) return;
		const { [editorId]: _closed, ...editors } = s.editors;

		let groups = { ...s.groups };
		let activeGroupId = s.activeGroupId;
		const owner = Object.values(groups).find((group) => group.editorIds.includes(editorId));
		if (owner !== undefined) {
			const index = owner.editorIds.indexOf(editorId);
			const editorIds = owner.editorIds.filter((id) => id !== editorId);
			if (editorIds.length === 0 && Object.keys(groups).length > 1) {
				const { [owner.id]: _removed, ...rest } = groups;
				groups = rest;
				const remaining = Object.keys(groups);
				if (activeGroupId === owner.id) activeGroupId = remaining[remaining.length - 1] as string;
			} else {
				let activeEditorIndex = owner.activeEditorIndex;
				if (activeEditorIndex >= editorIds.length) activeEditorIndex = Math.max(0, editorIds.length - 1);
				if (activeEditorIndex > index) activeEditorIndex -= 1;
				groups[owner.id] = { ...owner, editorIds, activeEditorIndex };
			}
		}

		let documents = s.documents;
		const document = documents[editor.documentUri];
		if (document !== undefined) {
			if (document.editorCount <= 1 && !document.dirty) {
				const { [editor.documentUri]: _released, ...rest } = documents;
				documents = rest;
			} else {
				documents = { ...documents, [editor.documentUri]: { ...document, editorCount: document.editorCount - 1 } };
			}
		}

		this.state = { documents, editors, groups, activeGroupId };
	}

	/**
	 * Build an editor with the next id.
	 *
	 * @param uri - The document it shows.
	 * @param label - Its tab label.
	 * @returns The editor.
	 */
	private newEditor(uri: string, label: string): Editor {
		return { id: `editor-${++this.editorSeq}`, documentUri: uri, scrollTop: 0, scrollLeft: 0, cursorLine: 1, cursorColumn: 1, label };
	}
}

/** A document that is not a connection's (it must survive). */
const OTHER_URI = 'settings:general';

/**
 * A document model holding one tab of every connection-scoped kind for `key`
 * plus a connection editor and one unrelated document, with the query tab also
 * split into a second group (so one document has two editors).
 *
 * @param key - The endpoint key the tabs belong to.
 * @returns The document model.
 */
function docsWithEveryTab(key: string): FakeDocs {
	const docs = new FakeDocs();
	docs.openStaticDocument(OTHER_URI, 'Settings');
	docs.openStaticDocument(connectionUri(key), 'Orders DB', { key });
	docs.openStaticDocument(tableDataUri(key, 'odd:name'), 'odd:name', { key });
	docs.openStaticDocument(designUri(key, null), 'New table', { key });
	docs.openStaticDocument(diagramUri(key), 'Diagram', { key });
	docs.openStaticDocument(connectionEditorUri('c-1'), 'Edit Orders DB');
	const query = nextQueryDoc(key);
	docs.openStaticDocument(query.uri, query.label, { key });
	docs.splitGroupWithDocument(docs.getState().activeGroupId);
	return docs;
}

/**
 * The document URIs the model still has an editor for.
 *
 * @param docs - The document model.
 * @returns The URIs, sorted.
 */
function openUris(docs: FakeDocs): string[] {
	return Object.values(docs.getState().editors).map((editor) => editor.documentUri).sort();
}

/** A fake client whose tool calls wait until `release` is called. */
interface IGatedClient {
	client: IExplorerClient;
	/** Every tool invoked, in order. */
	tools: string[];
	/** Let every waiting (and later) call answer. */
	release(): void;
}

/**
 * Build a fake client that answers like a postgres node, but only once released.
 *
 * @param gated - Whether calls wait for `release` (false: answer at once).
 * @param database - The database name its schema reports.
 * @returns The client, its tool log and the release switch.
 */
function gatedClient(gated: boolean, database = 'previous_team_db'): IGatedClient {
	const tools: string[] = [];
	let open = !gated;
	const waiting: (() => void)[] = [];
	const client: IExplorerClient = {
		getTasks: async () => [],
		getTaskPipeline: async () => undefined,
		tool: async <T,>({ tool }: { tool: string }): Promise<T> => {
			tools.push(tool);
			if (!open) await new Promise<void>((resolve) => waiting.push(resolve));
			if (tool === 'dialect') return { dialect: 'postgres' } as T;
			return { database, tables: { orders: { columns: [] } } } as T;
		},
	};
	return {
		client,
		tools,
		release: () => {
			open = true;
			waiting.splice(0).forEach((resolve) => resolve());
		},
	};
}

/**
 * SQL Explorer's session on a registered endpoint, over a client.
 *
 * @param client - The client.
 * @param name - The endpoint's project id.
 * @returns The session.
 */
async function sessionOn(client: IExplorerClient, name: string): Promise<SqlSession> {
	const endpoint = await registerEndpoint(name);
	return createSqlSession(sqlEndpoints.session(client, endpoint), describeEndpoint(endpoint));
}

// =============================================================================
// CLOSING THE TABS
// =============================================================================

describe('closeConnectionDocuments', () => {
	it('closes every connection-scoped tab and connection editor in every group, and keeps anything else', () => {
		const docs = docsWithEveryTab('scope:tabs');
		assert.equal(Object.keys(docs.getState().groups).length, 2, 'the query tab is split into a second group');

		const closed = closeConnectionDocuments(docs);

		assert.equal(closed, 7, 'six documents, one of them in two groups');
		assert.deepEqual(openUris(docs), [OTHER_URI]);
		// The documents are released, not just hidden: nothing still holds the results.
		assert.deepEqual(Object.keys(docs.getState().documents), [OTHER_URI]);
		for (const group of Object.values(docs.getState().groups)) {
			for (const editorId of group.editorIds) assert.ok(docs.getState().editors[editorId], `group ${group.id} still lists a closed editor`);
		}
	});

	it('closes nothing when no connection document is open', () => {
		const docs = new FakeDocs();
		docs.openStaticDocument(OTHER_URI, 'Settings');
		assert.equal(closeConnectionDocuments(docs), 0);
		assert.deepEqual(openUris(docs), [OTHER_URI]);
	});
});

// =============================================================================
// WHEN THE IDENTITY COUNTS AS CHANGED (R9)
// =============================================================================

describe('createIdentityScope', () => {
	/**
	 * A scope whose actions are counted.
	 *
	 * @returns The scope and reads of how often it forgot and reset.
	 */
	function countedScope() {
		const counts = { forget: 0, unknown: 0 };
		const scope = createIdentityScope({ forget: () => { counts.forget += 1; }, unknown: () => { counts.unknown += 1; } });
		return { scope, counts };
	}

	it('binds the first identity it sees without forgetting anything', () => {
		const { scope, counts } = countedScope();
		assert.equal(scope.apply('u1|org-A|team-A'), 'bound');
		assert.deepEqual(counts, { forget: 0, unknown: 0 });
	});

	it('forgets when the user, organization or team changes', () => {
		const { scope, counts } = countedScope();
		scope.apply('u1|org-A|team-A');
		assert.equal(scope.apply('u1|org-A|team-B'), 'forgot', 'team');
		assert.equal(scope.apply('u1|org-B|team-B'), 'forgot', 'organization');
		assert.equal(scope.apply('u2|org-B|team-B'), 'forgot', 'user');
		assert.equal(counts.forget, 3);
	});

	it('resets its caches (keeping the tabs) when nobody can be vouched for, and forgets when somebody else signs in', () => {
		const { scope, counts } = countedScope();
		scope.apply('u1|org-A|team-A');
		assert.equal(scope.apply(null), 'unknown');
		assert.equal(scope.apply(null), 'kept', 'once per drop');
		assert.deepEqual(counts, { forget: 0, unknown: 1 });
		assert.equal(scope.apply('u2|org-A|team-A'), 'forgot');
		assert.equal(counts.forget, 1);
	});

	it('forgets nothing when the same identity arrives again (a reconnect, a token refresh, a new object)', () => {
		const { scope, counts } = countedScope();
		scope.apply('u1|org-A|team-A');
		assert.equal(scope.apply('u1|org-A|team-A'), 'kept');
		scope.apply(null);
		assert.equal(scope.apply('u1|org-A|team-A'), 'kept', 'the same account after a drop');
		assert.equal(counts.forget, 0);
	});
});

// =============================================================================
// WHAT IS FORGOTTEN
// =============================================================================

describe('forgetConnectionScope', () => {
	it('closes the connection tabs and drops the schema snapshots', async () => {
		const { client } = gatedClient(false);
		const session = await sessionOn(client, 'scope-forget');
		await refreshSchema(session);
		assert.equal(schemaSnapshot(session.endpoint.key).status, 'ready');
		const docs = docsWithEveryTab(session.endpoint.key);

		forgetConnectionScope(docs);

		assert.deepEqual(openUris(docs), [OTHER_URI]);
		assert.equal(schemaSnapshot(session.endpoint.key).status, 'idle');
		assert.equal(schemaSnapshot(session.endpoint.key).schema, null);
	});

	it('drops a schema read still in flight, so its late answer is not shown', async () => {
		const gate = gatedClient(true);
		const session = await sessionOn(gate.client, 'scope-in-flight');
		const pending = refreshSchema(session);
		await new Promise((resolve) => { setTimeout(resolve, 0); });
		assert.equal(schemaSnapshot(session.endpoint.key).status, 'loading');

		forgetConnectionScope(null);
		gate.release();
		await pending;

		assert.equal(schemaSnapshot(session.endpoint.key).status, 'idle');
		assert.equal(schemaSnapshot(session.endpoint.key).schema, null, 'the previous account\'s schema came back');
	});

	it('never starts a fresh read that was queued behind the dropped one', async () => {
		const gate = gatedClient(true);
		const session = await sessionOn(gate.client, 'scope-queued');
		const plain = refreshSchema(session);
		const queued = refreshSchema(session, { fresh: true });

		forgetConnectionScope(null);
		gate.release();
		await Promise.all([plain, queued]);

		assert.ok(!gate.tools.includes('refresh_schema'), 'the queued fresh read still ran for the previous account');
		assert.equal(schemaSnapshot(session.endpoint.key).status, 'idle');
	});

	it('runs the next read afresh instead of joining the dropped one', async () => {
		const before = gatedClient(true);
		const dropping = await sessionOn(before.client, 'scope-rejoin');
		const dropped = refreshSchema(dropping);
		forgetConnectionScope(null);

		const after = gatedClient(false, 'next_team_db');
		const session = createSqlSession(sqlEndpoints.session(after.client, sqlEndpoints.getState().endpoints.find((e) => e.projectId === 'scope-rejoin')!), dropping.endpoint);
		// Joining the dropped read would wait on it for ever; give up after a
		// second. The timer is cleared either way, so the run does not wait it out.
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled: string;
		try {
			settled = await Promise.race([
				refreshSchema(session).then(() => 'answered'),
				new Promise<string>((resolve) => {
					timer = setTimeout(() => resolve('joined'), 1000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		assert.equal(settled, 'answered', 'the read after the change joined the dropped one');
		assert.ok(after.tools.length > 0);
		assert.equal(schemaSnapshot(session.endpoint.key).schema?.database, 'next_team_db');

		before.release();
		await dropped;
		assert.equal(schemaSnapshot(session.endpoint.key).schema?.database, 'next_team_db', 'the dropped read overwrote the fresh one');
	});
});

describe('sqlIdentityScope (the app\'s instance)', () => {
	it('drops the schema snapshots when the identity changes, and when it becomes unknown', async () => {
		const { client } = gatedClient(false);
		const session = await sessionOn(client, 'scope-app');
		sqlIdentityScope.apply('u1|org-A|team-A');
		await refreshSchema(session);
		assert.equal(schemaSnapshot(session.endpoint.key).status, 'ready');
		assert.equal(sqlIdentityScope.apply('u1|org-A|team-B'), 'forgot');
		assert.equal(schemaSnapshot(session.endpoint.key).status, 'idle');

		await refreshSchema(session);
		assert.equal(schemaSnapshot(session.endpoint.key).status, 'ready');
		assert.equal(sqlIdentityScope.apply(null), 'unknown');
		assert.equal(schemaSnapshot(session.endpoint.key).status, 'idle');
	});
});

// =============================================================================
// SQLAPP WIRING
// =============================================================================

describe('SqlApp: an identity change reaches the scope', () => {
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'SqlApp.tsx'), 'utf8');
	const scopeSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'identityScope.ts'), 'utf8');

	it('follows its engine core\'s identity tracker, before paint', () => {
		assert.match(source, /useLayoutEffect\(\(\) => \{\s*if \(!core\) return undefined;\s*sqlIdentityScope\.apply\(/, 'SqlApp does not apply the fingerprint to the identity scope in a layout effect');
		assert.match(source, /return core\.identity\.subscribe\(\(snapshot\) => \{\s*sqlIdentityScope\.apply\(snapshot\.known \? snapshot\.fingerprint : null\);/);
	});

	it('closes the app\'s own document model when it forgets', () => {
		assert.match(scopeSource, /forget: \(\) => forgetConnectionScope\(getDocs\(\)\),/);
	});
});
