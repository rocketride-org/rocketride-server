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

/**
 * The version card's state badge both DEPLOY screens draw: the review state
 * as a stock badge, nothing without one, and a failed build's badge as the
 * door to the build log only where the screen can open it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { VersionStateBadge } from './VersionStateBadge';

test('a version with no known state shows no badge', () => {
	assert.equal(renderToStaticMarkup(<VersionStateBadge badge={null} />), '');
});

test('the review state is a stock badge', () => {
	const markup = renderToStaticMarkup(<VersionStateBadge badge={{ variant: 'warning', label: 'in review', opensBuildLog: false }} />);
	assert.equal(markup, '<span data-variant="warning">in review</span>');
});

test('a failed build opens the build log where the screen can, and is a plain badge elsewhere', () => {
	const failed = { variant: 'error' as const, label: 'failed', opensBuildLog: true };
	const door = renderToStaticMarkup(<VersionStateBadge badge={failed} onOpenBuildLog={() => undefined} />);
	assert.match(door, /title="Show the build log" role="button" tabindex="0"/);
	assert.equal(renderToStaticMarkup(<VersionStateBadge badge={failed} />), '<span data-variant="error">failed</span>');
});

test('the door opens the log without reaching the card around it', () => {
	let opened = 0;
	let stopped = 0;
	const door = VersionStateBadge({ badge: { variant: 'error', label: 'failed', opensBuildLog: true }, onOpenBuildLog: () => (opened += 1) }) as React.ReactElement<{ onClick: (e: unknown) => void }>;
	door.props.onClick({ stopPropagation: () => (stopped += 1) });
	assert.equal(opened, 1);
	assert.equal(stopped, 1);
});
