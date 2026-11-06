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

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { explainUnbuiltApp } from './unbuiltApp';

test('a failed newest build names the build-log command for that version', () => {
	const text = explainUnbuiltApp('acme.reports', [
		{ registryVersion: 3, buildStatus: 'failed' },
		{ registryVersion: 2, buildStatus: 'failed' },
	]);
	assert.equal(text?.title, 'No working build of acme.reports');
	assert.match(text?.message ?? '', /v3, failed its server build/);
	assert.match(text?.message ?? '', /rocketride deploy log acme\.reports 3/);
});

test('a newest version whose deployment failed counts as a failed build, whatever its build word', () => {
	const text = explainUnbuiltApp('acme.reports', [{ registryVersion: 2, buildStatus: 'queued', state: 'failed' }]);
	assert.equal(text?.title, 'No working build of acme.reports');
});

test('a running newest build says it is still building', () => {
	const text = explainUnbuiltApp('acme.reports', [
		{ registryVersion: 2, buildStatus: 'installing' },
		{ registryVersion: 1, buildStatus: 'failed' },
	]);
	assert.equal(text?.title, 'acme.reports is still building');
	assert.match(text?.message ?? '', /v2 is still building on the server \(installing\)/);
});

test('no explanation when the rail is empty or any version has a working build', () => {
	assert.equal(explainUnbuiltApp('acme.reports', []), null);
	assert.equal(
		explainUnbuiltApp('acme.reports', [
			{ registryVersion: 2, buildStatus: 'failed' },
			{ registryVersion: 1, buildStatus: 'ok' },
		]),
		null
	);
	assert.equal(explainUnbuiltApp('acme.reports', [{ registryVersion: 1, buildStatus: '' }]), null);
});
