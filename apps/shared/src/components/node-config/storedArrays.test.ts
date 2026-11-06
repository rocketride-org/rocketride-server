// Copyright (c) 2026 Aparavi Software AG Inc. MIT License.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDefaultFormState, type RJSFSchema } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';
import { mergeFormDefaults, preserveStoredArrays, replaceStoredArray, storedArrays } from './storedArrays';

const schema: RJSFSchema = {
	type: 'object',
	properties: {
		credentialMap: {
			type: 'array',
			default: [],
			items: { type: 'object', properties: { credentialValue: { type: 'string' } } },
		},
		defaultRepo: { type: 'string', default: '' },
	},
};
const secureParameters = { secure: ['credentialMap', 'token'], token: 'opaque-engine-encrypted-config' };

test('canvas loading and late schema arrival preserve a stored array before mounting the form', () => {
	const saved = { profile: 'default', default: { secureParameters } };
	const defaults = getDefaultFormState(validator, schema, {}, schema) as Record<string, unknown>;
	assert.deepEqual(defaults.credentialMap, []);
	const loaded = mergeFormDefaults(schema, defaults, saved);
	assert.equal('credentialMap' in loaded, false);
	assert.equal(loaded.defaultRepo, '');
	assert.equal(storedArrays(schema, loaded).length, 1);
	assert.deepEqual(mergeFormDefaults(schema, defaults, loaded), loaded);
	const explicit = { ...saved, credentialMap: [] };
	assert.deepEqual(mergeFormDefaults(schema, defaults, explicit).credentialMap, []);
});

for (const profile of [false, true]) {
	test(`RJSF defaults cannot erase a saved array (${profile ? 'selected profile' : 'flat config'})`, () => {
		const original = profile ? { profile: 'default', default: { secureParameters } } : { secureParameters };
		const before = structuredClone(original);
		const stored = storedArrays(schema, original);
		assert.equal(stored.length, 1);
		const generated = getDefaultFormState(validator, schema, original, schema, true);
		assert.deepEqual(generated.credentialMap, []); // The regression's real form-library default.
		const saved = preserveStoredArrays({ ...generated, defaultRepo: 'acme/unrelated' }, original, stored);
		assert.equal(Object.hasOwn(saved, 'credentialMap'), false);
		assert.equal(saved.defaultRepo, 'acme/unrelated');
		assert.equal(JSON.stringify(profile ? saved.default : saved).includes(secureParameters.token), true);
		assert.deepEqual(original, before);
		// Reopening and saving again still preserves the opaque map.
		const reloaded = JSON.parse(JSON.stringify(saved));
		const next = preserveStoredArrays(getDefaultFormState(validator, schema, reloaded, schema, true), reloaded, storedArrays(schema, reloaded));
		assert.equal(Object.hasOwn(next, 'credentialMap'), false);
		assert.deepEqual(next, saved);
	});
}

test('plain arrays, explicit empty replacements and new configs remain editable', () => {
	for (const credentialMap of [[], [{ credentialValue: 'fake-value' }]]) {
		const config = { credentialMap, secureParameters };
		assert.deepEqual(storedArrays(schema, config), []);
		assert.deepEqual(preserveStoredArrays(config, config, []), config);
	}
	assert.deepEqual(storedArrays(schema, {}), []);
});

test('a top-level value overrides a protected profile and inactive profiles are ignored', () => {
	assert.deepEqual(storedArrays(schema, { profile: 'other', default: { secureParameters } }), []);
	assert.deepEqual(storedArrays(schema, { profile: 'default', default: { secureParameters }, credentialMap: [] }), []);
	assert.equal(storedArrays(schema, { default: { secureParameters } }).length, 1);
});

test('the schema-selected default profile is supported', () => {
	const withProfile = { ...schema, properties: { ...schema.properties, profile: { type: 'string', default: 'saved' } } } satisfies RJSFSchema;
	assert.equal(storedArrays(withProfile, { saved: { secureParameters } }).length, 1);
});

test('nested stored arrays keep their encrypted container even if RJSF omits it', () => {
	const nested = { type: 'object', properties: { settings: schema } } satisfies RJSFSchema;
	const original = { settings: { secureParameters } };
	const saved = preserveStoredArrays({ settings: { credentialMap: [], defaultRepo: 'acme/app' } }, original, storedArrays(nested, original));
	assert.deepEqual(saved, { settings: { secureParameters, defaultRepo: 'acme/app' } });
});

test('replace is explicit, leaves the old blob intact, and permits both clearing and new entries', () => {
	const original = { profile: 'default', default: { secureParameters } };
	const replaced = replaceStoredArray(original, ['credentialMap']);
	assert.deepEqual(replaced.credentialMap, []);
	assert.deepEqual(storedArrays(schema, replaced), []);
	assert.equal(Object.hasOwn(original, 'credentialMap'), false);
	assert.deepEqual(replaced.default, original.default);
	const added = { ...replaced, credentialMap: [{ credentialValue: 'new-fake-value' }] };
	assert.deepEqual(preserveStoredArrays(added, replaced, storedArrays(schema, replaced)), added);
});

test('protecting one array does not remove an edit to another', () => {
	const two = { ...schema, properties: { ...schema.properties, other: schema.properties?.credentialMap } } satisfies RJSFSchema;
	const original = { secureParameters, other: [] };
	const saved = preserveStoredArrays({ ...original, credentialMap: [], other: [{ credentialValue: 'new' }] }, original, storedArrays(two, original));
	assert.equal(Object.hasOwn(saved, 'credentialMap'), false);
	assert.deepEqual(saved.other, [{ credentialValue: 'new' }]);
});
