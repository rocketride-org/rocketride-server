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
import { CONST_DEFAULT_WEB_LOCAL } from '../../client/constants';
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
 * Run the loopback-redirect PKCE authorization and return the code.
 *
 * Starts a listener on a random 127.0.0.1 port, sends the browser to the
 * Zitadel authorize URL, and resolves with the `code` query parameter
 * from the redirect.
 *
 * @param zitadelUrl - Base URL of the Zitadel instance.
 * @param clientId - OAuth public client id.
 * @param challenge - The S256 code challenge.
 * @param out - Output channel for progress lines.
 * @returns The authorization code and the exact redirect URI used.
 */
function authorizeViaLoopback(zitadelUrl: string, clientId: string, challenge: string, out: Output): Promise<{ code: string; redirectUri: string }> {
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
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<html><body><p>RocketRide sign-in received. You can close this window and return to the terminal.</p></body></html>');
			clearTimeout(timer);
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close();
			if (error) {
				reject(new Error(`Sign-in was rejected: ${url.searchParams.get('error_description') || error}`));
			} else if (!code) {
				reject(new Error('Sign-in redirect carried no authorization code'));
			} else {
				resolve({ code, redirectUri: `http://127.0.0.1:${port}/auth/callback` });
			}
		});

		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
			const authorizeUrl = buildAuthorizeUrl(zitadelUrl, clientId, redirectUri, challenge);
			out.line('Opening your browser to sign in...');
			out.line(`If it did not open, visit: ${authorizeUrl}`);
			openBrowser(authorizeUrl);
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

	// step: browser authorization via the loopback redirect
	const { code, redirectUri } = await authorizeViaLoopback(DEFAULT_ZITADEL_URL, DEFAULT_CLI_CLIENT_ID, challenge, out);

	// step: exchange the code over a temporary DAP connection — the server
	// consumes the Zitadel tokens and returns an rr_* session key
	const tempClient = new RocketRideClient({ persist: false });
	try {
		const result = await tempClient.connect({ code, verifier, redirectUri }, { uri });
		if (result?.waitlisted) {
			const name = result.displayName || '';
			out.line(`Thanks for signing up${name ? `, ${name}` : ''}! Your account is in the access queue — you will be emailed when it is activated.`);
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
		return minted.key;
	} finally {
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
