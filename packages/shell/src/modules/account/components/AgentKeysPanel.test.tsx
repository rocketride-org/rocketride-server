// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentKeysPanel, saveErrorMessage } from './AgentKeysPanel';

test('stored key renders masked chip and never the placeholder input', () => {
	const html = renderToStaticMarkup(
		<AgentKeysPanel status={[{ provider: 'anthropic', last4: 'Kd3f' }]} busy={false} onSetKey={async () => {}} onClearKey={async () => {}} />
	);
	assert.match(html, /•••• Kd3f/);
	assert.doesNotMatch(html, /sk-ant-…/); // stored → no paste field for that provider
	assert.match(html, /sk-…/); // openai still shows its empty-state input
});

test('no stored keys renders both providers in the empty (paste) state', () => {
	const html = renderToStaticMarkup(<AgentKeysPanel status={[]} busy={false} onSetKey={async () => {}} onClearKey={async () => {}} />);
	assert.match(html, /sk-ant-…/);
	assert.match(html, /sk-…/);
	assert.doesNotMatch(html, /••••/);
});

test('the Validate & Save button starts disabled with an empty draft', () => {
	const html = renderToStaticMarkup(<AgentKeysPanel status={[]} busy={false} onSetKey={async () => {}} onClearKey={async () => {}} />);
	assert.match(html, /disabled=""[^>]*>Validate &amp; Save/);
});

test('busy disables both the Save and Remove verbs', () => {
	const html = renderToStaticMarkup(
		<AgentKeysPanel status={[{ provider: 'anthropic', last4: 'Kd3f' }]} busy={true} onSetKey={async () => {}} onClearKey={async () => {}} />
	);
	assert.match(html, /disabled=""[^>]*>Remove/);
	assert.match(html, /disabled=""[^>]*>Validating…/);
});

test('a panel-level error renders as a Banner', () => {
	const html = renderToStaticMarkup(<AgentKeysPanel status={[]} busy={false} error="Failed to load key status" onSetKey={async () => {}} onClearKey={async () => {}} />);
	assert.match(html, /Failed to load key status/);
	assert.match(html, /role="alert"/);
});

// saveErrorMessage pins the REAL wire shape: the server's DAP error is a full
// sentence carrying a parenthesized machine token, never the bare code —
// matched by substring, not exact equality.
test('saveErrorMessage maps a real invalid_key sentence to the rejected-by-provider copy', () => {
	assert.equal(saveErrorMessage('The provided key was rejected by the provider (invalid_key)'), 'key rejected by provider');
});

test('saveErrorMessage maps a real provider_unreachable sentence to the not-saved copy', () => {
	assert.equal(saveErrorMessage('Could not reach the provider to validate the key (provider_unreachable)'), "couldn't reach provider — key NOT saved, try again");
});

test('saveErrorMessage passes an unmapped message through unchanged', () => {
	assert.equal(saveErrorMessage('Not connected'), 'Not connected');
});
