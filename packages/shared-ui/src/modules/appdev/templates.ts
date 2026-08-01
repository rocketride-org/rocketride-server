// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * App scaffolder templates — the file trees `rocketride.app.create` writes.
 *
 * Templates are code-defined trees (path → rendered content) so one renderer
 * serves any host. NOTE: the web App Builder (M3) reuses these by lifting
 * this module into a shared package (packages/appdev-templates); keep it
 * free of vscode imports.
 *
 * Every generated file carries the project MIT header. The MF rsbuild shape
 * mirrors apps/hello-ui exactly: exposes ./AppDescriptor, dts:false,
 * runtime:false, shareStrategy 'loaded-first', react/react-dom eager
 * singletons, shell-ui/shared/rocketride import:false, assetPrefix 'auto'.
 */

// =============================================================================
// TYPES
// =============================================================================

/** Variables substituted into every template file. */
export interface TemplateVars {
	/** App id, e.g. 'acme.brandy'. */
	appId: string;
	/** Display name, e.g. 'Brand Studio'. */
	appName: string;
	/** MF container name (dots/hyphens → underscores). */
	moduleId: string;
	/** Dev-server port for `rsbuild dev`. */
	port: number;
	/** Preview URL the launch config opens (engine shell + appid + rrdev). */
	previewUrl: string;
}

/** One rendered file of a scaffolded app. */
export interface TemplateFile {
	/** Project-relative path (POSIX separators). */
	path: string;
	/** Full file content. */
	content: string;
}

/** Available template names (QuickPick order). */
export const TEMPLATE_NAMES = ['Blank', 'Dashboard'] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

// =============================================================================
// SHARED SNIPPETS
// =============================================================================

/** The project MIT header for generated TS/TSX files. */
const TS_HEADER = `// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================
`;

/** package.json — appManifest binding + hello-ui-matched toolchain pins. */
function packageJson(v: TemplateVars): string {
	return `${JSON.stringify(
		{
			name: v.appId.replace(/\./g, '-'),
			version: '0.1.0',
			private: true,
			// ESM package: rsbuild.config.ts uses import syntax — without this
			// Node re-parses the config per run (MODULE_TYPELESS_PACKAGE_JSON)
			type: 'module',
			description: `${v.appName} — a RocketRide app`,
			license: 'MIT',
			appManifest: {
				id: v.appId,
				publisher: 'local',
				name: v.appName,
				description: `${v.appName} — a RocketRide app`,
				categories: ['custom'],
				mode: 'free',
				authenticated: false,
			},
			scripts: {
				dev: 'rsbuild dev',
				build: 'rsbuild build',
			},
			dependencies: {
				rocketride: '^1.0.0',
				react: '^18.2.0',
				'react-dom': '^18.2.0',
			},
			devDependencies: {
				// EXACT pin: the container must run against the shell's MF
				// runtime generation — a floating range drifts ahead of the
				// shell's installed plugin and breaks share negotiation.
				'@module-federation/rsbuild-plugin': '2.5.1',
				'@rsbuild/core': '~2.0.11',
				'@rsbuild/plugin-react': '~2.0.1',
				'@types/react': '^18.2.0',
				'@types/react-dom': '^18.2.0',
				// Fallback copy for the shared 'react-refresh/runtime' (HMR);
				// the dev-flavor preview shell's copy wins at runtime.
				'react-refresh': '^0.14.2',
				typescript: '^5.3.0',
			},
		},
		null,
		2,
	)}\n`;
}

/**
 * rsbuild.config.ts — the standalone MF remote shape from
 * docs/README-apps.md: moduleId derived from appManifest.id in-config, the
 * src/index.ts async boundary as the entry, rocketride/app-sdk shared.
 */
function rsbuildConfig(v: TemplateVars): string {
	return `${TS_HEADER}
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

// Module Federation remote: the shell loads ./AppDescriptor at runtime.
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const moduleId = (pkg.appManifest?.id ?? 'unknown').replace(/[^a-zA-Z0-9_$]/g, '_');

export default defineConfig(() => ({
	plugins: [
		pluginReact(),
		pluginModuleFederation({
			name: moduleId,
			filename: 'remoteEntry.js',
			exposes: { './AppDescriptor': './src/AppDescriptor.ts' },
			dts: false,
			shared: {
				react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				'rocketride/app-sdk': { singleton: true, requiredVersion: false },
				// Platform modules are CONSUMED from the shell's share scope at
				// runtime, never bundled (import: false): the app repo needs no
				// platform checkout to build — editor types come from the
				// vendored types/rocketride-shell/ (tsconfig paths).
				'shell-ui': { singleton: true, requiredVersion: false, import: false },
				'shared': { singleton: true, requiredVersion: false, import: false },
				// react-refresh/runtime is deliberately NOT shared: the app's
				// own copy late-attaches to the devtools hook the dev-flavor
				// shell created BEFORE react-dom loaded (injectIntoGlobalHook
				// supports coexisting copies), and MF eager-consume of it
				// inside a remote hard-fails the container.
			},
		}),
	],
	server: { port: ${v.port} },
	// hmr on, liveReload OFF: hot updates apply in place (the dev-flavor
	// preview shell carries development React + the refresh runtime), and a
	// FAILED hot update surfaces as an error instead of location.reload()ing
	// the embedding shell — the page-reload fallback is what looped forever.
	// lazyCompilation stays off: compile-on-request made every served bundle
	// one hash behind, so the dev client always saw itself as stale.
	// client: the bundle runs INSIDE the preview shell's page (a different
	// origin) — without an explicit host the client derives its WebSocket URL
	// from that page's location and never reaches this dev server. '<port>'
	// is rsbuild's runtime placeholder for the ACTUAL port, so dynamic port
	// assignment keeps working.
	dev: { hmr: true, liveReload: false, lazyCompilation: false, client: { protocol: 'ws', host: 'localhost', port: '<port>' } },
	source: { entry: { index: './src/index.ts' } },
	output: { assetPrefix: 'auto' },
}));
`;
}

/** src/index.ts — the Module Federation async boundary (required). */
function asyncBoundary(): string {
	return `${TS_HEADER}
// Module Federation async boundary — see docs/README-apps.md.
import('./AppDescriptor');
`;
}

/** tsconfig.json for the scaffolded app. */
function tsconfigJson(): string {
	return `${JSON.stringify(
		{
			compilerOptions: {
				target: 'ES2020',
				lib: ['DOM', 'DOM.Iterable', 'ES2020'],
				module: 'ESNext',
				moduleResolution: 'bundler',
				jsx: 'react-jsx',
				strict: true,
				skipLibCheck: true,
				noEmit: true,
				// Platform types come from the VENDORED bundle the App Builder
				// maintains (types/rocketride-shell/) — the modules themselves
				// arrive from the shell's share scope at runtime, so nothing
				// platform-side is ever installed or checked out.
				paths: {
					'shell-ui': ['./types/rocketride-shell/shell-ui/index.d.ts'],
					shared: ['./types/rocketride-shell/shared/index.d.ts'],
				},
			},
			include: ['src', 'types'],
		},
		null,
		2,
	)}\n`;
}

/** .vscode/launch.json — F5 opens the preview in a real browser (D2). */
function launchJson(v: TemplateVars): string {
	return `${JSON.stringify(
		{
			version: '0.2.0',
			configurations: [
				{
					name: `Debug ${v.appName}`,
					type: 'msedge',
					request: 'launch',
					url: v.previewUrl,
					webRoot: '${workspaceFolder}',
					sourceMapPathOverrides: {
						'webpack:///./*': '${workspaceFolder}/*',
						'webpack:///*': '*',
					},
				},
			],
		},
		null,
		2,
	)}\n`;
}

/** src/AppDescriptor.ts — the single MF expose. */
function appDescriptor(v: TemplateVars): string {
	return `${TS_HEADER}
/**
 * AppDescriptor — the one module this app exposes to the RocketRide shell.
 * The shell lazy-loads it on activation and renders components.App.
 */

import type { AppDescriptor } from 'rocketride/app-sdk';
import App from './App';

const descriptor: AppDescriptor = {
	id: '${v.appId}',
	name: '${v.appName}',
	branding: { appName: '${v.appName}' },
	components: { App },
};

export default descriptor;
`;
}

// =============================================================================
// TEMPLATE BODIES
// =============================================================================

/** Blank template: a single hello screen. */
function blankApp(v: TemplateVars): string {
	return `${TS_HEADER}
/**
 * ${v.appName} — root component rendered by the RocketRide shell.
 */

import React from 'react';
import type { ShellAppProps } from 'rocketride/app-sdk';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: { padding: 40, fontFamily: 'var(--rr-font-family, system-ui)' },
	title: { fontSize: 22, fontWeight: 600, color: 'var(--rr-text-primary)' },
	sub: { marginTop: 8, fontSize: 13, color: 'var(--rr-text-secondary)' },
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Root view — replace with your app. */
const App: React.FC<ShellAppProps> = ({ isConnected, identity }) => (
	<div style={styles.wrap}>
		<h1 style={styles.title}>${v.appName}</h1>
		<p style={styles.sub}>Edit src/App.tsx and save — the preview reloads automatically.</p>
		<p style={styles.sub}>Connected: {isConnected ? 'yes' : 'no'} · User: {identity?.displayName ?? 'not signed in'}</p>
	</div>
);

export default App;
`;
}

/** Dashboard template: stat cards + a bar chart, token-styled. */
function dashboardApp(v: TemplateVars): string {
	return `${TS_HEADER}
/**
 * ${v.appName} — dashboard root rendered by the RocketRide shell.
 */

import React from 'react';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: { padding: '18px 22px', fontFamily: 'var(--rr-font-family, system-ui)' },
	title: { fontSize: 17, fontWeight: 600, color: 'var(--rr-text-primary)' },
	sub: { fontSize: 12, color: 'var(--rr-text-secondary)', marginBottom: 16 },
	row: { display: 'flex', gap: 12, marginBottom: 16 },
	card: { flex: 1, border: '1px solid var(--rr-border)', borderRadius: 8, padding: '12px 14px', background: 'var(--rr-bg-paper)' },
	label: { fontSize: 10.5, color: 'var(--rr-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' },
	value: { fontSize: 22, fontWeight: 700, marginTop: 4, color: 'var(--rr-text-primary)' },
	chart: { border: '1px solid var(--rr-border)', borderRadius: 8, background: 'var(--rr-bg-paper)', padding: 14 },
	bars: { display: 'flex', alignItems: 'flex-end', gap: 8, height: 96 },
	bar: { flex: 1, background: 'var(--rr-brand)', opacity: 0.75, borderRadius: '3px 3px 0 0' },
};

// Demo series — replace with live data from your pipelines.
const SERIES = [42, 55, 38, 64, 71, 52, 60, 78, 66, 83, 74, 90];

// =============================================================================
// COMPONENT
// =============================================================================

/** Dashboard view: three stat cards + a 12-point bar chart. */
const App: React.FC = () => (
	<div style={styles.wrap}>
		<div style={styles.title}>${v.appName}</div>
		<div style={styles.sub}>Live overview</div>
		<div style={styles.row}>
			<div style={styles.card}><div style={styles.label}>Items</div><div style={styles.value}>12,408</div></div>
			<div style={styles.card}><div style={styles.label}>Success</div><div style={styles.value}>96.4%</div></div>
			<div style={styles.card}><div style={styles.label}>Pending</div><div style={styles.value}>37</div></div>
		</div>
		<div style={styles.chart}>
			<div style={styles.bars}>
				{SERIES.map((h, i) => (
					<div key={i} style={{ ...styles.bar, height: \`\${h}%\` }} />
				))}
			</div>
		</div>
	</div>
);

export default App;
`;
}

// =============================================================================
// RENDER
// =============================================================================

/**
 * Renders a template into its file tree.
 *
 * @param name - Template name from TEMPLATE_NAMES.
 * @param vars - Substitution variables.
 * @returns The files to write into the new app folder.
 */
export function renderTemplate(name: TemplateName, vars: TemplateVars): TemplateFile[] {
	const files: TemplateFile[] = [
		{ path: 'package.json', content: packageJson(vars) },
		// The app DOCUMENT (.pipe-style): opening this file is opening the
		// app in the App Builder; it carries the binding id as JSON.
		{ path: `${vars.appId.split('.').pop()}.rrapp`, content: `${JSON.stringify({ id: vars.appId }, null, 2)}\n` },
		{ path: 'rsbuild.config.ts', content: rsbuildConfig(vars) },
		{ path: 'tsconfig.json', content: tsconfigJson() },
		{ path: '.vscode/launch.json', content: launchJson(vars) },
		{ path: '.gitignore', content: 'node_modules/\ndist/\n' },
		// Workspace boundary: app folders often land inside an enclosing pnpm
		// workspace (a monorepo checkout, a dist tree). This marks the app as
		// its OWN workspace root so `pnpm install` resolves here instead of
		// walking up — the app always gets a local node_modules.
		{ path: 'pnpm-workspace.yaml', content: "packages:\n  - '.'\n" },
		{ path: 'src/index.ts', content: asyncBoundary() },
		{ path: 'src/AppDescriptor.ts', content: appDescriptor(vars) },
		{ path: 'src/App.tsx', content: name === 'Dashboard' ? dashboardApp(vars) : blankApp(vars) },
	];
	return files;
}
