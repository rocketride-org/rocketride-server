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

import assert from 'node:assert/strict';
import test from 'node:test';
import { maxSize, resolveSize, stackedTopSize } from './panelSize';

/** DetailPanel's own numbers: a right drawer with the record-safe floor. */
const DRAWER = { minSize: 380, maxFraction: 0.85, contextSliver: 120 };

test('a phone-width host clamps the caller default to the floor', () => {
	// The bug this exists to stop: 640 rendered literally, with 250px of the
	// panel — including its resize handle — off the right of a 390px screen.
	assert.equal(resolveSize(640, { ...DRAWER, hostSize: 390 }), 380);
});

test('the floor wins over the band on a host too narrow for either', () => {
	// 320 * 0.85 is 272, below the 380 floor. A panel under its floor is broken
	// in a different way; a caller expecting a phone lowers `minWidth` instead.
	assert.equal(resolveSize(640, { ...DRAWER, hostSize: 320 }), 380);
});

test('a comfortable host leaves the caller default alone', () => {
	assert.equal(resolveSize(640, { ...DRAWER, hostSize: 1600 }), 640);
});

test('the context sliver binds before the fraction on a mid-width host', () => {
	// 900 * 0.85 = 765, but 900 - 120 = 780: the smaller of the two wins.
	assert.equal(maxSize({ ...DRAWER, hostSize: 900 }), 765);
	assert.equal(resolveSize(900, { ...DRAWER, hostSize: 900 }), 765);
});

test('a restored size is brought back inside a host that shrank', () => {
	// The panel was dragged to 900 on a desktop and reopened on a laptop.
	assert.equal(resolveSize(900, { ...DRAWER, hostSize: 1000 }), 850);
});

test('a stack reserves room for the panels it covers', () => {
	// Two levels of 40px sliver come off the top panel's allowance, so the ROOT
	// — the widest, against the host edge — still fits the band.
	assert.equal(resolveSize(900, { ...DRAWER, hostSize: 1000, stackAllowance: 80 }), 770);
});

test('a reset while stacked lands the root on the caller default', () => {
	// Three panels, 40px per sliver: the top starts 80 narrower so the root
	// lands on 640.
	assert.equal(stackedTopSize(640, 380, 40, 3), 560);
	assert.equal(560 + 40 * 2, 640);
});

test('a stacked reset never goes under the floor', () => {
	assert.equal(stackedTopSize(400, 380, 40, 5), 380);
});

test('a lone panel is its own root', () => {
	assert.equal(stackedTopSize(640, 380, 40, 1), 640);
});

test('a stacked reset on a narrow host is still clamped', () => {
	// CodeRabbit's Major: the stacked branch of resetSize wrote this candidate
	// straight into the shared size, so a 390px host got 600 where the band
	// allows 380.
	const candidate = stackedTopSize(640, 380, 40, 2);

	assert.equal(candidate, 600);
	assert.equal(resolveSize(candidate, { ...DRAWER, hostSize: 390, stackAllowance: 40 }), 380);
});
