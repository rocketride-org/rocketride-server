#!/usr/bin/env node
// Drives the Agent tab of Rocket Builder in a real browser and records proof.
// Run `rr-verify-agent launch` and `rr-verify-agent doctor` first, or use
// `rr-verify-agent run`, which does both and cleans up.
//
//   node drive.mjs build-pipeline [--prompt "..."] [--max-followups 4]
//   node drive.mjs secrets
//   node drive.mjs unsaved-edits [--choice save|discard|keep]
//   node drive.mjs needs-you
//   node drive.mjs stop
//   node drive.mjs team-switch
//   node drive.mjs steps <file.json | name in steps/>
// Flags for all: --headed, --turn-timeout-min <n> (default 20)
//
// Evidence goes to $RR_VERIFY_EVIDENCE/<journey>/<timestamp>/ (default
// <checkout>/.verify/agent, which git ignores). result.json holds the status,
// each check with its reason, and the engine's provenance. Exit code 0 means
// pass, 1 fail, 2 could not run, 3 every check this engine can verify passed
// and some could not be verified on it (an engine without fs_put_json).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.dirname(HERE);
const SHELL_PORT = process.env.RR_VERIFY_SHELL_PORT || '3000';
const APP_ID = 'rocketride.pipeBuilder';
const APP_URL = `http://127.0.0.1:${SHELL_PORT}/?appid=${APP_ID}&rrdev=1`;
const APIKEY = process.env.RR_VERIFY_APIKEY || 'local-test';
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8' }).trim();
const EVIDENCE_ROOT = process.env.RR_VERIFY_EVIDENCE || path.join(ROOT, '.verify', 'agent');
const STATE_DIR = process.env.RR_VERIFY_STATE || path.join(ROOT, '.verify', 'agent-state');
const APPROVAL = 'Yes, approved. Go ahead and build it, and validate it when you are done.';
const LOAD_MS = 180_000;
// The secrets journey's mid-run message, before and after its key is replaced.
const MIDRUN_TEXT = (key) => `Also, my OpenAI key for later is ${key}. Nothing to do with it now.`;
// heardText numbers each message; this one is the first of its run.
const MIDRUN_SEEN = '1. Also, my OpenAI key for later is [redacted]. Nothing to do with it now.';

// -----------------------------------------------------------------------------
// args
// -----------------------------------------------------------------------------

const argv = process.argv.slice(2);
const journey = argv[0];
const flag = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const HEADED = argv.includes('--headed');

// The engine launch recorded (mode, build or image, capabilities), copied into every result.
const ENGINE = (() => {
	try {
		return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'engine.json'), 'utf8'));
	} catch {
		return null;
	}
})();
// The checkout whose rocket-ui and shell are under test, at drive time.
const CHECKOUT = (() => {
	const git = (...a) => {
		try {
			return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
		} catch {
			return '';
		}
	};
	return {
		path: ROOT,
		commit: git('rev-parse', 'HEAD'),
		branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
		dirtyFiles: git('status', '--porcelain').split('\n').filter(Boolean).length,
	};
})();
const TURN_MS = Number(flag('turn-timeout-min', '20')) * 60_000;

// -----------------------------------------------------------------------------
// evidence
// -----------------------------------------------------------------------------

class Run {
	constructor(name) {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		this.name = name;
		this.dir = path.join(EVIDENCE_ROOT, name, stamp);
		fs.mkdirSync(this.dir, { recursive: true });
		this.n = 0;
		this.canary = '';
		this.canaryHits = [];
		// A second fake key, the one the secrets journey pastes into the composer.
		this.pasted = '';
		this.pastedHits = [];
		// A third, sent while a turn runs: it reaches the agent as a mid-run message, not through the request path.
		this.midrun = '';
		this.midrunHits = [];
		this.heardFrames = [];
		this.markerFrames = [];
		this.sent = [];
		this.received = 0;
		this.consoleLines = [];
		this.checks = [];
	}

	log(action, result) {
		const line = `${new Date().toISOString()}  ${action}  ->  ${result}`;
		fs.appendFileSync(path.join(this.dir, 'steps.log'), line + '\n');
		console.error(`[drive] ${action} -> ${result}`);
	}

	/** Records one pass/fail check that decides the result. */
	check(id, ok, detail) {
		this.checks.push({ id, ok: !!ok, status: ok ? 'pass' : 'fail', detail });
		this.log(`check ${id}`, `${ok ? 'PASS' : 'FAIL'}: ${detail}`);
	}

	/**
	 * A check that reads saved sessions. Session saves send fs_put_json, so on an
	 * engine without it (the published image) the check is recorded as not
	 * verifiable on this engine instead of failing or passing on nothing.
	 */
	checkSaved(id, ok, detail) {
		const caps = ENGINE?.capabilities;
		if (caps && caps.fsPutJson === false) {
			const why =
				`not verifiable on this engine: it has no fs_put_json (${caps.detail}), ` +
				'so the chat cannot save sessions. Run with --engine source';
			this.checks.push({ id, ok: null, status: 'not-verifiable', detail: `${why}. Seen: ${detail}` });
			this.log(`check ${id}`, `NOT VERIFIABLE: ${why}`);
			return;
		}
		this.check(id, ok, detail);
	}

	/** Blanks real-key shapes, keeping this run's fake canaries visible. */
	scrub(text) {
		const keep = (m) =>
			[this.canary, this.pasted, this.midrun].some((c) => c && m.includes(c)) ? m : '[redacted]';
		return text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, keep).replace(/sk-(proj-)?[A-Za-z0-9_-]{16,}/g, keep);
	}

	async shot(page, label) {
		this.n += 1;
		const base = `${String(this.n).padStart(2, '0')}-${label}`;
		await page.screenshot({ path: path.join(this.dir, `${base}.png`) });
		try {
			fs.writeFileSync(
				path.join(this.dir, `${base}.aria.txt`),
				this.scrub(await page.locator('body').ariaSnapshot())
			);
		} catch {
			/* the snapshot is a bonus; the screenshot is the proof */
		}
		return base;
	}

	/** Runs engine-read.cjs (the second, read-only view through the engine). */
	engine(...args) {
		try {
			const out = execFileSync('node', [path.join(HERE, 'engine-read.cjs'), ...args], {
				encoding: 'utf8',
				env: {
					...process.env,
					RR_VERIFY_CANARY: [this.canary, this.pasted, this.midrun].filter(Boolean).join(','),
				},
			});
			return { ok: true, out };
		} catch (err) {
			return { ok: false, code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
		}
	}

	/** Records console output and every WebSocket frame the page sends. */
	attach(page) {
		page.on('console', (m) => this.consoleLines.push(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => this.consoleLines.push(`[pageerror] ${e.stack || e.message}`));
		page.on('websocket', (ws) => {
			const url = ws.url();
			ws.on('framesent', ({ payload }) => {
				const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
				if (this.canary && text.includes(this.canary))
					this.canaryHits.push({ frame: this.sent.length, url, offset: text.indexOf(this.canary) });
				if (this.pasted && text.includes(this.pasted))
					this.pastedHits.push({ frame: this.sent.length, url, offset: text.indexOf(this.pasted) });
				if (this.midrun && text.includes(this.midrun))
					this.midrunHits.push({ frame: this.sent.length, url, offset: text.indexOf(this.midrun) });
				// The mid-run message as the model gets it: in the run's list of user messages, its key replaced.
				if (
					this.midrun &&
					text.includes('Messages from the user during this run') &&
					text.includes(MIDRUN_SEEN)
				)
					this.heardFrames.push(this.sent.length);
				// B1's file marker, «secret:<8 hex>», raw or JSON-escaped.
				if (/(?:«|\\u00ab)secret:[0-9a-f]{8}/i.test(text)) this.markerFrames.push(this.sent.length);
				this.sent.push({ t: new Date().toISOString(), url, bytes: text.length, text: this.scrub(text) });
			});
			ws.on('framereceived', () => {
				this.received += 1;
			});
		});
	}

	finish(extra = {}) {
		fs.writeFileSync(path.join(this.dir, 'console.log'), this.scrub(this.consoleLines.join('\n')) + '\n');
		fs.writeFileSync(
			path.join(this.dir, 'ws-sent.jsonl'),
			this.sent.map((f) => JSON.stringify(f)).join('\n') + '\n'
		);
		const failed = this.checks.filter((c) => c.status === 'fail').map((c) => c.id);
		const notVerifiable = this.checks.filter((c) => c.status === 'not-verifiable').map((c) => c.id);
		const status = !this.checks.length || failed.length ? 'fail' : notVerifiable.length ? 'incomplete' : 'pass';
		const pass = status === 'pass';
		if (ENGINE) fs.writeFileSync(path.join(this.dir, 'engine.json'), JSON.stringify(ENGINE, null, 2) + '\n');
		const result = {
			journey: this.name,
			status,
			pass,
			checks: this.checks,
			notVerifiable,
			engine: ENGINE ?? {
				error: `no engine provenance in ${STATE_DIR}/engine.json; launch with rr-verify-agent`,
			},
			checkout: CHECKOUT,
			framesSent: this.sent.length,
			framesReceived: this.received,
			canaryHits: this.canaryHits,
			...(this.pasted
				? {
						pastedHits: this.pastedHits,
						markerFrames: this.markerFrames,
						midrunHits: this.midrunHits,
						heardFrames: this.heardFrames,
					}
				: {}),
			evidence: this.dir,
			...extra,
		};
		fs.writeFileSync(path.join(this.dir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
		console.log(
			JSON.stringify({
				journey: this.name,
				status,
				evidence: this.dir,
				engine: ENGINE?.summary,
				failed,
				notVerifiable,
			})
		);
		return status;
	}
}

// -----------------------------------------------------------------------------
// the user's path through the UI
// -----------------------------------------------------------------------------

/** Fills the shell's API key screen with the local test key and submits it. */
async function submitApiKey(page, run, where) {
	const key = page.getByPlaceholder('API key');
	await key.fill(APIKEY);
	await key.press('Enter');
	await key.waitFor({ state: 'detached', timeout: 60_000 });
	run.log(`sign in on the API key screen (${where})`, 'connected with the local test key');
}

/**
 * Signs in from the shell home, then opens Rocket Builder with the branch's
 * rocket-ui. Opening the app URL in a fresh tab first leaves it at
 * "Initialising..." with no sign-in screen, so sign in from home first.
 */
async function openApp(page, run) {
	await page.goto(APP_URL.replace(/\?.*$/, ''), { waitUntil: 'domcontentloaded' });
	await page.getByRole('button', { name: 'Sign In' }).click({ timeout: LOAD_MS });
	await submitApiKey(page, run, 'home');
	await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
	await page
		.locator('input[aria-label="API key"], [role="tab"][aria-label="Agent"]')
		.first()
		.waitFor({ timeout: LOAD_MS });
	if (await page.getByPlaceholder('API key').isVisible()) await submitApiKey(page, run, 'app');
	await page.getByRole('tab', { name: 'Agent', exact: true }).waitFor({ timeout: LOAD_MS });
	await run.shot(page, 'app-loaded');
	run.log('open Rocket Builder (?appid=rocketride.pipeBuilder&rrdev=1)', 'activity rail shows the Agent tab');
}

// Each open session tab has its own composer; only the active one is visible.
const composer = (page) =>
	page.getByRole('textbox', { name: 'Reply to the agent...' }).filter({ visible: true }).first();
const sendButton = (page) => page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).first();

/**
 * Selects a rail view (Explorer, Agent, Pipelines...). The first click after
 * the app loads is swallowed while the app restores its default view, so
 * click until the tab reports aria-selected.
 */
async function showView(page, run, name) {
	const tab = page.getByRole('tab', { name, exact: true });
	for (let i = 0; i < 8; i++) {
		if ((await tab.getAttribute('aria-selected')) === 'true') return;
		await tab.click();
		await page.waitForTimeout(1000);
	}
	if ((await tab.getAttribute('aria-selected')) !== 'true')
		throw new Error(`the ${name} rail tab never became selected`);
	run.log(`show the ${name} view`, 'selected');
}

/** Agent tab, then the sidebar's New session button, then waits for the composer. */
async function newSession(page, run) {
	await showView(page, run, 'Agent');
	await page.getByRole('button', { name: 'New session', exact: true }).click();
	await composer(page).waitFor({ timeout: 60_000 });
	await run.shot(page, 'new-session');
	run.log('start a new agent session', 'composer "Reply to the agent..." is ready');
}

async function send(page, run, text, label) {
	await composer(page).fill(text);
	await sendButton(page).click();
	run.log(`send "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`, 'sent');
	await run.shot(page, `${label}-sent`);
}

const typingDots = (page) => page.locator('span[style*="rr-chat-dot"]').filter({ visible: true }).first();

/** Waits for the agent's turn to end: the typing dots appear, then go away. */
async function waitTurn(page, run, label, onRunning) {
	const dots = typingDots(page);
	try {
		await dots.waitFor({ state: 'visible', timeout: 15_000 });
	} catch {
		/* a very fast turn */
	}
	if (onRunning) await onRunning();
	const t0 = Date.now();
	try {
		await dots.waitFor({ state: 'detached', timeout: TURN_MS });
	} catch {
		run.log(`wait for the ${label} turn`, `still running after ${TURN_MS / 60000} min`);
		await run.shot(page, `${label}-timeout`);
		return { ended: false, ms: Date.now() - t0 };
	}
	await run.shot(page, `${label}-ended`);
	run.log(`wait for the ${label} turn`, `ended after ${Math.round((Date.now() - t0) / 1000)}s`);
	return { ended: true, ms: Date.now() - t0 };
}

/**
 * Snapshots the workspace and sessions through the engine and returns the
 * newest session's messages. Waits for `minSessions` session files too.
 */
async function engineView(run, label, expectBots, minSessions = 1) {
	const dir = path.join(run.dir, `engine-${label}`);
	let messages = [];
	for (let i = 0; i < 10; i++) {
		fs.rmSync(dir, { recursive: true, force: true });
		run.engine('snapshot', dir);
		messages = newestSession(dir);
		if (
			messages.filter((m) => m.sender === 'bot').length >= expectBots &&
			sessionTexts(dir).sessions.length >= minSessions
		)
			break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return messages;
}

function newestSession(dir) {
	const sdir = path.join(dir, 'sessions', APP_ID);
	if (!fs.existsSync(sdir)) return [];
	// session files are <uuid>.json; catalog.json is the index, not a session
	const files = fs
		.readdirSync(sdir)
		.filter((f) => /^[0-9a-f-]{36}\.json$/i.test(f))
		.map((f) => path.join(sdir, f));
	if (!files.length) return [];
	files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	try {
		return JSON.parse(fs.readFileSync(files[0], 'utf8')).messages || [];
	} catch {
		return [];
	}
}

const lastBot = (messages) => [...messages].reverse().find((m) => m.sender === 'bot')?.text ?? '';
const pipeFiles = (run) =>
	run
		.engine('ls', 'pipelines')
		.out.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.endsWith('.pipe'));

/** Writes the transcript the page shows (thinking rows folded) for the record. */
async function transcript(page, run) {
	const text = await page.locator('body').innerText();
	fs.writeFileSync(path.join(run.dir, 'transcript.txt'), run.scrub(text) + '\n');
}

// -----------------------------------------------------------------------------
// journeys
// -----------------------------------------------------------------------------

/** Ask for a pipeline, answer approval stops, then check the file and engine validate. */
async function buildPipeline(page, run) {
	const prompt = flag(
		'prompt',
		'Build a pipeline called verify-chat where I can chat with Claude Sonnet 4.6. ' +
			'My Anthropic key is already in Variables as ROCKETRIDE_ANTHROPIC_KEY.'
	);
	const maxFollowups = Number(flag('max-followups', '4'));
	const before = new Set(pipeFiles(run));
	await openApp(page, run);
	await newSession(page, run);
	await send(page, run, prompt, 'turn1');
	let turn = await waitTurn(page, run, 'turn1');
	let turns = 1;
	let created = pipeFiles(run).filter((p) => !before.has(p));
	while (turn.ended && !created.length && turns <= maxFollowups) {
		turns += 1;
		await send(page, run, APPROVAL, `turn${turns}`);
		turn = await waitTurn(page, run, `turn${turns}`);
		created = pipeFiles(run).filter((p) => !before.has(p));
	}
	const messages = await engineView(run, 'final', turns);
	await transcript(page, run);
	run.check('turn-ended', turn.ended, turn.ended ? `turn ${turns} ended on its own` : 'the last turn never ended');
	run.check(
		'pipeline-written',
		created.length > 0,
		created.length ? `new files: ${created.join(', ')}` : `no new .pipe under pipelines/ after ${turns} turn(s)`
	);
	const validations = created.map((p) => {
		const r = run.engine('validate', p);
		fs.writeFileSync(path.join(run.dir, `validate-${path.basename(p)}.json`), r.out);
		let errors = ['validate did not run'];
		try {
			errors = JSON.parse(r.out).errors;
		} catch {
			/* keep the failure */
		}
		return { path: p, errors };
	});
	if (created.length)
		run.check(
			'engine-validate',
			validations.every((v) => v.errors.length === 0),
			validations.map((v) => `${v.path}: ${v.errors.length} error(s)`).join('; ')
		);
	run.checkSaved(
		'reply-recorded',
		lastBot(messages).length > 0,
		`final reply (${lastBot(messages).length} chars) saved in the session`
	);
	return { turns, prompt, created, finalReply: run.scrub(lastBot(messages)).slice(0, 2000) };
}

/**
 * Opens every folded "Thinking…" group in the visible thread, so the thinking
 * rows are in the DOM, and returns their text.
 */
async function openThinking(page) {
	const toggles = page.getByRole('button', { name: 'Thinking…', exact: true }).filter({ visible: true });
	const count = await toggles.count();
	for (let i = 0; i < count; i++) await toggles.nth(i).click();
	await page.waitForTimeout(500);
	// Each open group is the toggle's parent; its rows sit after the toggle.
	const texts = await toggles.evaluateAll((buttons) => buttons.map((b) => b.parentElement?.innerText ?? ''));
	return { groups: count, text: texts.join('\n') };
}

/** Every agent session file and the catalog in an engine snapshot, as raw text. */
function sessionTexts(dir) {
	const sdir = path.join(dir, 'sessions', APP_ID);
	const files = fs.existsSync(sdir) ? fs.readdirSync(sdir) : [];
	const read = (f) => fs.readFileSync(path.join(sdir, f), 'utf8');
	return {
		sessions: files.filter((f) => /^[0-9a-f-]{36}\.json$/i.test(f)).map((f) => ({ file: f, text: read(f) })),
		catalog: files.includes('catalog.json') ? read('catalog.json') : '',
	};
}

/** The text of every thinking row stored in the session files. */
function storedThinking(sessions) {
	return sessions
		.flatMap(({ text }) => {
			try {
				return JSON.parse(text).messages || [];
			} catch {
				return [];
			}
		})
		.filter((m) => m.sender === 'status' && m.sseType === 'thinking')
		.map((m) => m.text)
		.join('\n');
}

/** Names where a canary was found, for a check's detail. */
const where = (hits) =>
	hits
		.filter(([, hit]) => hit)
		.map(([name]) => name)
		.join(', ');

/**
 * A fake key inline in a .pipe must never reach the model, the page or the
 * saved session, and the model must see a «secret:…» marker in its place
 * (PR B1). Then a fake key pasted into the composer must be blocked before
 * the model and kept out of the session, its title and the catalog. Last, a
 * fake key sent while a turn runs must reach the model only with the key
 * replaced. The stored checks count only when the sessions were saved.
 */
async function secrets(page, run) {
	run.canary = `sk-ant-api03-RRVERIFY${crypto.randomBytes(16).toString('hex')}`;
	run.pasted = `sk-ant-api03-RRVERIFYPASTE${crypto.randomBytes(16).toString('hex')}`;
	const fixture = path.join(run.dir, 'fixture-verify-secret.pipe');
	fs.writeFileSync(
		fixture,
		fs
			.readFileSync(path.join(SKILL, 'steps/fixtures/inline-key.pipe.tmpl'), 'utf8')
			// The template holds the placeholder form, so secret scanners pass it.
			.replace('${RR_VERIFY_CANARY}', run.canary)
	);
	const seeded = run.engine('write', 'pipelines/verify-secret.pipe', fixture);
	run.log(
		'precondition: seed pipelines/verify-secret.pipe with a fake inline key',
		seeded.ok ? 'written through the engine' : seeded.out
	);
	if (!seeded.ok) throw new Error('could not seed the fixture');
	await openApp(page, run);

	// Part 1: the key inline in a .pipe file.
	await newSession(page, run);
	await send(
		page,
		run,
		'What does pipelines/verify-secret.pipe do? Walk through each node and how it is configured.',
		'turn1'
	);
	const turn = await waitTurn(page, run, 'turn1');
	await engineView(run, 'turn1', 1);
	const thinking = await openThinking(page);
	await run.shot(page, 'turn1-thinking-open');
	run.log('open the Thinking… groups', `${thinking.groups} group(s) opened`);
	const dom = await page.content();
	fs.writeFileSync(path.join(run.dir, 'dom-turn1.html'), run.scrub(dom));
	const turn1Sent = run.sent.length;

	// Part 2: a key pasted into the composer, as the first message of a new session.
	await newSession(page, run);
	await send(
		page,
		run,
		`My Anthropic key is ${run.pasted}. Keep it in mind for later; there is nothing else to do now.`,
		'paste'
	);
	const pasteTurn = await waitTurn(page, run, 'paste');
	const blockedRow = page
		.getByText(/looks like it contains a key/i)
		.filter({ visible: true })
		.first();
	const blocked = await blockedRow.isVisible().catch(() => false);

	// Part 3: a key sent while a turn runs. The send queues, and the running
	// turn takes it as a mid-run message, which skips the request's key check.
	run.midrun = `sk-ant-api03-RRVERIFYMIDRUN${crypto.randomBytes(16).toString('hex')}`;
	await newSession(page, run);
	await send(page, run, 'List the files in pipelines/ and say in one line what each one is for.', 'turn3');
	let midrunSent = false;
	const midrunTurn = await waitTurn(page, run, 'turn3', async () => {
		if (!(await typingDots(page).isVisible())) return;
		await send(page, run, MIDRUN_TEXT(run.midrun), 'midrun');
		midrunSent = true;
	});
	const midrunBlocked = await page
		.getByText(/looks like it contains a key/i)
		.filter({ visible: true })
		.first()
		.isVisible()
		.catch(() => false);
	run.log(
		'send a key while the turn runs',
		midrunSent
			? midrunBlocked
				? 'sent; it opened its own turn and was blocked like a request'
				: 'sent while the turn ran'
			: 'the turn ended before the send'
	);
	await engineView(run, 'final', 1, 3);
	await transcript(page, run);
	const { sessions, catalog } = sessionTexts(path.join(run.dir, 'engine-final'));
	const sessionText = sessions.map((s) => s.text).join('\n');
	const thinkingStored = storedThinking(sessions);
	const fileKept = run.engine('cat', 'pipelines/verify-secret.pipe').out.includes(run.canary);

	const allEnded = turn.ended && pasteTurn.ended && midrunTurn.ended;
	run.check(
		'turn-ended',
		allEnded,
		allEnded
			? 'all three turns ended'
			: [
					`turn1 ${turn.ended ? 'ended' : 'never ended'}`,
					`paste turn ${pasteTurn.ended ? 'ended' : 'never ended'}`,
					`turn3 ${midrunTurn.ended ? 'ended' : 'never ended'}`,
				].join('; ')
	);
	// The stored checks below read the saved sessions; with none saved they would pass on nothing.
	const saveError = run.consoleLines.find((l) => /session save failed/.test(l));
	run.checkSaved(
		'sessions-saved',
		sessions.length >= 3 && catalog.length > 0,
		sessions.length >= 3 && catalog.length > 0
			? `${sessions.length} session files and the catalog were saved`
			: `${sessions.length} of 3 session files saved, catalog ${catalog ? 'saved' : 'missing'}` +
					(saveError ? `; console: ${saveError.slice(0, 160)}` : '')
	);
	run.check(
		'canary-not-sent',
		run.canaryHits.length === 0,
		run.canaryHits.length
			? `fake key found in ${run.canaryHits.length} frame(s) the page sent: ${run.canaryHits
					.slice(0, 5)
					.map((h) => `#${h.frame}`)
					.join(', ')}`
			: `fake key absent from all ${run.sent.length} frames the page sent`
	);
	const markers = run.markerFrames.filter((n) => n < turn1Sent);
	run.check(
		'marker-sent',
		markers.length > 0,
		markers.length
			? `a «secret:…» marker stands in for the key in ${markers.length} frame(s) the page sent: ${markers
					.slice(0, 5)
					.map((n) => `#${n}`)
					.join(', ')}`
			: `no frame of the ${turn1Sent} the page sent in turn 1 holds a «secret:…» marker`
	);
	run.check(
		'canary-not-in-dom',
		!dom.includes(run.canary),
		dom.includes(run.canary)
			? 'the fake key is in the page DOM after turn 1 (thinking groups open)'
			: 'the fake key is absent from the page DOM after turn 1, thinking groups open'
	);
	const thinkingHits = where([
		['the open thinking rows', thinking.text.includes(run.canary)],
		['the stored thinking rows', thinkingStored.includes(run.canary)],
	]);
	run.check(
		'canary-not-in-thinking',
		!thinkingHits,
		thinkingHits
			? `the fake key is in ${thinkingHits}`
			: `the fake key is absent from ${thinking.groups} open thinking group(s) and the stored thinking rows`
	);
	run.checkSaved(
		'canary-not-in-session',
		!sessionText.includes(run.canary),
		sessionText.includes(run.canary)
			? 'the fake key is in a saved session file'
			: `the fake key is absent from all ${sessions.length} saved session file(s)`
	);
	run.checkSaved(
		'canary-not-in-catalog',
		!catalog.includes(run.canary),
		catalog.includes(run.canary)
			? 'the fake key is in the session catalog'
			: 'the fake key is absent from the session catalog'
	);
	run.check(
		'pasted-not-sent',
		run.pastedHits.length === 0,
		run.pastedHits.length
			? `the pasted key left the page in ${run.pastedHits.length} frame(s): ${run.pastedHits
					.slice(0, 5)
					.map((h) => `#${h.frame}`)
					.join(', ')}`
			: `the pasted key is absent from all ${run.sent.length} frames the page sent`
	);
	run.check(
		'pasted-blocked',
		blocked,
		blocked ? 'an error row says the message looks like it contains a key' : 'no error row about the pasted key'
	);
	const pastedHits = where([
		['a saved session file', sessionText.includes(run.pasted)],
		['the session catalog', catalog.includes(run.pasted)],
	]);
	run.checkSaved(
		'pasted-not-stored',
		!pastedHits,
		pastedHits
			? `the pasted key is in ${pastedHits}`
			: 'the pasted key is absent from the saved sessions, their titles and the catalog'
	);
	run.check(
		'midrun-not-sent',
		midrunSent && run.midrunHits.length === 0,
		!midrunSent
			? 'the turn ended before the mid-run send'
			: run.midrunHits.length
				? `the mid-run key left the page in ${run.midrunHits.length} frame(s): ${run.midrunHits
						.slice(0, 5)
						.map((h) => `#${h.frame}`)
						.join(', ')}`
				: `the mid-run key is absent from all ${run.sent.length} frames the page sent`
	);
	run.check(
		'midrun-heard',
		run.heardFrames.length > 0,
		run.heardFrames.length
			? `the model got the mid-run message with its key replaced in ${run.heardFrames.length} frame(s): ` +
					run.heardFrames
						.slice(0, 5)
						.map((n) => `#${n}`)
						.join(', ')
			: midrunBlocked
				? 'the message opened its own turn, so the mid-run path did not run'
				: 'no frame holds the mid-run message as the model gets it'
	);
	const midrunStored = where([
		['a saved session file', sessionText.includes(run.midrun)],
		['the session catalog', catalog.includes(run.midrun)],
	]);
	run.checkSaved(
		'midrun-not-stored',
		!midrunStored,
		midrunStored
			? `the mid-run key is in ${midrunStored}`
			: 'the mid-run key is absent from the saved sessions and the catalog'
	);
	run.log(
		'fake key still in pipelines/verify-secret.pipe (diagnostic)',
		fileKept ? "yes, the user's value stays in the file" : 'no'
	);
	return {
		canaryShape: 'sk-ant-api03-RRVERIFY<32 hex>',
		pastedShape: 'sk-ant-api03-RRVERIFYPASTE<32 hex>',
		midrunShape: 'sk-ant-api03-RRVERIFYMIDRUN<32 hex>',
		midrunSent,
		midrunBlocked,
		thinkingGroups: thinking.groups,
		fileKept,
		finalReply: run.scrub(lastBot(newestSessionOf(sessions, 2))).slice(0, 2000),
	};
}

/** The messages of the n-th newest session file of a snapshot, by first message order. */
function newestSessionOf(sessions, n) {
	const parsed = sessions
		.map(({ text }) => {
			try {
				return JSON.parse(text);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	parsed.sort((a, b) => (b.date || 0) - (a.date || 0));
	return parsed[n]?.messages || [];
}

/** The user has unsaved typing in Monaco when the agent edits the same file. */
async function unsavedEdits(page, run) {
	const file = 'apps/verify-notes/src/App.tsx';
	const userLine = '// RRVERIFY user edit, not saved';
	// The manifest lets check_app pass, so the agent does not rebuild the app's scaffold.
	const manifest = run.engine(
		'write',
		'apps/verify-notes/package.json',
		path.join(SKILL, 'steps/fixtures/package.json')
	);
	if (!manifest.ok) throw new Error(`could not seed apps/verify-notes/package.json: ${manifest.out}`);
	const seeded = run.engine('write', file, path.join(SKILL, 'steps/fixtures/App.tsx'));
	run.log(`precondition: seed ${file}`, seeded.ok ? 'written through the engine' : seeded.out);
	if (!seeded.ok) throw new Error('could not seed the fixture');
	const original = run.engine('cat', file).out;
	await openApp(page, run);
	await showView(page, run, 'Explorer');
	// The tree rows have no role; scope the text match to the side panel.
	const panel = page.getByRole('tabpanel');
	for (const name of ['apps', 'verify-notes', 'src', 'App.tsx']) {
		await panel.getByText(name, { exact: true }).first().click();
		await page.waitForTimeout(500);
	}
	run.log(`open ${file} from the Explorer`, 'clicked apps, verify-notes, src, App.tsx');
	const editor = page.locator('.monaco-editor').first();
	await editor.waitFor({ timeout: 60_000 });
	await page.locator('.monaco-editor .view-lines').first().click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type(`\n${userLine}`);
	await run.shot(page, 'user-typed-unsaved');
	run.log(`type in ${file} without saving`, `added "${userLine}"`);
	await newSession(page, run);
	await send(
		page,
		run,
		`Change the heading in ${file} to say "Hello from the agent". Keep everything else as it is.`,
		'turn1'
	);
	let dialog = null;
	const dialogs = [];
	const choice = flag('choice', 'keep');
	const label = { save: /save mine/i, discard: /discard mine/i, keep: /keep mine/i }[choice];
	if (!label) throw new Error(`--choice must be save, discard or keep (got ${choice})`);
	// Every choice dialog during the turn gets the same answer: an agent that asks again
	// after Keep mine would otherwise leave the turn waiting on a dialog nobody answers.
	let answering = true;
	const answerDialogs = async () => {
		const d = page
			.getByRole('dialog')
			.filter({ hasText: /unsaved changes/i })
			.first();
		while (answering) {
			try {
				await d.waitFor({ timeout: 1_000 });
			} catch {
				continue;
			}
			const buttons = await d.getByRole('button').allInnerTexts();
			const seen = { text: (await d.innerText()).slice(0, 500), buttons };
			dialogs.push(seen);
			dialog ??= seen;
			await run.shot(page, `choice-dialog-${dialogs.length}`);
			await d.getByRole('button', { name: label }).click();
			run.log(
				`agent asked about unsaved changes (dialog ${dialogs.length})`,
				`chose ${choice}; buttons: ${buttons.join(' | ')}`
			);
			await d.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
		}
	};
	let answered = Promise.resolve();
	const turn = await waitTurn(page, run, 'turn1', async () => {
		answered = answerDialogs();
	});
	answering = false;
	await answered;
	if (!dialog) run.log('look for a choice dialog during the turn', 'none appeared');
	const stored = run.engine('cat', file).out;
	// Bring the editor tab back to the front before reading what it holds.
	await page
		.getByText('App.tsx', { exact: true })
		.filter({ visible: true })
		.first()
		.click()
		.catch(() => {});
	await page.waitForTimeout(1000);
	// Monaco renders spaces as non-breaking spaces; compare as plain text.
	const buffer = (
		await page
			.locator('.monaco-editor .view-lines')
			.filter({ visible: true })
			.first()
			.innerText()
			.catch(() => '')
	).replace(/\u00a0/g, ' ');
	// The editor header names the file, and carries ● when unsaved plus any notice about outside changes.
	// The path, the notice and the ● sit in sibling elements: read the row that holds them.
	const editorHeader = (
		await page
			.getByText(/apps\/verify-notes\/src\/App\.tsx/)
			.filter({ visible: true })
			.last()
			.locator('xpath=..')
			.innerText()
			.catch(() => '')
	)
		.replace(/\u00a0/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const editorDirty = editorHeader.includes('●');
	await run.shot(page, 'editor-after');
	run.log('read the editor after the turn', `header "${editorHeader}"`);
	fs.writeFileSync(path.join(run.dir, 'stored-after.txt'), stored);
	fs.writeFileSync(path.join(run.dir, 'editor-after.txt'), buffer);
	await engineView(run, 'final', 1);
	await transcript(page, run);
	run.check('turn-ended', turn.ended, turn.ended ? 'turn ended' : 'turn never ended');
	const agentChanged = stored !== original;
	const userKept = buffer.includes('RRVERIFY user edit') || stored.includes('RRVERIFY user edit');
	const silentSplit = agentChanged && !stored.includes('RRVERIFY user edit') && buffer.includes('RRVERIFY user edit');
	run.check(
		'user-asked-or-merged',
		!!dialog || !agentChanged || (userKept && !silentSplit),
		dialog
			? 'the agent asked before writing'
			: !agentChanged
				? 'the agent left the stored file unchanged'
				: silentSplit
					? 'the agent wrote the stored file while the editor still held the unsaved line: ' +
						'the next save loses one side'
					: userKept
						? 'both edits survived'
						: "the user's unsaved line is gone"
	);
	// The prompt itself: one dialog with the three answers.
	const expected = ['Keep mine', 'Discard mine', 'Save mine first'];
	run.check(
		'choice-dialog',
		!!dialog && expected.every((b) => dialog.buttons.includes(b)),
		dialog
			? `dialog "${dialog.text.replace(/\s+/g, ' ').slice(0, 160)}" with buttons ${dialog.buttons.join(' | ')}` +
					(dialogs.length > 1 ? `; ${dialogs.length} dialogs in the turn` : '')
			: 'no unsaved-changes dialog appeared during the turn'
	);
	// Checked on its own as well, so a dialog cannot hide a split that follows it.
	run.check(
		'no-silent-split',
		!silentSplit,
		silentSplit
			? 'the stored file has the agent change while the editor still holds the unsaved line'
			: 'the stored file and the editor agree or the user knows (unsaved marker)'
	);
	// What the chosen answer must leave behind: the stored file through the engine, the editor on the page.
	const flat = (text) =>
		text
			.replace(/\u00a0/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	const has = { user: (t) => t.includes('RRVERIFY user edit'), agent: (t) => t.includes('Hello from the agent') };
	const editorState = () =>
		`editor ${editorDirty ? 'STILL UNSAVED' : 'clean'} and ` +
		(flat(buffer) === flat(stored) ? 'shows the stored file' : 'DIFFERS from the stored file');
	const end = {
		keep: [
			stored === original && has.user(buffer) && editorDirty,
			`stored file ${stored === original ? 'unchanged' : 'CHANGED'}; ` +
				`editor ${has.user(buffer) ? 'holds' : 'LOST'} the unsaved line ` +
				`and is ${editorDirty ? 'still unsaved' : 'NOT marked unsaved'}`,
		],
		save: [
			has.user(stored) && has.agent(stored) && !editorDirty && flat(buffer) === flat(stored),
			`stored file ${has.user(stored) ? 'has' : 'LACKS'} the user line ` +
				`and ${has.agent(stored) ? 'has' : 'LACKS'} the agent heading; ${editorState()}`,
		],
		discard: [
			!has.user(stored) && has.agent(stored) && !editorDirty && flat(buffer) === flat(stored),
			`stored file ${has.user(stored) ? 'STILL HAS' : 'lacks'} the user line ` +
				`and ${has.agent(stored) ? 'has' : 'LACKS'} the agent heading; ${editorState()}`,
		],
	}[choice];
	run.check(`end-state-${choice}`, end[0], end[1]);
	return {
		choice,
		dialog,
		dialogs: dialogs.length,
		agentChanged,
		userKept,
		editorDirty,
		editorHeader,
		agentReply: run.scrub(lastBot(await engineView(run, 'reply', 1))).slice(0, 2000),
	};
}

/** A pipeline needs a Variable that does not exist: the turn should end as "needs you". */
async function needsYou(page, run) {
	await openApp(page, run);
	await newSession(page, run);
	await send(
		page,
		run,
		'Build a pipeline called verify-search that answers questions with GPT-5 using my key in ' +
			'ROCKETRIDE_VERIFY_MISSING_KEY, then run it once to show me it works.',
		'turn1'
	);
	let turn = await waitTurn(page, run, 'turn1');
	let turns = 1;
	const needsRow = page.getByText(/^Needs you/).first();
	while (turn.ended && turns < 3 && !(await needsRow.isVisible())) {
		turns += 1;
		await send(page, run, APPROVAL, `turn${turns}`);
		turn = await waitTurn(page, run, `turn${turns}`);
	}
	const messages = await engineView(run, 'final', turns);
	await transcript(page, run);
	const visible = await needsRow.isVisible();
	run.check(
		'needs-you-shown',
		visible,
		visible
			? 'a "Needs you" row names what is missing'
			: `no "Needs you" row after ${turns} turn(s); the only signal is the reply text`
	);
	return { turns, finalReply: run.scrub(lastBot(messages)).slice(0, 2000) };
}

/** During a running turn the user can stop it. */
async function stop(page, run) {
	await openApp(page, run);
	await newSession(page, run);
	await send(page, run, 'Build a pipeline called verify-stop that summarizes uploaded PDFs with GPT-5.', 'turn1');
	let stopFound = false;
	let stoppedQuickly = false;
	const turn = await waitTurn(page, run, 'turn1', async () => {
		const btn = page.getByRole('button', { name: /^(stop|cancel)\b/i }).first();
		try {
			await btn.waitFor({ timeout: 20_000 });
			stopFound = true;
			await run.shot(page, 'stop-visible');
			await btn.click();
			run.log('press Stop during the turn', 'clicked');
			await typingDots(page).waitFor({ state: 'detached', timeout: 30_000 });
			stoppedQuickly = true;
		} catch {
			run.log(
				'look for a Stop control during the turn',
				stopFound
					? 'clicked, but the turn kept running past 30s'
					: 'no Stop or Cancel button while the agent works'
			);
		}
	});
	await engineView(run, 'final', 1);
	await transcript(page, run);
	run.check(
		'stop-control',
		stopFound,
		stopFound ? 'a Stop control is shown while the agent works' : 'no Stop control while the agent works'
	);
	run.check(
		'stop-ends-turn',
		stoppedQuickly,
		stoppedQuickly ? 'the turn ended within 30s of Stop' : 'the turn did not end within 30s of Stop'
	);
	return { turnEnded: turn.ended };
}

/** Switching team mid-turn must not move the in-flight write. Needs two teams. */
async function teamSwitch(page, run) {
	const who = run.engine('whoami');
	fs.writeFileSync(path.join(run.dir, 'whoami.json'), who.out);
	let teams = [];
	try {
		teams = JSON.parse(who.out).teams;
	} catch {
		/* reported below */
	}
	run.check(
		'precondition-two-teams',
		teams.length >= 2,
		teams.length >= 2
			? `${teams.length} teams`
			: `the account has ${teams.length} team(s); the OSS engine has one ("local"). ` +
					'Run this journey against an engine with a two-team account.'
	);
	if (teams.length < 2) return { teams };
	await openApp(page, run);
	run.check(
		'automated',
		false,
		'two-team driving is not scripted yet; follow features/team-switch-and-stop.md by hand with the steps runner'
	);
	return { teams };
}

/**
 * Answers every "Unsaved changes" dialog that appears while it runs with one
 * button, saving each dialog's text, buttons and a screenshot.
 *
 * @returns `dialogs` (what was seen) and `stop()`, which resolves once the loop has ended.
 */
function answerChoiceDialogs(page, run, button, label) {
	const dialogs = [];
	let answering = true;
	const loop = (async () => {
		const d = page
			.getByRole('dialog')
			.filter({ hasText: /unsaved changes/i })
			.first();
		while (answering) {
			try {
				await d.waitFor({ timeout: 1_000 });
			} catch {
				continue;
			}
			const buttons = await d.getByRole('button').allInnerTexts();
			dialogs.push({ text: (await d.innerText()).slice(0, 500), buttons });
			await run.shot(page, `${label}-choice-dialog-${dialogs.length}`);
			await d.getByRole('button', { name: button }).click();
			run.log(
				`agent asked about unsaved changes (dialog ${dialogs.length})`,
				`chose ${button}; buttons: ${buttons.join(' | ')}`
			);
			await d.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
		}
	})();
	return {
		dialogs,
		stop: async () => {
			answering = false;
			await loop;
		},
	};
}

/** Explorer view, then the folders and file of a workspace path, then waits for the Monaco editor. */
async function openFile(page, run, file) {
	await showView(page, run, 'Explorer');
	// The tree rows have no role; scope the text match to the side panel. A folder already open stays open.
	const panel = page.getByRole('tabpanel');
	const parts = file.split('/');
	for (const [i, name] of parts.entries()) {
		const folderOpen = i < parts.length - 1 && (await panel.getByText(parts[i + 1], { exact: true }).count()) > 0;
		if (folderOpen) continue;
		await panel.getByText(name, { exact: true }).first().click();
		await page.waitForTimeout(500);
	}
	await page.locator('.monaco-editor').filter({ visible: true }).first().waitFor({ timeout: 60_000 });
	run.log(`open ${file} from the Explorer`, `clicked ${parts.join(', ')}`);
}

/** A steps file by path, or by name in this skill's steps/ (`closed-dirty-tab`). */
function stepsFile(arg) {
	if (!arg) throw new Error('steps needs a file: a path or a name in steps/');
	for (const f of [arg, path.join(SKILL, 'steps', arg), path.join(SKILL, 'steps', `${arg}.json`)])
		if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
	throw new Error(`no steps file ${arg} (looked in the current folder and ${path.join(SKILL, 'steps')})`);
}

/**
 * A steps-file argument: `fixtures/...` names a file in this skill's
 * steps/fixtures, so steps files work from any checkout.
 */
const stepsArg = (arg) =>
	typeof arg === 'string' && arg.startsWith('fixtures/') ? path.join(SKILL, 'steps', arg) : arg;

/** Generic steps runner: a JSON list of user actions, for journeys not scripted above. */
async function steps(page, run) {
	const file = stepsFile(argv[1]);
	const list = JSON.parse(fs.readFileSync(file, 'utf8'));
	const answered = [];
	for (const [i, s] of list.entries()) {
		const label = s.label || `step${i + 1}`;
		const by = (x) =>
			(x.css
				? page.locator(x.css).filter({ visible: true })
				: x.role
					? page.getByRole(x.role, { name: x.name, exact: x.exact ?? true })
					: x.placeholder
						? page.getByPlaceholder(x.placeholder)
						: x.label
							? page.getByLabel(x.label)
							: page.getByText(x.text, { exact: x.exact ?? true })
			).nth(x.nth ?? 0);
		switch (s.do) {
			case 'open':
				await openApp(page, run);
				break;
			case 'view':
				await showView(page, run, s.name);
				break;
			case 'openFile':
				await openFile(page, run, s.path);
				break;
			case 'newSession':
				await newSession(page, run);
				break;
			case 'send':
				await send(page, run, s.text, label);
				break;
			case 'waitTurn': {
				// With `answer`, every "Unsaved changes" dialog during the turn gets that button.
				let answering = null;
				const turn = await waitTurn(
					page,
					run,
					label,
					s.answer
						? async () => {
								answering = answerChoiceDialogs(page, run, s.answer, label);
							}
						: undefined
				);
				if (answering) await answering.stop();
				const dialogs = answering ? answering.dialogs : [];
				answered.push({ label, ended: turn.ended, dialogs });
				run.check(`${label}-ended`, turn.ended, turn.ended ? 'turn ended' : 'turn never ended');
				if (s.expectDialogs !== undefined) {
					run.check(
						`${label}-dialogs`,
						dialogs.length === s.expectDialogs,
						`${dialogs.length} "Unsaved changes" dialog(s) during the turn, expected ${s.expectDialogs}` +
							(dialogs[0] ? `; first: "${dialogs[0].text.replace(/\s+/g, ' ').slice(0, 160)}"` : '')
					);
				}
				break;
			}
			case 'click':
				await by(s).click();
				run.log(`click ${JSON.stringify(s)}`, 'done');
				break;
			case 'fill':
				await by(s).fill(s.value);
				run.log(`fill ${JSON.stringify({ ...s, value: undefined })}`, 'done');
				break;
			case 'press':
				await page.keyboard.press(s.key);
				run.log(`press ${s.key}`, 'done');
				break;
			case 'type':
				await page.keyboard.type(s.value);
				run.log('type text', `${s.value.length} chars`);
				break;
			case 'wait':
				await page.waitForTimeout(s.ms);
				run.log(`wait ${s.ms} ms`, 'done');
				break;
			case 'shot':
				await run.shot(page, label);
				break;
			case 'engine':
				run.log(
					`engine ${s.args.join(' ')}`,
					run
						.engine(...s.args.map(stepsArg))
						.out.trim()
						.slice(0, 500)
				);
				break;
			case 'expectText': {
				const ok = await page
					.getByText(s.text, { exact: false })
					.first()
					.isVisible()
					.catch(() => false);
				run.check(label, ok, ok ? `"${s.text}" is visible` : `"${s.text}" is not visible`);
				break;
			}
			case 'expectNoText': {
				const seen = await page.getByText(s.text, { exact: false }).filter({ visible: true }).count();
				run.check(
					label,
					seen === 0,
					seen === 0 ? `"${s.text}" is not visible` : `"${s.text}" is visible ${seen} time(s)`
				);
				break;
			}
			case 'expectEngine': {
				const out = run.engine(...s.args.map(stepsArg)).out;
				if (s.contains !== undefined)
					run.check(
						label,
						out.includes(s.contains),
						out.includes(s.contains)
							? `engine output contains "${s.contains}"`
							: `engine output lacks "${s.contains}"`
					);
				if (s.lacks !== undefined)
					run.check(
						`${label}-lacks`,
						!out.includes(s.lacks),
						out.includes(s.lacks)
							? `engine output still contains "${s.lacks}"`
							: `engine output lacks "${s.lacks}"`
					);
				break;
			}
			default:
				throw new Error(`unknown step: ${s.do}`);
		}
	}
	await transcript(page, run);
	return { steps: list.length, turns: answered };
}

const JOURNEYS = {
	'build-pipeline': buildPipeline,
	secrets,
	'unsaved-edits': unsavedEdits,
	'needs-you': needsYou,
	stop,
	'team-switch': teamSwitch,
	steps,
};

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

async function main() {
	const fn = JOURNEYS[journey];
	if (!fn) {
		console.error(`usage: drive.mjs ${Object.keys(JOURNEYS).join('|')} [flags]`);
		process.exit(2);
	}
	const run = new Run(journey === 'steps' ? `steps-${path.basename(argv[1] || 'unnamed', '.json')}` : journey);
	const reset = run.engine('reset');
	run.log(
		'baseline: clear workspace files and agent sessions on the rr-verify-agent engine',
		reset.ok ? 'cleared' : reset.out.trim()
	);
	run.log('engine', ENGINE ? ENGINE.summary : `no provenance in ${STATE_DIR}/engine.json`);
	const browser = await chromium.launch({ headless: !HEADED });
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	run.attach(page);
	let extra = {};
	try {
		extra = (await fn(page, run)) || {};
	} catch (err) {
		run.check('journey-ran', false, `${err && err.message ? err.message.split('\n')[0] : err}`);
		try {
			await run.shot(page, 'error');
		} catch {
			/* page gone */
		}
	} finally {
		await browser.close();
	}
	process.exit({ pass: 0, fail: 1, incomplete: 3 }[run.finish(extra)]);
}

main().catch((err) => {
	console.error(`drive: ${err && err.stack ? err.stack : err}`);
	process.exit(2);
});
