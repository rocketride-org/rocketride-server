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
// EXPLORER ERRORS + GENERATIONS
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError, isStaleError, readErrorCode, readErrorMessage, splitMessage } from './errors';
import { createGeneration } from './generation';

describe('ExplorerToolError', () => {
	it('keeps the full message verbatim and splits a headline from the "Database said" detail', () => {
		const error = new ExplorerToolError({ kind: 'raised', tool: 'read_query', message: 'Syntax error near MATCH\nline 1, column 3\nexpected RETURN' });
		assert.equal(error.message, 'Syntax error near MATCH\nline 1, column 3\nexpected RETURN');
		assert.equal(error.headline, 'Syntax error near MATCH');
		assert.equal(error.detail, 'line 1, column 3\nexpected RETURN');
		assert.equal(error.kind, 'raised');
		assert.equal(error.tool, 'read_query');
		assert.equal(error instanceof Error, true);
		assert.equal(error instanceof ExplorerToolError, true);
	});

	it('has no detail for a one-line message', () => {
		const error = new ExplorerToolError({ kind: 'invalid', tool: 'get_data', message: 'bad' });
		assert.equal(error.headline, 'bad');
		assert.equal(error.detail, undefined);
	});

	it('carries the server code only when it is a non-empty string', () => {
		assert.equal(new ExplorerToolError({ kind: 'raised', tool: 't', message: 'm', code: 'TASK_STOPPED' }).code, 'TASK_STOPPED');
		assert.equal(new ExplorerToolError({ kind: 'raised', tool: 't', message: 'm', code: '' }).code, undefined);
		assert.equal(new ExplorerToolError({ kind: 'raised', tool: 't', message: 'm' }).code, undefined);
	});
});

describe('isStaleError', () => {
	it('recognises only a stale ExplorerToolError', () => {
		assert.equal(isStaleError(new ExplorerToolError({ kind: 'stale', tool: 't', message: 'dropped' })), true);
		assert.equal(isStaleError(new ExplorerToolError({ kind: 'raised', tool: 't', message: 'x' })), false);
		assert.equal(isStaleError(new Error('stale')), false);
		assert.equal(isStaleError(null), false);
	});
});

describe('readErrorCode / readErrorMessage / splitMessage', () => {
	it('reads a string code off any error-like value and nothing else', () => {
		const withCode = Object.assign(new Error('x'), { code: 'TASK_STOPPED' });
		assert.equal(readErrorCode(withCode), 'TASK_STOPPED');
		assert.equal(readErrorCode(new Error('x')), undefined);
		assert.equal(readErrorCode(Object.assign(new Error('x'), { code: 42 })), undefined);
		assert.equal(readErrorCode(Object.assign(new Error('x'), { code: '' })), undefined);
		assert.equal(readErrorCode('TASK_STOPPED'), undefined);
		assert.equal(readErrorCode(null), undefined);
	});

	it('reads the message of an Error, a string, or anything else', () => {
		assert.equal(readErrorMessage(new Error('boom')), 'boom');
		assert.equal(readErrorMessage('plain'), 'plain');
		assert.equal(readErrorMessage(42), '42');
	});

	it('splits on the first newline and trims', () => {
		assert.deepEqual(splitMessage('  a  \n\n b \n c '), { headline: 'a', detail: 'b \n c' });
		assert.deepEqual(splitMessage('only'), { headline: 'only', detail: undefined });
		assert.deepEqual(splitMessage(''), { headline: '', detail: undefined });
		assert.deepEqual(splitMessage('head\n   '), { headline: 'head', detail: undefined });
	});
});

describe('createGeneration', () => {
	it('expires every earlier ticket when a new one is issued', () => {
		const gen = createGeneration();
		const first = gen.next();
		assert.equal(first.isCurrent(), true);
		const second = gen.next();
		assert.equal(first.isCurrent(), false);
		assert.equal(gen.isCurrent(first), false);
		assert.equal(second.isCurrent(), true);
		assert.equal(gen.isCurrent(second), true);
	});

	it('expires the current ticket on invalidate (Stop waiting, reset) without issuing one', () => {
		const gen = createGeneration();
		const ticket = gen.next();
		gen.invalidate();
		assert.equal(ticket.isCurrent(), false);
		assert.ok(gen.current() > ticket.id);
	});

	it('keeps separate generations independent: one owner\'s reset cannot expire another\'s ticket', () => {
		const a = createGeneration();
		const b = createGeneration();
		const ticketA = a.next();
		const ticketB = b.next();
		b.invalidate();
		assert.equal(ticketA.isCurrent(), true);
		assert.equal(ticketB.isCurrent(), false);
	});
});
