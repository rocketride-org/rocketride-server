// vscode.mjs: run VS Code with the RocketRide extension from this checkout, drive it the way a
// user does, and save evidence. Call it through `rr-verify vscode <command>`, which loads the
// run's engine.env (ROCKETRIDE_URI, ROCKETRIDE_APIKEY, RR_VERIFY_DIR, ...).
//
// VS Code runs detached with its own user data, extensions, and HOME under
// .verify/<run-id>/vscode-profile/, so it never reads or writes the user's VS Code profile or
// ~/.config/RocketRide. Every step attaches over the Chrome DevTools protocol, records a webm
// video and PNG screenshots, and writes a JSON record under .verify/<run-id>/<feature>/.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = execFileSync('git', ['-C', SKILL_DIR, 'rev-parse', '--show-toplevel']).toString().trim();
const requireRepo = createRequire(path.join(REPO, 'package.json'));
const VSCODE_VERSION = process.env.RR_VERIFY_VSCODE_VERSION || '1.143.1';
const CACHE = process.env.RR_VERIFY_VSCODE_CACHE || path.join(REPO, '.verify', 'vscode-cache');
const SYSROOT = path.join(CACHE, 'sysroot');
const EXT_BUILD = path.join(REPO, 'build', 'vscode');
const SCREEN = { width: 1440, height: 900 };
// Libraries the VS Code build links against that a server install often lacks. Their own
// dependencies are resolved with apt-cache; Debian and older Ubuntu name them without t64.
const ROOT_PACKAGES = ['libcups2t64', 'libgtk-3-0t64', 'libcairo2', 'libpango-1.0-0', 'libpangocairo-1.0-0'];
// Sources the extension build is made from; a newer file means build/vscode is stale.
const EXT_SOURCES = ['apps/vscode/src', 'apps/vscode/package.json', 'apps/shared/src', 'packages/client-typescript/src'];

const RUN_DIR = process.env.RR_VERIFY_DIR || '';
const VS_DIR = RUN_DIR && path.join(RUN_DIR, 'vscode-profile');
const VS_ENV = VS_DIR && path.join(VS_DIR, 'vscode.env');
const VS_STATE = VS_DIR && path.join(VS_DIR, 'state.json');

class StepFailure extends Error {}

function die(message, code = 2) {
	console.error(`rr-verify vscode: ${message}`);
	process.exit(code);
}

function stamp(date = new Date()) {
	const pad = (n, w = 2) => String(n).padStart(w, '0');
	return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(fn, timeout, interval = 300) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() > deadline) return null;
		await sleep(interval);
	}
}

// ---------------------------------------------------------------------------
// Setup: the VS Code build and the libraries it needs, both under .verify/vscode-cache
// ---------------------------------------------------------------------------

function libraryEnv() {
	const libDir = path.join(SYSROOT, 'usr', 'lib', 'x86_64-linux-gnu');
	if (!fs.existsSync(libDir)) return {};
	return { LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
}

function missingLibraries(exe) {
	const out = execFileSync('ldd', [exe], { env: { ...process.env, ...libraryEnv() } }).toString();
	return out
		.split('\n')
		.filter((line) => line.includes('not found'))
		.map((line) => line.trim().split(' ')[0]);
}

function aptCandidate(name) {
	try {
		const out = execFileSync('apt-cache', ['policy', name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
		return /Candidate: (?!\(none\))/.test(out);
	} catch {
		return false;
	}
}

function installedPackage(name) {
	try {
		return execFileSync('dpkg-query', ['-W', '-f=${db:Status-Status}', name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString() === 'installed';
	} catch {
		return false;
	}
}

// apt-get download and dpkg -x need no root: the packages are unpacked into the cache, and
// launch points LD_LIBRARY_PATH at them.
function installLibraries(exe) {
	const roots = ROOT_PACKAGES.map((name) => (aptCandidate(name) ? name : name.replace(/t64$/, ''))).filter(aptCandidate);
	const tree = execFileSync('apt-cache', ['depends', '--recurse', '--no-recommends', '--no-suggests', '--no-conflicts', '--no-breaks', '--no-replaces', '--no-enhances', ...roots]).toString();
	const wanted = [...new Set(tree.split('\n').filter((line) => /^lib[\w.+-]+$/.test(line)))].filter((name) => !installedPackage(name));
	const debs = path.join(CACHE, 'debs');
	fs.mkdirSync(debs, { recursive: true });
	console.error(`setup: downloading ${wanted.length} library packages with apt-get download`);
	execFileSync('apt-get', ['download', ...wanted], { cwd: debs, stdio: ['ignore', 'ignore', 'inherit'] });
	for (const deb of fs.readdirSync(debs).filter((f) => f.endsWith('.deb'))) {
		execFileSync('dpkg', ['-x', path.join(debs, deb), SYSROOT]);
	}
	const still = missingLibraries(exe);
	if (still.length) die(`VS Code still misses ${still.join(', ')} after unpacking ${debs}`);
}

async function setup() {
	fs.mkdirSync(CACHE, { recursive: true });
	const { downloadAndUnzipVSCode, SilentReporter } = createRequire(path.join(REPO, 'apps', 'vscode', 'package.json'))('@vscode/test-electron');
	// Progress is worth printing only for the one real download.
	const cached = fs.existsSync(path.join(CACHE, `vscode-linux-x64-${VSCODE_VERSION}`));
	const exe = await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: CACHE, ...(cached ? { reporter: new SilentReporter() } : {}) });
	const missing = missingLibraries(exe);
	if (missing.length) {
		console.error(`setup: VS Code needs ${missing.join(', ')}`);
		installLibraries(exe);
	}
	// page.screencast needs Playwright's ffmpeg; this is a no-op when it is already installed.
	execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'playwright', 'cli.js'), 'install', 'ffmpeg'], { stdio: ['ignore', 'ignore', 'inherit'] });
	return exe;
}

// ---------------------------------------------------------------------------
// Launch, close, doctor
// ---------------------------------------------------------------------------

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function readEnvFile(file) {
	if (!file || !fs.existsSync(file)) return null;
	const env = {};
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const at = line.indexOf('=');
		if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
	}
	return env;
}

function tail(file, lines) {
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n') : '';
}

function signal(pid, sig) {
	try {
		process.kill(pid, sig);
	} catch {
		// It already exited.
	}
}

function groupAlive(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

function readState() {
	try {
		return JSON.parse(fs.readFileSync(VS_STATE, 'utf8'));
	} catch {
		return {};
	}
}

function writeState(update) {
	fs.writeFileSync(VS_STATE, JSON.stringify({ ...readState(), ...update }, null, '\t'));
}

function userSettings() {
	return {
		// Point the extension at this run's engine before it starts. With no host URL it fetches
		// /client/shell from http://localhost:5565 at startup, which may be another engine.
		'rocketride.development.connectionMode': 'onprem',
		'rocketride.development.hostUrl': process.env.ROCKETRIDE_URI,
		'rocketride.integrations.autoAgentIntegration': false,
		'chat.disableAIFeatures': true,
		'workbench.startupEditor': 'none',
		'workbench.tips.enabled': false,
		'workbench.enableExperiments': false,
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'update.mode': 'none',
		'telemetry.telemetryLevel': 'off',
		'extensions.autoCheckUpdates': false,
		'extensions.autoUpdate': false,
		'extensions.ignoreRecommendations': true,
		'security.workspace.trust.enabled': false,
		'git.enabled': false,
		'github.gitAuthentication': false,
		'window.newWindowDimensions': 'maximized',
		'window.restoreWindows': 'none',
	};
}

async function launch() {
	const running = readEnvFile(VS_ENV);
	if (running && groupAlive(Number(running.VSCODE_PID))) die(`VS Code is already running for this run (pid ${running.VSCODE_PID}). Run rr-verify vscode close first`);
	if (!fs.existsSync(path.join(EXT_BUILD, 'rocketride.js'))) die('the extension is not built. Run: ./builder vscode:build');
	try {
		const res = await fetch(`${process.env.ROCKETRIDE_URI}/version`, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (error) {
		die(`the run's engine at ${process.env.ROCKETRIDE_URI} does not answer (${error.message}). Run rr-verify doctor`);
	}
	const exe = await setup();

	const userData = path.join(VS_DIR, 'user-data');
	const home = path.join(VS_DIR, 'home');
	const workspace = path.join(VS_DIR, 'workspace');
	for (const dir of [path.join(userData, 'User'), path.join(VS_DIR, 'extensions'), home, path.join(workspace, 'pipelines')]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const settingsFile = path.join(userData, 'User', 'settings.json');
	if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify(userSettings(), null, '\t'));
	const fixtures = path.join(SKILL_DIR, 'fixtures', 'vscode');
	for (const fixture of fs.readdirSync(fixtures).filter((f) => f.endsWith('.pipe'))) {
		const dest = path.join(workspace, 'pipelines', fixture);
		if (!fs.existsSync(dest)) fs.copyFileSync(path.join(fixtures, fixture), dest);
	}
	// VS Code puts its IPC sockets in XDG_RUNTIME_DIR, and a socket path over 107 characters
	// fails to bind, so this directory lives in /tmp rather than in the run folder.
	const runtime = fs.mkdtempSync('/tmp/rr-vscode-');

	const cdpPort = await freePort();
	const args = [
		// Without it VS Code aborts unless chrome-sandbox is owned by root with mode 4755.
		'--no-sandbox',
		'--disable-gpu',
		// No display: Chromium's headless Ozone backend renders without X11 or Wayland.
		'--ozone-platform=headless',
		`--ozone-override-screen-size=${SCREEN.width},${SCREEN.height}`,
		`--remote-debugging-port=${cdpPort}`,
		`--user-data-dir=${userData}`,
		`--extensions-dir=${path.join(VS_DIR, 'extensions')}`,
		`--extensionDevelopmentPath=${EXT_BUILD}`,
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
		'--disable-telemetry',
		// Keeps secrets (the API key) in the run's user data instead of the desktop keyring.
		'--password-store=basic',
		workspace,
	];
	// VS Code also writes to ~/.vscode, ~/.vscode-shared, ~/.copilot, and ~/.cache, and the
	// extension writes to ~/.config/RocketRide. A private HOME keeps all of it inside the run.
	// The App Builder's pnpm install shares one store in the cache instead of one per run.
	// The run's ROCKETRIDE_*, RR_*, and ENGINE_* variables stay out: a user's VS Code has none, and
	// an engine the extension starts would inherit them.
	const keep = Object.entries(process.env).filter(([k]) => !/^(VSCODE_|ELECTRON_|XDG_|DBUS_|ROCKETRIDE_|RR_|ENGINE_)/.test(k));
	const env = {
		...Object.fromEntries(keep),
		...libraryEnv(),
		HOME: home,
		XDG_RUNTIME_DIR: runtime,
		pnpm_config_store_dir: path.join(CACHE, 'pnpm-store'),
		pnpm_config_cache_dir: path.join(CACHE, 'pnpm-cache'),
	};
	const log = fs.openSync(path.join(VS_DIR, 'vscode.log'), 'a');
	// detached makes VS Code a process-group leader, so close and stop end it and every helper,
	// extension host, and pnpm process it started.
	const child = spawn(exe, args, { detached: true, stdio: ['ignore', log, log], env, cwd: workspace });
	child.unref();
	const vsEnv = { VSCODE_PID: child.pid, VSCODE_CDP_PORT: cdpPort, VSCODE_WORKSPACE: workspace, VSCODE_USER_DATA: userData, VSCODE_LOG: path.join(VS_DIR, 'vscode.log'), VSCODE_RUNTIME: runtime };
	fs.writeFileSync(
		VS_ENV,
		Object.entries(vsEnv)
			.map(([k, v]) => `${k}=${v}\n`)
			.join('')
	);

	const started = Date.now();
	const { browser, page } = await attach(60000);
	try {
		await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
		await page.locator('.activitybar [aria-label^="RocketRide"]').first().waitFor({ timeout: 60000 });
	} finally {
		await browser.close();
	}
	await until(() => /RocketRide extension activated successfully|Extension activation failed/.test(extensionLog()), 60000, 500);
	const activation = extensionLog().match(/RocketRide extension activated successfully|Extension activation failed.*/)?.[0] || 'no activation line in the extension log';
	console.log(`vscode:    ${VSCODE_VERSION}, pid ${child.pid}, devtools port ${cdpPort}, ready in ${Math.round((Date.now() - started) / 1000)}s`);
	console.log(`extension: ${activation}`);
	// On the first launch the extension waits on its Welcome page. A relaunch reconnects with
	// the saved settings and key, so wait for that before reporting the status bar.
	const firstRun = !fs.existsSync(path.join(workspace, '.env'));
	let status = '';
	const { browser: b2, page: p2 } = await attach();
	try {
		status =
			(await until(async () => {
				const s = await statusBar(p2);
				return firstRun || /Connected|failed|error/i.test(s) ? s : null;
			}, 30000)) || (await statusBar(p2));
	} finally {
		await b2.close();
	}
	console.log(`status:    ${status || 'no RocketRide status bar item'}`);
	console.log(`workspace: ${workspace}`);
	if (!activation.includes('successfully')) process.exitCode = 1;
}

async function close({ quiet = false } = {}) {
	const running = readEnvFile(VS_ENV);
	if (!running) {
		if (!quiet) console.log('no VS Code running for this run');
		return;
	}
	const pgid = Number(running.VSCODE_PID);
	if (groupAlive(pgid)) {
		try {
			process.kill(-pgid, 'SIGTERM');
		} catch {
			// Already gone.
		}
		await until(() => !groupAlive(pgid), 15000, 500);
		if (groupAlive(pgid)) process.kill(-pgid, 'SIGKILL');
		console.log(`stopped VS Code pid ${pgid} and its process group`);
	} else {
		console.log(`VS Code pid ${pgid} already stopped`);
	}
	// The extension starts pnpm installs and app dev servers in process groups of their own.
	// Every process VS Code started carries the run's private HOME, so end those too.
	const strays = processesWithHome(path.join(VS_DIR, 'home'));
	if (strays.length) {
		for (const pid of strays) signal(pid, 'SIGTERM');
		await until(() => !processesWithHome(path.join(VS_DIR, 'home')).length, 10000, 500);
		for (const pid of processesWithHome(path.join(VS_DIR, 'home'))) signal(pid, 'SIGKILL');
		console.log(`stopped ${strays.length} more process(es) VS Code started: ${strays.join(', ')}`);
	}
	if (running.VSCODE_RUNTIME?.startsWith('/tmp/rr-vscode-')) fs.rmSync(running.VSCODE_RUNTIME, { recursive: true, force: true });
	fs.renameSync(VS_ENV, `${VS_ENV}.closed`);
}

// Processes of this user whose environment sets HOME to `home`. Only processes VS Code started
// for this run have it, so this never matches anything else on the machine.
function processesWithHome(home) {
	const pids = [];
	for (const entry of fs.readdirSync('/proc')) {
		if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
		try {
			if (fs.readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`HOME=${home}`)) pids.push(Number(entry));
		} catch {
			// Another user's process, or it exited.
		}
	}
	return pids;
}

function newestFile(dir, newerThan) {
	let count = 0;
	const walk = (p) => {
		const st = fs.statSync(p);
		if (st.isDirectory()) {
			for (const entry of fs.readdirSync(p)) if (entry !== 'node_modules') walk(path.join(p, entry));
		} else if (st.mtimeMs > newerThan) {
			count += 1;
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return count;
}

async function doctor() {
	let fail = false;
	const bundle = path.join(EXT_BUILD, 'rocketride.js');
	if (!fs.existsSync(bundle)) {
		console.log('info the VS Code extension is not built; rr-verify vscode needs ./builder vscode:build');
	} else {
		const built = fs.statSync(bundle).mtimeMs;
		const newer = EXT_SOURCES.reduce((n, rel) => n + newestFile(path.join(REPO, rel), built), 0);
		if (newer === 0) console.log('ok   the VS Code extension build is newer than its source');
		else console.log(`WARN ${newer} VS Code extension source file(s) are newer than build/vscode. Run ./builder vscode:build, then rr-verify vscode close and rr-verify vscode launch`);
	}
	const running = readEnvFile(VS_ENV);
	if (running) {
		if (groupAlive(Number(running.VSCODE_PID))) {
			console.log(`ok   VS Code pid ${running.VSCODE_PID} is alive`);
			try {
				await fetch(`http://127.0.0.1:${running.VSCODE_CDP_PORT}/json/version`, { signal: AbortSignal.timeout(5000) });
				console.log(`ok   VS Code answers on devtools port ${running.VSCODE_CDP_PORT}`);
			} catch {
				console.log(`FAIL VS Code does not answer on devtools port ${running.VSCODE_CDP_PORT}`);
				fail = true;
			}
		} else {
			console.log(`FAIL VS Code pid ${running.VSCODE_PID} is not running; see ${running.VSCODE_LOG}. Run rr-verify vscode close, then rr-verify vscode launch`);
			fail = true;
		}
	}
	process.exitCode = fail ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Attaching over CDP, logs, and evidence
// ---------------------------------------------------------------------------

async function attach(timeout = 15000) {
	const running = readEnvFile(VS_ENV);
	if (!running) die('VS Code is not running for this run. Start it: rr-verify vscode launch');
	if (!groupAlive(Number(running.VSCODE_PID))) die(`VS Code pid ${running.VSCODE_PID} is not running; see ${running.VSCODE_LOG}. Run rr-verify vscode close, then rr-verify vscode launch`);
	const { chromium } = requireRepo('playwright');
	const deadline = Date.now() + timeout;
	let browser;
	while (!browser) {
		try {
			browser = await chromium.connectOverCDP(`http://127.0.0.1:${running.VSCODE_CDP_PORT}`);
		} catch (error) {
			if (!groupAlive(Number(running.VSCODE_PID))) die(`VS Code exited. Last log lines:\n${tail(running.VSCODE_LOG, 15)}`);
			if (Date.now() > deadline) die(`cannot reach VS Code's devtools port ${running.VSCODE_CDP_PORT}: ${error.message}`);
			await sleep(500);
		}
	}
	const page = await until(
		() =>
			browser
				.contexts()
				.flatMap((c) => c.pages())
				.find((p) => p.url().includes('workbench.html')),
		timeout,
		500
	);
	if (!page) die('VS Code has no workbench window');
	return { browser, page, running };
}

function logFiles() {
	const userData = (readEnvFile(VS_ENV) || readEnvFile(`${VS_ENV}.closed`))?.VSCODE_USER_DATA;
	const logs = userData && path.join(userData, 'logs');
	if (!logs || !fs.existsSync(logs)) return {};
	const sessions = fs.readdirSync(logs).sort();
	if (!sessions.length) return {};
	const exthost = path.join(logs, sessions[sessions.length - 1], 'window1', 'exthost');
	const files = { exthost: path.join(exthost, 'exthost.log') };
	if (fs.existsSync(exthost)) {
		for (const dir of fs.readdirSync(exthost).filter((d) => d.startsWith('output_logging_'))) {
			for (const f of fs.readdirSync(path.join(exthost, dir))) {
				if (f.includes('Rocket Ride')) files.extension = path.join(exthost, dir, f);
			}
		}
	}
	return files;
}

function extensionLog() {
	const file = logFiles().extension;
	return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function logSizes() {
	const sizes = {};
	for (const [name, file] of Object.entries(logFiles())) sizes[name] = fs.existsSync(file) ? fs.statSync(file).size : 0;
	return sizes;
}

function logSince(sizes) {
	const out = {};
	for (const [name, file] of Object.entries(logFiles())) {
		if (fs.existsSync(file))
			out[name] = fs
				.readFileSync(file)
				.subarray(sizes[name] || 0)
				.toString();
	}
	return out;
}

// An exthost line is an error when VS Code tagged it [error]; an extension output line is an
// error when the extension marked it with its error icon or the word error.
function logErrors(chunks) {
	const errors = [];
	for (const line of (chunks.exthost || '').split('\n')) {
		if (line.includes('[error]')) errors.push({ source: 'exthost', text: line.slice(0, 2000) });
	}
	for (const line of (chunks.extension || '').split('\n')) {
		if (line.startsWith('❌') || /\berror\b/i.test(line.slice(0, 60))) errors.push({ source: 'extension', text: line.slice(0, 2000) });
	}
	return errors;
}

// Notification toasts in the bottom-right corner, with their severity.
async function readToasts(page) {
	try {
		return await page.evaluate(() =>
			[...document.querySelectorAll('.notifications-toasts .notification-list-item')].map((el) => {
				const icon = el.querySelector('.notification-list-item-icon')?.className || '';
				const severity = icon.includes('codicon-error') ? 'error' : icon.includes('codicon-warning') ? 'warning' : 'info';
				const text = (el.querySelector('.notification-list-item-message')?.textContent || el.textContent || '').trim();
				return { severity, text };
			})
		);
	} catch {
		return [];
	}
}

// One line for the record: the error's first line plus the last lines of Playwright's call log,
// which name the element that blocked a click.
function describe(error) {
	if (error instanceof StepFailure) return error.message;
	const lines = String(error.message)
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	const log = lines
		.slice(1)
		.filter((l) => !l.startsWith('Call log'))
		.slice(-2);
	return [`${error.name}: ${lines[0]}`, ...log].join(' | ').slice(0, 1000);
}

async function runStep(name, feature, body) {
	if (!RUN_DIR) die('no run; launch an engine first with rr-verify launch --mock');
	const started = new Date();
	const prefix = `${stamp(started)}-${name}`;
	const dir = path.join(RUN_DIR, feature);
	fs.mkdirSync(dir, { recursive: true });
	const { browser, page } = await attach();
	const marks = logSizes();
	const consoleErrors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') consoleErrors.push({ source: 'webview', url: msg.location()?.url || '', text: msg.text().slice(0, 2000) });
	});
	page.on('pageerror', (error) => consoleErrors.push({ source: 'webview', url: '', text: String(error).slice(0, 2000) }));
	const toasts = new Map();
	const pollToasts = async () => {
		for (const t of await readToasts(page)) toasts.set(`${t.severity}:${t.text}`, t);
	};
	const poller = setInterval(() => void pollToasts(), 700);

	const record = { feature, step: name, steps: [], ok: false, seconds: 0, mock: process.env.ENGINE_MOCK === '1', screenshots: [], video: `${prefix}.webm`, notifications: [], errors: [] };
	let shots = 0;
	const ctx = {
		page,
		feature,
		workspace: readEnvFile(VS_ENV).VSCODE_WORKSPACE,
		frame: (selector, timeout) => webviewFrame(page, selector, timeout),
		// Save a PNG of the whole window and add it to the record.
		shot: async (label) => {
			shots += 1;
			const file = `${prefix}-${shots}-${label}.png`;
			await page.screenshot({ path: path.join(dir, file) });
			record.screenshots.push(file);
			return file;
		},
		// Record one check. A failed check fails the step; later checks still run.
		check: async (label, fn) => {
			const t0 = Date.now();
			try {
				const detail = await fn();
				record.steps.push({ name: label, ok: true, detail: detail ?? '', seconds: (Date.now() - t0) / 1000 });
				console.log(`ok   ${label}${detail ? `: ${detail}` : ''}`);
				return true;
			} catch (error) {
				const detail = describe(error);
				record.steps.push({ name: label, ok: false, detail, seconds: (Date.now() - t0) / 1000 });
				console.log(`FAIL ${label}: ${detail}`);
				return false;
			}
		},
		fail: (message) => {
			throw new StepFailure(message);
		},
	};

	await page.screencast.start({ path: path.join(dir, record.video), size: SCREEN });
	try {
		await body(ctx);
	} catch (error) {
		const detail = describe(error);
		record.steps.push({ name: 'step stopped', ok: false, detail });
		console.log(`FAIL step stopped: ${detail}`);
	}
	try {
		await ctx.shot('end');
	} catch {
		// The window may be gone; the record says why.
	}
	clearInterval(poller);
	await pollToasts();
	await page.screencast.stop();
	await browser.close();

	record.ok = record.steps.length > 0 && record.steps.every((s) => s.ok);
	record.seconds = Math.round((Date.now() - started.getTime()) / 10) / 100;
	record.notifications = [...toasts.values()];
	const chunks = logSince(marks);
	record.errors = [...logErrors(chunks), ...consoleErrors, ...record.notifications.filter((t) => t.severity === 'error').map((t) => ({ source: 'notification', text: t.text }))];
	// The extension logs every status update, so keep only the last lines of what this step added.
	record.extension_log = (chunks.extension || '')
		.split('\n')
		.filter(Boolean)
		.slice(-60)
		.map((l) => l.slice(0, 400));
	const file = path.join(dir, `${prefix}.json`);
	fs.writeFileSync(file, JSON.stringify(record, null, 2));
	for (const t of record.notifications) console.log(`notification (${t.severity}): ${t.text}`);
	console.error(`saved: ${file}`);
	console.log(
		record.ok
			? `PASS: ${name}`
			: `FAIL: ${name}: ${record.steps
					.filter((s) => !s.ok)
					.map((s) => s.name)
					.join('; ')}`
	);
	if (record.errors.length) console.log(`note: ${record.errors.length} error line(s) from the extension host, webviews, or notifications; see "errors" in ${path.basename(file)}`);
	return record.ok;
}

// ---------------------------------------------------------------------------
// Workbench helpers
// ---------------------------------------------------------------------------

// True when every iframe between the frame and the workbench is shown. VS Code keeps hidden
// editors' webviews in the page, so two open .pipe files both contain a canvas.
async function frameShown(frame) {
	for (let f = frame; f.parentFrame(); f = f.parentFrame()) {
		try {
			if (!(await (await f.frameElement()).isVisible())) return false;
		} catch {
			return false;
		}
	}
	return true;
}

// The visible webview content frame whose document matches `selector`. A webview is an
// iframe.webview in the workbench with the extension's page in a nested frame.
async function webviewFrame(page, selector, timeout = 20000) {
	const found = await until(async () => {
		for (const frame of page.frames()) {
			const outer = frame.parentFrame();
			if (!frame.url().startsWith('vscode-webview://') || !outer?.url().startsWith('vscode-webview://')) continue;
			try {
				if ((await frame.locator(selector).count()) && (await frameShown(frame))) return frame;
			} catch {
				// Frame navigated or detached; try the next one.
			}
		}
		return null;
	}, timeout);
	if (!found) throw new StepFailure(`no visible webview shows ${selector}`);
	return found;
}

async function statusBar(page) {
	const item = page.locator('.statusbar-item').filter({ hasText: 'RocketRide' }).first();
	return (await item.count()) ? (await item.innerText()).trim() : '';
}

async function sidebar(page) {
	const tab = '[role="tab"]:has-text("Pipelines")';
	try {
		return await webviewFrame(page, tab, 1500);
	} catch {
		// Clicking the activity bar icon of a view that is already showing hides it, so click only now.
		await page.locator('.activitybar [aria-label^="RocketRide"]').first().click();
		return webviewFrame(page, tab, 20000);
	}
}

async function sidebarTab(page, name) {
	const frame = await sidebar(page);
	const tab = frame.locator(`[role="tab"]:has-text("${name}")`).first();
	if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
	return frame;
}

// The pipeline's path relative to the workspace: NAME means pipelines/NAME.pipe.
function pipelinePath(name) {
	const rel = name.includes('/') ? name : `pipelines/${name}`;
	return /\.pipe(\.json)?$/.test(rel) ? rel : `${rel}.pipe`;
}

// The Pipelines tab lists folders and files as rows whose title is the workspace-relative path,
// followed by a status line such as "Running" while a pipeline in it runs.
async function rowTitles(panel) {
	return panel.locator('[title]').evaluateAll((els) => els.map((e) => (e.getAttribute('title') || '').split('\n')[0]));
}

async function rowByPath(panel, rel) {
	const titles = await rowTitles(panel);
	const i = titles.indexOf(rel);
	return i >= 0 ? panel.locator('[title]').nth(i) : null;
}

// Expands the folders on the way to the pipeline and returns its row.
async function pipelineRow(page, name) {
	const panel = (await sidebarTab(page, 'Pipelines')).locator('[role="tabpanel"][aria-hidden="false"]');
	const rel = pipelinePath(name);
	const parts = rel.split('/');
	for (let i = 1; i < parts.length; i++) {
		if (await rowByPath(panel, parts.slice(0, i + 1).join('/'))) continue;
		const folder = await rowByPath(panel, parts.slice(0, i).join('/'));
		if (!folder) throw new StepFailure(`the Pipelines tab has no ${parts.slice(0, i).join('/')} folder`);
		await folder.click();
	}
	const row = await until(() => rowByPath(panel, rel), 10000);
	if (!row) throw new StepFailure(`the Pipelines tab does not list ${rel}; it shows: ${(await rowTitles(panel)).filter((t) => t.includes('.pipe')).join(', ') || 'no pipelines'}`);
	return row;
}

async function dismissCloudPrompt(frame, wait) {
	const title = frame.locator('#cloud-canvas-prompt-title');
	if (wait) await title.waitFor({ timeout: wait }).catch(() => {});
	if (!(await title.isVisible())) return false;
	await frame.getByRole('button', { name: 'Dismiss', exact: true }).click();
	await title.waitFor({ state: 'hidden', timeout: 5000 });
	return true;
}

// Brings the editor tab of the last opened pipeline to the front when the canvas is hidden.
// The canvas of the pipeline editor in front, on its Design tab. When another editor is in
// front, brings the last opened pipeline's tab forward.
async function canvasFrame(page) {
	let frame;
	try {
		frame = await webviewFrame(page, '.react-flow__node', 2000);
		await dismissCloudPrompt(frame, 0);
	} catch {
		const pipe = readState().pipeline;
		if (!pipe) throw new StepFailure('no canvas is showing; open a pipeline first with rr-verify vscode open NAME');
		await page
			.locator(`.tabs-container .tab[aria-label="${path.basename(pipe)}"]`)
			.first()
			.click();
		frame = await webviewFrame(page, '.react-flow__node', 20000);
		// Revealing a canvas can bring the RocketRide Cloud prompt back over it.
		await dismissCloudPrompt(frame, 4000);
	}
	const design = frame.getByRole('tab', { name: /^design$/i }).first();
	if ((await design.count()) && (await design.getAttribute('aria-selected')) !== 'true') {
		await design.click();
		await frame.locator('.react-flow__node').first().waitFor({ state: 'visible', timeout: 10000 });
	}
	return frame;
}

// The source node to act on: the one named, else the first node with a Run button.
async function sourceNode(frame, nodeId) {
	if (nodeId) return frame.locator(`.react-flow__node[data-id="${nodeId}"]`);
	const node = frame.locator('.react-flow__node:has(.rr-run-button-wrapper)').first();
	if (!(await node.count())) throw new StepFailure('no node on the canvas has a Run button; is the extension connected?');
	return node;
}

// What a command visibly changed: the editor tab in front, the status bar, notifications, and the
// visible webviews. Labels of background tabs are left out, so an already open page does not count.
async function visibleText(page) {
	const active = page.locator('.tabs-container .tab.active');
	let text = (await active.count()) ? `${await active.first().getAttribute('aria-label')}\n` : '';
	text += `${await page.locator('.part.statusbar').innerText()}\n`;
	text += (await readToasts(page)).map((t) => t.text).join('\n');
	for (const frame of page.frames()) {
		if (frame === page.mainFrame() || !(await frameShown(frame))) continue;
		try {
			text += `\n${await frame.locator('body').innerText()}`;
		} catch {
			// Detached while reading.
		}
	}
	return text;
}

async function runCommand(page, title) {
	const input = page.locator('.quick-input-widget input.input');
	await page.keyboard.press('F1');
	if (
		!(await input.waitFor({ timeout: 3000 }).then(
			() => true,
			() => false
		))
	) {
		await page.locator('.part.statusbar').click({ position: { x: 2, y: 2 } });
		await page.keyboard.press('Control+Shift+P');
		await input.waitFor({ timeout: 10000 });
	}
	await input.fill(`>${title}`);
	// A row's aria-label is the command's full title, sometimes followed by ", recently used".
	const rows = page.locator('.quick-input-list .monaco-list-row');
	const index = await until(async () => {
		const labels = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || ''));
		const i = labels.findIndex((l) => l === title || l.startsWith(`${title}, `));
		return i >= 0 ? i + 1 : null;
	}, 10000);
	if (!index) {
		await page.keyboard.press('Escape');
		throw new StepFailure(`the Command Palette has no command "${title}"`);
	}
	await rows.nth(index - 1).click();
}

async function chatFrame(page, timeout) {
	return until(async () => {
		for (const frame of page.frames()) {
			if (/^https?:\/\/[^/]+\/chat\//.test(frame.url()) && (await frameShown(frame))) return frame;
		}
		return null;
	}, timeout);
}

// ---------------------------------------------------------------------------
// User steps
// ---------------------------------------------------------------------------

async function stepConnect({ page, check, shot, frame, workspace, fail }) {
	let welcome;
	await check('the Welcome page shows the connection form', async () => {
		try {
			welcome = await frame('select[id$="connectionMode"]', 15000);
		} catch {
			await runCommand(page, 'RocketRide: Welcome');
			welcome = await frame('select[id$="connectionMode"]', 20000);
		}
		return `status bar: ${await statusBar(page)}`;
	});
	if (!welcome) fail('no Welcome page to connect from');
	await shot('welcome');
	await check('choose Direct Connect and enter the host URL and API key', async () => {
		await welcome.locator('select[id$="connectionMode"]').selectOption('onprem');
		await welcome.locator('input[id$="hostUrl"]').fill(process.env.ROCKETRIDE_URI);
		await welcome.locator('input[id$="apiKey"]').fill(process.env.ROCKETRIDE_APIKEY);
		return process.env.ROCKETRIDE_URI;
	});
	await check('Test connection succeeds', async () => {
		const panel = welcome.locator('[id$="apiKeyGroup"]').locator('..');
		const before = await panel.innerText();
		await welcome.getByText('Test connection', { exact: true }).click();
		const ok = await until(async () => (await welcome.getByText('Connection successful!').count()) > 0, 20000);
		if (!ok) {
			const after = (await panel.innerText()).replace(before, '').trim();
			fail(`no "Connection successful!" within 20s${after ? `; the form shows: ${after.slice(0, 300)}` : ''}`);
		}
		return 'Connection successful!';
	});
	await shot('filled');
	await check('Save & Connect connects', async () => {
		await welcome.getByRole('button', { name: 'Save & Connect' }).click();
		const status = await until(async () => {
			const s = await statusBar(page);
			return /Connected/.test(s) ? s : null;
		}, 30000);
		if (!status) fail(`status bar still shows "${await statusBar(page)}" after 30s`);
		return `status bar: ${status}`;
	});
	await check('the RocketRide sidebar shows Apps, Nodes, and Pipelines', async () => {
		const side = await sidebar(page);
		const tabs = await side.locator('[role="tab"]').allInnerTexts();
		if (!['apps', 'nodes', 'pipelines'].every((t) => tabs.some((x) => x.toLowerCase() === t))) fail(`tabs: ${tabs.join(', ')}`);
		return tabs.join(', ');
	});
	await shot('connected');
	await check('the workspace .env points at this engine', async () => {
		const envFile = path.join(workspace, '.env');
		const text = (await until(() => fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf8').includes('ROCKETRIDE_URI=') && fs.readFileSync(envFile, 'utf8'), 10000)) || '';
		const uri = text.match(/^ROCKETRIDE_URI=(.*)$/m)?.[1];
		const key = text.match(/^ROCKETRIDE_APIKEY=(.*)$/m)?.[1];
		if (uri !== process.env.ROCKETRIDE_URI || key !== process.env.ROCKETRIDE_APIKEY) fail(`.env has ROCKETRIDE_URI=${uri} ROCKETRIDE_APIKEY=${key ? '<set>' : key}`);
		return `ROCKETRIDE_URI=${uri}`;
	});
}

async function stepPipes({ page, check, shot }, expect, absent) {
	let paths = [];
	await check('the Pipelines tab lists the workspace pipelines', async () => {
		const panel = (await sidebarTab(page, 'Pipelines')).locator('[role="tabpanel"][aria-hidden="false"]');
		const titles = await rowTitles(panel);
		if (titles.includes('pipelines') && !titles.some((t) => t.startsWith('pipelines/'))) await (await rowByPath(panel, 'pipelines')).click();
		await sleep(500);
		paths = (await rowTitles(panel)).filter((t) => /\.pipe(\.json)?$/.test(t));
		return paths.join(', ') || 'none';
	});
	await shot('pipelines');
	for (const name of expect) {
		await check(`${pipelinePath(name)} is listed`, async () => (paths.includes(pipelinePath(name)) ? 'listed' : Promise.reject(new StepFailure(`not listed; the tab shows: ${paths.join(', ') || 'none'}`))));
	}
	for (const name of absent) {
		await check(`${pipelinePath(name)} is not listed`, async () => (paths.includes(pipelinePath(name)) ? Promise.reject(new StepFailure('still listed')) : 'not listed'));
	}
}

async function stepOpen({ page, check, shot, workspace, fail }, name) {
	const file = path.join(workspace, pipelinePath(name));
	if (!fs.existsSync(file)) fail(`no ${file}`);
	const pipe = JSON.parse(fs.readFileSync(file, 'utf8'));
	let canvas;
	await check('the pipeline is listed in the sidebar', async () => {
		await pipelineRow(page, name);
		return path.relative(workspace, file);
	});
	await check('clicking it opens the canvas', async () => {
		await (await pipelineRow(page, name)).click();
		const tab = page.locator(`.tabs-container .tab.active[aria-label^="${path.basename(file, '.pipe')}"]`);
		await tab.waitFor({ timeout: 20000 });
		canvas = await webviewFrame(page, '.react-flow__node', 30000);
		return `editor: ${(await page.locator('.tabs-container .tab.active').getAttribute('aria-label')).split(',')[0]}`;
	});
	if (!canvas) return;
	writeState({ pipeline: path.relative(path.join(workspace, 'pipelines'), file).replace(/\.pipe$/, '') });
	await check('dismiss the RocketRide Cloud prompt if it appears', async () => ((await dismissCloudPrompt(canvas, 6000)) ? 'dismissed' : 'not shown'));
	await check('the canvas shows every node and connection in the file', async () => {
		const ids = await canvas.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
		const want = pipe.components.map((c) => c.id);
		const edges = await canvas.locator('.react-flow__edge').count();
		const wantEdges = pipe.components.reduce((n, c) => n + (c.input?.length || 0) + (c.control?.length || 0), 0);
		const missing = want.filter((id) => !ids.includes(id));
		if (missing.length || edges !== wantEdges) fail(`nodes ${ids.length}/${want.length} (missing ${missing.join(', ') || 'none'}), connections ${edges}/${wantEdges}`);
		return `${ids.length} nodes, ${edges} connections`;
	});
	await shot('canvas');
}

async function stepRun({ page, check, shot, fail }, nodeId) {
	const canvas = await canvasFrame(page);
	const node = await sourceNode(canvas, nodeId);
	const id = await node.getAttribute('data-id');
	await shot('before');
	await check(`press Run on ${id}`, async () => {
		if (await node.locator('.stop-button').count()) fail(`${id} is already running; stop it first with rr-verify vscode stop-pipeline`);
		await node.locator('.rr-run-button-wrapper').click();
		return id;
	});
	await check(`${id} shows it is running`, async () => {
		const running = await until(async () => (await node.locator('.stop-button').count()) > 0, 60000, 500);
		if (!running) fail(`no Stop button after 60s; node shows "${(await node.innerText()).replace(/\n/g, ' / ')}"`);
		return 'the Run button turned into Stop';
	});
	await check(`${id} is ready`, async () => {
		// A started source shows its endpoint actions once the engine reports it ready.
		const ready = await until(async () => (await node.getByRole('button', { name: 'Endpoint Info' }).count()) > 0, 60000, 500);
		const text = (await node.innerText()).replace(/\n+/g, ' / ');
		if (!ready) fail(`not ready after 60s; node shows "${text}"`);
		return text;
	});
	await shot('running');
}

async function stepChat({ page, check, shot, fail }, question, expect, nodeId) {
	let chat = await chatFrame(page, 1500);
	await check('the chat panel is open', async () => {
		if (!chat) {
			const canvas = await canvasFrame(page);
			const node = await sourceNode(canvas, nodeId);
			const button = node.getByRole('button', { name: 'Chat now' });
			if (!(await button.count())) fail(`${await node.getAttribute('data-id')} has no Chat now button; run the pipeline first with rr-verify vscode run`);
			await button.click();
			chat = await chatFrame(page, 20000);
		}
		if (!chat) fail('no chat page opened');
		await chat.locator('textarea').waitFor({ timeout: 20000 });
		return chat.url().replace(/\?.*$/, '');
	});
	if (!chat) return;
	let answer = '';
	await check('ask the question', async () => {
		const before = await chat.locator('.message-wrapper.bot').count();
		await chat.getByPlaceholder('Type your message here...').fill(question);
		await chat.getByTitle('Send message').click();
		const done = await until(async () => (await chat.locator('.message-wrapper.bot').count()) > before && !(await chat.locator('.typing-indicator').count()), 90000, 500);
		if (!done) fail('no reply within 90s');
		await sleep(1000);
		answer = (await chat.locator('.message-wrapper.bot').last().innerText()).trim();
		return answer.split('\n')[0].slice(0, 200);
	});
	await shot('answer');
	await check(expect === 'none' ? 'the chat says the pipeline returned no answers' : 'the reply is an answer', async () => {
		const noAnswers = answer.startsWith("I don't see any answers");
		if (expect === 'none') {
			if (!noAnswers) fail(`expected no answers, got: ${answer.slice(0, 200)}`);
			return 'no answers returned, as expected';
		}
		if (!answer) fail('expected an answer, got an empty reply');
		if (noAnswers) fail('expected an answer, got "I don\'t see any answers in there..."');
		if (/^LLM error/.test(answer)) fail(`the answer is an LLM error: ${answer.slice(0, 300)}`);
		return 'an answer was returned';
	});
}

async function stepStop({ page, check, shot, fail }, nodeId) {
	const canvas = await canvasFrame(page);
	const node = await sourceNode(canvas, nodeId);
	const id = await node.getAttribute('data-id');
	await check(`press Stop on ${id}`, async () => {
		if (!(await node.locator('.stop-button').count())) fail(`${id} is not running`);
		await node.locator('.stop-button').click();
		return id;
	});
	await check(`${id} returns to idle`, async () => {
		const idle = await until(async () => !(await node.locator('.stop-button, .stopping-button').count()), 30000, 500);
		if (!idle) fail(`still ${(await node.locator('.stopping-button').count()) ? 'stopping' : 'running'} after 30s`);
		return (await node.innerText()).replace(/\n+/g, ' / ');
	});
	await shot('stopped');
}

async function stepCommand({ page, check, shot, fail }, title, expect) {
	await check(`run "${title}" from the Command Palette`, async () => {
		await runCommand(page, title);
		return 'ran';
	});
	await sleep(2000);
	if (expect) {
		await check(`the window shows "${expect}"`, async () => {
			const seen = await until(async () => (await visibleText(page)).includes(expect), 20000, 700);
			if (!seen) fail(`"${expect}" did not appear within 20s; status bar: ${await statusBar(page)}`);
			return `status bar: ${await statusBar(page)}`;
		});
	}
	await shot('result');
}

async function stepApp({ page, check, shot, workspace, fail }, appName, displayName) {
	let wizard;
	await check('New app opens the New App form', async () => {
		const side = await sidebarTab(page, 'Apps');
		await side.getByText('New app', { exact: true }).click();
		wizard = await webviewFrame(page, 'text=Create a new app', 20000);
		return 'New App';
	});
	if (!wizard) return;
	await check('fill in the app name and display name', async () => {
		await wizard.getByPlaceholder('starts lowercase; letters, digits, underscores, hyphens').fill(appName);
		await wizard.locator('input[type="text"], input:not([type])').nth(1).fill(displayName);
		return `${appName}, "${displayName}"`;
	});
	await shot('form');
	await check('Create App opens the App Builder', async () => {
		await wizard.getByRole('button', { name: 'Create App' }).click();
		await page.locator(`.tabs-container .tab.active[aria-label^="${displayName}"]`).waitFor({ timeout: 30000 });
		const builder = await webviewFrame(page, 'text=/^Dashboard$/i', 30000);
		const tabs = (await builder.locator('[role="tab"]').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
		if (!tabs.length) fail('the App Builder shows no tabs');
		return `tabs: ${tabs.join(', ')}`;
	});
	await check('the app folder and its .rrapp file exist', async () => {
		const rrapp = await until(() => {
			const dir = path.join(workspace, 'apps', `${appName}-ui`);
			const f = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => x.endsWith('.rrapp'));
			return f && path.join('apps', `${appName}-ui`, f);
		}, 10000);
		if (!rrapp) fail(`no apps/${appName}-ui/*.rrapp in the workspace`);
		return rrapp;
	});
	await shot('app-builder');
	await check('the sidebar Apps tab lists the new app', async () => {
		const panel = (await sidebarTab(page, 'Apps')).locator('[role="tabpanel"][aria-hidden="false"]');
		const listed = await until(async () => (await panel.getByText(displayName, { exact: true }).count()) > 0, 20000, 1000);
		if (!listed) fail(`after 20s the Apps tab shows: ${(await panel.innerText()).replace(/\n+/g, ' / ').slice(0, 200)}`);
		return displayName;
	});
	await shot('apps-tab');
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const HELP = `rr-verify vscode <command> [--label FEATURE] [args]

Setup and lifecycle:
  setup                       Download VS Code ${VSCODE_VERSION} and any missing libraries into .verify/vscode-cache.
  launch                      Start VS Code for this run with the extension from build/vscode.
  close                       Close this run's VS Code. rr-verify stop does it too.
  doctor                      The extension build and VS Code checks that rr-verify doctor runs.

User steps (each saves PNGs, a webm, and a JSON record; exit 0 = PASS, 1 = FAIL, 2 = could not run):
  connect                     Welcome page: Direct Connect with this run's URL and API key.
  pipes [--expect N] [--absent N]
                              List the sidebar's Pipelines tab and check which pipelines it shows.
  open NAME                   Open pipelines/NAME.pipe from the sidebar in the canvas.
  run [--node ID]             Press Run on a source node of the open canvas.
  chat [--node ID] [--expect answers|none] QUESTION
                              Chat now on the source node, then ask QUESTION in the chat panel.
  stop-pipeline [--node ID]   Press Stop on a running source node.
  command TITLE [--expect T]  Run a command from the Command Palette, e.g. "RocketRide: Settings".
  app NAME [--display NAME]   New app from the sidebar, then the App Builder.
  shot NAME                   Save a screenshot of the window as it is now.
  script FILE                 Your own steps: FILE exports default async ({ page, frame, shot, check, fail }).
`;

function takeOption(args, name, multiple = false) {
	const values = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === name) {
			values.push(args[i + 1]);
			args.splice(i, 2);
			i -= 1;
		} else if (args[i].startsWith(`${name}=`)) {
			values.push(args[i].slice(name.length + 1));
			args.splice(i, 1);
			i -= 1;
		}
	}
	return multiple ? values : values[values.length - 1];
}

async function main() {
	const args = process.argv.slice(2);
	const label = takeOption(args, '--label');
	const [command, ...rest] = args;
	const step = async (name, defaultFeature, body) => {
		if (!VS_DIR) die('no run; launch an engine first with rr-verify launch --mock');
		process.exitCode = (await runStep(name, label || defaultFeature, body)) ? 0 : 1;
	};
	switch (command) {
		case 'setup':
			console.log(`vscode: ${await setup()}`);
			return;
		case 'launch':
			if (!VS_DIR) die('no run; launch an engine first with rr-verify launch --mock');
			return launch();
		case 'close':
			return VS_DIR ? close({ quiet: rest.includes('--quiet') }) : undefined;
		case 'doctor':
			return doctor();
		case 'connect':
			return step('connect', 'vscode-connect', (ctx) => stepConnect(ctx));
		case 'pipes': {
			const expect = takeOption(rest, '--expect', true);
			const absent = takeOption(rest, '--absent', true);
			return step('pipes', 'vscode-sidebar', (ctx) => stepPipes(ctx, expect, absent));
		}
		case 'open':
			if (!rest[0]) die('open: NAME is required, e.g. rr-verify vscode open quickstart-chat');
			return step('open', 'canvas-open', (ctx) => stepOpen(ctx, rest[0]));
		case 'run': {
			const node = takeOption(rest, '--node');
			return step('run', 'canvas-run', (ctx) => stepRun(ctx, node));
		}
		case 'chat': {
			const node = takeOption(rest, '--node');
			const expect = takeOption(rest, '--expect') || 'answers';
			if (!['answers', 'none'].includes(expect)) die('chat: --expect is answers or none');
			if (!rest[0]) die('chat: QUESTION is required');
			return step('chat', 'canvas-chat', (ctx) => stepChat(ctx, rest.join(' '), expect, node));
		}
		case 'stop-pipeline': {
			const node = takeOption(rest, '--node');
			return step('stop-pipeline', 'canvas-stop', (ctx) => stepStop(ctx, node));
		}
		case 'command': {
			const expect = takeOption(rest, '--expect');
			if (!rest[0]) die('command: TITLE is required, e.g. rr-verify vscode command "RocketRide: Settings"');
			return step('command', 'vscode-commands', (ctx) => stepCommand(ctx, rest.join(' '), expect));
		}
		case 'app': {
			const display = takeOption(rest, '--display');
			if (!/^[a-z][a-z0-9_-]*$/.test(rest[0] || '')) die('app: NAME is required: a lowercase letter, then letters, digits, underscores, or hyphens');
			return step('app', 'vscode-app-builder', (ctx) => stepApp(ctx, rest[0], display || rest[0]));
		}
		case 'shot':
			return step(`shot-${rest[0] || 'window'}`, 'vscode', async ({ check, shot }) => {
				await check('screenshot', async () => shot(rest[0] || 'window'));
			});
		case 'script': {
			if (!rest[0]) die('script: FILE is required');
			const mod = await import(pathToFileURL(path.resolve(rest[0])).href);
			return step(path.basename(rest[0]).replace(/\.m?js$/, ''), 'vscode', (ctx) => mod.default(ctx));
		}
		case undefined:
		case 'help':
		case '--help':
			console.log(HELP);
			return;
		default:
			console.error(HELP);
			process.exit(2);
	}
}

await main();
