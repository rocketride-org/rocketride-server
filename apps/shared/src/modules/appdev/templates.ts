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
 * The generated App.tsx is composed from FrameOptions — sidebar, status
 * footer, and document tabs each toggle a chrome region of the scaffolded
 * AppLayout, so the New App wizard's frame checkboxes map 1:1 onto the
 * emitted code.
 *
 * Every generated file carries the project MIT header. The MF rsbuild shape
 * mirrors apps/hello-ui exactly: exposes ./AppDescriptor, dts:false,
 * runtime:false, shareStrategy 'loaded-first', react/react-dom eager
 * singletons, shell/rocketride import:false, assetPrefix 'auto'.
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
	/** Publisher slug for appManifest.publisher — the organization developer id, or 'local' when none. */
	publisher: string;
	/** MF container name (dots/hyphens → underscores). */
	moduleId: string;
	/** Dev-server port for `rsbuild dev`. */
	port: number;
	/** Preview URL the launch config opens (engine shell + appid + rrdev). */
	previewUrl: string;
}

/** Composable frame options — each toggles a chrome region of the scaffolded app. */
export interface FrameOptions {
	/** Two-column layout with a navigation sidebar on the left. */
	sidebar: boolean;
	/** Status bar across the bottom of the app (AppLayout showStatus). */
	statusFooter: boolean;
	/** Document tab strip across the content area (Documents + DocSplitLayout + DocTabs). */
	docTabs: boolean;
}

/** Frame used when the caller passes none — matches the pre-options scaffold shape. */
const DEFAULT_FRAME: FrameOptions = { sidebar: false, statusFooter: true, docTabs: false };

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
				publisher: v.publisher,
				name: v.appName,
				description: `${v.appName} — a RocketRide app`,
				categories: ['custom'],
				mode: 'free',
				authenticated: false,
			},
			scripts: {
				dev: 'rsbuild dev',
				// rsbuild transpiles WITHOUT typechecking, so build runs tsc
				// first — type errors must fail the build, not sit silent.
				build: 'tsc --noEmit && rsbuild build',
				typecheck: 'tsc --noEmit',
			},
			dependencies: {
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
 * src/index.ts async boundary as the entry, shell shared.
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
				// Platform modules are CONSUMED from the shell's share scope at
				// runtime, never bundled (import: false): the app repo needs no
				// platform checkout to build — editor types come from the
				// installed shell package (the workspace's vendored shell.tgz).
				'shell': { singleton: true, requiredVersion: false, import: false },
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
				target: 'ES2022',
				lib: ['DOM', 'DOM.Iterable', 'ES2022'],
				module: 'ESNext',
				moduleResolution: 'bundler',
				jsx: 'react-jsx',
				strict: true,
				skipLibCheck: true,
				noEmit: true,
				// Platform types resolve from the INSTALLED shell package (the
				// workspace's vendored .rocketride/shell/shell.tgz, wired as the
				// app's "shell" dependency) — the modules themselves arrive from
				// the shell's share scope at runtime, so nothing platform-side
				// is ever checked out or copied into the app.
			},
			include: ['src'],
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
 * The shell lazy-loads it on activation and renders \`app\` raw; the app
 * declares its layout inside with <AppLayout>.
 */

import type { AppDescriptor } from 'shell';
import App from './App';

const descriptor: AppDescriptor = {
	id: '${v.appId}',
	name: '${v.appName}',
	branding: { appName: '${v.appName}' },
	app: App,
};

export default descriptor;
`;
}

// =============================================================================
// FRAME COMPOSITION
// =============================================================================

/** Named import list for 'shell' — AppLayout plus the docs trio when tabbed. */
function shellImports(o: FrameOptions): string {
	// step: only tabbed frames pull the document-model components
	const names = ['AppLayout'];
	if (o.docTabs) names.push('Documents', 'DocSplitLayout', 'DocTabs');
	return `import { ${names.join(', ')} } from 'shell';`;
}

/** Extra style entries the frame options contribute (nav styles for the sidebar). */
function frameStyles(o: FrameOptions): string {
	if (!o.sidebar) return '';
	return `
	nav: { padding: '10px 8px' },
	navItem: { padding: '6px 10px', borderRadius: 6, fontSize: 13, color: 'var(--rr-text-primary)', cursor: 'pointer' },`;
}

/** The app-owned Documents model section (module scope), when tabbed. */
function docsModel(o: FrameOptions): string {
	if (!o.docTabs) return '';
	return `
// =============================================================================
// DOCUMENTS
// =============================================================================

// The app OWNS its document model — the shell never sees it. No VFS is wired
// here, so documents are static; pass an IVirtualFileSystem to open real files.
const docs = new Documents();
docs.openStaticDocument('welcome', 'Welcome');
`;
}

/** The sidebar navigation component, when the two-column frame is on. */
function sidebarNav(o: FrameOptions): string {
	if (!o.sidebar) return '';
	return `
/** Sidebar navigation — replace the items with your app's sections. */
const SidebarNav: React.FC = () => (
	<div style={styles.nav}>
		<div style={styles.navItem}>Overview</div>
		<div style={styles.navItem}>Activity</div>
		<div style={styles.navItem}>Settings</div>
	</div>
);
`;
}

/**
 * The App component's JSX — AppLayout with the option-selected props wrapping
 * either the raw content or the DocSplitLayout/DocTabs pane tree.
 *
 * @param o - Frame options driving the composition.
 * @param content - A single self-closing content element, e.g. '<Content />'.
 */
function appJsx(o: FrameOptions, content: string): string {
	// step: AppLayout props from the frame options
	const props = [o.sidebar ? ' sidebar={<SidebarNav />}' : '', o.statusFooter ? ' showStatus' : ''].join('');
	// step: plain frame — content fills the client area directly
	if (!o.docTabs) {
		return `	<AppLayout${props}>
		${content}
	</AppLayout>`;
	}
	// step: tabbed frame — the split tree renders a tab strip per pane
	return `	<AppLayout${props}>
		<DocSplitLayout
			docs={docs}
			renderPane={(groupId) => (
				<>
					<DocTabs docs={docs} groupId={groupId} isActive />
					${content}
				</>
			)}
		/>
	</AppLayout>`;
}

// =============================================================================
// TEMPLATE BODIES
// =============================================================================

/** Blank template: a hello screen composed into the selected frame. */
function blankApp(v: TemplateVars, o: FrameOptions): string {
	return `${TS_HEADER}
/**
 * ${v.appName} — root component rendered by the RocketRide shell.
 */

import React from 'react';
import type { ShellAppProps } from 'shell';
${shellImports(o)}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: { padding: 40, fontFamily: 'var(--rr-font-family, system-ui)' },
	title: { fontSize: 22, fontWeight: 600, color: 'var(--rr-text-primary)' },
	sub: { marginTop: 8, fontSize: 13, color: 'var(--rr-text-secondary)' },${frameStyles(o)}
};
${docsModel(o)}
// =============================================================================
// COMPONENT
// =============================================================================
${sidebarNav(o)}
/** Client-area content — replace with your app. */
const Content: React.FC<ShellAppProps> = ({ isConnected, identity }) => (
	<div style={styles.wrap}>
		<h1 style={styles.title}>${v.appName}</h1>
		<p style={styles.sub}>Edit src/App.tsx and save — the preview reloads automatically.</p>
		<p style={styles.sub}>Connected: {isConnected ? 'yes' : 'no'} · User: {identity?.displayName ?? 'not signed in'}</p>
	</div>
);

/**
 * Root view — AppLayout declares the frame the wizard selected; recompose
 * its props (\`sidebar\`, \`showStatus\`) to change it.
 */
const App: React.FC<ShellAppProps> = (props) => (
${appJsx(o, '<Content {...props} />')}
);

export default App;
`;
}

/** Dashboard template: stat cards + a bar chart, token-styled, composed into the selected frame. */
function dashboardApp(v: TemplateVars, o: FrameOptions): string {
	return `${TS_HEADER}
/**
 * ${v.appName} — dashboard root rendered by the RocketRide shell.
 */

import React from 'react';
${shellImports(o)}

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
	bar: { flex: 1, background: 'var(--rr-brand)', opacity: 0.75, borderRadius: '3px 3px 0 0' },${frameStyles(o)}
};

// Demo series — replace with live data from your pipelines.
const SERIES = [42, 55, 38, 64, 71, 52, 60, 78, 66, 83, 74, 90];
${docsModel(o)}
// =============================================================================
// COMPONENT
// =============================================================================
${sidebarNav(o)}
/** Dashboard content: three stat cards + a 12-point bar chart. */
const Content: React.FC = () => (
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

/**
 * Root view — AppLayout declares the frame the wizard selected; recompose
 * its props (\`sidebar\`, \`showStatus\`) to change it.
 */
const App: React.FC = () => (
${appJsx(o, '<Content />')}
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
 * @param frame - Frame options composing the generated App.tsx; defaults to
 *                the pre-options shape (status footer only).
 * @returns The files to write into the new app folder.
 */
export function renderTemplate(name: TemplateName, vars: TemplateVars, frame: FrameOptions = DEFAULT_FRAME): TemplateFile[] {
	const files: TemplateFile[] = [
		{ path: 'package.json', content: packageJson(vars) },
		// The app DOCUMENT (.pipe-style): opening this file is opening the
		// app in the App Builder; it carries the binding id as JSON.
		{ path: `${vars.appId.split('.').pop()}.rrapp`, content: `${JSON.stringify({ id: vars.appId }, null, 2)}\n` },
		{ path: 'rsbuild.config.ts', content: rsbuildConfig(vars) },
		{ path: 'tsconfig.json', content: tsconfigJson() },
		{ path: 'src/index.ts', content: asyncBoundary() },
		{ path: 'src/AppDescriptor.ts', content: appDescriptor(vars) },
		{ path: 'src/App.tsx', content: name === 'Dashboard' ? dashboardApp(vars, frame) : blankApp(vars, frame) },
	];
	return files;
}
