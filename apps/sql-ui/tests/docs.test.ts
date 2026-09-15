// MIT License
//
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
// DOCS — unit tests for the document URI schemes
// =============================================================================
//
// The endpoint key itself contains colons (`projectId:source:nodeId`), so the
// suffixed schemes split on the LAST colon. That only holds if the suffix
// carries no colon of its own — hence the percent-encoded table segment, and
// hence the colon-in-table-name cases below.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	CONNECTIONS_URI,
	connectionUri,
	designUri,
	diagramUri,
	endpointKeyFromAnyUri,
	endpointKeyFromUri,
	isDesignUri,
	isDiagramUri,
	isQueryUri,
	isTableDataUri,
	nextQueryDoc,
	tableDataUri,
} from '../src/docs';

// =============================================================================
// FIXTURES
// =============================================================================

/** A realistic endpoint key: three colon-separated identifiers. */
const KEY = '5badc60c-1b62-4c00-83ef-081f0c96d02a:src-1:db_mysql_1';

// =============================================================================
// BUILDERS
// =============================================================================

describe('URI builders', () => {
	it('builds the connection and diagram URIs from the key verbatim', () => {
		assert.equal(connectionUri(KEY), `connection:${KEY}`);
		assert.equal(diagramUri(KEY), `diagram:${KEY}`);
	});

	it('numbers query documents monotonically and labels them to match', () => {
		const first = nextQueryDoc(KEY);
		const second = nextQueryDoc(KEY);
		assert.match(first.uri, new RegExp(`^query:${KEY}:\\d+$`));
		assert.equal(first.label, `Query ${first.uri.slice(first.uri.lastIndexOf(':') + 1)}`);
		assert.notEqual(first.uri, second.uri);
		assert.ok(Number(second.uri.slice(second.uri.lastIndexOf(':') + 1)) > Number(first.uri.slice(first.uri.lastIndexOf(':') + 1)));
	});

	it('gives every create-table draft its own design URI', () => {
		const a = designUri(KEY, null);
		const b = designUri(KEY, null);
		assert.notEqual(a, b);
		assert.match(a, new RegExp(`^design:${KEY}:\\*new\\*\\d+$`));
	});

	it('leaves an ordinary table name readable in the URI', () => {
		assert.equal(tableDataUri(KEY, 'orders'), `table:${KEY}:orders`);
		assert.equal(designUri(KEY, 'orders'), `design:${KEY}:orders`);
	});

	it('percent-encodes a table name that would otherwise break the split', () => {
		assert.equal(tableDataUri(KEY, 'odd:name'), `table:${KEY}:odd%3Aname`);
		assert.equal(designUri(KEY, 'odd:name'), `design:${KEY}:odd%3Aname`);
	});
});

// =============================================================================
// SCHEME PREDICATES
// =============================================================================

describe('scheme predicates', () => {
	it('recognises each scheme and rejects the others', () => {
		assert.equal(isQueryUri(nextQueryDoc(KEY).uri), true);
		assert.equal(isTableDataUri(tableDataUri(KEY, 'orders')), true);
		assert.equal(isDesignUri(designUri(KEY, 'orders')), true);
		assert.equal(isDiagramUri(diagramUri(KEY)), true);

		assert.equal(isQueryUri(connectionUri(KEY)), false);
		assert.equal(isTableDataUri(designUri(KEY, 'orders')), false);
		assert.equal(isDesignUri(tableDataUri(KEY, 'orders')), false);
		assert.equal(isDiagramUri(CONNECTIONS_URI), false);
	});
});

// =============================================================================
// KEY EXTRACTION
// =============================================================================

describe('endpointKeyFromUri', () => {
	it('returns the key of a connection document and null for anything else', () => {
		assert.equal(endpointKeyFromUri(connectionUri(KEY)), KEY);
		assert.equal(endpointKeyFromUri(diagramUri(KEY)), null);
		assert.equal(endpointKeyFromUri(CONNECTIONS_URI), null);
	});
});

describe('endpointKeyFromAnyUri', () => {
	it('returns the key for all five document schemes', () => {
		assert.equal(endpointKeyFromAnyUri(connectionUri(KEY)), KEY);
		assert.equal(endpointKeyFromAnyUri(diagramUri(KEY)), KEY);
		assert.equal(endpointKeyFromAnyUri(nextQueryDoc(KEY).uri), KEY);
		assert.equal(endpointKeyFromAnyUri(tableDataUri(KEY, 'orders')), KEY);
		assert.equal(endpointKeyFromAnyUri(designUri(KEY, 'orders')), KEY);
		assert.equal(endpointKeyFromAnyUri(designUri(KEY, null)), KEY);
	});

	it('returns the key for a table whose name contains a colon', () => {
		// Unencoded, `table:<key>:odd:name` would split one colon too late and
		// hand the sidebar the key `<key>:odd` — an endpoint that does not exist.
		assert.equal(endpointKeyFromAnyUri(tableDataUri(KEY, 'odd:name')), KEY);
		assert.equal(endpointKeyFromAnyUri(designUri(KEY, 'odd:name')), KEY);
	});

	it('returns the key for a table name that is entirely punctuation', () => {
		assert.equal(endpointKeyFromAnyUri(tableDataUri(KEY, ':')), KEY);
		assert.equal(endpointKeyFromAnyUri(tableDataUri(KEY, 'a b/c?d#e')), KEY);
	});

	it('returns null for the landing document and unknown schemes', () => {
		assert.equal(endpointKeyFromAnyUri(CONNECTIONS_URI), null);
		assert.equal(endpointKeyFromAnyUri('settings:foo'), null);
		assert.equal(endpointKeyFromAnyUri(''), null);
	});

	it('returns null for a suffixed scheme that carries no suffix at all', () => {
		assert.equal(endpointKeyFromAnyUri('table:orders'), null);
	});
});

// =============================================================================
// TABLE EXTRACTION
// =============================================================================

