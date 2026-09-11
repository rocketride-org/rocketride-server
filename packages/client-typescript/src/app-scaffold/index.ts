// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * App scaffold templates — `rocketride/app-scaffold` (browser-safe).
 *
 * The CANONICAL file trees every scaffold host writes: the App Builder's
 * New App wizard, `deploy.createApp()`, and the `rocketride app create`
 * CLI all render from this one module. Templates are code-defined trees
 * (path → rendered content) so one renderer serves any host; this module
 * is PURE STRINGS — no Node imports — because the wizard's webview UI
 * imports it directly for previews.
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
			// npm forbids uppercase in package names; the app id may carry it
			name: v.appId.replace(/\./g, '-').toLowerCase(),
			version: '0.1.0',
			private: true,
			// No "type" field: the rsbuild config is .mts (self-declaring ESM),
			// so the package stays typeless and CJS helper scripts keep working.
			description: `${v.appName} — a RocketRide app`,
			license: 'MIT',
			appManifest: {
				id: v.appId,
				publisher: v.publisher,
				name: v.appName,
				description: `${v.appName} — a RocketRide app`,
				// Every scaffold ships a real icon + README so the PACKAGE tab's
				// readiness starts green and the tile never shows a bare glyph.
				icon: './icon.svg',
				readme: './README.md',
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
				// The SERVER-MATCHED client SDK, vendored by the platform into
				// .rocketride/client/ — the npm registry's `rocketride` can lag
				// the connected server badly, so apps pin the server's own
				// build exactly like the shell below. At runtime the shell
				// shares the client (MF import:false); this install supplies
				// the matching types and node-side tooling.
				rocketride: 'file:../../.rocketride/client/rocketride.tgz',
				// The platform package — vendored from the connected server.
				shell: 'file:../../.rocketride/shell/shell.tgz',
			},
			devDependencies: {
				// EXACT pin: the container must run against the shell's MF
				// runtime generation — a floating range drifts ahead of the
				// shell's installed plugin and breaks share negotiation.
				'@module-federation/rsbuild-plugin': '2.5.1',
				'@rsbuild/core': '~2.0.11',
				'@rsbuild/plugin-react': '~2.0.1',
				// The scaffolded rsbuild.config.mts imports node:fs/node:path
				// and uses __dirname, and tsconfig includes the config — so
				// Node type declarations are a REAL dependency of every app.
				// In-tree apps inherit this hoisted from the monorepo root; a
				// user workspace has no root to hoist from, so the app must
				// declare it (mirrors the platform root's pin).
				'@types/node': '^20.19.41',
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
 * rsbuild.config.mts — the standalone MF remote shape from
 * .rocketride/docs/ROCKETRIDE_APPS.md: moduleId derived from appManifest.id
 * in-config, the src/index.ts async boundary as the entry, shell shared.
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
			// runtime: false — the host (the shell) provides the MF runtime;
			// remotes don't embed their own copy, keeping remoteEntry.js
			// stable across app-code-only rebuilds.
			runtime: false,
			// loaded-first: use the host's already-loaded shared instances
			// instead of version-first's boot-time download of EVERY registered
			// remoteEntry.js just to compare shared versions (everything here
			// is singleton + co-deployed).
			shareStrategy: 'loaded-first',
			shared: {
				react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },
				// Platform modules are CONSUMED from the shell's share scope at
				// runtime, never bundled (import: false): the app repo needs no
				// platform checkout to build — editor types come from the
				// installed shell package (the workspace's vendored shell.tgz).
				'shell': { singleton: true, requiredVersion: false, import: false },
				// The SDK surface — runtime values (protocol classes, enums,
				// constants) resolve to the host's singleton so class identity
				// holds across the container boundary.
				'rocketride': { singleton: true, requiredVersion: false, import: false },
				// react-refresh/runtime is deliberately NOT shared: the app's
				// own copy late-attaches to the devtools hook the dev-flavor
				// shell created BEFORE react-dom loaded (injectIntoGlobalHook
				// supports coexisting copies), and MF eager-consume of it
				// inside a remote hard-fails the container.
			},
		}),
	],
	// Treat .pipe files as JSON so pipeline definitions can be imported and
	// passed to client.use({ pipeline }) — the browser has no filesystem, so
	// filepath loading is Node-only.
	// \`as const\` keeps the rule's \`type\` a literal for the config typecheck.
	tools: {
		rspack: {
			module: {
				rules: [{ test: /\\.pipe$/, type: 'json' } as const],
			},
		},
	},
	// CORS: explicitly allow any origin — the serving host isn't fixed, so no
	// allowlist is possible; declaring it also stops the MF plugin injecting
	// its own wildcard defaults (and warning about it).
	server: { port: ${v.port}, cors: { origin: '*' } },
	// hmr on; liveReload stays at its DEFAULT (true): a failed hot update
	// that rejects check() falls back to a full reload of the preview page.
	// (The historic reload loop came from zombie multi-container HMR clients,
	// gone since dev-remote injection became once-per-page; the silent-freeze
	// class is prevented at the source by the AppDescriptor jsx anchor.)
	// lazyCompilation stays off: compile-on-request made every served bundle
	// one hash behind, so the dev client always saw itself as stale.
	// client: the bundle runs INSIDE the preview shell's page (a different
	// origin) — without an explicit host the client derives its WebSocket URL
	// from that page's location and never reaches this dev server. '<port>'
	// is rsbuild's runtime placeholder for the ACTUAL port, so dynamic port
	// assignment keeps working.
	dev: { hmr: true, lazyCompilation: false, client: { protocol: 'ws', host: 'localhost', port: '<port>' } as const },
	source: { entry: { index: './src/index.ts' } },
	output: { assetPrefix: 'auto' },
}));
`;
}

/** src/index.ts — the Module Federation async boundary (required). */
function asyncBoundary(): string {
	return `${TS_HEADER}
// Module Federation async boundary — see .rocketride/docs/ROCKETRIDE_APPS.md.
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
			// The rsbuild config joins the project so the editor checks it with
			// real settings (a loose config file gets inferred-project noise).
			include: ['src', 'rsbuild.config.mts'],
		},
		null,
		2,
	)}\n`;
}

/** src/global.d.ts — ambient module declarations for bundler-loaded assets. */
function globalDts(): string {
	return `${TS_HEADER}
/** RocketRide pipeline files — JSON with a .pipe extension (see the .pipe
 * rule in rsbuild.config.mts). Import one and pass it to
 * client.use({ pipeline }) — browser bundles cannot use filepath loading. */
declare module '*.pipe' {
	const value: Record<string, unknown>;
	export default value;
}
`;
}

/** src/AppDescriptor.ts — the single MF expose. */
function appDescriptor(v: TemplateVars): string {
	return `${TS_HEADER}
/**
 * AppDescriptor — the one module this app exposes to the RocketRide shell.
 * The shell lazy-loads it on activation and renders \`app\` raw; the app
 * declares its layout inside with <AppLayout>.
 */

// HMR anchor: keeps the shared jsx runtime referenced even when the app's
// root component fails to compile — an error build otherwise orphans it, the
// hot runtime tombstones its factory, and every later fix-apply dies
// silently (the frozen-preview bug).
import 'react/jsx-dev-runtime';

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
 * The scaffolded placeholder icon — a neutral rounded tile with an abstract
 * rocket mark. Deliberately generic: it exists so the PACKAGE tab's icon
 * readiness starts green and tiles never render the bare fallback glyph;
 * replacing it is the developer's first branding act.
 *
 * @returns The icon.svg file content.
 */
function placeholderIcon(): string {
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n' +
		'\t<rect width="64" height="64" rx="14" fill="#4F46E5"/>\n' +
		'\t<path d="M32 12c8 6 12 14 12 24l-6 8H26l-6-8c0-10 4-18 12-24z" fill="#FFFFFF"/>\n' +
		'\t<circle cx="32" cy="30" r="5" fill="#4F46E5"/>\n' +
		'\t<path d="M24 46l-4 8 8-4zM40 46l4 8-8-4z" fill="#C7D2FE"/>\n' +
		'</svg>\n'
	);
}

/**
 * The scaffolded starter README — what the app does and how to work on it.
 * Ships with every template so the PACKAGE tab's readme readiness starts
 * green and the store listing has a document to grow into. The canonical
 * authored copy is docs/README-template.md — keep the two in sync.
 *
 * @param v - Substitution variables.
 * @returns The README.md file content.
 */
function readmeMd(v: TemplateVars): string {
	return (
		`# ${v.appName}\n\n` +
		`${v.appName} — a RocketRide app.\n\n` +
		'## What it does\n\n' +
		'Describe your app here — this README ships with the app and appears on its store listing.\n\n' +
		'## Development\n\n' +
		'Open the `.rrapp` file to launch the App Builder: live preview on the Design tab, identity and packaging on the Package tab, publishing on the Deploy tab.\n\n' +
		'Platform guide for building apps: `.rocketride/docs/ROCKETRIDE_APPS.md` in this workspace.\n'
	);
}

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
		{ path: 'rsbuild.config.mts', content: rsbuildConfig(vars) },
		{ path: 'tsconfig.json', content: tsconfigJson() },
		// App-level ignore: the workspace root carries the full set, but the
		// app folder must stay self-protecting when copied or git-inited on
		// its own — node_modules/dist must never enter version control (the
		// deploy pack filter hard-excludes them regardless).
		{ path: '.gitignore', content: 'node_modules/\ndist/\n' },
		// The manifest's icon/readme point at these — scaffolded so every new
		// app starts PACKAGE-ready instead of accumulating warnings.
		{ path: 'icon.svg', content: placeholderIcon() },
		{ path: 'README.md', content: readmeMd(vars) },
		{ path: 'src/index.ts', content: asyncBoundary() },
		{ path: 'src/global.d.ts', content: globalDts() },
		{ path: 'src/AppDescriptor.ts', content: appDescriptor(vars) },
		{ path: 'src/App.tsx', content: name === 'Dashboard' ? dashboardApp(vars, frame) : blankApp(vars, frame) },
	];
	return files;
}
