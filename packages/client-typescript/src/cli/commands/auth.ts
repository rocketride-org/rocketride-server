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
 * Workspace credential and provisioning commands: `login` and `init`.
 *
 * `login` is the credential half: resolve the server, probe it, sign in
 * (OSS: API key; saas: browser PKCE ending in a durable minted rr_* key),
 * validate, and write the `.env` pairs.
 *
 * `init` is `login` plus the provisioning half: services catalog +
 * schemas, vendored platform packages, the agent docs bundle from
 * GET /client/docs, the CLAUDE.md stub, `.gitignore` entries, and the
 * workspace directory conventions. The provisioning operations live in
 * the client-common source library (shared with the VS Code extension);
 * this module owns only the CLI-shaped parts — prompts, the loopback
 * OAuth listener, and command wiring.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import { Command } from 'commander';
import { RocketRideClient } from '../../client/client';
import { CONST_DEFAULT_WEB_CLOUD, CONST_DEFAULT_WEB_LOCAL } from '../../client/constants';
import { Output } from '../output';
import { addConnectionOptions, connectClient, disconnectAll, promptHidden, promptLine, runCliCommand, ConnectionOptions } from '../common';
import { ENV_DEV_URI, ENV_DEV_APIKEY, ENV_DEPLOY_URI, ENV_DEPLOY_APIKEY, writeDotEnv } from '../env';
import { toHttpBase, writeIfChanged, fetchArtifact, installDocsBundle, syncServiceCatalog, installStub, ensureGitignore } from '../../../../client-common/typescript/src/provision';
import { generatePkce, buildAuthorizeUrl } from '../../../../client-common/typescript/src/pkce';
import { DEFAULT_ZITADEL_URL, DEFAULT_CLI_CLIENT_ID } from '../../../../client-common/typescript/src/auth-defaults';

/** How long the loopback listener waits for the browser redirect. */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

// =============================================================================
// SERVER RESOLUTION
// =============================================================================

/**
 * Recover the server host this CLI was installed from, as a prompt
 * default. The bootstrap `pnpm add <server>/client/typescript` records
 * the URL verbatim as the dependency spec in the workspace package.json.
 *
 * @param cwd - Workspace directory.
 * @returns The install-source origin, or empty when unknown.
 */
function installSourceUri(cwd: string): string {
	try {
		const pkgPath = path.join(cwd, 'package.json');
		if (!fs.existsSync(pkgPath)) return '';
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		const spec = String(pkg.dependencies?.rocketride || pkg.devDependencies?.rocketride || '');
		if (!/^https?:\/\//i.test(spec)) return '';
		return new URL(spec).origin;
	} catch {
		return '';
	}
}

/**
 * Resolve the server URI for login: flag, then `.env`, then the install
 * source, then an interactive prompt.
 *
 * @param options - Parsed command options.
 * @param out - Output channel (decides prompt eligibility).
 * @param envKey - Which env pair's URI to consult.
 * @returns The chosen URI, or empty when unresolvable non-interactively.
 */
async function resolveServerUri(options: ConnectionOptions, out: Output, envKey: string): Promise<string> {
	const flagged = typeof options.uri === 'string' ? options.uri : '';
	if (flagged) return flagged;
	const fromEnv = process.env[envKey] || '';
	if (fromEnv) return fromEnv;
	const fallback = installSourceUri(process.cwd()) || CONST_DEFAULT_WEB_LOCAL;
	if (!out.interactive) return fallback;
	return promptLine('Server address', fallback);
}

// =============================================================================
// SAAS SIGN-IN (PKCE, loopback redirect)
// =============================================================================

/**
 * Open the system browser at a URL (best-effort; the URL is also printed).
 *
 * @param url - The URL to open.
 */
function openBrowser(url: string): void {
	// step: pick the platform opener. rundll32 takes the URL as a direct
	// argument — no cmd.exe in the path, so `&` in the query string
	// survives (cmd's `start` treats `&` as a command separator and
	// truncates OAuth URLs).
	let command = 'xdg-open';
	let args = [url];
	if (process.platform === 'win32') {
		command = 'rundll32';
		args = ['url.dll,FileProtocolHandler', url];
	} else if (process.platform === 'darwin') {
		command = 'open';
	}
	try {
		const child = spawn(command, args, { detached: true, stdio: 'ignore' });
		// A missing opener surfaces asynchronously as an 'error' event, not
		// as a throw — without this listener it would reach the process as
		// an uncaught exception and kill the CLI before the printed URL is
		// ever used.
		child.on('error', () => {
			// Non-fatal — the user can follow the printed URL
		});
		child.unref();
	} catch {
		// Non-fatal — the user can follow the printed URL
	}
}

/**
 * The RocketRide web app's two palettes — `rocketride` (dark) and
 * `rocketride-light`, from packages/shell/public/themes/*.json (a unit test
 * keeps these in step). The callback page cannot read the theme a user saved
 * inside the web app (another origin's storage), so it follows the system
 * light/dark setting onto these palettes — the web app's own default.
 */
export const CALLBACK_PALETTES = {
	dark: { bg: '#080808', paper: '#161616', text: '#ffffff', muted: 'rgba(255,255,255,0.40)', border: 'rgba(255,255,255,0.08)', buttonBg: '#00b9ec', buttonFg: '#ffffff', success: '#229954', error: '#f44336' },
	light: { bg: '#f0efe9', paper: '#e8e7e1', text: '#0a0a0a', muted: 'rgba(10,10,10,0.62)', border: 'rgba(0,0,0,0.15)', buttonBg: '#00a3d9', buttonFg: '#0a0a0a', success: '#229954', error: '#f44336' },
} as const;

/** The web app's font stack (the themes' --rr-font-family). */
const CALLBACK_FONT = "'Figtree Variable', 'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/** The RocketRide mark, as on the landing page (flame in brand red, body in text colour). */
const CALLBACK_LOGO = '<svg class="logo" width="36" height="36" viewBox="0 0 191 192" fill="none" aria-hidden="true"><path d="M159.5 161.424L153.7 167.224C151.9 169.024 148.9 169.024 147 167.224L126.6 146.824C115.6 135.824 115.6 118.024 126.6 107.024C138.1 95.5245 138.1 76.9245 126.6 65.4245L125.1 63.9245C113.6 52.4245 95 52.4245 83.5 63.9245C72.5 74.9245 54.6 74.9245 43.6 63.9245L23.2 43.5245C21.4 41.7245 21.4 38.7245 23.2 36.8245L29 31.0245C37 23.0245 49.1 20.5245 59.6 24.9245L87.5 36.3245C97.3 40.1245 108.4 38.0245 116.3 31.1245L137 10.4245C138.6 8.92449 140.4 7.42449 142.5 6.22449C146.2 4.12449 150.3 3.02449 154.5 2.62449L185.4 0.0244895C188.3 -0.275511 190.8 2.22449 190.5 5.12449L187.8 36.4245C187.3 42.8245 184.5 48.8245 180.1 53.5245L160.5 73.1245C152.5 81.2245 150.1 93.3245 154.5 103.824L155.5 106.224L161.2 120.024L165.6 130.924C169.9 141.424 167.5 153.524 159.5 161.524V161.424Z" fill="currentColor" fill-opacity="0.85"/><path d="M0.799997 190.325C-0.200003 189.325 -0.300003 187.625 0.599997 186.425L21.1 162.024C31.1 150.024 37.9 137.725 41.3 125.325C43.6 116.625 44.6 108.525 44.1 101.225C44.1 100.325 44.4 99.4245 45.1 98.8245C45.8 98.2245 46.8 97.9245 47.7 98.1245C65 101.625 83.5 98.3245 98.5 88.9245C99.6 88.2245 101.1 88.4245 102 89.3245C102.9 90.2245 103.1 91.7245 102.4 92.8245C93 107.825 89.7 126.325 93.2 143.525C93.4 144.325 93.2 145.225 92.6 145.925C92 146.625 91 147.225 90.1 147.125C82.8 146.625 74.6 147.525 66 149.925C53.6 153.225 41.2 160.025 29.3 170.125L4.9 190.625C3.8 191.525 2.1 191.525 0.999997 190.425H0.799997V190.325Z" fill="#F93822"/></svg>';

/** The RocketRide cloud's web app — where people use RocketRide in a browser. */
const CLOUD_WEB_APP_URL = 'https://rocketride.ai/';

/**
 * The web app a signed-in user should land on for a server: the cloud API
 * (CONST_DEFAULT_WEB_CLOUD) is fronted by the cloud web app at
 * rocketride.ai; any other server serves its web app from its own origin.
 *
 * @param serverBase - The server's http(s) origin (toHttpBase of its URI).
 * @returns The web app URL, with a trailing slash.
 */
export function webAppUrlFor(serverBase: string): string {
	const origin = serverBase.replace(/\/+$/, '');
	// URL.origin lowercases the host and drops a default port, so
	// https://api.rocketride.ai:443 still reads as the cloud API
	const canonical = (value: string): string => {
		try {
			return new URL(value).origin;
		} catch {
			return value.toLowerCase();
		}
	};
	return canonical(origin) === canonical(CONST_DEFAULT_WEB_CLOUD) ? CLOUD_WEB_APP_URL : `${origin}/`;
}

/**
 * Escapes text for an HTML text node or attribute.
 *
 * @param text - Untrusted text.
 * @returns The escaped text.
 */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** The sign-in outcome the callback page shows. */
export type CallbackResult = { ok: true; webUrl?: string; waitlisted?: boolean } | { ok: false; error: string };

/**
 * Renders the page the browser lands on after the sign-in redirect,
 * branded like the RocketRide landing page and themed with the web app's
 * palettes (system light/dark).
 *
 * Success tries to close the tab. Chromium allows that for this tab;
 * Firefox only lets scripts close windows scripts opened, so there the page
 * stays as a finished state — never a dead end, with a link to the web app.
 * A waitlisted account stays open with its access-queue notice. A failure
 * shows the reason and makes no close attempt.
 *
 * @param result - The sign-in outcome; `webUrl` is the server's web app.
 * @returns The HTML document.
 */
export function renderCallbackPage(result: CallbackResult): string {
	const vars = (p: (typeof CALLBACK_PALETTES)['dark' | 'light']): string => `--bg:${p.bg};--paper:${p.paper};--text:${p.text};--muted:${p.muted};--border:${p.border};--btn-bg:${p.buttonBg};--btn-fg:${p.buttonFg};--ok:${p.success};--err:${p.error}`;
	const style = [
		`:root{${vars(CALLBACK_PALETTES.light)}}`,
		`@media (prefers-color-scheme:dark){:root{${vars(CALLBACK_PALETTES.dark)}}}`,
		`*{box-sizing:border-box}`,
		`body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-family:${CALLBACK_FONT};-webkit-font-smoothing:antialiased}`,
		`header{display:flex;align-items:center;gap:10px;padding:20px 28px}`,
		`header .logo{color:var(--text);display:block;flex-shrink:0}`,
		`header span{font-size:22px;font-weight:700}`,
		`main{flex:1;display:grid;place-items:center;padding:24px}`,
		`.card{width:100%;max-width:440px;padding:40px 36px;text-align:center;background:var(--paper);border:1px solid var(--border);border-radius:16px}`,
		`.badge{width:56px;height:56px;margin:0 auto 20px;display:grid;place-items:center;border-radius:50%;border:2px solid var(--state)}`,
		`.badge svg{display:block;stroke:var(--state)}`,
		`h1{margin:0 0 8px;font-size:28px;font-weight:800}`,
		`p{margin:0;font-size:15px;line-height:1.5;color:var(--muted)}`,
		`.reason{margin-top:12px;color:var(--text);word-break:break-word}`,
		`.btn{display:inline-block;margin-top:28px;padding:10px 22px;border-radius:8px;background:var(--btn-bg);color:var(--btn-fg);font-weight:700;font-size:15px;text-decoration:none}`,
		`.hint{margin-top:18px;font-size:13px}`,
	].join('');
	const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>RocketRide sign-in</title><style>${style}</style></head><body><header>${CALLBACK_LOGO}<span>RocketRide</span></header><main>`;

	if (!result.ok) {
		const badge = '<div class="badge" style="--state:var(--err)"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg></div>';
		return `${head}<div class="card">${badge}<h1>Sign-in failed</h1><p class="reason">${escapeHtml(result.error)}</p><p class="hint">Return to your terminal and run <strong>rocketride login</strong> again.</p></div></main></body></html>`;
	}

	// step: the web app link — absolute http(s) with a host only
	let webUrl = '';
	try {
		const parsed = new URL(result.webUrl ?? '');
		if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) webUrl = parsed.toString();
	} catch {
		webUrl = '';
	}

	const badge = '<div class="badge" style="--state:var(--ok)"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>';
	const button = webUrl ? `<a class="btn" href="${escapeHtml(webUrl)}">Open RocketRide</a>` : '';
	if (result.waitlisted) {
		return `${head}<div class="card">${badge}<h1>You're on the list</h1><p>Your account is in the access queue; you will be emailed when it is activated.</p>${button}</div></main></body></html>`;
	}
	return `${head}<div class="card">${badge}<h1>You're signed in</h1><p>Return to your terminal; the RocketRide CLI is ready.</p>${button}<p class="hint">You can close this tab.</p></div></main><script>window.close();</script></body></html>`;
}

/**
 * Run the loopback-redirect PKCE authorization and return the code.
 *
 * Starts a listener on a random 127.0.0.1 port, sends the browser to the
 * Zitadel authorize URL, and resolves with the `code` query parameter
 * from the redirect. A code is not a sign-in yet (the exchange and the key
 * mint can still fail), so the browser's request is held open until the
 * caller reports the real outcome through `finish`. A provider error or a
 * code-less redirect is answered at once.
 *
 * @param zitadelUrl - Base URL of the Zitadel instance.
 * @param clientId - OAuth public client id.
 * @param challenge - The S256 code challenge.
 * @param out - Output channel for progress lines.
 * @param open - Opens the authorize URL (the system browser by default).
 * @returns The authorization code, the exact redirect URI used, and
 *   `finish`, which answers the held browser request and closes the listener.
 */
export function authorizeViaLoopback(zitadelUrl: string, clientId: string, challenge: string, out: Output, open: (url: string) => void = openBrowser): Promise<{ code: string; redirectUri: string; finish: (result: CallbackResult) => void }> {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		const timer = setTimeout(() => {
			server.close();
			reject(new Error('Sign-in timed out waiting for the browser redirect'));
		}, OAUTH_TIMEOUT_MS);

		server.on('request', (req, res) => {
			const url = new URL(req.url || '/', 'http://127.0.0.1');
			if (url.pathname !== '/auth/callback') {
				res.writeHead(404).end();
				return;
			}
			const error = url.searchParams.get('error');
			const code = url.searchParams.get('code') || '';
			let answered = false;
			const answer = (result: CallbackResult): void => {
				if (answered) return;
				answered = true;
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
				res.end(renderCallbackPage(result));
				server.close();
			};
			clearTimeout(timer);
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			if (error) {
				const reason = url.searchParams.get('error_description') || error;
				answer({ ok: false, error: reason });
				reject(new Error(`Sign-in was rejected: ${reason}`));
			} else if (!code) {
				answer({ ok: false, error: 'The sign-in redirect carried no authorization code.' });
				reject(new Error('Sign-in redirect carried no authorization code'));
			} else {
				resolve({ code, redirectUri: `http://127.0.0.1:${port}/auth/callback`, finish: answer });
			}
		});

		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
			const authorizeUrl = buildAuthorizeUrl(zitadelUrl, clientId, redirectUri, challenge);
			out.line('Opening your browser to sign in...');
			out.line(`If it did not open, visit: ${authorizeUrl}`);
			open(authorizeUrl);
		});
	});
}

/**
 * Sign in to a saas server and mint a durable API key for `.env`.
 *
 * The Zitadel host and client id are BAKED into this build (like the VS
 * Code extension's id) — the client package a server serves was built
 * from the same tree as that server. The PKCE exchange returns a 90-day
 * session key; the durable credential is a freshly minted personal API
 * key (never expires), created over the same authenticated connection.
 *
 * @param uri - The server URI.
 * @param out - Output channel.
 * @returns The minted rr_* key, or empty on waitlisted.
 */
async function signInSaas(uri: string, out: Output): Promise<string> {
	// step: PKCE verifier + S256 challenge (shared helper)
	const { verifier, challenge } = generatePkce();

	// step: browser authorization via the loopback redirect; the browser
	// waits on its callback page until this sign-in finishes
	const { code, redirectUri, finish } = await authorizeViaLoopback(DEFAULT_ZITADEL_URL, DEFAULT_CLI_CLIENT_ID, challenge, out);
	const webUrl = webAppUrlFor(toHttpBase(uri));
	let outcome: CallbackResult = { ok: false, error: 'Sign-in did not complete; see your terminal.' };

	// step: exchange the code over a temporary DAP connection — the server
	// consumes the Zitadel tokens and returns an rr_* session key
	const tempClient = new RocketRideClient({ persist: false });
	try {
		const result = await tempClient.connect({ code, verifier, redirectUri }, { uri });
		if (result?.waitlisted) {
			const name = result.displayName || '';
			out.line(`Thanks for signing up${name ? `, ${name}` : ''}! Your account is in the access queue — you will be emailed when it is activated.`);
			outcome = { ok: true, webUrl, waitlisted: true };
			return '';
		}
		if (!result?.userToken) {
			throw new Error('Sign-in succeeded but the server returned no token');
		}

		// step: mint the durable credential — a personal API key that,
		// unlike the session key, never expires and survives sign-outs.
		// Empty permissions = full personal access token.
		const keyName = `CLI on ${os.hostname()}`;
		const minted = await tempClient.account.createKey({ name: keyName, permissions: [] });
		out.line(`Signed in${result.displayName ? ` as ${result.displayName}` : ''}; minted API key '${keyName}'.`);
		outcome = { ok: true, webUrl };
		return minted.key;
	} catch (err) {
		outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
		throw err;
	} finally {
		finish(outcome);
		await tempClient.disconnect().catch(() => {});
	}
}

// =============================================================================
// LOGIN FLOW (shared by `login` and `init`)
// =============================================================================

/** Result of the credential half. */
interface LoginResult {
	uri: string;
	apikey: string;
}

/**
 * Run the credential flow: resolve server, probe, authenticate, validate,
 * and persist the `.env` pair(s).
 *
 * @param options - Parsed command options (uri/apikey/deploy flags).
 * @param out - Output channel.
 * @param forDeploy - Target the ROCKETRIDE_DEPLOY_* pair instead of dev.
 * @returns The validated pair, or null when the flow could not complete.
 */
async function runLogin(options: ConnectionOptions, out: Output, forDeploy: boolean): Promise<LoginResult | null> {
	const envUriKey = forDeploy ? ENV_DEPLOY_URI : ENV_DEV_URI;
	const uri = await resolveServerUri(options, out, envUriKey);
	if (!uri) {
		out.fail('No server address given', 'pass --uri or run interactively');
		return null;
	}

	// step: probe — unauthenticated; decides OSS vs saas sign-in
	out.line(`Probing ${uri}...`);
	const info = await RocketRideClient.getServerInfo(uri);
	const isSaas = (info.capabilities || []).includes('saas');
	// The engine reports version as {version, hash, stamp}; older servers
	// may send a plain string — display either without leaking the object
	const rawVersion = info.version as unknown;
	const versionDisplay = typeof rawVersion === 'string' ? rawVersion : ((rawVersion as { version?: string })?.version ?? '(unknown version)');
	out.line(`Server ${versionDisplay || '(unknown version)'} — ${isSaas ? 'saas' : 'oss'} mode.`);

	// step: obtain a credential
	let apikey = typeof options.apikey === 'string' ? options.apikey : '';
	if (!apikey) {
		if (isSaas && DEFAULT_ZITADEL_URL && DEFAULT_CLI_CLIENT_ID) {
			apikey = await signInSaas(uri, out);
			if (!apikey) return null; // waitlisted — message already printed
		} else if (isSaas) {
			out.fail('This CLI build carries no sign-in configuration', 'create an API key in the web UI and run: rocketride login --apikey <key>');
			return null;
		} else if (out.interactive) {
			apikey = await promptHidden('API key');
		} else {
			out.fail('An API key is required in non-interactive mode', 'pass --apikey');
			return null;
		}
	}

	// step: validate by connecting once with the credential
	out.line('Validating credentials...');
	const client = await connectClient({ uri, apikey });
	await client.disconnect().catch(() => {});

	// step: persist. The deploy pair mirrors the dev pair by default (one
	// server = one target) unless --no-deploy keeps deploys unarmed; a
	// deploy pair already pointing elsewhere is never overwritten.
	const updates: Record<string, string> = {};
	if (forDeploy) {
		updates[ENV_DEPLOY_URI] = uri;
		updates[ENV_DEPLOY_APIKEY] = apikey;
	} else {
		updates[ENV_DEV_URI] = uri;
		updates[ENV_DEV_APIKEY] = apikey;
		const existingDeployUri = process.env[ENV_DEPLOY_URI] || '';
		const mirrorDeploy = options.deploy !== false && (existingDeployUri === '' || existingDeployUri === uri);
		if (mirrorDeploy) {
			updates[ENV_DEPLOY_URI] = uri;
			updates[ENV_DEPLOY_APIKEY] = apikey;
		}
	}
	const envPath = writeDotEnv(updates);
	for (const [key, value] of Object.entries(updates)) {
		process.env[key] = value;
	}
	out.line(`Saved ${Object.keys(updates).join(', ')} to ${envPath}.`);

	// step: the .env now holds a live credential — make it un-committable
	// in the same breath, never as a later provisioning step
	if (ensureGitignore(process.cwd())) {
		out.line('.gitignore: added .rocketride/ and .env.');
	}
	return { uri, apikey };
}

// =============================================================================
// PROVISIONING (init)
// =============================================================================

/**
 * Re-point the workspace's `rocketride` dependency from the bootstrap URL
 * to the vendored tarball, making the workspace hermetic.
 *
 * @param workspaceRoot - Workspace directory.
 * @param out - Output channel.
 * @returns True when package.json was rewritten.
 */
function repointClientDependency(workspaceRoot: string, out: Output): boolean {
	const pkgPath = path.join(workspaceRoot, 'package.json');
	if (!fs.existsSync(pkgPath)) return false;
	const raw = fs.readFileSync(pkgPath, 'utf-8');
	const pkg = JSON.parse(raw);
	const spec = String(pkg.dependencies?.rocketride || '');
	if (!/^https?:\/\//i.test(spec)) return false;
	pkg.dependencies.rocketride = 'file:.rocketride/client/rocketride.tgz';
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
	out.line('package.json: rocketride now resolves to the vendored .rocketride/client/rocketride.tgz.');
	return true;
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

/**
 * Register the `login` and `init` commands on the program.
 *
 * @param program - The root commander program.
 */
export function registerAuthCommands(program: Command): void {
	// ── login ────────────────────────────────────────────────────────────
	const loginCmd = program
		.command('login')
		.description('(Re-)authenticate against a server and save credentials to .env')
		.addHelpText(
			'after',
			`
SaaS servers sign in through your browser. Afterwards the tab closes itself
where the browser allows it (Chrome, Edge); elsewhere (Firefox) it shows a
"You're signed in" page you can close. OSS servers take an API key (--apikey,
or a prompt).
Credentials land in .env as the development pair, mirrored into the deployment
pair unless --no-deploy.`,
		)
		.option('--deploy', 'Re-authenticate the deployment pair (ROCKETRIDE_DEPLOY_*) instead')
		.option('--no-deploy', 'Do not mirror the credentials into the deploy pair')
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				const result = await runLogin(options, out, options.deploy === true);
				if (!result) return 1;
				out.result({ uri: result.uri, saved: true });
				return 0;
			});
		});
	addConnectionOptions(loginCmd);

	// ── init ─────────────────────────────────────────────────────────────
	const initCmd = program
		.command('init')
		.description('Initialize this workspace: sign in, vendor platform packages, install agent docs')
		.option('--deploy', 'Also treat this server as the deploy target (default)', true)
		.option('--no-deploy', 'Do not configure a deploy target')
		.option('--no-install', 'Skip the workspace pnpm install after vendoring')
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				const workspaceRoot = process.cwd();

				// step: credentials — reuse a valid .env silently, else login
				let uri = process.env[ENV_DEV_URI] || '';
				let apikey = process.env[ENV_DEV_APIKEY] || '';
				let haveCredentials = false;
				if ((uri && apikey) || (typeof options.uri === 'string' && options.uri && typeof options.apikey === 'string' && options.apikey)) {
					uri = (typeof options.uri === 'string' && options.uri) || uri;
					apikey = (typeof options.apikey === 'string' && options.apikey) || apikey;
					try {
						const probeClient = await connectClient({ uri, apikey });
						await probeClient.disconnect().catch(() => {});
						haveCredentials = true;
						out.line(`Using existing credentials for ${uri}.`);
					} catch {
						out.line(`Stored credentials for ${uri} were rejected — signing in again.`);
					}
				}
				if (!haveCredentials) {
					const login = await runLogin(options, out, false);
					if (!login) return 1;
					uri = login.uri;
					apikey = login.apikey;
				}

				// step: services catalog + schemas over one connection
				const client = await connectClient({ uri, apikey });
				const servicesResponse = await client.getServices();
				const services = (servicesResponse.services || {}) as Record<string, unknown>;
				syncServiceCatalog(workspaceRoot, services, (line) => out.line(line));
				await disconnectAll();

				// step: vendor the platform packages from the same server
				const base = toHttpBase(uri);
				const shellTgz = await fetchArtifact(base, 'client/shell', 'platform package (shell.tgz)');
				if (writeIfChanged(path.join(workspaceRoot, '.rocketride', 'shell', 'shell.tgz'), shellTgz)) {
					out.line('Vendored .rocketride/shell/shell.tgz.');
				}
				const clientTgz = await fetchArtifact(base, 'client/typescript', 'client SDK package (rocketride.tgz)');
				if (writeIfChanged(path.join(workspaceRoot, '.rocketride', 'client', 'rocketride.tgz'), clientTgz)) {
					out.line('Vendored .rocketride/client/rocketride.tgz.');
				}

				// step: agent docs bundle (sweep + stamp) and the CLAUDE.md stub
				await installDocsBundle(workspaceRoot, base, (line) => out.line(line));
				try {
					if (installStub(workspaceRoot, 'CLAUDE.md', 'CLAUDE.md')) {
						out.line('CLAUDE.md stub installed.');
					}
				} catch (err) {
					out.line(`CLAUDE.md stub skipped: ${err instanceof Error ? err.message : String(err)}`);
				}

				// step: workspace conventions
				ensureGitignore(workspaceRoot);
				for (const dir of ['apps', 'pipelines', 'nodes']) {
					fs.mkdirSync(path.join(workspaceRoot, dir), { recursive: true });
				}

				// step: make the workspace hermetic and link the vendored client
				const repointed = repointClientDependency(workspaceRoot, out);
				if (repointed && options.install !== false) {
					try {
						out.line('Running pnpm install...');
						execSync('pnpm install', { cwd: workspaceRoot, stdio: 'ignore' });
					} catch {
						out.line('pnpm install failed — run it manually to link the vendored client.');
					}
				}

				out.line('');
				out.line(`Workspace initialized against ${uri}.`);
				out.line('Docs: .rocketride/docs/ROCKETRIDE_README.md is the starting point.');
				out.result({ uri, workspaceRoot, initialized: true });
				return 0;
			});
		});
	addConnectionOptions(initCmd);
}
