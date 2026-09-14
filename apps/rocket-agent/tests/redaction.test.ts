/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Task 5.2c — key-redaction as a tested invariant.
 *
 * Three layers, cheapest/most-isolated first:
 *
 *  1. `redactSecrets()` unit tests — the five value-shape patterns, plus a "does not corrupt
 *     normal output" guard.
 *  2. `log` wrapper tests — the key-name guard (any property whose KEY matches
 *     `SENSITIVE_KEY_RE`, regardless of value shape) and a direct `buildChildEnv()` ->
 *     `log.error()` round trip (the exact "accidental raw env log" scenario the task brief
 *     is worried about), plus a grep-level check that no `src/` module outside `log.ts` still
 *     calls the raw `console.*` — i.e. there is no OTHER path a secret could reach stdout
 *     through in the first place.
 *  3. A full FAKE session (Phase 3's `attachFake`-style fixtures, real `SessionManager` +
 *     `createApp`, no real opencode binary) with a realistic-looking key planted in the key
 *     resolver — every OBSERVABLE surface (logger output, `publicRecord` session listings,
 *     audit records, SSE panel-event payloads, HTTP error bodies) is captured across the run
 *     and asserted to never contain the key substring.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditRecord, Auditor, InMemorySink } from '../src/audit';
import { loadConfig } from '../src/config';
import { createApp } from '../src/index';
import { log, redactSecrets, SENSITIVE_KEY_RE } from '../src/log';
import { buildChildEnv, SpawnOpts } from '../src/opencode';
import { MemorySessionIndex } from '../src/sessionIndex';
import { SessionManager, SessionManagerDeps } from '../src/session';
import type { Identity, IdentityResolver, InferenceSettings, KeyResolver, LiveSession, SessionRecord } from '../src/types';
import { initGit } from '../src/workspace';

/** A realistic-looking (but fake) Anthropic key — the one substring every assertion below hunts for. */
const FAKE_KEY = 'sk-ant-api03-FAKEFAKE1234567890ABCDEFabcdef-FAKE00';

// ---------------------------------------------------------------------------
// 1. redactSecrets() — pattern coverage + "does not corrupt normal output".
// ---------------------------------------------------------------------------

describe('redactSecrets', () => {
	test.each<[string, string]>([
		['sk-ant-api03-FAKEFAKE1234567890ABCDEF', 'Anthropic key (sk-ant-...)'],
		['sk-abcdefghijklmnopqrstuvwx', 'OpenAI-shaped key (sk-<16+>)'],
		['rr_0123456789abcdef0123456789abcdef', 'RocketRide rr_ vault-exchange key (rr_<32 hex>)'],
		['Bearer some.jwt.looking.token-value', 'Authorization: Bearer header'],
		['gAAAAABmFakeFernetBlob0123456789-_==', 'Fernet ciphertext blob (gAAAAA prefix)'],
	])('redacts %s (%s)', (secret) => {
		const line = `context-before ${secret} context-after`;
		const out = redactSecrets(line);
		expect(out).not.toContain(secret);
		expect(out).toContain('[redacted]');
		expect(out).toContain('context-before');
		expect(out).toContain('context-after');
	});

	test('an sk-ant- key is matched once by its own pattern, not left partially matched by the generic sk- pattern', () => {
		const secret = 'sk-ant-api03-FAKEFAKE1234567890ABCDEF';
		expect(redactSecrets(`key=${secret} end`)).toBe('key=[redacted] end');
	});

	test('multiple distinct secrets in the same line are each redacted', () => {
		// Bearer continuation is >=16 chars (token-shaped) so it actually matches the
		// tightened Bearer pattern below.
		const line = `token=rr_0123456789abcdef0123456789abcdef auth=Bearer abc.def.ghijklmnopqrstuvwxyz key=sk-ant-api03-FAKEFAKE1234567890AB`; // gitleaks:allow — fake secret-shaped fixtures, not credentials
		const out = redactSecrets(line);
		expect(out).not.toMatch(/rr_[0-9a-f]{32}/);
		expect(out).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/-]{16,}/);
		expect(out).not.toMatch(/sk-ant-[A-Za-z0-9_-]{8,}/);
		expect((out.match(/\[redacted\]/g) ?? []).length).toBe(3);
	});

	test('does not corrupt normal log lines (no secret-shaped substrings)', () => {
		const normal =
			'[rocket-agent] listening on :8790 (saas) — tenant t1 has 3 active session(s), last archived s-123 at 2026-08-11T00:00:00.000Z';
		expect(redactSecrets(normal)).toBe(normal);
	});

	test('does not corrupt ordinary words that merely contain "key" or "auth" as a substring', () => {
		const normal = 'monkey business: authorization granted, keyboard shortcut saved';
		expect(redactSecrets(normal)).toBe(normal);
	});

	// Review fix (Important): the OLD `Bearer\s+\S+` pattern was greedy enough to eat ordinary
	// prose — `redactSecrets("Bearer token required")` used to come back
	// `"[redacted] required"`, mangling the exact phrase src/index.ts's 401 responses use at 4
	// sites (dormant today because those sites don't log, but a landmine the moment anything
	// does: `log.warn('[auth]', 'Bearer token required')` would silently truncate a real
	// message). The tightened pattern requires a >=16-char token-shaped continuation, so
	// ordinary short words never match.
	test('does not mangle the literal 401 body text "Bearer token required"', () => {
		expect(redactSecrets('Bearer token required')).toBe('Bearer token required');
	});

	test('still redacts a real-length opaque bearer token (>=16 chars)', () => {
		const token = 'aB3-xY9_qW7pR2mN8kL5'; // gitleaks:allow — fake opaque token fixture, 20 chars
		const out = redactSecrets(`Authorization: Bearer ${token}`);
		expect(out).not.toContain(token);
		expect(out).toBe('Authorization: [redacted]');
	});

	test('still redacts a JWT after Bearer', () => {
		// gitleaks:allow — fake JWT fixture (header.payload.signature shape), not a credential
		const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'; // gitleaks:allow
		const out = redactSecrets(`Bearer ${jwt}`);
		expect(out).not.toContain(jwt);
		expect(out).toBe('[redacted]');
	});
});

// ---------------------------------------------------------------------------
// 2. log wrapper — key-name guard, buildChildEnv round trip, grep-level check.
// ---------------------------------------------------------------------------

describe('log wrapper', () => {
	let logSpy: jest.SpyInstance;
	let warnSpy: jest.SpyInstance;
	let errorSpy: jest.SpyInstance;

	beforeEach(() => {
		logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => jest.restoreAllMocks());

	function allOutput(): string {
		return JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]);
	}

	test('SENSITIVE_KEY_RE matches APIKEY / API_KEY / AUTH / TOKEN / SECRET (case-insensitively), not bare "KEY"', () => {
		for (const key of ['apiKey', 'API_KEY', 'authorization', 'RR_AGENT_SERVICE_TOKEN', 'RR_ENCRYPTION_KEY_SECRET', 'auth']) {
			expect(SENSITIVE_KEY_RE.test(key)).toBe(true);
		}
		// AGENT_ANTHROPIC_KEY is deliberately NOT caught by the key-name guard (no APIKEY/
		// API_KEY/AUTH/TOKEN/SECRET substring) — it is caught by the VALUE-shape layer instead
		// (see the buildChildEnv test below). This test pins that division of labor.
		expect(SENSITIVE_KEY_RE.test('AGENT_ANTHROPIC_KEY')).toBe(false);
	});

	test('redacts object properties whose KEY matches SENSITIVE_KEY_RE regardless of value shape', () => {
		const opaqueToken = 'plain-opaque-service-token-not-a-known-secret-shape';
		const opaqueSecret = 'plain-encryption-key-material-not-a-known-shape';
		log.error('dangerous object', {
			RR_AGENT_SERVICE_TOKEN: opaqueToken,
			RR_ENCRYPTION_SECRET: opaqueSecret,
			authorization: 'whatever-value',
			safeField: 'hello world',
			count: 3,
		});
		const out = allOutput();
		expect(out).not.toContain(opaqueToken);
		expect(out).not.toContain(opaqueSecret);
		expect(out).not.toContain('whatever-value');
		expect(out).toContain('hello world');
		expect(out).toContain('[redacted]');
	});

	test('redacts nested objects and arrays, both by key and by value shape', () => {
		log.warn('nested', {
			outer: { inner: { RR_ENCRYPTION_SECRET: 'super-secret-material', ok: 'fine' } },
			list: ['plain', `leaked=${FAKE_KEY}`],
		});
		const out = allOutput();
		expect(out).not.toContain('super-secret-material');
		expect(out).not.toContain(FAKE_KEY);
		expect(out).toContain('fine');
		expect(out).toContain('plain');
	});

	test('redacts Error message + stack, preserves everything else useful about the error', () => {
		const err = new Error(`upstream rejected token ${FAKE_KEY}`);
		log.error('[some-module]', err);
		const out = allOutput();
		expect(out).not.toContain(FAKE_KEY);
		expect(out).toContain('upstream rejected token [redacted]');
	});

	test('buildChildEnv() -> log.error() round trip: the exact "accidentally logged raw env" scenario never leaks the key', () => {
		const cfg = loadConfig({ RR_MCP_UPSTREAM: 'http://localhost:8080/mcp' });
		const spawnOpts: SpawnOpts = {
			sessionId: 's1',
			workspaceDir: '/tmp/s1/workspace',
			sessionHome: '/tmp/s1/home',
			mcpProxyUrl: 'http://127.0.0.1:8790/internal/mcp/s1/secret',
			inference: { keys: { anthropic: FAKE_KEY } },
		};
		const env = buildChildEnv(cfg, spawnOpts, 'pw123');
		// Sanity check FIRST: prove this test isn't vacuous — the raw env really does carry
		// the key in plaintext before we assert the logger scrubs it.
		expect(env.AGENT_KEY_ANTHROPIC).toBe(FAKE_KEY);

		log.error('[opencode-proxy s1] simulated accidental raw env log', env);
		const out = allOutput();
		expect(out).not.toContain(FAKE_KEY);
		expect(out).toContain('[redacted]');
	});

	test('normal log lines pass through unchanged (redaction never corrupts ordinary output)', () => {
		log.info('[rocket-agent] listening on :8790 (oss)');
		expect(logSpy).toHaveBeenCalledWith('[rocket-agent] listening on :8790 (oss)');
		log.warn('[reaper]', { sweepMs: 12, archived: 2 });
		expect(warnSpy).toHaveBeenCalledWith('[reaper]', { sweepMs: 12, archived: 2 });
	});
});

describe('grep-level invariant: no src/ module outside log.ts calls raw console.*', () => {
	test('buildChildEnv\'s result (or any other secret-shaped value) has no OTHER path to stdout/stderr', () => {
		const srcDir = path.join(__dirname, '..', 'src');
		const offenders: string[] = [];
		for (const file of fs.readdirSync(srcDir)) {
			if (!file.endsWith('.ts') || file === 'log.ts') continue;
			const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
			if (/console\.(log|warn|error|info|debug)\s*\(/.test(content)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3. Full fake session — every observable surface, one planted key.
// ---------------------------------------------------------------------------

function listen(handler: http.RequestListener): Promise<{ srv: http.Server; url: string }> {
	const srv = http.createServer(handler);
	return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
		resolve({ srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` })));
}

class FakeIdentityResolver implements IdentityResolver {
	constructor(private map: Record<string, Identity>) {}
	async resolve(credential: string): Promise<Identity> {
		const id = this.map[credential];
		if (!id) throw new Error('bad credential');
		return id;
	}
}

/** Resolves every credential to an InferenceSettings carrying the planted FAKE_KEY — mirrors SaasVaultKeyResolver's shape without touching the real vault/fernet code. */
class FakeKeyResolver implements KeyResolver {
	async resolve(): Promise<InferenceSettings> {
		return { keys: { anthropic: FAKE_KEY } };
	}
}

/**
 * `attach()` override (same extension point Phase 3/5.1's tests use — see
 * `CountingSessionManager`/`FileWatchSessionManager` in tests/proxy.test.ts) that ALSO calls
 * the real `buildChildEnv()` with the real resolved keys — exercising the exact
 * env-build step a real spawn would use — before registering a `LiveSession` pointed at a
 * fake opencode HTTP server instead of actually spawning a binary. `envsBuilt` lets the test
 * prove the key really did flow through this path (non-vacuous) without ever handing it to a
 * logger.
 */
class ObservingSessionManager extends SessionManager {
	envsBuilt: Record<string, string>[] = [];

	constructor(deps: SessionManagerDeps, private fakeOcUrl: string) {
		super(deps);
	}

	protected async attach(record: SessionRecord, settings: InferenceSettings, credential: string, sessionRoot: string): Promise<LiveSession> {
		const workspaceDir = path.join(sessionRoot, 'workspace');
		const sessionHome = path.join(sessionRoot, 'home');
		await fsp.mkdir(workspaceDir, { recursive: true });
		await fsp.writeFile(path.join(workspaceDir, 'AGENTS.md'), '# fake session\n', 'utf8');
		await initGit(workspaceDir);
		const env = buildChildEnv(this.deps.cfg, {
			sessionId: record.sessionId,
			workspaceDir,
			sessionHome,
			mcpProxyUrl: `http://127.0.0.1:0/internal/mcp/${record.sessionId}/fake-mcp-secret`,
			inference: settings,
		}, 'fake-password');
		this.envsBuilt.push(env);
		const live: LiveSession = {
			record,
			proc: { kill: () => true } as unknown as ChildProcess,
			port: 0,
			password: 'fake-password',
			baseUrl: this.fakeOcUrl,
			mcpSecret: 'fake-mcp-secret',
			latestToken: credential,
			workspaceDir,
			sessionHome,
			events: new EventEmitter(),
			openStreams: 0,
			turn: {},
		};
		(this as unknown as { live: Map<string, LiveSession> }).live.set(record.sessionId, live);
		return live;
	}
}

describe('full fake session — every observable surface, one planted key', () => {
	let fakeOc: { srv: http.Server; url: string };
	let app: ReturnType<typeof createApp>;
	let appSrv: http.Server;
	let base: string;
	let manager: ObservingSessionManager;
	let index: MemorySessionIndex;
	let auditSink: InMemorySink;
	let logSpy: jest.SpyInstance;
	let warnSpy: jest.SpyInstance;
	let errorSpy: jest.SpyInstance;

	beforeAll(async () => {
		// Stands in for opencode: 204 on prompt_async, 200 on permission replies, a minimal
		// SSE frame on /global/event — never itself echoes the fake key anywhere.
		fakeOc = await listen((req, res) => {
			if (req.url === '/global/event') {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.write('data: {"type":"server.connected"}\n\n');
				return;
			}
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				if (req.url && /\/prompt_async\/?$/.test(req.url)) { res.writeHead(204); res.end(); return; }
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: true }));
			});
		});

		const cfg = loadConfig({
			RR_MCP_UPSTREAM: 'http://127.0.0.1:1/unused-mcp-upstream',
			RR_AGENT_DATA_DIR: await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-redaction-test-')),
		} as NodeJS.ProcessEnv);

		index = new MemorySessionIndex();
		auditSink = new InMemorySink();
		const auditor = new Auditor(auditSink);
		manager = new ObservingSessionManager({
			cfg,
			keys: new FakeKeyResolver(),
			index,
			storeFactory: async () => ({ fsReadString: async () => '', fsWriteString: async () => undefined, close: async () => undefined }),
			auditor,
		}, fakeOc.url);
		app = createApp({
			cfg, manager, index,
			identity: new FakeIdentityResolver({ 'tok-alice': { ownerId: 'alice', tenantId: 't1' } }),
			auditor,
		});
		appSrv = app.listen(0, '127.0.0.1');
		await new Promise<void>((r) => appSrv.once('listening', r));
		base = `http://127.0.0.1:${(appSrv.address() as AddressInfo).port}`;
	});

	afterAll(() => { fakeOc.srv.close(); appSrv.close(); });

	beforeEach(() => {
		logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => jest.restoreAllMocks());

	test('the planted key never appears in ANY observable surface across a full session lifecycle', async () => {
		// --- drive a realistic session: create, prompt (key pasted into chat by the user),
		// an MCP tool call (key pasted into tool args), an auth-pause/refresh event pair,
		// and a couple of error responses. ---

		const createRes = await fetch(`${base}/agent/sessions`, {
			method: 'POST',
			headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'redaction-test' }),
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()) as { sessionId: string };
		const id = created.sessionId;
		const live = manager.getLive(id)!;

		// Sanity check FIRST — non-vacuous: buildChildEnv really did see the raw key on this
		// real create() -> attach() path.
		expect(manager.envsBuilt.at(-1)?.AGENT_KEY_ANTHROPIC).toBe(FAKE_KEY);

		// Surface: HTTP response body of a normal API call (session listing).
		const listRes = await fetch(`${base}/agent/sessions`, { headers: { authorization: 'Bearer tok-alice' } });
		const listBody = await listRes.text();

		// Surface: a user pasting their own key into a prompt (agent.prompt audit tap).
		const promptRes = await fetch(`${base}/agent/sessions/${id}/opencode/session/oc-session-1/prompt_async`, {
			method: 'POST',
			headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
			body: JSON.stringify({ agent: 'rr-builder', parts: [{ type: 'text', text: `here is my key ${FAKE_KEY}, use it` }] }),
		});
		expect(promptRes.status).toBe(204);

		// Surface: a tool call whose arguments happen to carry the key (mcp.tool audit tap).
		await fetch(`${base}/internal/mcp/${id}/${live.mcpSecret}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0', id: 1, method: 'tools/call',
				params: { name: 'validate_pipeline', arguments: { pipePath: 'flows/demo.pipe', apiKey: FAKE_KEY } },
			}),
		});

		// Surface: rocket-agent's own SSE panel events (auth.expired / auth.refreshed).
		const emittedEvents: unknown[] = [];
		live.events.on('event', (e) => emittedEvents.push(e));
		manager.pauseForAuth(live);
		manager.touch(live, `Bearer ${FAKE_KEY}`); // a freshly-cached credential that happens to embed the key
		manager.pauseForCap(live);

		// Surface: HTTP error bodies (404 owner-mismatch, 401 bad credential, 404 wrong MCP secret).
		const err404 = await (await fetch(`${base}/agent/sessions/${id}`, {
			method: 'DELETE', headers: { authorization: 'Bearer tok-nobody' },
		})).text().catch(() => '');
		const err401 = await (await fetch(`${base}/agent/sessions`, { headers: { authorization: `Bearer ${FAKE_KEY}-but-invalid` } })).text();
		const errMcp404Status = (await fetch(`${base}/internal/mcp/${id}/wrong-secret`, { method: 'POST', body: '{}' })).status;
		expect(errMcp404Status).toBe(404);

		// --- gather every observable surface named in the task brief ---

		const loggerOutput = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]);
		const sessionRecordsJson = JSON.stringify((await index.listByOwner('alice')));
		const auditRecordsJson = JSON.stringify(auditSink.records);
		const sseEventsJson = JSON.stringify(emittedEvents);
		const httpErrorBodiesJson = JSON.stringify({ err404, err401, listBody });

		const surfaces: Record<string, string> = {
			'logger output': loggerOutput,
			'session records (publicRecord via listByOwner)': sessionRecordsJson,
			'audit records': auditRecordsJson,
			'SSE panel-event payloads': sseEventsJson,
			'HTTP response/error bodies': httpErrorBodiesJson,
		};

		for (const [surface, content] of Object.entries(surfaces)) {
			if (content.includes(FAKE_KEY)) throw new Error(`key leaked into surface: ${surface}`);
		}
		// Belt-and-suspenders: assert on the concatenation too, so a future refactor that
		// renames one of the surfaces above can't silently narrow coverage.
		const everything = Object.values(surfaces).join('\n');
		expect(everything).not.toContain(FAKE_KEY);

		// The audit trail is digest-only BY DESIGN (never raw args) — pin that explicitly too.
		const promptRecord = auditSink.records.find((r: AuditRecord) => r.kind === 'agent.prompt');
		const toolRecord = auditSink.records.find((r: AuditRecord) => r.kind === 'mcp.tool');
		expect(promptRecord?.argsDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(toolRecord?.argsDigest).toMatch(/^[0-9a-f]{64}$/);
	});
});
