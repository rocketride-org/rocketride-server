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

// =============================================================================
// E2E FIXTURE APP: scenarios
// =============================================================================
// X* scenarios are the exploits of #1022 (plan section 5.4). Each one tries
// every way the fixture knows and reports what worked; the specs assert that
// nothing did. L* scenarios are the legitimate flows. All errors are caught
// and reported as data, never thrown, so a refusal is an outcome too.
// =============================================================================

import * as shell from 'shell';

const ATTACKER_TOKEN = 'ATTACKER-TOKEN-0123456789abcdef';

/** The base the fixture's own files load from (works in the shell realm and in a frame). */
function ownBase() {
	/* global __webpack_public_path__ */
	return typeof __webpack_public_path__ === 'string' ? __webpack_public_path__ : new URL('./', document.currentScript ? document.currentScript.src : location.href).href;
}

const note = (err) => String((err && err.name) || 'Error') + ': ' + String((err && err.message) || err).slice(0, 160);

/** Runs `fn` and records the outcome; `found(value)` says whether it exposed what the scenario hunts. */
async function attempt(list, where, fn, found) {
	try {
		const value = await fn();
		list.push({ where, ok: true, hit: found ? Boolean(found(value)) : false });
		return value;
	} catch (err) {
		list.push({ where, ok: false, error: note(err), hit: false });
		return undefined;
	}
}

// -----------------------------------------------------------------------------
// X1: read the token, cookies and parent.* (T86)
// -----------------------------------------------------------------------------
async function x1(p, props, report) {
	const secret = String(p.secret || '');
	const has = (v) => typeof v === 'string' && secret !== '' && v.includes(secret);
	const attempts = [];
	const dump = (storage) => JSON.stringify(Object.fromEntries(Object.keys(storage).map((k) => [k, storage.getItem(k)])));
	await attempt(attempts, 'own localStorage', () => dump(localStorage), has);
	await attempt(attempts, 'own sessionStorage', () => dump(sessionStorage), has);
	await attempt(attempts, 'own cookie', () => document.cookie, has);
	await attempt(attempts, 'parent localStorage', () => dump(parent.localStorage), has);
	await attempt(attempts, 'parent cookie', () => parent.document.cookie, has);
	await attempt(attempts, 'parent document', () => parent.document.documentElement.outerHTML, has);
	await attempt(attempts, 'top localStorage', () => dump(top.localStorage), has);
	await attempt(attempts, 'top cookie', () => top.document.cookie, has);
	await attempt(attempts, 'shell ConnectionManager token', () => shell.ConnectionManager.getInstance().loadToken(), has);
	await attempt(attempts, 'shell ApiKeyAuthProvider token', () => shell.ApiKeyAuthProvider.getInstance().getToken(), has);
	await attempt(attempts, 'shell client config', () => JSON.stringify(shell.getClient(), (k, v) => (typeof v === 'function' ? undefined : v)), has);
	await attempt(attempts, 'shell auth user', () => JSON.stringify(shell.ConnectionManager.getInstance().getAccountInfo?.() ?? null), has);
	await attempt(attempts, 'indexedDB names', async () => JSON.stringify((await indexedDB.databases?.()) ?? []), has);
	await attempt(attempts, 'window.name', () => window.name, has);
	await attempt(attempts, 'location', () => location.href, has);
	report('x1', { attempts, found: attempts.filter((a) => a.hit).map((a) => a.where) });
}

// -----------------------------------------------------------------------------
// X2: admin commands reach the engine (T87)
// -----------------------------------------------------------------------------
async function x2(p, props, report) {
	const sent = [];
	const client = shell.getClient();
	const commands = [
		['rrext_app', { subcommand: 'admin_approve', appId: 'e2e.fixture', version: 1, capabilities: ['pipelines.run'] }],
		['rrext_account_keys', { subcommand: 'list' }],
		['rrext_account_keys', { subcommand: 'create', name: 'x2' }],
	];
	for (const [command, args] of commands) {
		const outcome = { command, subcommand: args.subcommand };
		try {
			const message = typeof client.buildRequest === 'function' ? client.buildRequest(command, { arguments: args }) : { type: 'request', command, arguments: args };
			const reply = await Promise.race([client.request(message), new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
			outcome.reply = { success: reply && reply.success, message: String((reply && reply.message) || '').slice(0, 120) };
		} catch (err) {
			outcome.error = note(err);
		}
		sent.push(outcome);
	}
	report('x2', { sent });
}

// -----------------------------------------------------------------------------
// X3: an attacker token reaches shell storage (T88)
// -----------------------------------------------------------------------------
async function x3(p, props, report) {
	const attempts = [];
	const msg = { type: 'rrdev:auth', token: ATTACKER_TOKEN };
	await attempt(attempts, 'localStorage.setItem on the shell key', () => localStorage.setItem('rr:user_token', ATTACKER_TOKEN));
	await attempt(attempts, 'parent.localStorage.setItem', () => parent.localStorage.setItem('rr:user_token', ATTACKER_TOKEN));
	await attempt(attempts, 'top.localStorage.setItem', () => top.localStorage.setItem('rr:user_token', ATTACKER_TOKEN));
	await attempt(attempts, 'parent.postMessage rrdev:auth', () => parent.postMessage(msg, '*'));
	await attempt(attempts, 'top.postMessage rrdev:auth', () => top.postMessage(msg, '*'));
	await attempt(attempts, 'self postMessage rrdev:auth', () => window.postMessage(msg, '*'));
	await attempt(attempts, 'parent.postMessage rrdev:registerRemote', () => parent.postMessage({ type: 'rrdev:registerRemote', appId: 'e2e.fixture', moduleId: 'evil', entry: p.evilEntry || '' }, '*'));
	await attempt(attempts, 'parent.postMessage view:ready', () => parent.postMessage({ type: 'view:ready' }, '*'));
	await attempt(attempts, 'ConnectionManager.saveToken', () => shell.ConnectionManager.getInstance().saveToken(ATTACKER_TOKEN));
	// Let the shell react to the messages before the spec reads its storage.
	await new Promise((r) => setTimeout(r, 1500));
	report('x3', { attempts, attackerToken: ATTACKER_TOKEN });
}

// -----------------------------------------------------------------------------
// X4: change the shell's top URL (T89)
// -----------------------------------------------------------------------------
async function x4(p, props, report) {
	const attempts = [];
	const evil = String(p.evilUrl || '');
	await attempt(attempts, 'top.location.href', () => {
		top.location.href = evil;
	});
	await attempt(attempts, 'top.location.replace', () => top.location.replace(evil));
	await attempt(attempts, 'window.open _top', () => window.open(evil, '_top'));
	await attempt(attempts, 'anchor target _top', () => {
		const a = document.createElement('a');
		a.href = evil;
		a.target = '_top';
		document.body.appendChild(a);
		a.click();
	});
	await attempt(attempts, 'parent.location', () => {
		parent.location.href = evil;
	});
	await new Promise((r) => setTimeout(r, 1500));
	report('x4', { attempts });
}

// -----------------------------------------------------------------------------
// X5: register a service worker (T90)
// -----------------------------------------------------------------------------
async function x5(p, props, report) {
	const result = { supported: 'serviceWorker' in navigator };
	if (result.supported) {
		try {
			const registration = await Promise.race([navigator.serviceWorker.register(ownBase() + 'sw.js', { scope: ownBase() }), new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
			result.registered = true;
			result.scope = registration.scope;
			try {
				await registration.unregister();
			} catch {
				/* cleanup only */
			}
		} catch (err) {
			result.registered = false;
			result.error = note(err);
		}
	}
	report('x5', result);
}

// -----------------------------------------------------------------------------
// X6: frame the shell and read its DOM (T91)
// -----------------------------------------------------------------------------
async function x6(p, props, report) {
	const result = { readable: false };
	try {
		const frame = document.createElement('iframe');
		frame.src = String(p.shellUrl || '');
		document.body.appendChild(frame);
		await new Promise((resolve) => {
			frame.addEventListener('load', resolve);
			setTimeout(resolve, 5000);
		});
		await new Promise((r) => setTimeout(r, 1500));
		try {
			const text = frame.contentDocument ? frame.contentDocument.body.innerText : '';
			result.readable = typeof text === 'string' && text.length > 0;
			result.sample = String(text).slice(0, 80);
		} catch (err) {
			result.error = note(err);
		}
	} catch (err) {
		result.error = note(err);
	}
	report('x6', result);
}

// -----------------------------------------------------------------------------
// X7: ?rrdev=1 popup, then rrdev:auth (T92)
// -----------------------------------------------------------------------------
async function x7(p, props, report) {
	const result = { opened: false };
	try {
		const popup = window.open(String(p.shellUrl || '') + '/?rrdev=1', 'rrdevpopup');
		result.opened = Boolean(popup);
		if (popup) {
			for (let i = 0; i < 12; i++) {
				try {
					popup.postMessage({ type: 'rrdev:auth', token: ATTACKER_TOKEN }, '*');
				} catch {
					/* closed */
				}
				await new Promise((r) => setTimeout(r, 400));
			}
		}
	} catch (err) {
		result.error = note(err);
	}
	report('x7', { ...result, attackerToken: ATTACKER_TOKEN });
}

// -----------------------------------------------------------------------------
// X8: a popup navigates opener.top (T93)
// -----------------------------------------------------------------------------
async function x8(p, props, report) {
	const result = { opened: false };
	const target = String(p.openerNavUrl || '');
	try {
		const popup = window.open(target, 'rrx8popup');
		result.opened = Boolean(popup);
		await new Promise((r) => setTimeout(r, 2000));
		try {
			const a = document.createElement('a');
			a.href = target;
			a.target = '_blank';
			document.body.appendChild(a);
			a.click();
			result.anchorClicked = true;
		} catch (err) {
			result.anchorError = note(err);
		}
		await new Promise((r) => setTimeout(r, 2000));
	} catch (err) {
		result.error = note(err);
	}
	report('x8', result);
}

// -----------------------------------------------------------------------------
// L1: render with theme and identity (T96)
// -----------------------------------------------------------------------------
async function l1(p, props, report) {
	const style = getComputedStyle(document.documentElement);
	const tokens = {};
	for (const name of ['--rr-bg-default', '--rr-text-primary', '--rr-brand', '--rr-color-primary']) tokens[name] = style.getPropertyValue(name).trim();
	const anyToken = Array.from(document.documentElement.style).filter((n) => n.startsWith('--rr-')).length;
	let version = null;
	try {
		version = await (await fetch(ownBase() + 'version.json', { cache: 'no-store' })).json();
	} catch {
		/* no version file */
	}
	report('render', { isConnected: props.isConnected, identity: props.identity || null, tokens, inlineRrTokens: anyToken, version, base: ownBase() });
}

// -----------------------------------------------------------------------------
// L3: file round trip through the SDK (T98)
// -----------------------------------------------------------------------------
async function l3(p, props, report) {
	const client = shell.getClient();
	const key = location.hostname.split('.')[0];
	const dir = 'apps/' + key;
	const out = {};
	const step = async (name, fn) => {
		try {
			out[name] = { ok: true, value: await fn() };
		} catch (err) {
			out[name] = { ok: false, error: note(err) };
		}
	};
	await step('write', () => client.fsWriteJson(dir + '/roundtrip.json', { hello: 'world', n: 7 }));
	await step('read', () => client.fsReadJson(dir + '/roundtrip.json'));
	await step('list', async () => (await client.fsListDir(dir)).entries.map((e) => e.name));
	await step('writeString', () => client.fsWriteString(dir + '/note.txt', 'plain text'));
	await step('readString', () => client.fsReadString(dir + '/note.txt'));
	await step('outside', () => client.fsReadJson('apps/someoneelse/roundtrip.json'));
	await step('traversal', () => client.fsReadJson(dir + '/../other/x.json'));
	await step('delete', () => client.fsDelete(dir + '/roundtrip.json'));
	report('l3', { out, key });
}

// -----------------------------------------------------------------------------
// L4: notify and openExternal (T99)
// -----------------------------------------------------------------------------
async function l4(p, props, report) {
	const cm = shell.ConnectionManager.getInstance();
	const out = {};
	const step = async (name, fn) => {
		try {
			out[name] = { ok: true, value: await fn() };
		} catch (err) {
			out[name] = { ok: false, error: note(err) };
		}
	};
	await step('notify', () => cm.request('shell.notify', { message: 'hello from the fixture' }));
	await step('statusMessage', () => cm.request('shell.statusMessage', { message: 'fixture status' }));
	// The root allows one openExternal per 2 s (a refused call counts), so the calls are paced.
	const pace = () => new Promise((resolve) => setTimeout(resolve, 2200));
	await pace();
	await step('openExternalJavascript', () => cm.request('shell.openExternal', { url: 'javascript:alert(1)' }));
	await pace();
	await step('openExternalShellOrigin', () => cm.request('shell.openExternal', { url: String(p.shellUrl || 'https://localhost') + '/' }));
	await pace();
	report('l4-denials', { out });
	// The confirmed link: the answer arrives only once the user decides (the spec clicks).
	await step('openExternalAllowed', () => cm.request('shell.openExternal', { url: 'https://example.com/e2e' }, { timeoutMs: 60000 }));
	report('l4', { out });
}

// -----------------------------------------------------------------------------
// L6: keep a value in this origin's storage (T101)
// -----------------------------------------------------------------------------
async function l6(p, props, report) {
	const before = { local: localStorage.getItem('e2e:secret'), session: sessionStorage.getItem('e2e:secret'), cookie: document.cookie };
	if (p.write) {
		localStorage.setItem('e2e:secret', String(p.write));
		document.cookie = 'e2e_secret=' + encodeURIComponent(String(p.write)) + '; path=/; max-age=3600';
		try {
			await new Promise((resolve, reject) => {
				const open = indexedDB.open('e2e', 1);
				open.onupgradeneeded = () => open.result.createObjectStore('kv');
				open.onsuccess = () => {
					const tx = open.result.transaction('kv', 'readwrite');
					tx.objectStore('kv').put(String(p.write), 'secret');
					tx.oncomplete = () => resolve();
					tx.onerror = () => reject(tx.error);
				};
				open.onerror = () => reject(open.error);
			});
		} catch {
			/* storage unavailable */
		}
	}
	let idb = null;
	try {
		idb = await new Promise((resolve) => {
			const open = indexedDB.open('e2e', 1);
			open.onupgradeneeded = () => open.result.createObjectStore('kv');
			open.onsuccess = () => {
				const tx = open.result.transaction('kv', 'readonly');
				const get = tx.objectStore('kv').get('secret');
				get.onsuccess = () => resolve(get.result === undefined ? null : get.result);
				get.onerror = () => resolve(null);
			};
			open.onerror = () => resolve(null);
		});
	} catch {
		/* none */
	}
	report('l6', { before, idb, wrote: Boolean(p.write) });
}

// -----------------------------------------------------------------------------
// L7 / T102 and the default: just render
// -----------------------------------------------------------------------------
async function idle(p, props, report) {
	report('idle', { isConnected: props.isConnected });
}

const SCENARIOS = { x1, x2, x3, x4, x5, x6, x7, x8, l1, l3, l4, l6, idle };

export async function runScenario(name, params, props, report) {
	// "The fixture ran" is itself an outcome: a spec that never sees it fails as
	// "the frame is missing", which is not the same as "the exploit failed".
	report('started', { scenario: name });
	const run = SCENARIOS[name];
	if (!run) {
		report('scenario-error', { scenario: name, error: 'unknown scenario' });
		return;
	}
	await run(params, props, report);
}
