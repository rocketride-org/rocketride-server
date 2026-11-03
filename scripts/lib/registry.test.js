/**
 * Actions that run on some OSes only (`platforms` on an action definition).
 *
 * Run:
 *     node --test scripts/lib/registry.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const registry = require('./registry');

// A registry of its own, with one module: everywhere, Linux only, Windows only
function fixture() {
	const r = new registry.constructor();
	r.modules.set('m', {
		actions: [
			{ name: 'm:any', action: { description: 'runs everywhere' } },
			{
				name: 'm:linux',
				platforms: ['linux'],
				unavailable: (platform) => `it needs Linux, and this is ${platform}`,
				action: { description: 'Linux only' },
			},
			{ name: 'm:windows', platforms: ['win32'], action: () => ({ description: 'Windows only' }) },
			{ name: 'm:byname', global: false, action: { description: 'asked for by name only' } },
		],
	});
	return r;
}

test('an action without platforms runs everywhere', () => {
	const r = fixture();
	for (const platform of ['linux', 'win32', 'darwin']) assert.ok(r.isAvailable(r.getAction('m:any'), platform));
});

test('an action with platforms runs on those only', () => {
	const r = fixture();
	assert.ok(r.isAvailable(r.getAction('m:linux'), 'linux'));
	assert.ok(!r.isAvailable(r.getAction('m:linux'), 'win32'));
	assert.ok(!r.isAvailable(r.getAction('m:windows'), 'darwin'));
});

test('the error names the OS and says why', () => {
	const r = fixture();
	assert.strictEqual(
		r.unavailableMessage(r.getAction('m:linux'), 'win32'),
		'm:linux is not available on Windows: it needs Linux, and this is win32'
	);
	assert.strictEqual(r.unavailableMessage(r.getAction('m:windows'), 'darwin'), 'm:windows is not available on macOS');
});

test('a global command takes in what runs here, except actions asked for by name only', () => {
	const r = fixture();
	assert.ok(r.inGlobalCommands(r.getAction('m:any'), 'linux'));
	assert.ok(r.inGlobalCommands(r.getAction('m:linux'), 'linux'));
	assert.ok(!r.inGlobalCommands(r.getAction('m:linux'), 'win32'));
	assert.ok(!r.inGlobalCommands(r.getAction('m:byname'), 'linux'));
	assert.ok(r.isAvailable(r.getAction('m:byname'), 'linux'));
});

test('--help lists only what runs on this OS; --list-actions lists all, marked', () => {
	const r = fixture();
	const expected = ['m:any', 'm:byname', 'm:linux', 'm:windows'].filter((name) => r.isAvailable(r.getAction(name)));
	assert.deepStrictEqual(
		r.listCommands({}).map((c) => c.command),
		expected
	);
	const all = r.listActions({});
	assert.strictEqual(all.length, 4);
	assert.deepStrictEqual(
		all.filter((a) => a.available).map((a) => a.name),
		expected
	);
});
