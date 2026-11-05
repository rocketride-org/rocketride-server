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
// PROXY CONFIG — the dev server's passthrough-proxy wrapper (local-first)
// =============================================================================

/**
 * Generates the rsbuild wrapper config that turns the app's dev server into
 * a passthrough proxy for the preview shell (the local-first dev design).
 * The wrapper is PURE rsbuild configuration — no custom middleware:
 *
 *   - `dev.assetPrefix` mounts the compiled assets (remoteEntry, chunks,
 *     HMR updates) under the app's own `/apps/<devAppId>/dev/` namespace,
 *     so URLs resolve exactly like a published version would, one path
 *     segment over (`/v<N>/**` still proxies to the server).
 *   - `output.copy` carries the app's manifest (package.json) and its icon
 *     into the SAME compiled output, so the URL-convention
 *     self-registration and manifest icons serve through the normal asset
 *     pipeline — correct types, memory-served, nothing hand-rolled.
 *   - CATCH-ALL proxy: everything else goes to the connected engine origin
 *     (websockets tunneled). Glob exclusions carve out the dev prefix and
 *     the HMR socket — the proxy runs BEFORE the asset middleware, so
 *     without them the engine would swallow the dev assets.
 *
 * The wrapper IMPORTS the app's own rsbuild.config.mts and merges these
 * settings in — the user's config is never modified. It is written to the
 * app's `.rocketride/` directory per session (regenerated on every start;
 * engine origin may change between sessions) and passed to rsbuild via
 * `dev --config <wrapper>`.
 */

import * as path from 'path';
import { randomBytes } from 'crypto';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { CONST_DEFAULT_WEB_CLOUD } from '../client/constants';

/** The wrapper's file-name shape inside the app's .rocketride directory —
 *  session-unique (owner pid + random token), so concurrent dev servers for
 *  the same app folder never overwrite each other's wrapper (a crash respawn
 *  re-reads the file by path). */
const WRAPPER_PATTERN = /^dev-proxy\.(\d+)-[0-9a-f]+\.rsbuild\.config\.mts$/;

/** Whether a process with this pid is still running. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The cloud web app's origin — where cloud browser sign-ins are registered
 *  (the CLI's webAppUrlFor makes the same mapping for its callback pages). */
const CLOUD_WEB_APP_ORIGIN = 'https://rocketride.ai';

/**
 * The REGISTERED web origin for an engine: where a browser can complete an
 * OAuth sign-in against that engine's Zitadel registration. The cloud API
 * origin maps to the cloud web app; any other engine's web app is served
 * from its own origin. The dev preview relays its sign-in through this
 * origin (`rrauthorigin` param → the shell's dev relay), because the preview's
 * own random-port origin can never be a registered redirect_uri.
 *
 * @param engineOrigin - The connected engine's http(s) origin.
 * @returns The registered web origin for that engine.
 */
export function webOriginFor(engineOrigin: string): string {
	const canonical = (value: string): string => {
		try {
			return new URL(value).origin;
		} catch {
			return value.replace(/\/+$/, '').toLowerCase();
		}
	};
	return canonical(engineOrigin) === canonical(CONST_DEFAULT_WEB_CLOUD) ? CLOUD_WEB_APP_ORIGIN : canonical(engineOrigin);
}

/** Per-host knobs for the generated wrapper. */
export interface WrapperOptions {
	/**
	 * Redirect the bare front door (`GET /`, no query) to the canonical
	 * preview URL (`/?appid=<id>&rrdev=1`), so `localhost:<port>` just works.
	 * TERMINAL HOSTS ONLY (`rocketride app dev`): panel hosts always navigate
	 * with the params present, and leaving this off keeps their wrapper
	 * byte-identical to the pre-option output.
	 */
	injectPreviewParams?: boolean;
	/**
	 * Override the dev-server port (the wrapper merges AFTER the app's own
	 * config, so this outranks the scaffold's pinned port). rsbuild still
	 * auto-bumps when the port is busy.
	 */
	port?: number;
	/**
	 * The session was launched signed out (--no-auth): the front-door
	 * redirect appends the empty `#rrtoken=` fragment, so a tab opened on
	 * the bare origin honors the launch's auth contract exactly like the
	 * printed preview URL — without this, the 302 resumed whatever session
	 * the browser remembered for the origin.
	 */
	signedOut?: boolean;
}

/**
 * Renders the wrapper config source.
 *
 * @param appId - The dev app's id (URL-encoded into the served prefix).
 * @param engineOrigin - The connected engine origin to proxy to.
 * @param appConfigPath - Absolute path of the app's own rsbuild config.
 * @param copyFiles - App-folder-relative files to carry into the output
 *                    (manifest + icon), POSIX-slashed.
 * @param opts - Per-host knobs (see {@link WrapperOptions}).
 * @returns The wrapper file content.
 */
function renderWrapper(appId: string, engineOrigin: string, appConfigPath: string, copyFiles: string[], opts: WrapperOptions = {}): string {
	const devPrefix = `/apps/${encodeURIComponent(appId)}/dev`;
	// step: RELATIVE import — the wrapper lives in <app>/.rocketride/, so
	// ../<name> is stable on every platform; an absolute Windows path
	// ('C:/...') is an unsupported URL scheme to native ESM
	const importPath = `../${path.basename(appConfigPath)}`;
	// step: copy patterns preserve each file's relative directory so URLs
	// under the dev prefix match the app-folder layout (icon paths). Every
	// interpolation below is JSON-quoted — paths and manifest-sourced names
	// may hold quotes and must never break the generated module
	const copyEntries = copyFiles
		.map((rel) => `{ from: ${JSON.stringify(rel)}, to: ${JSON.stringify(path.posix.dirname(rel))} }`)
		.join(', ');
	// step: the bare-front-door redirect (terminal hosts). The registration
	// reads window.location in the BROWSER, so the params must land in the
	// address bar — a 302, never an upstream path rewrite. unshift puts the
	// handler ahead of the built-ins, INCLUDING the catch-all proxy, which
	// would otherwise forward '/' to the engine before the redirect could
	// fire. (dev.setupMiddlewares is deprecated in favor of server.setup,
	// but it is the one API that guarantees that ordering.)
	// rrauthorigin: the registered web origin the shell's dev relay signs in
	// through — baked here so even a hand-typed localhost:<port> tab can
	// use the preview's Log in button.
	// _ts (stamped per session at wrapper generation) busts the browser's
	// cached index.html — a bare-origin open must not revive last session's
	// stitched html and its stale shell bundle.
	const previewPath = `/?appid=${encodeURIComponent(appId)}&rrdev=1&rrauthorigin=${encodeURIComponent(webOriginFor(engineOrigin))}&_ts=${Date.now()}${opts.signedOut ? '#rrtoken=' : ''}`;
	const redirectBlock = opts.injectPreviewParams
		? `
		// Bare front door → canonical preview URL (terminal hosts): a tab
		// opened on plain localhost:<port> self-registers without the user
		// pasting params — and a sign-in round-trip that lands back on '/'
		// re-applies them. URLs already carrying a query pass through.
		setupMiddlewares: [(middlewares) => {
			middlewares.unshift((req, res, next) => {
				if (req.url === '/') {
					res.writeHead(302, { Location: ${JSON.stringify(previewPath)} });
					res.end();
					return;
				}
				next();
			});
		}],`
		: '';
	const portLine = opts.port ? `
		// Host-requested port override (--port); outranks the app config's
		// pinned port. rsbuild still auto-bumps when it is busy.
		port: ${Math.floor(opts.port)},` : '';
	return `// GENERATED by RocketRide app-dev — do not edit, do not commit.
// Turns this app's dev server into a passthrough proxy for the preview
// shell (local-first dev). Regenerated on every dev-session start.
import { mergeRsbuildConfig } from '@rsbuild/core';
import appConfigExport from ${JSON.stringify(importPath)};

// defineConfig(() => ({...})) exports a FUNCTION — it must be invoked
// before merging, or mergeRsbuildConfig silently produces a config with
// the app's plugins (Module Federation included) missing.
const appConfig = typeof appConfigExport === 'function'
	? appConfigExport({ env: 'development', command: 'dev', envMode: 'development' })
	: appConfigExport;

const ENGINE = ${JSON.stringify(engineOrigin)};
const DEV_PREFIX = ${JSON.stringify(devPrefix)};

export default mergeRsbuildConfig(appConfig, {
	dev: {
		// DEV asset prefix (output.assetPrefix is prod-only): remoteEntry,
		// chunks, and HMR updates serve under the app's own /dev/ namespace
		// so URLs resolve exactly like a published version would, one path
		// segment over (v<N> still proxies to the server).
		assetPrefix: \`\${DEV_PREFIX}/\`,
		// Same-origin — the HMR client follows the page location instead
		// of a pinned localhost port.
		client: { protocol: 'ws', host: '', port: '' },${redirectBlock}
	},
	output: {
		// The manifest (and icon) ride the compiled output, so the
		// URL-convention self-registration reads them through the normal
		// asset pipeline — no extra serving path exists.
		copy: [${copyEntries}],
	},
	server: {${portLine}
		proxy: [
			{
				// step: catch-all passthrough — everything NOT locally
				// served goes to the engine, websockets tunneled raw. The
				// proxy runs BEFORE the asset middleware, so the dev prefix
				// and the HMR socket are carved out by glob. rsbuild 2 rides
				// http-proxy-middleware v3: the matcher key is pathFilter
				// ('context' is v2 and is silently ignored — everything
				// would proxy).
				pathFilter: ['**', \`!\${DEV_PREFIX}/**\`, '!/rsbuild-hmr', '!/rsbuild-hmr/**'],
				target: ENGINE,
				ws: true,
				changeOrigin: true,
				// Set-Cookie must arrive untouched (path=/apps prime).
				cookieDomainRewrite: '',
			},
		],
	},
});
`;
}

/**
 * Writes the per-session wrapper config into the app's .rocketride dir.
 *
 * @param appFolder - Absolute path of the app project folder.
 * @param appId - The dev app's id.
 * @param engineOrigin - The connected engine origin to proxy to.
 * @param opts - Per-host knobs (see {@link WrapperOptions}); omitted, the
 *               wrapper is byte-identical to the pre-option output.
 * @returns Absolute path of the wrapper file (for `--config`).
 */
export async function writeProxyConfig(appFolder: string, appId: string, engineOrigin: string, opts: WrapperOptions = {}): Promise<string> {
	const dir = path.join(appFolder, '.rocketride');
	await mkdir(dir, { recursive: true });
	// step: sweep wrappers this process left behind (a new start supersedes
	// them) and wrappers whose owning process is dead — a LIVE other process
	// keeps its own wrapper, so concurrent sessions never clobber each other
	try {
		for (const name of await readdir(dir)) {
			const owner = WRAPPER_PATTERN.exec(name);
			if (!owner) continue;
			const pid = Number(owner[1]);
			if (pid === process.pid || !isAlive(pid)) await rm(path.join(dir, name), { force: true });
		}
	} catch { /* best-effort sweep */ }
	const wrapperPath = path.join(dir, `dev-proxy.${process.pid}-${randomBytes(4).toString('hex')}.rsbuild.config.mts`);
	// step: resolve the config file the app ACTUALLY has, in rsbuild's OWN
	// selection order (DEFAULT_CONFIG_FILE_NAMES in @rsbuild/core) — the
	// wrapper must merge the same file a plain `rsbuild dev` would load, and
	// importing a missing file crashes rsbuild through the respawn budget
	let appConfigPath = path.join(appFolder, 'rsbuild.config.mts');
	for (const name of ['rsbuild.config.ts', 'rsbuild.config.js', 'rsbuild.config.mts', 'rsbuild.config.mjs', 'rsbuild.config.cts', 'rsbuild.config.cjs']) {
		const candidate = path.join(appFolder, name);
		try {
			await access(candidate);
			appConfigPath = candidate;
			break;
		} catch { /* try the next form */ }
	}
	// step: manifest always rides; the icon rides when the manifest names
	// one (relative, normalized — absolute/traversal paths never copy)
	const copyFiles = ['package.json'];
	try {
		const pkg = JSON.parse(await readFile(path.join(appFolder, 'package.json'), 'utf8')) as { appManifest?: { icon?: string } };
		const icon = pkg.appManifest?.icon;
		if (typeof icon === 'string' && icon) {
			const rel = icon.replace(/^\.\//, '').replace(/\\/g, '/');
			if (!rel.startsWith('/') && !rel.split('/').includes('..')) copyFiles.push(rel);
		}
	} catch { /* unreadable manifest — the entry notification reads it again later */ }
	await writeFile(wrapperPath, renderWrapper(appId, engineOrigin, appConfigPath, copyFiles, opts), 'utf8');
	return wrapperPath;
}
