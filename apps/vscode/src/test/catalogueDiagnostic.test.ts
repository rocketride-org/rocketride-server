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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueDiagnostic, createCatalogueReporter, NOT_CONNECTED } from '../shared/util/catalogueDiagnostic';

test('a failed catalogue is an error that names the reason', () => {
	const diagnostic = catalogueDiagnostic({ services: {}, servicesError: 'HTTP 401: invalid API key' });

	assert.equal(diagnostic?.level, 'error');
	assert.match(diagnostic?.message ?? '', /HTTP 401: invalid API key/);
});

test('an empty catalogue is a warning that points at the node definitions', () => {
	const diagnostic = catalogueDiagnostic({ services: {} });

	assert.equal(diagnostic?.level, 'warning');
	assert.match(diagnostic?.message ?? '', /zero services/);
	assert.match(diagnostic?.message ?? '', /--trace=Services/);
});

test('a healthy catalogue says nothing', () => {
	assert.equal(catalogueDiagnostic({ services: { llm_openai: {} } }), null);
});

test('not being connected yet is a state, not a failure, and says nothing', () => {
	assert.equal(catalogueDiagnostic({ services: {}, servicesError: NOT_CONNECTED }), null);
});

test('the reporter says each thing once, however many editors ask', () => {
	const report = createCatalogueReporter();
	const failed = { services: {}, servicesError: 'HTTP 401' };

	assert.notEqual(report(failed), null);
	assert.equal(report(failed), null);
	assert.equal(report(failed), null);
});

test('the reporter says it again after the catalogue recovers', () => {
	const report = createCatalogueReporter();
	const failed = { services: {}, servicesError: 'HTTP 401' };

	report(failed);
	assert.equal(report({ services: { llm_openai: {} } }), null);
	assert.notEqual(report(failed), null);
});

test('the reporter says a different failure straight away', () => {
	const report = createCatalogueReporter();

	report({ services: {}, servicesError: 'HTTP 401' });
	assert.equal(report({ services: {} })?.level, 'warning');
});
