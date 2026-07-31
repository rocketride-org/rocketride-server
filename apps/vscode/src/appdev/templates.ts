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
				react: '^18.2.0',
				'react-dom': '^18.2.0',
			},
			devDependencies: {
				'@module-federation/rsbuild-plugin': '^2.5.1',
				'@rsbuild/core': '~2.0.11',
				'@rsbuild/plugin-react': '~2.0.1',
				'@types/react': '^18.2.0',
				'@types/react-dom': '^18.2.0',
				typescript: '^5.3.0',
			},
		},
		null,
		2,
	)}\n`;
}

/** rsbuild.config.ts — the MF remote shape (mirrors hello-ui). */
function rsbuildConfig(v: TemplateVars): string {
	return `${TS_HEADER}
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';

// Module Federation remote: the shell loads ./AppDescriptor at runtime.
// react/react-dom are eager singletons; shell-ui/shared/rocketride are
// import:false — the HOST provides the live instances (never bundle them).
export default defineConfig({
	plugins: [
		pluginReact(),
		pluginModuleFederation({
			name: '${v.moduleId}',
			filename: 'remoteEntry.js',
			exposes: { './AppDescriptor': './src/AppDescriptor.ts' },
			dts: false,
			runtime: false,
			shareStrategy: 'loaded-first',
			shared: {
				react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				'shell-ui': { singleton: true, requiredVersion: false, import: false },
				shared: { singleton: true, requiredVersion: false, import: false },
				rocketride: { singleton: true, requiredVersion: false, import: false },
			},
		}),
	],
	server: { port: ${v.port} },
	output: { assetPrefix: 'auto' },
});
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
			},
			include: ['src'],
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

import App from './App';

const descriptor = {
	id: '${v.appId}',
	name: '${v.appName}',
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
const App: React.FC = () => (
	<div style={styles.wrap}>
		<h1 style={styles.title}>${v.appName}</h1>
		<p style={styles.sub}>Edit src/App.tsx and save — the preview reloads automatically.</p>
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
		{ path: 'rsbuild.config.ts', content: rsbuildConfig(vars) },
		{ path: 'tsconfig.json', content: tsconfigJson() },
		{ path: '.vscode/launch.json', content: launchJson(vars) },
		{ path: '.gitignore', content: 'node_modules/\ndist/\n' },
		{ path: 'src/AppDescriptor.ts', content: appDescriptor(vars) },
		{ path: 'src/App.tsx', content: name === 'Dashboard' ? dashboardApp(vars) : blankApp(vars) },
	];
	return files;
}
