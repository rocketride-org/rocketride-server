// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { NamespaceBanner, NamespaceBannerView } from './NamespaceBanner';
import type { NamespaceBannerPhase } from './NamespaceBanner';

const noop = (): void => undefined;
const adopt = async (): Promise<void> => undefined;

/** Renders the stateless view of a local app in one phase. */
function view(phase: NamespaceBannerPhase, error?: string): string {
	return renderToStaticMarkup(<NamespaceBannerView appId="local.brandy" developerId="acme" targetId="acme.brandy" phase={phase} error={error} onAsk={noop} onConfirm={noop} onCancel={noop} />);
}

test('a local app on a host that can move it is offered the move instead of the hand edit', () => {
	const markup = renderToStaticMarkup(<NamespaceBanner appId="local.brandy" developerId="acme" onAdopt={adopt} />);
	assert.match(markup, /Move it to <code>acme\.brandy<\/code>/);
	assert.match(markup, /<button[^>]*>Move to acme\.brandy<\/button>/);
	assert.doesNotMatch(markup, /Rename the app id in package\.json/);
});

test('the hand-edit instruction stays when the host cannot move the app, or the app is not under local', () => {
	for (const markup of [renderToStaticMarkup(<NamespaceBanner appId="local.brandy" developerId="acme" />), renderToStaticMarkup(<NamespaceBanner appId="other.brandy" developerId="acme" onAdopt={adopt} />)]) {
		assert.match(markup, /Rename the app id in package\.json/);
		assert.doesNotMatch(markup, /<button/);
	}
});

test('the confirmation says what changes before anything is written', () => {
	const markup = view('confirm');
	assert.match(markup, /This changes the app id to <code>acme\.brandy<\/code> in package\.json/);
	assert.match(markup, /Nothing on the server changes/);
	assert.match(markup, /<button[^>]*>Move app<\/button>/);
	assert.match(markup, /<button[^>]*>Cancel<\/button>/);
	assert.doesNotMatch(markup, />Move to /);
});

test('while the move runs both buttons are disabled; a failure shows its reason', () => {
	const busy = view('busy');
	assert.match(busy, /<button[^>]*disabled=""[^>]*>Moving…<\/button>/);
	assert.match(busy, /<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
	assert.match(view('confirm', 'Not connected to server'), /Not connected to server/);
});

test('after the move the banner says the App Builder is reopening', () => {
	const markup = view('done');
	assert.match(markup, /Moved to <code>acme\.brandy<\/code>/);
	assert.doesNotMatch(markup, /<button/);
});
