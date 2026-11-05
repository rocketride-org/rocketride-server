// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// A CHANGE OF IDENTITY CLOSES WHAT BELONGED TO THE PREVIOUS ONE
// =============================================================================
//
// On a change of user, organization or development team (or a sign-out) the shared endpoint store forgets every
// endpoint, token, probe and session. The open workbench and write-console documents go too: otherwise their
// results, graph and editor would stay on screen, and a document still bound to the previous team's endpoint would
// show it as ready until a discovery ran. The app closes every connection-scoped document and clears its
// per-connection caches.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityFingerprint, identityFromConnectResult } from 'shared/explorer';
import { CONNECTIONS_URI, workbenchUri, writeUri } from '../src/graph/addresses';
import { connectionEditorIds, forgetConnections } from '../src/graph/identityChange';
import type { IConnectionDocs } from '../src/graph/identityChange';
import { createSchemaStore } from '../src/graph/schemaStore';
import type { IFailureNotice } from '../src/graph/failures';
import { fixture } from './support/builders';

const A = 'k1|dev|user|u1|team-a|p1|tools=tools_1|graph_1';
const B = 'k1|deploy|team|team-a|team-a|p2|tools=tools_1|graph_2';
const notice = (headline: string): IFailureNotice => ({ variant: 'error', headline, detail: '', verbatim: '', generic: false, hint: null, ignore: false });

/** A stand-in for the app's Documents: editors by id, closeEditor removes one, openStaticDocument focuses or opens. */
function docsWith(uris: string[]): IConnectionDocs & { editors: Record<string, { documentUri: string }>; opened: string[] } {
	const editors: Record<string, { documentUri: string }> = {};
	uris.forEach((uri, i) => {
		editors[`editor-${i + 1}`] = { documentUri: uri };
	});
	const docs = {
		editors,
		opened: [] as string[],
		getState: () => ({ editors: { ...docs.editors } }),
		closeEditor: (id: string) => {
			delete docs.editors[id];
		},
		openStaticDocument: (uri: string) => {
			docs.opened.push(uri);
		},
	};
	return docs;
}

test('a team switch changes the fingerprint the app tracks; a new object for the same identity does not', () => {
	const signedIn = { userId: 'u1', organization: { id: 'org-1', permissions: ['task.data'] }, devTeam: 'team-a' };
	const fp = (value: unknown) => identityFingerprint(identityFromConnectResult(value));
	assert.equal(fp({ ...signedIn, organization: { id: 'org-1', permissions: [] } }), fp(signedIn), 'a permission change is not a change of identity');
	assert.notEqual(fp({ ...signedIn, devTeam: 'team-b' }), fp(signedIn));
	assert.equal(fp(null), null, 'signed out');
});

test('every workbench and write console is closed; the landing stays, and is focused so the new identity is discovered', () => {
	const docs = docsWith([CONNECTIONS_URI, workbenchUri(A), writeUri(A), workbenchUri(B)]);
	assert.deepEqual(connectionEditorIds(docs.getState().editors), ['editor-2', 'editor-3', 'editor-4']);
	const schemas = createSchemaStore();
	assert.equal(forgetConnections(docs, { schemas }), 3);
	assert.deepEqual(
		Object.values(docs.editors).map((e) => e.documentUri),
		[CONNECTIONS_URI]
	);
	assert.deepEqual(docs.opened, [CONNECTIONS_URI]);
});

test('the per-connection caches are cleared, and a schema load in flight for the previous identity cannot repopulate them', async () => {
	const schemas = createSchemaStore();
	await schemas.load(
		A,
		async () => fixture('schema_v2'),
		() => notice('x')
	);
	assert.equal(schemas.get(A).status, 'ready');
	let land: (value: unknown) => void = () => undefined;
	const late = schemas.load(
		B,
		() =>
			new Promise((resolve) => {
				land = resolve;
			}),
		() => notice('x')
	);
	forgetConnections(docsWith([workbenchUri(A)]), { schemas });
	assert.equal(schemas.get(A).status, 'idle');
	land(fixture('schema_v2'));
	await late;
	assert.equal(schemas.get(B).status, 'idle', 'the late answer is dropped');
});

test('with nothing connection-scoped open, nothing is closed and the landing is not forced open', () => {
	const docs = docsWith([CONNECTIONS_URI]);
	assert.equal(forgetConnections(docs, { schemas: createSchemaStore() }), 0);
	assert.deepEqual(docs.opened, []);
	const closedLanding = docsWith([]);
	assert.equal(forgetConnections(closedLanding, { schemas: createSchemaStore() }), 0);
	assert.deepEqual(closedLanding.opened, [], 'a landing the user closed stays closed');
	assert.equal(forgetConnections(null, { schemas: createSchemaStore() }), 0, 'before the app mounted its documents');
});
