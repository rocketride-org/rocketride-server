// =============================================================================
// Unit tests: the Tokens grid on the answer render.
//
// Pins the three behaviours of the tokens block: the per-call `breakdown` is
// dropped from the chip grid (each call shows on its own invoke row instead), a
// tokens object that holds only `breakdown` renders no Tokens section at all, and
// the non-numeric `model` chip is stringified rather than thrown at React.
//
// Run via `shared:test` (node --import tsx --test), matching the package convention.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { renderAnswerFields } from './format_answer';

const render = (a: Parameters<typeof renderAnswerFields>[0]) => renderToStaticMarkup(renderAnswerFields(a)!);

test('scalar totals render as chips; the model renders as a string', () => {
	const html = render({
		answer: 'hi',
		tokens: { input: 1234, output: 56, model: 'claude-sonnet-4-6', calls: 3, breakdown: [{ input: 1, output: 2 }] },
	});
	assert.match(html, /Tokens/); // the section label
	assert.match(html, /1,234/); // toLocaleString on a number
	assert.match(html, /claude-sonnet-4-6/); // String(v) on the non-numeric model chip
	assert.match(html, /calls/i); // the calls chip is present
});

test('the per-call breakdown is dropped from the chip grid', () => {
	const html = render({
		answer: 'hi',
		tokens: { input: 10, output: 5, model: 'm', breakdown: [{ input: 10, output: 5, model: 'm' }] },
	});
	// The breakdown array is never rendered as a child, so no object leaks into the DOM,
	// and there is no "breakdown" chip label.
	assert.doesNotMatch(html, /\[object Object\]/);
	assert.doesNotMatch(html, /breakdown/i);
});

test('a tokens object with only a breakdown renders no Tokens section', () => {
	const html = render({ answer: 'hi', tokens: { breakdown: [{ input: 10, output: 5, model: 'm' }] } });
	assert.doesNotMatch(html, /Tokens/);
});

test('no tokens object renders no Tokens section', () => {
	const html = render({ answer: 'hi' });
	assert.doesNotMatch(html, /Tokens/);
});
