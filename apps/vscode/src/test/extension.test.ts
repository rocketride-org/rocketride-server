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

import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { buildEffectiveEngineArgs, splitEngineArgs } from '../shared/util/engineArgs';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('splitEngineArgs splits multiple flags into separate argv tokens', () => {
		assert.deepStrictEqual(splitEngineArgs('--verbose --modelserver=5590'), ['--verbose', '--modelserver=5590']);
	});

	test('splitEngineArgs preserves quoted paths with spaces', () => {
		assert.deepStrictEqual(splitEngineArgs('--path="C:\\Program Files\\RocketRide" --flag'), ['--path=C:\\Program Files\\RocketRide', '--flag']);
	});

	test('buildEffectiveEngineArgs injects trace only when not already present', () => {
		assert.deepStrictEqual(buildEffectiveEngineArgs('--verbose', true), ['--verbose', '--trace=servicePython']);
		assert.deepStrictEqual(buildEffectiveEngineArgs('--trace=servicePython --verbose', true), ['--trace=servicePython', '--verbose']);
	});
});
