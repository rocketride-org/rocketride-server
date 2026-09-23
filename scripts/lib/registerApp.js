/**
 * registerApp — App self-registration action factory
 *
 * Returns an action object for use in a tasks.js bundle action.
 * Declares locks: ['apps-json'] so the action runner handles mutual
 * exclusion automatically — safe when multiple apps build concurrently.
 *
 * The app's package.json must have an appManifest field:
 *   "appManifest": {
 *     "id": "rocketride.pipeBuilder",
 *     "publisher": "Aparavi Software AG",
 *     "name": "RocketRide",
 *     "description": "Visual AI pipeline editor",
 *     "icon": "./src/icon.svg",
 *     "categories": ["pipelines", "ai"],
 *     "mode": "free",
 *     "shells": ["saas", "vscode"]
 *   }
 *
 * mode must be one of "free", "subscription", or "paywall".
 * "subscription" and "paywall" require stripeProductId to be set.
 * Default: "free" if no stripeProductId, "subscription" if stripeProductId present.
 *
 * shells is an optional array of compatible shells: "saas", "oss", "vscode".
 * Omitted means compatible with all shells.
 *
 * moduleId is derived from id by replacing non-identifier characters
 * with underscores (e.g. 'rocketride.pipeBuilder' → 'rocketride_pipeBuilder').
 * It does not need to be declared in package.json.
 *
 * The icon file is copied to the app's build output dir and served at:
 *   /${APPS_BASE_URL}/${appManifest.id}/icon.svg
 *
 * apps.json is written to both build/ (dev server publicDir) and
 * dist/server/static/ (production server static root).
 *
 * Usage in tasks.js:
 *   const { registerApp } = require('../../../scripts/lib/registerApp');
 *   { name: 'my-app:register', action: () => registerApp(APP_ROOT) }
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { BUILD_ROOT, DIST_ROOT, setState } = require('./index');

const BUILD_APPS_JSON = path.join(BUILD_ROOT, 'apps.json');
const DIST_APPS_JSON  = path.join(DIST_ROOT, 'server', 'static', 'apps.json');
const APPS_BASE       = process.env.APPS_BASE_URL ?? 'apps';

// Single source of truth for the shell contract version (freeze auto-writes it).
const APIVER_TS = path.join(__dirname, '..', '..', 'packages', 'shell', 'src', 'apiver.ts');

// Memoized across calls: apiver.ts is process-global and does not change during
// a build run, so it is read and parsed once (including a memoized null). This
// also guarantees every app registered in one run is stamped with an identical
// version even if the file were somehow rewritten mid-build. `undefined` = not
// yet read; a number or `null` = the settled result.
let _shellApiVersionCache;

/**
 * Reads the current shell-api contract version from the shell's apiver.ts. Every
 * app is built against the current shell, so we stamp this onto its apps.json
 * entry — recording, across all registered apps, the lowest version still in use
 * so obsolete frozen versions can be pruned safely. The result is cached after
 * the first call. Returns null if unparseable (registration still proceeds
 * without the field).
 *
 * @returns {number|null} The shell-api version, or null.
 */
function readShellApiVersion() {
	// Return the memoized result (including a memoized null) after the first read.
	if (_shellApiVersionCache !== undefined) return _shellApiVersionCache;
	try {
		const m = /SHELL_API_VERSION\s*=\s*(\d+)/.exec(fs.readFileSync(APIVER_TS, 'utf-8'));
		_shellApiVersionCache = m ? parseInt(m[1], 10) : null;
	} catch {
		_shellApiVersionCache = null;
	}
	return _shellApiVersionCache;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Reads an existing apps.json manifest from disk.
 * Returns { apps: [] } if the file doesn't exist or is invalid.
 *
 * @param {string} filePath - Path to apps.json.
 * @returns {{ apps: object[] }}
 */
function readManifest(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch {
		return { apps: [] };
	}
}

/**
 * Writes an apps.json manifest to disk, creating directories as needed.
 *
 * @param {string} filePath  - Path to apps.json.
 * @param {object} manifest  - The manifest object to write.
 */
function writeManifest(filePath, manifest) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
}

/**
 * Inserts or replaces an app entry in the manifest by appId.
 *
 * @param {object} manifest - Current manifest.
 * @param {object} entry    - New app entry.
 * @returns {object} Updated manifest.
 */
function upsert(manifest, entry) {
	return {
		apps: [
			...manifest.apps.filter(a => a.id !== entry.id),
			entry,
		],
	};
}

/**
 * Converts an appId to a valid JavaScript identifier for Module Federation.
 * Replaces dots, hyphens, and other non-identifier characters with underscores.
 *
 * @param {string} appId - The app identifier (e.g. 'rocketride.pipeBuilder').
 * @returns {string} A valid JS identifier (e.g. 'rocketride_pipeBuilder').
 */
function toModuleId(appId) {
	return appId.replace(/[^a-zA-Z0-9_$]/g, '_');
}

/**
 * Validates that an app id is a filesystem-safe slug before it is joined into a
 * build path or embedded in a public URL. The served directory and every public
 * URL (entry/icon/readme) key on the app id, so an id containing a path
 * separator or a ".." segment could write copies outside build/apps/ and emit a
 * broken public URL. App ids are dotted slugs (e.g. 'rocketride.hello'): letters,
 * digits, dot, hyphen and underscore are allowed; any ".." sequence is rejected,
 * as is an id that is ENTIRELY dots ('.', '...') — a bare '.' passes the
 * character class and the '..' check yet joins to the apps root itself, writing
 * copies beside every other app and emitting a '/apps/./…' entry URL.
 *
 * @param {string} appId - The app identifier to validate.
 * @throws {Error} When appId is not a safe slug.
 */
function assertSafeAppId(appId) {
	if (typeof appId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(appId) || appId.includes('..') || /^\.+$/.test(appId)) {
		throw new Error(
			`App id "${appId}" is not a valid slug. `
			+ 'Must contain only letters, digits, ".", "-" and "_" (no path separators, no ".." segments, not all dots).'
		);
	}
}

// =============================================================================
// REGISTER APP
// =============================================================================

/**
 * Creates an action that registers an app into apps.json.
 *
 * @param {string} appRoot - Absolute path to the app's root directory.
 * @returns {object} Action object with locks and run function.
 */
function registerApp(appRoot) {
	return {
		locks: ['apps-json'],
		run: async (ctx, task) => {
			// Read the app's package.json
			let pkg;
			try {
				pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf-8'));
			} catch {
				task.skip('package.json not found');
				return;
			}

			const { appManifest } = pkg;
			if (!appManifest) {
				task.skip('No appManifest field — skipping registration');
				return;
			}

			// The app id is joined into the build path and embedded in every
			// public URL (entry/icon/readme) below, so it MUST be a
			// filesystem-safe slug — an id with a path separator or a ".."
			// segment could write copies outside build/apps/.
			assertSafeAppId(appManifest.id);

			// The SERVED name is the app id, not the source folder: rsbuild
			// bundles to build/apps/<appId>, appModule's copy step lands it at
			// dist/server/static/apps/<appId>/, so every public URL
			// (entry/icon/readme) points there and the server authorizes each
			// fetch by app id. The icon/readme copies below MUST target the
			// same appId dir — keying them on the source folder name would
			// recreate the old build/apps/<folder>-ui dirs.
			const servedName = appManifest.id;
			const buildDir = path.join(BUILD_ROOT, APPS_BASE, servedName);

			// Derive moduleId from appId
			const moduleId = appManifest.moduleId ?? toModuleId(appManifest.id);

			// The shell contract version this app was built against.
			const shellApiVersion = readShellApiVersion();

			// Resolve app mode — default based on stripeProductId presence
			const mode = appManifest.mode
				?? (appManifest.stripeProductId ? 'subscription' : 'free');

			// Note: subscription/paywall apps get their stripeProductId at runtime
			// via seed_apps → ensure_stripe_billing, not at build time.

			// Validate mode value
			if (!['free', 'subscription', 'paywall'].includes(mode)) {
				throw new Error(
					`App "${appManifest.id}" has invalid mode="${mode}". `
					+ 'Must be "free", "subscription", or "paywall".'
				);
			}

			// Validate the app's settings contribution — the VSCode
			// contributes.configuration shape: { title?, properties: { <key>: schema } }.
			// Keys must be dotted and prefixed with the app id so they are globally
			// unique, and every schema needs a valid JSON type.
			const configuration = appManifest.contributes?.configuration ?? null;
			if (configuration) {
				if (typeof configuration !== 'object' || Array.isArray(configuration)
					|| typeof configuration.properties !== 'object' || Array.isArray(configuration.properties)) {
					throw new Error(
						`App "${appManifest.id}" has an invalid contributes.configuration. `
						+ 'Expected { title?, properties: { "<appId>.<setting>": { type, ... } } }.'
					);
				}
				const validTypes = ['string', 'number', 'integer', 'boolean'];
				for (const [key, schema] of Object.entries(configuration.properties)) {
					if (!key.startsWith(`${appManifest.id}.`)) {
						throw new Error(
							`App "${appManifest.id}" setting "${key}" must be prefixed with the app id `
							+ `("${appManifest.id}.<settingName>") so setting keys are globally unique.`
						);
					}
					if (!schema || !validTypes.includes(schema.type)) {
						throw new Error(
							`App "${appManifest.id}" setting "${key}" has invalid type `
							+ `"${schema && schema.type}". Must be one of: ${validTypes.join(', ')}.`
						);
					}
				}
			}

			// Warnings accumulate here and surface joined with the final success
			// line — task.output holds a single value, so direct assignments
			// earlier in the run would be silently overwritten by later ones.
			const warnings = [];

			// Resolve shells — optional array of compatible shells
			const shells = appManifest.shells ?? null;
			if (shells !== null) {
				const valid = ['saas', 'oss', 'vscode'];
				for (const s of shells) {
					if (!valid.includes(s)) {
						throw new Error(
							`App "${appManifest.id}" has invalid shell="${s}". `
							+ `Must be one of: ${valid.join(', ')}.`
						);
					}
				}
			}

			// Copy icon to the app's build output dir
			let icon = '';
			if (appManifest.icon) {
				const iconSrc = path.resolve(appRoot, appManifest.icon);
				try {
					fs.mkdirSync(buildDir, { recursive: true });
					fs.copyFileSync(iconSrc, path.join(buildDir, 'icon.svg'));
					icon = `/${APPS_BASE}/${servedName}/icon.svg`;
				} catch {
					warnings.push(`Warning: icon not found at ${appManifest.icon}`);
				}
			}

			// Copy readme to the app's build output dir
			let readme = '';
			if (appManifest.readme) {
				const readmeSrc = path.resolve(appRoot, appManifest.readme);
				try {
					fs.mkdirSync(buildDir, { recursive: true });
					fs.copyFileSync(readmeSrc, path.join(buildDir, 'README.md'));
					readme = `/${APPS_BASE}/${servedName}/README.md`;

					// Copy sibling assets/ directory if it exists (images referenced by the README)
					const assetsSrc = path.join(path.dirname(readmeSrc), 'assets');
					const assetsDst = path.join(buildDir, 'assets');
					if (fs.existsSync(assetsSrc) && fs.statSync(assetsSrc).isDirectory()) {
						fs.mkdirSync(assetsDst, { recursive: true });
						for (const file of fs.readdirSync(assetsSrc)) {
							const srcFile = path.join(assetsSrc, file);
							if (fs.statSync(srcFile).isFile()) {
								fs.copyFileSync(srcFile, path.join(assetsDst, file));
							}
						}
					}
				} catch {
					warnings.push(`Warning: readme not found at ${appManifest.readme}`);
				}
			}

			// Build the apps.json entry
			const appEntry = {
				id:            appManifest.id,
				moduleId,
				publisher:     appManifest.publisher ?? '',
				name:          appManifest.name,
				description:   appManifest.description ?? '',
				// Built-in app version (package.json) — surfaces on the desktop
				// tile version chip; SaaS marketplace apps get theirs from the
				// active AppVersion row in enrich_apps instead.
				...(pkg.version ? { version: pkg.version } : {}),
				readme,
				icon,
				categories:    appManifest.categories ?? [],
				// Settings contribution (VSCode contributes.configuration shape)
				...(configuration ? { configuration } : {}),
				entry:         `/${APPS_BASE}/${servedName}/remoteEntry.js`,
				// Shell contract version this app was built against (for prune analysis).
				...(shellApiVersion !== null ? { shellApiVersion } : {}),
				// App monetization mode
				mode,
				// Shell compatibility filter (omitted = all shells)
				...(shells ? { shells } : {}),
				// Include authenticated only when explicitly false
				...(appManifest.authenticated === false ? { authenticated: false } : {}),
				// Include showHeader only when explicitly false
				...(appManifest.showHeader === false ? { showHeader: false } : {}),
				// Include showStatusBar only when explicitly false
				...(appManifest.showStatusBar === false ? { showStatusBar: false } : {}),
				// stripeProductId is NOT included — it is created at runtime by
				// seed_apps → ensure_stripe_billing and stored in the DB only.
				// Include public only when explicitly false (default is true)
				...(appManifest.public === false ? { public: false } : {}),
				// Include billing section (plans array) for seed_apps to provision Stripe products
				...(appManifest.billing ? { billing: appManifest.billing } : {}),
				// Permission-gated apps — user must hold ALL listed sysPermissions to see the app
				...(Array.isArray(appManifest.requiredPermissions)
					&& appManifest.requiredPermissions.length
					&& appManifest.requiredPermissions.every((p) => typeof p === 'string' && p.length > 0)
					? { requiredPermissions: appManifest.requiredPermissions }
					: {}),
			};

			// Upsert into build/apps.json (dev server publicDir)
			writeManifest(BUILD_APPS_JSON, upsert(readManifest(BUILD_APPS_JSON), appEntry));

			// Upsert into dist/server/static/apps.json (production server)
			writeManifest(DIST_APPS_JSON, upsert(readManifest(DIST_APPS_JSON), appEntry));

			// Register apps.json for packaging so it's included in release archives
			await setState(['package', DIST_APPS_JSON], ['static/apps.json']);

			// Success line last; accumulated warnings surface above it instead of
			// being clobbered by it.
			task.output = [...warnings, `Registered "${appEntry.name}" (${appEntry.id}) → ${appEntry.entry}`].join('\n');
		},
	};
}

module.exports = { registerApp, assertSafeAppId };
