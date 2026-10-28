#!/usr/bin/env node
// Drives the Agent tab of Rocket Builder in a real browser and records proof.
// Run `rr-verify-agent launch` and `rr-verify-agent doctor` first, or use
// `rr-verify-agent run`, which does both and cleans up.
//
//   node drive.mjs build-pipeline [--prompt "..."] [--max-followups 4]
//   node drive.mjs secrets
//   node drive.mjs unsaved-edits [--choice save|discard|keep]
//   node drive.mjs needs-you
//   node drive.mjs foreign-terminate
//   node drive.mjs step-cap
//   node drive.mjs undo
//   node drive.mjs stop
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
// The secrets journey's pasted and mid-run messages, before and after their key is replaced.
const PASTE_TEXT = (key) => `My Anthropic key is ${key}. Keep it in mind for later; there is nothing else to do now.`;
const MIDRUN_TEXT = (key) => `Also, my OpenAI key for later is ${key}. Nothing to do with it now.`;
// The note the chat adds when a key is sent while a turn runs (#2836).
const REMOVED_NOTE = /I removed a key \(.+\) from your message, so it was not sent/;
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
// Whether the chat can save sessions on this engine: saves send fs_put_json, which the published image lacks.
const SAVES = ENGINE?.capabilities?.fsPutJson !== false;
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
		// "Needs your OK" cards the journey did not plan for, and how each was answered (answerCard).
		this.cards = [];
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
		if (!SAVES) {
			const why =
				`not verifiable on this engine: it has no fs_put_json (${ENGINE.capabilities.detail}), ` +
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
				// #2836's file marker, «secret:<8 hex>», raw or JSON-escaped.
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
			...(this.cards.length ? { unplannedCards: this.cards } : {}),
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

/** Whether visible text holds `text` (a string or a RegExp). */
const textShown = (page, text) =>
	page
		.getByText(text)
		.filter({ visible: true })
		.first()
		.isVisible()
		.catch(() => false);

// A "Needs your OK" card waiting in the running turn (the shell's AskCard).
const askCard = (page) => page.getByRole('group', { name: 'Needs your OK' }).filter({ visible: true }).first();
// The line an approval card for a pipeline run ends with when this conversation started the run (#2869).
const OWN_RUN = 'This conversation started it.';

/** A "Needs your OK" card the journey does not expect. answerCard has already recorded the failed check. */
class UnexpectedCard extends Error {}

/**
 * Answers a "Needs your OK" card the journey has no plan for. A card for an
 * action on a run this conversation started gets Approve: the agent may stop
 * or restart its own run, and Ask first still asks. Any other card gets Deny,
 * a failed check that names it, and the journey stops there, so no turn waits
 * out the timeout on a card. Journeys about approvals (foreign-terminate)
 * answer their own cards first, through waitTurn's onRunning.
 *
 * @returns Whether a card was answered.
 */
async function answerCard(page, run, label) {
	const card = askCard(page);
	if (!(await card.isVisible().catch(() => false))) return false;
	const text = ((await card.innerText().catch(() => '')) || '').trim().replace(/\n/g, ' | ');
	if (!text) return false;
	const base = await run.shot(page, `${label}-card`);
	if (text.includes(OWN_RUN)) {
		await card.getByRole('button', { name: 'Approve', exact: true }).click();
		run.cards.push({ turn: label, text, answer: 'approve', shot: base });
		run.log('answer an unplanned card', `Approve, since it is for the agent's own run: "${text}"`);
		return true;
	}
	await card
		.getByRole('button', { name: 'Deny', exact: true })
		.click()
		.catch(() => {});
	run.cards.push({ turn: label, text, answer: 'deny', shot: base });
	const why = `the ${label} turn showed a "Needs your OK" card this journey does not expect: "${text}"`;
	run.check('no-unexpected-card', false, `${why}. Denied it and stopped the journey`);
	throw new UnexpectedCard(why);
}

/**
 * Waits for the agent's turn to end: the typing dots appear, then go away.
 * While it runs, a "Needs your OK" card left unanswered goes to answerCard.
 */
async function waitTurn(page, run, label, onRunning) {
	const dots = typingDots(page);
	try {
		await dots.waitFor({ state: 'visible', timeout: 15_000 });
	} catch {
		/* a very fast turn */
	}
	if (onRunning) await onRunning();
	const t0 = Date.now();
	for (;;) {
		if (await answerCard(page, run, label)) continue;
		if (!(await dots.isVisible().catch(() => false))) break;
		if (Date.now() - t0 > TURN_MS) {
			run.log(`wait for the ${label} turn`, `still running after ${TURN_MS / 60000} min`);
			await run.shot(page, `${label}-timeout`);
			return { ended: false, ms: Date.now() - t0 };
		}
		await page.waitForTimeout(500);
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
		if (messages.filter((m) => m.sender === 'bot').length >= expectBots && sessionCount(dir) >= minSessions) break;
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

/** How many agent session files an engine snapshot holds (catalog.json is the index, not a session). */
function sessionCount(dir) {
	const sdir = path.join(dir, 'sessions', APP_ID);
	return fs.existsSync(sdir) ? fs.readdirSync(sdir).filter((f) => /^[0-9a-f-]{36}\.json$/i.test(f)).length : 0;
}

/** Frame numbers for a check's detail. */
const frames = (hits) =>
	hits
		.slice(0, 5)
		.map((h) => `#${h.frame ?? h}`)
		.join(', ');

/**
 * A fake key inline in a .pipe must never reach the model, and the model must
 * see a «secret:…» marker in its place (#2836). Then a fake key pasted into
 * the composer must be blocked before the model, and a fake key sent while a
 * turn runs must reach the model only with the key replaced. The user's rows
 * show both keys as [redacted], so the page holds neither.
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
	// Before switching sessions: the thinking rows open, so the DOM holds what they show.
	const thinking = await openThinking(page);
	await run.shot(page, 'turn1-thinking-open');
	const turn1Dom = await page.content();
	fs.writeFileSync(path.join(run.dir, 'dom-turn1.html'), run.scrub(turn1Dom));
	const turn1Sent = run.sent.length;

	// Part 2: a key pasted into the composer, as the first message of a new session.
	await newSession(page, run);
	await send(page, run, PASTE_TEXT(run.pasted), 'paste');
	const pasteTurn = await waitTurn(page, run, 'paste');
	const blocked = await textShown(page, /looks like it contains a key/i);
	const pasteDom = await page.content();
	fs.writeFileSync(path.join(run.dir, 'dom-paste.html'), run.scrub(pasteDom));
	const pastedRow = await textShown(page, PASTE_TEXT('[redacted]'));

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
	const midrunBlocked = await textShown(page, /looks like it contains a key/i);
	const midrunDom = await page.content();
	fs.writeFileSync(path.join(run.dir, 'dom-midrun.html'), run.scrub(midrunDom));
	const midrunRow = await textShown(page, MIDRUN_TEXT('[redacted]'));
	const midrunNote = await textShown(page, REMOVED_NOTE);
	run.log(
		'send a key while the turn runs',
		midrunSent
			? midrunBlocked
				? 'sent; it opened its own turn and was blocked like a request'
				: 'sent while the turn ran'
			: 'the turn ended before the send'
	);
	const messages = await engineView(run, 'final', 1);
	await transcript(page, run);

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
	// The marker shows the agent read the file, so a missing key is not a pass on nothing.
	const markers = run.markerFrames.filter((n) => n < turn1Sent);
	run.check(
		'inline-key-marked',
		run.canaryHits.length === 0 && markers.length > 0,
		[
			run.canaryHits.length
				? `the fake key left the page in ${run.canaryHits.length} frame(s): ${frames(run.canaryHits)}`
				: `the fake key is absent from all ${run.sent.length} frames the page sent`,
			markers.length
				? `a «secret:…» marker stands in for it in ${markers.length} turn 1 frame(s): ${frames(markers)}`
				: `no turn 1 frame of the ${turn1Sent} holds a «secret:…» marker`,
		].join('; ')
	);
	// The read's row among the open ones shows the DOM was read with the thinking unfolded.
	const readShown = thinking.text.includes('verify-secret.pipe');
	const keyShown = turn1Dom.includes(run.canary);
	run.check(
		'inline-key-not-shown',
		readShown && !keyShown,
		[
			readShown
				? `${thinking.groups} thinking group(s) open, the read of the file among them`
				: `no open thinking row names the file (${thinking.groups} group(s) opened)`,
			keyShown
				? 'the fake key is in the page DOM after turn 1'
				: 'the fake key is absent from the page DOM after turn 1',
		].join('; ')
	);
	run.check(
		'pasted-blocked',
		blocked && run.pastedHits.length === 0,
		[
			blocked
				? 'an error row says the message looks like it contains a key'
				: 'no error row about the pasted key',
			run.pastedHits.length
				? `the pasted key left the page in ${run.pastedHits.length} frame(s): ${frames(run.pastedHits)}`
				: 'the pasted key is absent from every frame',
		].join('; ')
	);
	const pastedInDom = pasteDom.includes(run.pasted);
	run.check(
		'pasted-row-redacted',
		pastedRow && !pastedInDom,
		[
			pastedRow
				? "the user's row reads the message with [redacted]"
				: 'no user row reads the message with [redacted]',
			pastedInDom ? 'the pasted key is in the page DOM' : 'the pasted key is absent from the page DOM',
		].join('; ')
	);
	// Heard shows the mid-run path ran, so a missing key is not a pass on a message that opened its own turn.
	run.check(
		'midrun-heard',
		midrunSent && run.heardFrames.length > 0 && run.midrunHits.length === 0,
		!midrunSent
			? 'the turn ended before the mid-run send'
			: [
					run.heardFrames.length
						? `the model got the message with its key replaced in frame(s) ${frames(run.heardFrames)}`
						: midrunBlocked
							? 'the message opened its own turn, so the mid-run path did not run'
							: 'no frame holds the mid-run message as the model gets it',
					run.midrunHits.length
						? `the mid-run key left the page in frame(s) ${frames(run.midrunHits)}`
						: 'the mid-run key is absent from every frame',
				].join('; ')
	);
	const midrunInDom = midrunDom.includes(run.midrun);
	run.check(
		'midrun-row-redacted',
		midrunSent && midrunRow && midrunNote && !midrunInDom,
		!midrunSent
			? 'the turn ended before the mid-run send'
			: [
					midrunRow
						? "the user's row reads the message with [redacted]"
						: 'no user row reads the message with [redacted]',
					midrunNote ? 'a note says the key was removed and not sent' : 'no note that the key was removed',
					midrunInDom ? 'the mid-run key is in the page DOM' : 'the mid-run key is absent from the page DOM',
				].join('; ')
	);
	return {
		canaryShape: 'sk-ant-api03-RRVERIFY<32 hex>',
		pastedShape: 'sk-ant-api03-RRVERIFYPASTE<32 hex>',
		midrunShape: 'sk-ant-api03-RRVERIFYMIDRUN<32 hex>',
		midrunSent,
		midrunBlocked,
		finalReply: run.scrub(lastBot(messages)).slice(0, 2000),
	};
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
	await openFile(page, run, file);
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
	const choice = flag('choice', 'keep');
	const button = { save: 'Save mine first', discard: 'Discard mine', keep: 'Keep mine' }[choice];
	if (!button) throw new Error(`--choice must be save, discard or keep (got ${choice})`);
	let answering = null;
	const turn = await waitTurn(page, run, 'turn1', async () => {
		answering = answerChoiceDialogs(page, run, button, 'turn1');
	});
	await answering?.stop();
	const dialogs = answering?.dialogs ?? [];
	const dialog = dialogs[0] ?? null;
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
		editorDirty,
		editorHeader,
		agentReply: run.scrub(lastBot(await engineView(run, 'reply', 1))).slice(0, 2000),
	};
}

/** A turn's result card under its bot row, by its title ("Needs you", "Done"). */
const resultCard = (page, title) =>
	page.getByRole('group', { name: `Turn result: ${title}` }).filter({ visible: true });

/**
 * The label of each visible editor tab. The tabs have no ARIA role; each is a
 * div in DocTabs' `rr-doctabs-scroll` strip whose label is a direct child span.
 */
const editorTabLabels = (page) => page.locator('.rr-doctabs-scroll > div > span').filter({ visible: true });

/** The newest agent session file in an engine snapshot, parsed whole, or null. */
function newestSessionFile(dir) {
	const sdir = path.join(dir, 'sessions', APP_ID);
	if (!fs.existsSync(sdir)) return null;
	const files = fs
		.readdirSync(sdir)
		.filter((f) => /^[0-9a-f-]{36}\.json$/i.test(f))
		.map((f) => path.join(sdir, f));
	files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	try {
		return files.length ? JSON.parse(fs.readFileSync(files[0], 'utf8')) : null;
	} catch {
		return null;
	}
}

/**
 * Waits while a turn runs, calling `each` every half second, until the
 * typing dots are gone or `each` returns true.
 */
async function whileRunning(page, each) {
	const dots = typingDots(page);
	const t0 = Date.now();
	while (Date.now() - t0 < TURN_MS) {
		if (await each()) return;
		if (!(await dots.isVisible())) return;
		await page.waitForTimeout(500);
	}
}

/**
 * A pipeline needs a Variable that does not exist (#2869). The turn ends as
 * needs-you with a card that names the Variable and opens Variables. The
 * user's next message answers the request, and the saved session (version 2)
 * keeps the card, so a reload shows it again.
 */
async function needsYou(page, run) {
	const variable = 'ROCKETRIDE_VERIFY_MISSING_KEY';
	const prompt =
		'Build a pipeline called verify-search that answers questions with GPT-5 using my key in ' +
		`${variable}, then run it once to show me it works.`;
	await openApp(page, run);
	await newSession(page, run);
	await send(page, run, prompt, 'turn1');
	let turn = await waitTurn(page, run, 'turn1');
	let turns = 1;
	const card = () => resultCard(page, 'Needs you').last();
	while (turn.ended && turns < 3 && !(await card().isVisible())) {
		turns += 1;
		await send(page, run, APPROVAL, `turn${turns}`);
		turn = await waitTurn(page, run, `turn${turns}`);
	}
	const shown = await card().isVisible();
	run.check(
		'needs-you-card',
		shown,
		shown ? `a "Needs you" card ended turn ${turns}` : `no "Needs you" card after ${turns} turn(s)`
	);
	if (!shown) {
		await transcript(page, run);
		return { turns };
	}
	const cardText = (await card().innerText()).trim();
	run.log('read the card', cardText.replace(/\n/g, ' | '));
	await run.shot(page, 'needs-you-card');
	const openVariables = card().getByRole('button', { name: 'Open Variables' });
	const offers = await openVariables.isVisible();
	run.check(
		'card-names-variable',
		offers && cardText.includes(variable),
		`card text "${cardText.replace(/\n/g, ' | ')}"; Open Variables ${offers ? 'shown' : 'missing'}`
	);
	if (offers) {
		await openVariables.click();
		const overlay = page.getByRole('dialog', { name: 'environment' });
		let opened = false;
		try {
			await overlay.waitFor({ timeout: 10_000 });
			opened = true;
		} catch {
			/* reported below */
		}
		await run.shot(page, 'variables-overlay');
		run.check(
			'open-variables',
			opened,
			opened ? 'Open Variables opened the Variables overlay' : 'no Variables overlay after Open Variables'
		);
		if (opened) {
			await overlay.getByRole('button', { name: 'Close' }).click();
			await overlay.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
		}
	}

	// The reply answers the request: the model reads "(answering request <id>)",
	// and the saved turn says which turn answered it.
	const framesBefore = run.sent.length;
	turns += 1;
	await send(page, run, "I can't add that key right now. Skip the run and tell me what you built.", `turn${turns}`);
	turn = await waitTurn(page, run, `turn${turns}`);
	let file = null;
	const dir = path.join(run.dir, 'engine-after-reply');
	for (let i = 0; i < 10; i++) {
		fs.rmSync(dir, { recursive: true, force: true });
		run.engine('snapshot', dir);
		file = newestSessionFile(dir);
		const asked = (file?.turns || []).filter((t) => t.outcome === 'needs_input').at(-1);
		if (asked?.request?.answeredBy) break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	const asked = (file?.turns || []).filter((t) => t.outcome === 'needs_input').at(-1);
	const note = asked?.request ? `(answering request ${asked.request.id})` : '';
	const noteSent = !!note && run.sent.slice(framesBefore).some((f) => f.text.includes(note));
	run.checkSaved(
		'reply-answers-request',
		!!asked?.request?.answeredBy && noteSent,
		asked
			? `request ${asked.request?.id} (${asked.request?.kind}) ` +
					`answeredBy ${asked.request?.answeredBy ?? 'nobody'}; ` +
					`the next question ${noteSent ? 'carried' : 'lacked'} "${note}"`
			: 'no needs_input turn in the saved session'
	);

	// A file link on the card opens the file in its editor. The model decides whether the turn wrote one.
	const link = card()
		.getByRole('button', { name: /^pipelines\// })
		.first();
	if (await link.isVisible().catch(() => false)) {
		const linked = ((await link.innerText()) || '').trim();
		const name = linked.split('/').pop();
		const stem = name.replace(/\.pipe$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		// Only the editor tab strip's labels count, so the file's name in the model's answer cannot.
		const tabs = () =>
			editorTabLabels(page)
				.filter({ hasText: new RegExp(`^${stem}(\\.pipe)?$`) })
				.count();
		const before = await tabs();
		await link.click();
		await page.waitForTimeout(3000);
		const opened = await tabs();
		await run.shot(page, 'file-link-opened');
		run.check(
			'file-link-opens',
			opened > before,
			`clicked ${linked} on the card: ${before} editor tab(s) named "${name}" before and ${opened} after`
		);
	} else run.log('file link', 'the card has no pipeline file link, so none was clicked');

	// A reload reads the session file again; the card comes back from it.
	// With no saved session there is nothing to reopen.
	if (!SAVES) {
		run.checkSaved('card-after-reload', false, 'no reload: the chat could not save the session');
		await transcript(page, run);
		return { turns, card: cardText, request: asked?.request ?? null };
	}
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page
		.locator('input[aria-label="API key"], [role="tab"][aria-label="Agent"]')
		.first()
		.waitFor({ timeout: LOAD_MS });
	if (await page.getByPlaceholder('API key').isVisible()) await submitApiKey(page, run, 'reload');
	await showView(page, run, 'Agent');
	if (
		!(await card()
			.isVisible()
			.catch(() => false))
	) {
		await page.locator(`[role="button"][title^="Build a pipeline called verify-search"]`).first().click();
		run.log('reopen the session from the Agent sidebar', 'clicked its row');
	}
	let again = false;
	try {
		await card().waitFor({ timeout: 30_000 });
		again = true;
	} catch {
		/* reported below */
	}
	await run.shot(page, 'after-reload');
	const after = again ? (await card().innerText()).trim() : '';
	run.checkSaved(
		'card-after-reload',
		again && after.includes(variable),
		again
			? `after the reload the card reads "${after.replace(/\n/g, ' | ')}"`
			: 'no "Needs you" card after the reload'
	);
	await transcript(page, run);
	return {
		turns,
		card: cardText,
		request: asked?.request ?? null,
		finalReply: run.scrub(lastBot(file?.messages || [])).slice(0, 2000),
	};
}

/**
 * A pipeline run the agent did not start (#2869). The journey starts it
 * through the engine, as another tab would. In Ask mode the agent's
 * terminate shows a "Needs your OK" card that says this conversation did not
 * start the run, and Deny leaves it running. In Auto mode, in a new session,
 * the agent's terminate is refused with no card, and the run still runs.
 * The run's status is read from the engine after each, since the card or the
 * refusal can show while the terminate still runs.
 */
async function foreignTerminate(page, run) {
	const seeded = run.engine(
		'write',
		'pipelines/verify-foreign.pipe',
		path.join(SKILL, 'steps/fixtures/foreign-run.pipe')
	);
	run.log('precondition: seed pipelines/verify-foreign.pipe', seeded.ok ? 'written' : seeded.out.trim());
	/** Starts the run through the engine, as another tab would; '' when it could not, with why. */
	const start = () => {
		const started = run.engine('start', 'pipelines/verify-foreign.pipe', 'verify-foreign');
		try {
			return { token: JSON.parse(started.out).token || '', out: started.out };
		} catch {
			return { token: '', out: started.out };
		}
	};
	let { token, out } = start();
	run.check(
		'precondition-foreign-run',
		!!token,
		token ? `run ${token.slice(0, 11)}… started outside the agent` : `could not start it: ${out.trim()}`
	);
	if (!token) return {};
	const status = () => {
		try {
			return JSON.parse(run.engine('status', token).out);
		} catch {
			return { gone: true };
		}
	};
	const alive = () => {
		const st = status();
		return !st.gone && !st.completed;
	};
	const mode = page
		.getByRole('button', { name: /^(Ask first|Don't ask)/ })
		.filter({ visible: true })
		.first();
	const ask = page.getByRole('group', { name: 'Needs your OK' }).filter({ visible: true }).first();
	const request = () => `Stop the pipeline run with token ${token}. I started it from another tab.`;
	let cardText = '';
	let sawCardInAuto = false;
	let refusal = '';
	try {
		await openApp(page, run);
		await newSession(page, run);
		const before = (await mode.innerText()).trim();
		run.check('starts-in-ask', before.startsWith('Ask first'), `the mode switch reads "${before}"`);

		// Ask mode: the card asks, whoever started the run, and says this conversation did not.
		await send(page, run, request(), 'ask-turn');
		await waitTurn(page, run, 'ask-turn', () =>
			whileRunning(page, async () => {
				if (!(await ask.isVisible())) return false;
				cardText = (await ask.innerText()).trim();
				await run.shot(page, 'ask-card');
				await ask.getByRole('button', { name: 'Deny' }).click();
				run.log('answer the card', `Deny; it read "${cardText.replace(/\n/g, ' | ')}"`);
				return true;
			})
		);
		run.check(
			'ask-card-says-foreign',
			cardText.includes('Stop the pipeline run') && cardText.includes('This conversation did not start it.'),
			cardText ? `card text "${cardText.replace(/\n/g, ' | ')}"` : 'no card in Ask mode'
		);
		run.check('denied-run-alive', alive(), `after Deny the run's status is ${JSON.stringify(status())}`);
		// Auto's checks need a run that still goes.
		if (!alive()) {
			({ token, out } = start());
			run.log(
				'precondition: start the foreign run again for Auto',
				token ? `run ${token.slice(0, 11)}…` : out.trim()
			);
		}

		// Auto mode: no card, the call is refused, and the model is told to ask the user.
		await mode.click();
		await page.waitForTimeout(500);
		const now = (await mode.innerText()).trim();
		run.check('switched-to-auto', now.startsWith("Don't ask"), `the mode switch reads "${now}"`);
		await newSession(page, run);
		await send(page, run, request(), 'auto-turn');
		await waitTurn(page, run, 'auto-turn', () =>
			whileRunning(page, async () => {
				if (await ask.isVisible()) sawCardInAuto = true;
				return false;
			})
		);
		const thinking = await openThinking(page);
		await run.shot(page, 'auto-thinking');
		refusal = (thinking.text.match(/[^\n]*did not start the pipeline run[^\n]*/) || [''])[0];
		run.check(
			'auto-refused',
			!!refusal && !sawCardInAuto,
			(sawCardInAuto ? 'a card showed in Auto; ' : '') +
				(refusal ? `refusal: "${refusal.slice(0, 300)}"` : 'no refusal in the thinking rows')
		);
		run.check('auto-run-alive', alive(), `after the Auto turn the run's status is ${JSON.stringify(status())}`);
	} finally {
		// back to Ask, so later journeys start where they expect, and stop the run
		try {
			if ((await mode.innerText()).trim().startsWith("Don't ask")) await mode.click();
		} catch {
			/* the page is gone */
		}
		run.log('cleanup: stop the foreign run', run.engine('terminate', token).out.trim());
	}
	await transcript(page, run);
	const messages = await engineView(run, 'final', 2, 2);
	return {
		token: `${token.slice(0, 11)}…`,
		card: cardText,
		refusal: refusal.slice(0, 500),
		finalReply: run.scrub(lastBot(messages)).slice(0, 2000),
	};
}

/**
 * Answers every "Unsaved changes" dialog that appears while it runs with one
 * button, saving each dialog's text, buttons and a screenshot. An agent that
 * asks again after Keep mine would otherwise leave the turn waiting.
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
			page
				.locator(x.css)
				.filter({ visible: true })
				.nth(x.nth ?? 0);
		switch (s.do) {
			case 'open':
				await openApp(page, run);
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
				break;
			}
			case 'click':
				await by(s).click();
				run.log(`click ${JSON.stringify(s)}`, 'done');
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
			case 'expectEditors': {
				const texts = (
					await page.locator('.monaco-editor .view-lines').filter({ visible: true }).allInnerTexts()
				).map((t) => t.replace(/\u00a0/g, ' '));
				const showing =
					s.contains === undefined ? texts.length : texts.filter((t) => t.includes(s.contains)).length;
				const unsaved = s.clean ? await page.getByText('●').filter({ visible: true }).count() : 0;
				const problems = [
					s.count !== undefined && texts.length !== s.count
						? `${texts.length} visible editor(s), not ${s.count}`
						: '',
					texts.length ? '' : 'no visible editor',
					showing < texts.length ? `${showing} of ${texts.length} editor(s) show "${s.contains}"` : '',
					unsaved ? `● (unsaved) is visible ${unsaved} time(s)` : '',
				].filter(Boolean);
				run.check(
					label,
					!problems.length,
					problems.join('; ') ||
						`${texts.length} visible editor(s)` +
							(s.contains === undefined ? '' : `, each shows "${s.contains}"`) +
							(s.clean ? ', none marked unsaved' : '')
				);
				break;
			}
			case 'expectEngine': {
				const out = run.engine(...s.args.map(stepsArg)).out;
				run.check(
					label,
					out.includes(s.contains),
					out.includes(s.contains)
						? `engine output contains "${s.contains}"`
						: `engine output lacks "${s.contains}"`
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

// -----------------------------------------------------------------------------
// limits and Undo (#2873)
// -----------------------------------------------------------------------------

/** The bot row meta line with the turn's estimated cost ("~$0.42 est., not counting thinking"). */
const COST_META = /^(~\$\d+\.\d\d|<\$0\.01) est\., not counting thinking$/;

/**
 * Sets the Agent Step Limit in the shell's Settings, the way a user does: the
 * sidebar footer's menu, Settings, a search, the number field, then Save (the
 * page keeps a draft until Save). '' resets it to its default.
 *
 * @returns The value the field shows after Save.
 */
async function setStepLimit(page, run, value) {
	await page.locator('[role="button"][aria-haspopup="menu"]').filter({ visible: true }).first().click();
	await page.getByText('Settings', { exact: true }).filter({ visible: true }).last().click();
	const overlay = page.getByRole('dialog', { name: 'settings' });
	await overlay.waitFor({ timeout: 10_000 });
	await overlay.getByPlaceholder('Search settings').fill('Step Limit');
	// the row reads "Rocket Builder: Agent Step Limit", the name in its own element
	await overlay
		.getByText(/Agent Step Limit/)
		.first()
		.waitFor({ timeout: 10_000 });
	const field = overlay.locator('input[type="number"]').filter({ visible: true }).first();
	await field.fill(String(value));
	await overlay.getByRole('button', { name: 'Save', exact: true }).click();
	await page.waitForTimeout(500);
	const shown = await field.inputValue();
	await run.shot(page, `step-limit-${value === '' ? 'reset' : value}`);
	await overlay.getByRole('button', { name: 'Close' }).click();
	await overlay.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
	run.log(
		`Settings: Agent Step Limit ${value === '' ? 'reset to its default' : `set to ${value}`}`,
		`the field shows "${shown}"`
	);
	return shown;
}

/** The Agent view with a conversation's tab in front: its row in the Agent sidebar, by the start of its title. */
async function showSession(page, run, title) {
	await showView(page, run, 'Agent');
	await page.locator(`[role="button"][title^="${title}"]`).first().click();
	await composer(page).waitFor({ timeout: 30_000 });
	run.log(`bring the conversation "${title}…" to the front`, 'clicked its row in the Agent sidebar');
}

/** The newest saved session and its turns, read back through the engine, waiting for `n` turns. */
async function savedTurns(run, label, n) {
	const dir = path.join(run.dir, `engine-${label}`);
	let file = null;
	for (let i = 0; i < 15; i++) {
		fs.rmSync(dir, { recursive: true, force: true });
		run.engine('snapshot', dir);
		file = newestSessionFile(dir);
		if ((file?.turns || []).length >= n) break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return file;
}

/**
 * The step limit (#2873). With the Agent Step Limit at 2 in Settings, a task
 * that follows a chain of notes needs more steps. The turn pauses with a
 * "Paused after 2 steps" card and Continue, after a best-effort answer. Continue
 * starts a new turn with a fresh budget of 2 steps, which answers the request
 * and pauses again while notes remain. The row shows the turn's estimated cost.
 */
async function stepCap(page, run) {
	// the engine reader writes under pipelines/, apps/ or nodes/; a note under pipelines/ needs no check
	const chain = [
		'pipelines/chain/start.md',
		'pipelines/chain/q7x.md',
		'pipelines/chain/m3k.md',
		'pipelines/chain/z9p.md',
		'pipelines/chain/w2b.md',
	];
	const fixtures = path.join(run.dir, 'fixtures');
	fs.mkdirSync(fixtures, { recursive: true });
	for (const [i, note] of chain.entries()) {
		const next = chain[i + 1];
		const last = next ? `Next: read ${next}` : 'This is the last note.';
		const text = `# Note ${i + 1}\n\nNumber: ${(i + 1) * 7}\n\n${last}\n`;
		const local = path.join(fixtures, path.basename(note));
		fs.writeFileSync(local, text);
		const seeded = run.engine('write', note, local);
		if (!seeded.ok) throw new Error(`could not seed ${note}: ${seeded.out}`);
	}
	run.log('precondition: seed a chain of 5 notes under pipelines/chain/', 'written through the engine');
	await openApp(page, run);
	const set = await setStepLimit(page, run, 2);
	run.check('limit-set', set === '2', `the Agent Step Limit field shows "${set}"`);
	try {
		await newSession(page, run);
		await send(
			page,
			run,
			'Follow the chain of notes that starts at pipelines/chain/start.md. Each note names the next one, ' +
				'so read them one at a time, in order. Then tell me the sum of the numbers in all of them.',
			'turn1'
		);
		await waitTurn(page, run, 'turn1');
		const paused = resultCard(page, 'Paused after 2 steps').last();
		const shown = await paused.isVisible();
		const cardText = shown ? (await paused.innerText()).trim() : '';
		await run.shot(page, 'paused-card');
		const cont = paused.getByRole('button', { name: 'Continue', exact: true });
		const offers = shown && (await cont.isVisible());
		run.check(
			'paused-card',
			shown && offers,
			shown
				? `card "${cardText.replace(/\n/g, ' | ')}"; Continue ${offers ? 'shown' : 'missing'}`
				: 'no "Paused after 2 steps" card'
		);
		const meta = await page.getByText(COST_META).filter({ visible: true }).allInnerTexts();
		run.check(
			'cost-shown',
			meta.length > 0,
			meta.length ? `the row's meta line reads "${meta.at(-1)}"` : 'no "~$… est., not counting thinking" line'
		);
		const first = await savedTurns(run, 'turn1', 1);
		const t1 = (first?.turns || []).at(-1);
		run.checkSaved(
			'saved-limited',
			t1?.outcome === 'needs_input' &&
				t1?.reason === 'limited' &&
				t1?.usage?.waves === 2 &&
				t1?.request?.kind === 'continue' &&
				t1?.usage?.cost?.estimated === true,
			t1
				? `turn 1: outcome ${t1.outcome}, reason ${t1.reason}, waves ${t1.usage?.waves}, ` +
						`request ${t1.request?.kind} "${t1.request?.question}", cost ${JSON.stringify(t1.usage?.cost)}`
				: 'no turn in the saved session'
		);
		if (!offers) return { card: cardText };

		// Continue: a new turn with a fresh budget, which answers the request
		const framesBefore = run.sent.length;
		await cont.click();
		run.log('press Continue', 'clicked');
		await waitTurn(page, run, 'turn2');
		const second = await savedTurns(run, 'turn2', 2);
		const turns = second?.turns || [];
		const [a, b] = [turns.at(-2), turns.at(-1)];
		const note = a?.request ? `(answering request ${a.request.id})` : '';
		const noteSent = !!note && run.sent.slice(framesBefore).some((f) => f.text.includes(note));
		const answeredBy = a?.request?.answeredBy === b?.turnId ? 'turn 2' : (a?.request?.answeredBy ?? 'nobody');
		// The fresh budget is 2 steps again. Until a question carries the last note, work
		// remains, so turn 2 pauses at 2 steps too.
		const lastRead = run.sent.some((f) => f.text.includes('This is the last note.'));
		const pausedAgain = b?.reason === 'limited' && b.usage?.waves === 2 && b.request?.kind === 'continue';
		run.checkSaved(
			'continue-fresh-budget',
			!!b &&
				b.turnId !== a?.turnId &&
				b.usage?.waves <= 2 &&
				(pausedAgain || (b.reason !== 'limited' && lastRead)) &&
				a?.request?.answeredBy === b.turnId &&
				noteSent,
			b
				? `turn 2: outcome ${b.outcome}, reason ${b.reason}, waves ${b.usage?.waves} of 2, ` +
						`request ${b.request?.kind ?? 'none'}; ` +
						`the last note ${lastRead ? 'was read' : 'was not read yet'}; ` +
						`turn 1's request answeredBy ${answeredBy}; ` +
						`the next question ${noteSent ? 'carried' : 'lacked'} "${note}"`
				: 'no second turn in the saved session'
		);
		await transcript(page, run);
		return {
			card: cardText,
			turn1: t1 ? { reason: t1.reason, waves: t1.usage?.waves, cost: t1.usage?.cost } : null,
			turn2: b ? { outcome: b.outcome, reason: b.reason, waves: b.usage?.waves } : null,
			finalReply: run.scrub(lastBot(second?.messages || [])).slice(0, 2000),
		};
	} finally {
		// back to the default, so later journeys run with it
		try {
			await setStepLimit(page, run, '');
		} catch (err) {
			run.log('cleanup: reset the Agent Step Limit', `failed: ${err.message}`);
		}
	}
}

/**
 * Undo (#2873). The agent changes a note, and the turn's card offers Undo.
 * Undo puts the note back as it was, says so in a row, and the button goes.
 * The next turn's question carries that row, and the agent changes the note
 * again. With the note typed into in an editor, Undo on that turn refuses and
 * names it, and the note keeps the agent's change. (An editor stays unsaved
 * after Ctrl+Z, and closing its tab keeps the text, so the refusal comes last.)
 */
async function undoJourney(page, run) {
	const file = 'pipelines/undo-me.md';
	const title = `In ${file}, change the heading`;
	const original = '# Original heading\n\nThis line stays as it is.\n';
	const local = path.join(run.dir, 'undo-me.md');
	fs.writeFileSync(local, original);
	const seeded = run.engine('write', file, local);
	run.log(`precondition: seed ${file}`, seeded.ok ? 'written through the engine' : seeded.out.trim());
	if (!seeded.ok) throw new Error('could not seed the fixture');
	const stored = () => run.engine('cat', file).out;
	const undoOn = () => resultCard(page, 'Done').last().getByRole('button', { name: 'Undo', exact: true });
	await openApp(page, run);
	await newSession(page, run);
	await send(page, run, `${title} line to "# Changed by the agent". Change nothing else.`, 'turn1');
	await waitTurn(page, run, 'turn1');
	const changed = stored();
	run.check(
		'agent-changed',
		changed === '# Changed by the agent\n\nThis line stays as it is.\n',
		`the stored note reads ${JSON.stringify(changed.slice(0, 200))}`
	);
	const offered = (await undoOn().isVisible()) && (await undoOn().isEnabled());
	await run.shot(page, 'done-card');
	run.check(
		'undo-offered',
		offered,
		offered ? 'the "Done" card has an enabled Undo button' : 'no enabled Undo on a "Done" card'
	);
	if (!offered) {
		await transcript(page, run);
		return {};
	}

	// Undo with no editor open: the note is back, the row says so, and the button goes
	await undoOn().click();
	run.log('press Undo', 'clicked');
	const doneText =
		'Undo: the user reversed the file changes of the turn before, ' +
		`so these files are back as they were before it: ${file}.`;
	let undone = false;
	try {
		await page.getByText(doneText).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
		undone = true;
	} catch {
		/* reported below */
	}
	await run.shot(page, 'undone');
	const back = stored();
	run.check(
		'undone',
		undone && back === original,
		`${undone ? 'the chat says' : 'no row saying'} "${doneText}"; the stored note ` +
			(back === original ? 'is the original again' : `reads ${JSON.stringify(back.slice(0, 200))}`)
	);
	const gone = !(await undoOn()
		.isVisible()
		.catch(() => false));
	run.check('undo-gone', gone, gone ? 'the card has no Undo after it ran (one level)' : 'Undo is still on the card');

	// The next turn reads the row, and changes the note again
	const framesBefore = run.sent.length;
	await send(
		page,
		run,
		`Read ${file}. What is its heading now? ` +
			'Then change the heading line to "# Changed again". Change nothing else.',
		'turn2'
	);
	await waitTurn(page, run, 'turn2');
	const read = run.sent
		.slice(framesBefore)
		.some((f) => f.text.includes('Undo: the user reversed the file changes of the turn before'));
	run.check(
		'model-reads-undo',
		read,
		read ? 'a frame sent to the model after the Undo carries its row' : 'no frame after the Undo carries its row'
	);
	const again = stored();
	const offeredAgain = (await undoOn().isVisible()) && (await undoOn().isEnabled());
	run.check(
		'changed-again',
		again.startsWith('# Changed again') && offeredAgain,
		`the stored note reads ${JSON.stringify(again.slice(0, 200))}; ` +
			`Undo ${offeredAgain ? 'is offered' : 'is not offered'} on turn 2's card`
	);

	// An editor with unsaved typing on the note: Undo refuses, names it, and changes nothing
	await openFile(page, run, file);
	await page.locator('.monaco-editor .view-lines').filter({ visible: true }).first().click();
	await page.keyboard.press('Control+End');
	await page.keyboard.type(' typing');
	await run.shot(page, 'editor-dirty');
	run.log(`type in ${file} without saving`, 'added " typing"');
	await showSession(page, run, title);
	await undoOn().click();
	const refusal = `Undo refused, nothing was changed: ${file} has unsaved changes in an editor.`;
	let refused = false;
	try {
		await page.getByText(refusal).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
		refused = true;
	} catch {
		/* reported below */
	}
	await run.shot(page, 'undo-refused');
	const kept = stored();
	run.check(
		'dirty-refused',
		refused && kept === again,
		`${refused ? 'the chat says' : 'no row saying'} "${refusal}"; the stored note ` +
			(kept === again ? "still has the agent's second change" : `changed: ${JSON.stringify(kept.slice(0, 200))}`)
	);

	const saved = await savedTurns(run, 'final', 2);
	const row = (saved?.messages || []).find((m) => m.sender === 'system' && m.text === doneText);
	run.checkSaved(
		'row-saved',
		!!row,
		row ? `the saved session keeps the Undo row (id ${row.id})` : 'the saved session has no Undo row'
	);
	await transcript(page, run);
	return { finalReply: run.scrub(lastBot(saved?.messages || [])).slice(0, 2000) };
}

/**
 * Stop during a turn (#2869). The turn ends at once with a "Stopped" card,
 * and the saved session records it as stopped, linked to the chat's stop row.
 */
async function stopJourney(page, run) {
	await openApp(page, run);
	await newSession(page, run);
	await send(page, run, 'Build a pipeline called verify-stop that summarizes uploaded PDFs with GPT-5.', 'turn1');
	let pressed = false;
	const turn = await waitTurn(page, run, 'turn1', async () => {
		try {
			await page
				.getByRole('button', { name: 'Stop', exact: true })
				.filter({ visible: true })
				.first()
				.click({ timeout: 20_000 });
			pressed = true;
			run.log('press Stop during the turn', 'clicked');
		} catch {
			run.log('look for Stop during the turn', 'no Stop button while the agent works');
		}
	});
	run.check(
		'stop-ends-turn',
		pressed && turn.ended && turn.ms < 30_000,
		!pressed
			? 'no Stop button while the agent works'
			: turn.ended
				? `the turn ended ${Math.round(turn.ms / 1000)}s after Stop`
				: 'the turn kept running after Stop'
	);
	const card = resultCard(page, 'Stopped').last();
	let shown = false;
	try {
		await card.waitFor({ timeout: 30_000 });
		shown = true;
	} catch {
		/* reported below */
	}
	await run.shot(page, 'stopped-card');
	run.check('stopped-card', shown, shown ? 'a "Stopped" card ended the turn' : 'no "Stopped" card after Stop');
	const saved = await savedTurns(run, 'final', 1);
	const t = (saved?.turns || []).at(-1);
	const row = (saved?.messages || []).find((m) => m.id === t?.messageId);
	run.checkSaved(
		'stopped-saved',
		t?.outcome === 'stopped' && row?.sender === 'bot' && row.text.startsWith('Stopped by you.'),
		t
			? `the saved turn's outcome is ${t.outcome}, linked to row ${t.messageId}: ` +
					JSON.stringify((row?.text ?? 'no such row').slice(0, 80))
			: 'no turn in the saved session'
	);
	await transcript(page, run);
	return { stoppedAfterMs: turn.ms };
}

const JOURNEYS = {
	'build-pipeline': buildPipeline,
	secrets,
	'unsaved-edits': unsavedEdits,
	'needs-you': needsYou,
	'foreign-terminate': foreignTerminate,
	'step-cap': stepCap,
	undo: undoJourney,
	stop: stopJourney,
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
		// answerCard recorded its own check for an unexpected card
		if (!(err instanceof UnexpectedCard))
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
