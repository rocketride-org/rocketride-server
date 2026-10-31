// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// Unit tests: webhook integration examples.
//
// The Content-Type in these snippets is not decoration — it selects the lane
// the engine delivers the body on, and a body sent on a lane the pipeline does
// not read is answered `200 OK` while reaching no component. The snippets are
// emitted in seven dialects, so the pinned invariant is that the SELECTED
// Content-Type appears in every one of them and no other Content-Type leaks in.
//
// Run via `shared:test` (node --import tsx --test), matching the package
// convention.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIntegrationExamples, defaultWebhookPayloadId, getWebhookPayload, WEBHOOK_PAYLOADS, type IntegrationTabId, type WebhookPayloadId } from './endpointIntegrationExamples';

// --- Fixtures ---------------------------------------------------------------

const ENDPOINT = 'http://localhost:5565/webhook/00000000-0000-0000-0000-000000000000/webhook_1';
/** Obviously-not-a-credential stand-in: real-looking keys trip secret scanners. */
const AUTH_KEY = 'pk_EXAMPLE_NOT_A_REAL_KEY';

/** Every tab the generator emits — each one is a separate copy-paste snippet. */
const ALL_TABS: IntegrationTabId[] = ['curl', 'curlCmd', 'powershell', 'wget', 'typescript', 'python', 'http'];

/** Build the webhook snippets for one payload choice. */
function webhookExamples(payloadId?: WebhookPayloadId): Record<IntegrationTabId, string> {
	return buildIntegrationExamples({ endpointUrl: ENDPOINT, authKey: AUTH_KEY, isWebhook: true, payloadId });
}

/** Content-Types the generator can emit, used to assert none of the others leak in. */
const ALL_CONTENT_TYPES = WEBHOOK_PAYLOADS.map((payload) => payload.contentType);

// --- The selected Content-Type reaches every dialect ------------------------

for (const payload of WEBHOOK_PAYLOADS) {
	test(`webhook examples: '${payload.id}' puts ${payload.contentType} in every snippet`, () => {
		const examples = webhookExamples(payload.id);
		for (const tab of ALL_TABS) {
			assert.ok(examples[tab].includes(payload.contentType), `tab '${tab}' is missing Content-Type ${payload.contentType}: ${examples[tab]}`);
		}
	});

	test(`webhook examples: '${payload.id}' leaks no other Content-Type`, () => {
		const examples = webhookExamples(payload.id);
		const others = ALL_CONTENT_TYPES.filter((contentType) => contentType !== payload.contentType);
		for (const tab of ALL_TABS) {
			for (const other of others) {
				assert.ok(!examples[tab].includes(other), `tab '${tab}' still mentions ${other} while '${payload.id}' is selected: ${examples[tab]}`);
			}
		}
	});
}

// --- Defaults and fallbacks -------------------------------------------------

test('webhook examples: JSON is the default when no payload is named', () => {
	const examples = webhookExamples();
	for (const tab of ALL_TABS) {
		assert.ok(examples[tab].includes('application/json'), `tab '${tab}' did not default to JSON`);
	}
});

test('getWebhookPayload: an unknown id falls back to JSON rather than returning undefined', () => {
	const payload = getWebhookPayload('nonsense' as WebhookPayloadId);
	assert.equal(payload.id, 'json');
	assert.equal(payload.contentType, 'application/json');
});

test('WEBHOOK_PAYLOADS: each entry names a distinct lane and Content-Type', () => {
	const lanes = new Set(WEBHOOK_PAYLOADS.map((payload) => payload.lane));
	const contentTypes = new Set(ALL_CONTENT_TYPES);
	assert.equal(lanes.size, WEBHOOK_PAYLOADS.length);
	assert.equal(contentTypes.size, WEBHOOK_PAYLOADS.length);
});

// --- Which payload a freshly opened panel preselects -------------------------

test('default payload: JSON when the pipeline reads the json lane', () => {
	assert.equal(defaultWebhookPayloadId(['json']), 'json');
});

test('default payload: text when the pipeline reads text but not json', () => {
	assert.equal(defaultWebhookPayloadId(['text']), 'text');
});

test('default payload: JSON wins when the pipeline reads both lanes', () => {
	assert.equal(defaultWebhookPayloadId(['text', 'json']), 'json');
});

test('default payload: JSON when the pipeline reads neither lane', () => {
	assert.equal(defaultWebhookPayloadId(['tags', 'documents']), 'json');
});

test('default payload: JSON when the engine reported no lanes at all', () => {
	assert.equal(defaultWebhookPayloadId([]), 'json');
	assert.equal(defaultWebhookPayloadId(undefined), 'json');
});

test('default payload: every answer names a payload that actually exists', () => {
	for (const lanes of [['json'], ['text'], ['tags'], [], undefined]) {
		const id = defaultWebhookPayloadId(lanes);
		assert.ok(
			WEBHOOK_PAYLOADS.some((payload) => payload.id === id),
			`lanes ${JSON.stringify(lanes)} produced unknown payload '${id}'`
		);
	}
});

// --- Body shape per payload -------------------------------------------------

test("webhook examples: the JSON payload uses each language's JSON helper", () => {
	const examples = webhookExamples('json');
	assert.ok(examples.typescript.includes('JSON.stringify({"event":"test","message":"hello"})'));
	assert.ok(examples.python.includes('json={"event":"test","message":"hello"},'));
});

test('webhook examples: a text payload is sent as a plain string, not as JSON', () => {
	const examples = webhookExamples('text');
	assert.ok(!examples.typescript.includes('JSON.stringify('), `text body should not be wrapped in JSON.stringify: ${examples.typescript}`);
	assert.ok(examples.python.includes('data="hello from RocketRide",'), examples.python);
});

test('webhook examples: the cmd snippet escapes double quotes in the body', () => {
	const examples = webhookExamples('json');
	assert.ok(examples.curlCmd.includes('-d "{\\"event\\":\\"test\\",\\"message\\":\\"hello\\"}"'), examples.curlCmd);
});

// --- Chat / dropper endpoints are untouched ---------------------------------

test('chat endpoints ignore the payload choice and stay GET-shaped', () => {
	const asJson = buildIntegrationExamples({ endpointUrl: 'http://localhost:5565/chat/p/chat_1', authKey: AUTH_KEY, isWebhook: false, payloadId: 'json' });
	const asText = buildIntegrationExamples({ endpointUrl: 'http://localhost:5565/chat/p/chat_1', authKey: AUTH_KEY, isWebhook: false, payloadId: 'text' });

	assert.deepEqual(asJson, asText);
	for (const contentType of ALL_CONTENT_TYPES) {
		assert.ok(!asJson.curl.includes(contentType), `chat curl should carry no Content-Type, found ${contentType}`);
	}
	assert.ok(asJson.http.startsWith('GET '), asJson.http);
});
