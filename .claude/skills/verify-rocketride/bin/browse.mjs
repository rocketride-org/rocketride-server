// browse.mjs: run a short browser script against a verification run and save the evidence.
//
// Run through `rr-verify browse`, which sets RR_VERIFY_DIR, RR_VERIFY_REPO, ROCKETRIDE_URI,
// ROCKETRIDE_APIKEY, ENGINE_MOCK, and DOCS_URI (after `rr-verify docs`) for the active run.
//
//   browse.mjs [--label F] [--site engine|docs] [--strict] [--ignore REGEX]... [--timeout MS]
//              [--max-seconds N] [--viewport WxH] [--trace] SCRIPT.mjs [ARGS...]
//
// SCRIPT.mjs exports a default async function that receives the helper API (see HELP below).
// Every run saves PNG screenshots, a webm video, and <time>-browse.json under
// .verify/<run-id>/<label>/. Exit codes: 0 = every step passed, 1 = a step failed,
// 2 = the run itself failed (bad script, no browser, nothing to connect to).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const BIN_DIR = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.resolve(BIN_DIR, '..', 'fixtures');
const SNAPSHOT_LINES = 80;
// The shell and the docs site read the repository's star count from GitHub, which rate-limits
// by IP and answers 403. That is not the product failing, so it never counts.
const DEFAULT_IGNORE = ['https://api\\.github\\.com/repos/rocketride-org/'];

const HELP = `Options:
  --label F        Evidence folder under .verify/<run-id>/ (default: browser).
  --site docs      Resolve paths against the docs server from \`rr-verify docs\`, not the engine.
  --strict         Fail the run on any console error or failed request.
  --ignore REGEX   Leave matching URLs and messages out of the checks. Repeat for more.
  --timeout MS     Timeout for each step (default: 15000).
  --max-seconds N  Stop the whole script after N seconds (default: 300).
  --viewport WxH   Size of the page and the video (default: 1280x800).
  --trace          Also save a Playwright trace as <time>-trace.zip.

Helper API passed to the script's default export:
  open(url, {status})        Go to a URL. A path is relative to the site. Fails on HTTP >= 400
                             unless {status} names the code you expect.
  click(target)              Click. target is a Playwright selector string, such as
  fill(target, text)           'role=button[name="Sign In"]', 'text=Connected', or CSS,
  press(key, target?)          or a Locator from page.
  hover(target)  upload(target, files)  select(target, value)
  waitText(text, {timeout, exact})      Wait until the text is visible.
  waitFor(target, {state, timeout})     Wait for an element: visible (default), hidden, attached.
  expectNoText(text)         Fail if the text is visible now.
  count(target)  text(target)  attr(target, name)   Read state; each is recorded as a step.
  check(description, value)  Fail unless value (or the awaited function value) is truthy.
  shot(name, {target, fullPage})        Save <time>-<name>.png.
  snapshot(name, {target})   Print the accessibility tree and save <time>-<name>.aria.yml.
  signIn(key?)               Sign in to the shell with the run's API key.
  pipeline(file)             Start a .pipe through the TypeScript SDK. Returns {token, publicToken}.
                             It is terminated when the run ends.
  expectNoErrors()           Fail if any console error or failed request was seen so far.
  ignore(regex)              Leave matching console errors and requests out of the checks.
  step(name, fn)  note(text)  page  context  args  fixtures  env
`;

function usage(message) {
	if (message) process.stderr.write(`browse: ${message}\n`);
	// --help is an answer, so it goes to stdout and exits 0; a usage error goes to stderr.
	const stream = message ? process.stderr : process.stdout;
	stream.write('usage: rr-verify browse [--label F] [--site engine|docs] [--strict] [--ignore REGEX]... [--timeout MS]\n' + '                        [--max-seconds N] [--viewport WxH] [--trace] SCRIPT.mjs [ARGS...]\n\n' + HELP);
	process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
	const opts = { label: 'browser', site: 'engine', strict: false, ignore: [], timeout: 15000, maxSeconds: 300, viewport: '1280x800', trace: false, script: '', args: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const value = () => {
			if (i + 1 >= argv.length) usage(`${a} needs a value`);
			return argv[++i];
		};
		if (opts.script) {
			opts.args.push(a);
		} else if (a === '--label') opts.label = value();
		else if (a === '--site') opts.site = value();
		else if (a === '--strict') opts.strict = true;
		else if (a === '--ignore') opts.ignore.push(value());
		else if (a === '--timeout') opts.timeout = Number(value());
		else if (a === '--max-seconds') opts.maxSeconds = Number(value());
		else if (a === '--viewport') opts.viewport = value();
		else if (a === '--trace') opts.trace = true;
		else if (a === '-h' || a === '--help') usage();
		else if (a === '--') continue;
		else if (a.startsWith('--')) usage(`unknown option ${a}`);
		else opts.script = a;
	}
	if (!opts.script) usage('SCRIPT is required');
	if (!['engine', 'docs'].includes(opts.site)) usage('--site must be engine or docs');
	if (!/^\d+x\d+$/.test(opts.viewport)) usage('--viewport must look like 1280x800');
	return opts;
}

function stampOf(date) {
	const pad = (n, w = 2) => String(n).padStart(w, '0');
	return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function firstLines(text, n = 3) {
	return String(text ?? '')
		.split('\n')
		.map((l) => l.trimEnd())
		.filter(Boolean)
		.slice(0, n)
		.join(' | ');
}

function safeName(name) {
	return (
		String(name)
			.replace(/[^A-Za-z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'shot'
	);
}

class StepFailure extends Error {}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const started = new Date();
	const stamp = stampOf(started);
	const runDir = process.env.RR_VERIFY_DIR;
	if (!runDir) usage('RR_VERIFY_DIR is not set; run this through rr-verify browse');
	const featureDir = path.join(runDir, opts.label);
	fs.mkdirSync(featureDir, { recursive: true });
	const jsonPath = path.join(featureDir, `${stamp}-browse.json`);
	const scriptPath = path.resolve(opts.script);
	const [width, height] = opts.viewport.split('x').map(Number);

	const engineUri = process.env.ROCKETRIDE_URI || '';
	const docsUri = process.env.DOCS_URI || '';
	const baseURL = opts.site === 'docs' ? docsUri : engineUri;

	const record = {
		feature: opts.label,
		mode: 'browse',
		script: scriptPath,
		args: opts.args,
		site: opts.site,
		url: baseURL,
		engine: engineUri,
		mock: process.env.ENGINE_MOCK === '1',
		steps: [],
		console_errors: [],
		failed_requests: [],
		ignored: { patterns: [...opts.ignore], console_errors: [], failed_requests: [] },
		screenshots: [],
		video: [],
		trace: null,
		ok: false,
		verdict: '',
		seconds: 0,
	};

	const consoleSeen = [];
	const requestsSeen = [];
	const ignorePatterns = [...DEFAULT_IGNORE, ...opts.ignore].map((p) => new RegExp(p));
	const isIgnored = (text) => ignorePatterns.some((re) => re.test(text));
	const consoleKey = (e) => `${e.text} ${e.url}`;
	const requestKey = (r) => `${r.method} ${r.url} ${r.status ?? ''} ${r.error ?? ''}`;
	const activeConsole = () => consoleSeen.filter((e) => !isIgnored(consoleKey(e)));
	const activeRequests = () => requestsSeen.filter((r) => !isIgnored(requestKey(r)));

	// A reader that stops early (`| head`) must not end the run before the evidence is saved.
	let stdoutOpen = true;
	process.stdout.on('error', () => {
		stdoutOpen = false;
	});
	process.stderr.on('error', () => {});
	const out = (line) => {
		if (stdoutOpen) process.stdout.write(`${line}\n`);
	};
	const shots = new Map();
	const sdkClients = [];
	const pipelines = [];
	let server = null;
	let browser = null;
	let context = null;
	let page = null;
	let procFile = null;
	let fatal = null;
	let exitCode = 0;

	const writeRecord = () => {
		record.console_errors = activeConsole();
		record.failed_requests = activeRequests();
		record.ignored.patterns = ignorePatterns.map((re) => re.source);
		record.ignored.console_errors = consoleSeen.filter((e) => isIgnored(consoleKey(e)));
		record.ignored.failed_requests = requestsSeen.filter((r) => isIgnored(requestKey(r)));
		record.seconds = Math.round((Date.now() - started.getTime()) / 10) / 100;
		fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2));
	};

	const shotPath = (name) => {
		const base = safeName(name);
		const n = (shots.get(base) ?? 0) + 1;
		shots.set(base, n);
		return path.join(featureDir, `${stamp}-${base}${n > 1 ? `-${n}` : ''}.png`);
	};

	// Signals: close the browser and keep the evidence instead of leaving Chromium behind.
	let stopping = false;
	const onSignal = async (signal) => {
		if (stopping) return;
		stopping = true;
		record.verdict = `interrupted by ${signal}`;
		try {
			writeRecord();
		} catch {
			// The record is best effort when the run is being stopped.
		}
		try {
			if (server) await server.kill();
		} catch {
			// Chromium may already be gone.
		}
		if (procFile) fs.rmSync(procFile, { force: true });
		process.exit(signal === 'SIGINT' ? 130 : 143);
	};
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => onSignal(signal));

	const fail = (message) => {
		fatal = message;
		exitCode = 2;
	};

	if (!baseURL) {
		fail(opts.site === 'docs' ? 'no docs server for this run; start one with: rr-verify docs' : 'ROCKETRIDE_URI is not set; launch a run first');
	} else if (!scriptPath.endsWith('.mjs')) {
		fail(`the script must be an ES module ending in .mjs: ${scriptPath}`);
	} else if (!fs.existsSync(scriptPath)) {
		fail(`script not found: ${scriptPath}`);
	}

	let playwright = null;
	if (!fatal) {
		try {
			playwright = require('playwright');
		} catch {
			fail('the playwright package is missing. Run: pnpm install --frozen-lockfile');
		}
	}

	let scriptFn = null;
	if (!fatal) {
		try {
			const mod = await import(pathToFileURL(scriptPath).href);
			scriptFn = mod.default;
			if (typeof scriptFn !== 'function') fail(`${scriptPath} must export a default async function`);
		} catch (e) {
			fail(`could not load ${scriptPath}: ${firstLines(e.message)}`);
		}
	}

	const videoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-verify-video-'));
	const pages = [];

	if (!fatal) {
		try {
			server = await playwright.chromium.launchServer({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
			// Chromium runs in its own process group. Record it so `rr-verify stop` can end it
			// even if this process is killed first.
			const procDir = path.join(runDir, 'browsers');
			fs.mkdirSync(procDir, { recursive: true });
			procFile = path.join(procDir, `${process.pid}.env`);
			fs.writeFileSync(procFile, `BROWSE_PID=${process.pid}\nBROWSER_PID=${server.process().pid}\nFEATURE=${opts.label}\nSCRIPT=${scriptPath}\n`);
			browser = await playwright.chromium.connect(server.wsEndpoint());
			context = await browser.newContext({ baseURL, viewport: { width, height }, recordVideo: { dir: videoTmp, size: { width, height } } });
			context.setDefaultTimeout(opts.timeout);
			context.setDefaultNavigationTimeout(Math.max(opts.timeout, 30000));
			context.on('page', (p) => pages.push(p));
			context.on('console', (msg) => {
				if (msg.type() !== 'error') return;
				const loc = msg.location();
				consoleSeen.push({ type: 'console', text: msg.text().slice(0, 2000), url: loc?.url ?? '', page: msg.page()?.url() ?? '' });
			});
			context.on('weberror', (err) => {
				const e = err.error();
				consoleSeen.push({ type: 'pageerror', text: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`.slice(0, 2000), url: '', page: err.page()?.url() ?? '' });
			});
			context.on('requestfailed', (req) => {
				requestsSeen.push({ method: req.method(), url: req.url(), status: null, error: req.failure()?.errorText ?? 'failed', resource: req.resourceType() });
			});
			context.on('response', (res) => {
				if (res.status() >= 400) {
					const req = res.request();
					requestsSeen.push({ method: req.method(), url: res.url(), status: res.status(), error: null, resource: req.resourceType() });
				}
			});
			if (opts.trace) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
			page = await context.newPage();
		} catch (e) {
			fail(`could not start Chromium: ${firstLines(e.message)}. If the browser is missing, run: pnpm exec playwright install chromium`);
		}
	}

	// ---- helper API --------------------------------------------------------------------------

	const describe = (target) => {
		if (target === undefined || target === null) return '';
		if (typeof target === 'string') return target;
		if (target instanceof RegExp) return String(target);
		return typeof target.toString === 'function' ? target.toString() : String(target);
	};
	const loc = (target) => (typeof target === 'string' ? page.locator(target) : target);

	const runStep = async (action, target, fn) => {
		const entry = { n: record.steps.length + 1, action, target: describe(target), ok: false };
		record.steps.push(entry);
		const t0 = Date.now();
		try {
			const { value, detail } = (await fn()) ?? {};
			entry.ok = true;
			if (detail !== undefined) entry.detail = detail;
			entry.seconds = Math.round((Date.now() - t0) / 10) / 100;
			out(`ok   ${entry.n} ${action}${entry.target ? ` ${entry.target}` : ''}${detail !== undefined ? ` -> ${detail}` : ''}`);
			return value;
		} catch (e) {
			entry.seconds = Math.round((Date.now() - t0) / 10) / 100;
			entry.error = e instanceof StepFailure ? e.message : firstLines(e.message, 4);
			out(`FAIL ${entry.n} ${action}${entry.target ? ` ${entry.target}` : ''}: ${entry.error}`);
			throw new StepFailure(`step ${entry.n} ${action}${entry.target ? ` ${entry.target}` : ''}: ${entry.error}`);
		}
	};

	const errorSummary = () => {
		const c = activeConsole();
		const r = activeRequests();
		if (!c.length && !r.length) return null;
		const first = c.length ? `console: ${c[0].text}` : `request: ${r[0].method} ${r[0].url} ${r[0].status ?? r[0].error}`;
		return `${c.length} console error(s), ${r.length} failed request(s); first ${first}`;
	};

	const api = {
		page,
		context,
		args: opts.args,
		fixtures: FIXTURES,
		env: { engine: engineUri, docs: docsUri, site: baseURL, apiKey: process.env.ROCKETRIDE_APIKEY || '', mock: record.mock, runDir, featureDir },
		open: (url, { status } = {}) =>
			runStep('open', url, async () => {
				const res = await page.goto(url, { waitUntil: 'load' });
				const code = res ? res.status() : null;
				if (status !== undefined && code !== status) throw new StepFailure(`HTTP ${code}, expected ${status}`);
				// An error status the script asked for is not a failed request.
				if (status !== undefined && res) ignorePatterns.push(new RegExp(`(^|\\s)${res.url().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`));
				if (status === undefined && code !== null && code >= 400) throw new StepFailure(`HTTP ${code}`);
				return { value: res, detail: code === null ? 'no response' : `HTTP ${code}` };
			}),
		click: (target, options) => runStep('click', target, async () => void (await loc(target).click(options))),
		fill: (target, text) => runStep('fill', target, async () => ({ detail: JSON.stringify(String(text).slice(0, 80)), value: await loc(target).fill(String(text)) })),
		press: (key, target) =>
			runStep('press', target ? `${key} in ${describe(target)}` : key, async () => {
				if (target) await loc(target).press(key);
				else await page.keyboard.press(key);
			}),
		hover: (target) => runStep('hover', target, async () => void (await loc(target).hover())),
		upload: (target, files) =>
			runStep('upload', target, async () => ({
				detail: []
					.concat(files)
					.map((f) => path.basename(f))
					.join(', '),
				value: await loc(target).setInputFiles(files),
			})),
		select: (target, value) => runStep('select', target, async () => ({ detail: JSON.stringify(value), value: await loc(target).selectOption(value) })),
		waitText: (text, { timeout, exact } = {}) =>
			runStep('waitText', JSON.stringify(String(text)), async () => {
				await page.getByText(text, { exact: !!exact }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout });
			}),
		waitFor: (target, { state = 'visible', timeout } = {}) =>
			runStep('waitFor', target, async () => {
				// visible and hidden ask about visible matches, so a hidden copy (another tab) does not count.
				const l = state === 'visible' || state === 'hidden' ? loc(target).filter({ visible: true }) : loc(target);
				await l.first().waitFor({ state, timeout });
				return { detail: state };
			}),
		expectNoText: (text, { exact } = {}) =>
			runStep('expectNoText', JSON.stringify(String(text)), async () => {
				const n = await page.getByText(text, { exact: !!exact }).filter({ visible: true }).count();
				if (n > 0) throw new StepFailure(`the text is visible (${n} match(es))`);
			}),
		count: (target) =>
			runStep('count', target, async () => {
				const n = await loc(target).count();
				return { value: n, detail: String(n) };
			}),
		text: (target) =>
			runStep('text', target, async () => {
				const t = await loc(target).first().innerText();
				return { value: t, detail: JSON.stringify(t.slice(0, 120)) };
			}),
		attr: (target, name) =>
			runStep('attr', `${describe(target)} @${name}`, async () => {
				const v = await loc(target).first().getAttribute(name);
				return { value: v, detail: JSON.stringify(v === null ? null : String(v).slice(0, 120)) };
			}),
		check: (description, value) =>
			runStep('check', description, async () => {
				const v = typeof value === 'function' ? await value() : value;
				if (!v) throw new StepFailure(`not true (got ${JSON.stringify(v)})`);
				return { value: v, detail: typeof v === 'boolean' ? undefined : JSON.stringify(v).slice(0, 120) };
			}),
		shot: (name, { target, fullPage } = {}) =>
			runStep('shot', name, async () => {
				const file = shotPath(name);
				if (target) await loc(target).first().screenshot({ path: file });
				else await page.screenshot({ path: file, fullPage: !!fullPage });
				record.screenshots.push(file);
				return { value: file, detail: path.basename(file) };
			}),
		snapshot: (name = 'page', { target } = {}) =>
			runStep('snapshot', name, async () => {
				const tree = await (target ? loc(target).first() : page.locator('body')).ariaSnapshot();
				const file = path.join(featureDir, `${stamp}-${safeName(name)}.aria.yml`);
				fs.writeFileSync(file, `${tree}\n`);
				const lines = tree.split('\n');
				out(
					lines
						.slice(0, SNAPSHOT_LINES)
						.map((l) => `     | ${l}`)
						.join('\n')
				);
				if (lines.length > SNAPSHOT_LINES) out(`     | ... ${lines.length - SNAPSHOT_LINES} more line(s) in ${file}`);
				return { value: tree, detail: path.basename(file) };
			}),
		signIn: (key) =>
			runStep('signIn', 'shell', async () => {
				const signOut = page.getByRole('button', { name: 'Sign Out', exact: true });
				if (await signOut.isVisible()) return { detail: 'already signed in' };
				await page.getByRole('button', { name: 'Sign In', exact: true }).click();
				await page.getByRole('textbox', { name: 'API key' }).fill(key ?? (process.env.ROCKETRIDE_APIKEY || ''));
				await page.getByRole('button', { name: 'Connect', exact: true }).click();
				await signOut.waitFor({ state: 'visible' });
				return { detail: 'Sign Out is visible' };
			}),
		pipeline: (file) =>
			runStep('pipeline', file, async () => {
				const sdk = require(path.join(process.env.RR_VERIFY_REPO || '', 'packages/client-typescript/dist/cjs/client/index.js'));
				const client = new sdk.RocketRideClient({ uri: engineUri, auth: process.env.ROCKETRIDE_APIKEY });
				sdkClients.push(client);
				await client.connect();
				const started = await client.use({ filepath: path.resolve(file) });
				pipelines.push({ client, token: started.token });
				return { value: started, detail: `token ${started.token}` };
			}),
		expectNoErrors: () =>
			runStep('expectNoErrors', '', async () => {
				const summary = errorSummary();
				if (summary) throw new StepFailure(summary);
				return { detail: 'no console errors or failed requests' };
			}),
		ignore: (pattern) => {
			ignorePatterns.push(pattern instanceof RegExp ? pattern : new RegExp(pattern));
		},
		step: (name, fn) =>
			runStep('step', name, async () => {
				const value = await fn();
				return { value, detail: value === undefined ? undefined : JSON.stringify(value)?.slice(0, 160) };
			}),
		note: (text) => runStep('note', String(text), async () => undefined),
	};

	// ---- run the script ----------------------------------------------------------------------

	let failure = null;
	if (!fatal) {
		let timer = null;
		const deadline = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new StepFailure(`the script ran longer than ${opts.maxSeconds}s (--max-seconds)`)), opts.maxSeconds * 1000);
		});
		try {
			await Promise.race([scriptFn(api), deadline]);
			if (opts.strict) await api.expectNoErrors();
		} catch (e) {
			failure = e instanceof StepFailure ? e.message : `the script threw: ${firstLines(e.stack || e.message, 4)}`;
		} finally {
			clearTimeout(timer);
		}
		if (!failure && record.steps.some((s) => !s.ok)) failure = 'a step failed (the script caught the error)';
	}

	// ---- cleanup: final screenshot, pipelines, trace, video ------------------------------------

	if (page && !page.isClosed()) {
		try {
			const file = shotPath(failure ? 'failure' : 'final');
			await page.screenshot({ path: file, timeout: 10000 });
			record.screenshots.push(file);
		} catch {
			// A page that cannot be captured still has its video.
		}
	}
	for (const { client, token } of pipelines) {
		const entry = { n: record.steps.length + 1, action: 'terminate', target: token, ok: true };
		try {
			await client.terminate(token);
		} catch (e) {
			entry.ok = false;
			entry.error = firstLines(e.message);
			failure = failure ?? `could not terminate pipeline ${token}: ${entry.error}`;
		}
		record.steps.push(entry);
		out(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.n} terminate ${token}${entry.ok ? '' : `: ${entry.error}`}`);
	}
	for (const client of sdkClients) {
		try {
			await client.disconnect();
		} catch {
			// Disconnect errors do not change what the user saw.
		}
	}
	if (context) {
		if (opts.trace) {
			try {
				const file = path.join(featureDir, `${stamp}-trace.zip`);
				await context.tracing.stop({ path: file });
				record.trace = file;
			} catch {
				// Keep going without the trace.
			}
		}
		try {
			await context.close();
			for (const [i, p] of pages.entries()) {
				const video = p.video();
				if (!video) continue;
				const file = path.join(featureDir, `${stamp}-video${i ? `-${i + 1}` : ''}.webm`);
				await video.saveAs(file);
				record.video.push(file);
			}
		} catch (e) {
			out(`warn could not save the video: ${firstLines(e.message)}`);
		}
	}
	try {
		if (browser) await browser.close();
		if (server) await server.close();
	} catch {
		if (server) await server.kill().catch(() => {});
	}
	if (procFile) fs.rmSync(procFile, { force: true });
	fs.rmSync(videoTmp, { recursive: true, force: true });

	// ---- report --------------------------------------------------------------------------------

	if (fatal) {
		record.ok = false;
		record.verdict = `run failed: ${fatal}`;
	} else if (failure) {
		record.ok = false;
		record.verdict = failure;
		exitCode = 1;
	} else {
		record.ok = true;
		record.verdict = `${record.steps.length} step(s) passed`;
	}
	writeRecord();

	const c = record.console_errors;
	const r = record.failed_requests;
	const ignoredCount = record.ignored.console_errors.length + record.ignored.failed_requests.length;
	out(`console errors: ${c.length}  failed requests: ${r.length}${ignoredCount ? `  (ignored: ${ignoredCount})` : ''}`);
	for (const e of c.slice(0, 5)) out(`  console: ${e.text.slice(0, 200)}${e.url ? ` (${e.url})` : ''}`);
	for (const e of r.slice(0, 5)) out(`  request: ${e.method} ${e.url} ${e.status ?? e.error}`);
	for (const file of record.screenshots) out(`screenshot: ${file}`);
	for (const file of record.video) out(`video: ${file}`);
	if (record.trace) out(`trace: ${record.trace}`);
	out(`${record.ok ? 'PASS' : 'FAIL'}: ${record.verdict}`);
	process.stderr.write(`saved: ${jsonPath}\n`);
	process.exit(exitCode);
}

main().catch((e) => {
	process.stderr.write(`browse: ${e.stack || e.message}\n`);
	process.exit(2);
});
