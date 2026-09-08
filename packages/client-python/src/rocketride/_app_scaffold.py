# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""App scaffolding — the Python mirror of ``rocketride/app-scaffold`` +
``createAppWorkspace`` from ``rocketride/app-pack``.

Renders the CANONICAL scaffold file trees (the TypeScript
``rocketride/app-scaffold`` module is the canonical statement of them; keep
the two in sync — the generated files are TypeScript source and must come
out BYTE-IDENTICAL from both SDKs) and writes a new app workspace exactly
as the App Builder's New App wizard and ``deploy.createApp()`` do:

- Templates are code-defined trees (path -> rendered content); the generated
  App.tsx is composed from frame options — sidebar, status footer, and
  document tabs each toggle a chrome region of the scaffolded AppLayout.
- :func:`create_app_workspace` validates the slug/developer-id grammar,
  writes ``./apps/<slug>``, ensures the pnpm workspace file and ignore
  hygiene, vendors the server-matched shell + client packages when a server
  base URL is given, and runs ``pnpm install`` (non-fatal on failure).
- Every generated file carries the project MIT header. The MF rsbuild shape
  mirrors apps/hello-ui exactly: exposes ./AppDescriptor, dts:false,
  runtime:false, shareStrategy 'loaded-first', react/react-dom eager
  singletons, shell/rocketride import:false, assetPrefix 'auto'.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

# =============================================================================
# TYPES
# =============================================================================


@dataclass
class TemplateVars:
    """Variables substituted into every template file."""

    app_id: str
    """App id, e.g. 'acme.brandy'."""
    app_name: str
    """Display name, e.g. 'Brand Studio'."""
    publisher: str
    """Publisher slug for appManifest.publisher — the organization developer id, or 'local' when none."""
    module_id: str
    """MF container name (dots/hyphens -> underscores)."""
    port: int
    """Dev-server port for ``rsbuild dev``."""
    preview_url: str
    """Preview URL the launch config opens (engine shell + appid + rrdev)."""


@dataclass
class FrameOptions:
    """Composable frame options — each toggles a chrome region of the scaffolded app.

    The defaults ARE the frame used when the caller passes none — they match
    the pre-options scaffold shape (status footer only).
    """

    sidebar: bool = False
    """Two-column layout with a navigation sidebar on the left."""
    status_footer: bool = True
    """Status bar across the bottom of the app (AppLayout showStatus)."""
    doc_tabs: bool = False
    """Document tab strip across the content area (Documents + DocSplitLayout + DocTabs)."""


# Available template names (QuickPick order).
TEMPLATE_NAMES = ('Blank', 'Dashboard')

# Slug grammar: the name part of the app id.
_SLUG_RE = re.compile(r'^[a-z][a-zA-Z0-9_-]*$')
# Developer-id grammar: the namespace part of the app id.
_DEVELOPER_RE = re.compile(r'^[a-z][a-z_]*$')

# =============================================================================
# SHARED SNIPPETS
# =============================================================================

# The project MIT header for generated TS/TSX files.
_TS_HEADER = (
    '// =============================================================================\n'
    '// MIT License\n'
    '// Copyright (c) 2026 Aparavi Software AG\n'
    '// =============================================================================\n'
)


def _package_json(v: TemplateVars) -> str:
    """package.json — appManifest binding + hello-ui-matched toolchain pins.

    Args:
        v: Substitution variables.

    Returns:
        The package.json file content (2-space JSON + trailing newline,
        byte-identical to the TypeScript emitter's ``JSON.stringify``).
    """
    description = v.app_name + ' — a RocketRide app'
    obj = {
        # npm forbids uppercase in package names; the app id may carry it
        'name': v.app_id.replace('.', '-').lower(),
        'version': '0.1.0',
        'private': True,
        # No "type" field: the rsbuild config is .mts (self-declaring ESM),
        # so the package stays typeless and CJS helper scripts keep working.
        'description': description,
        'license': 'MIT',
        'appManifest': {
            'id': v.app_id,
            'publisher': v.publisher,
            'name': v.app_name,
            'description': description,
            # Every scaffold ships a real icon + README so the PACKAGE tab's
            # readiness starts green and the tile never shows a bare glyph.
            'icon': './icon.svg',
            'readme': './README.md',
            'categories': ['custom'],
            'mode': 'free',
            'authenticated': False,
        },
        'scripts': {
            'dev': 'rsbuild dev',
            # rsbuild transpiles WITHOUT typechecking, so build runs tsc
            # first — type errors must fail the build, not sit silent.
            'build': 'tsc --noEmit && rsbuild build',
            'typecheck': 'tsc --noEmit',
        },
        'dependencies': {
            'react': '^18.2.0',
            'react-dom': '^18.2.0',
            # The SERVER-MATCHED client SDK, vendored by the platform into
            # .rocketride/client/ — the npm registry's `rocketride` can lag
            # the connected server badly, so apps pin the server's own
            # build exactly like the shell below. At runtime the shell
            # shares the client (MF import:false); this install supplies
            # the matching types and node-side tooling.
            'rocketride': 'file:../../.rocketride/client/rocketride.tgz',
            # The platform package — vendored from the connected server.
            'shell': 'file:../../.rocketride/shell/shell.tgz',
        },
        'devDependencies': {
            # EXACT pin: the container must run against the shell's MF
            # runtime generation — a floating range drifts ahead of the
            # shell's installed plugin and breaks share negotiation.
            '@module-federation/rsbuild-plugin': '2.5.1',
            '@rsbuild/core': '~2.0.11',
            '@rsbuild/plugin-react': '~2.0.1',
            # The scaffolded rsbuild.config.mts imports node:fs/node:path
            # and uses __dirname, and tsconfig includes the config — so
            # Node type declarations are a REAL dependency of every app.
            # In-tree apps inherit this hoisted from the monorepo root; a
            # user workspace has no root to hoist from, so the app must
            # declare it (mirrors the platform root's pin).
            '@types/node': '^20.19.41',
            '@types/react': '^18.2.0',
            '@types/react-dom': '^18.2.0',
            # Fallback copy for the shared 'react-refresh/runtime' (HMR);
            # the dev-flavor preview shell's copy wins at runtime.
            'react-refresh': '^0.14.2',
            'typescript': '^5.3.0',
        },
    }
    return json.dumps(obj, indent=2, ensure_ascii=False) + '\n'


def _rsbuild_config(v: TemplateVars) -> str:
    """rsbuild.config.mts — the standalone MF remote shape from
    .rocketride/docs/ROCKETRIDE_APPS.md: moduleId derived from appManifest.id
    in-config, the src/index.ts async boundary as the entry, shell shared.

    Args:
        v: Substitution variables (only ``port`` lands in the output).

    Returns:
        The rsbuild.config.mts file content.
    """
    # step: everything above the port-carrying server line (invariant)
    head = r"""
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
	// `as const` keeps the rule's `type` a literal for the config typecheck.
	tools: {
		rspack: {
			module: {
				rules: [{ test: /\.pipe$/, type: 'json' } as const],
			},
		},
	},
	// CORS: explicitly allow any origin — the serving host isn't fixed, so no
	// allowlist is possible; declaring it also stops the MF plugin injecting
	// its own wildcard defaults (and warning about it).
"""
    # step: everything below the server line (invariant)
    tail = """	// hmr on; liveReload stays at its DEFAULT (true): a failed hot update
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
"""
    return _TS_HEADER + head + '	server: { port: ' + str(v.port) + ", cors: { origin: '*' } },\n" + tail


def _async_boundary() -> str:
    """src/index.ts — the Module Federation async boundary (required).

    Returns:
        The src/index.ts file content.
    """
    return (
        _TS_HEADER
        + '\n// Module Federation async boundary — see .rocketride/docs/ROCKETRIDE_APPS.md.\n'
        + "import('./AppDescriptor');\n"
    )


def _tsconfig_json() -> str:
    """tsconfig.json for the scaffolded app.

    Returns:
        The tsconfig.json file content.
    """
    obj = {
        'compilerOptions': {
            'target': 'ES2022',
            'lib': ['DOM', 'DOM.Iterable', 'ES2022'],
            'module': 'ESNext',
            'moduleResolution': 'bundler',
            'jsx': 'react-jsx',
            'strict': True,
            'skipLibCheck': True,
            'noEmit': True,
            # Platform types resolve from the INSTALLED shell package (the
            # workspace's vendored .rocketride/shell/shell.tgz, wired as the
            # app's "shell" dependency) — the modules themselves arrive from
            # the shell's share scope at runtime, so nothing platform-side
            # is ever checked out or copied into the app.
        },
        # The rsbuild config joins the project so the editor checks it with
        # real settings (a loose config file gets inferred-project noise).
        'include': ['src', 'rsbuild.config.mts'],
    }
    return json.dumps(obj, indent=2, ensure_ascii=False) + '\n'


def _global_dts() -> str:
    """src/global.d.ts — ambient module declarations for bundler-loaded assets.

    Returns:
        The src/global.d.ts file content.
    """
    return (
        _TS_HEADER
        + """
/** RocketRide pipeline files — JSON with a .pipe extension (see the .pipe
 * rule in rsbuild.config.mts). Import one and pass it to
 * client.use({ pipeline }) — browser bundles cannot use filepath loading. */
declare module '*.pipe' {
	const value: Record<string, unknown>;
	export default value;
}
"""
    )


def _app_descriptor(v: TemplateVars) -> str:
    """src/AppDescriptor.ts — the single MF expose.

    Args:
        v: Substitution variables.

    Returns:
        The src/AppDescriptor.ts file content.
    """
    head = """
/**
 * AppDescriptor — the one module this app exposes to the RocketRide shell.
 * The shell lazy-loads it on activation and renders `app` raw; the app
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
"""
    return (
        _TS_HEADER
        + head
        + "	id: '"
        + v.app_id
        + "',\n"
        + "	name: '"
        + v.app_name
        + "',\n"
        + "	branding: { appName: '"
        + v.app_name
        + "' },\n"
        + '	app: App,\n'
        + '};\n'
        + '\nexport default descriptor;\n'
    )


# =============================================================================
# FRAME COMPOSITION
# =============================================================================


def _shell_imports(o: FrameOptions) -> str:
    """Named import list for 'shell' — AppLayout plus the docs trio when tabbed.

    Args:
        o: Frame options driving the composition.

    Returns:
        The one-line ``import { ... } from 'shell';`` statement.
    """
    # step: only tabbed frames pull the document-model components
    names = ['AppLayout']
    if o.doc_tabs:
        names.extend(['Documents', 'DocSplitLayout', 'DocTabs'])
    return 'import { ' + ', '.join(names) + " } from 'shell';"


def _frame_styles(o: FrameOptions) -> str:
    """Extra style entries the frame options contribute (nav styles for the sidebar).

    Args:
        o: Frame options driving the composition.

    Returns:
        The style entries to splice after the template's last base style, or
        '' when no sidebar is selected.
    """
    if not o.sidebar:
        return ''
    return (
        '\n'
        + "	nav: { padding: '10px 8px' },\n"
        + "	navItem: { padding: '6px 10px', borderRadius: 6, fontSize: 13, color: 'var(--rr-text-primary)', cursor: 'pointer' },"
    )


def _docs_model(o: FrameOptions) -> str:
    """The app-owned Documents model section (module scope), when tabbed.

    Args:
        o: Frame options driving the composition.

    Returns:
        The DOCUMENTS section, or '' when document tabs are off.
    """
    if not o.doc_tabs:
        return ''
    return """
// =============================================================================
// DOCUMENTS
// =============================================================================

// The app OWNS its document model — the shell never sees it. No VFS is wired
// here, so documents are static; pass an IVirtualFileSystem to open real files.
const docs = new Documents();
docs.openStaticDocument('welcome', 'Welcome');
"""


def _sidebar_nav(o: FrameOptions) -> str:
    """The sidebar navigation component, when the two-column frame is on.

    Args:
        o: Frame options driving the composition.

    Returns:
        The SidebarNav component source, or '' when no sidebar is selected.
    """
    if not o.sidebar:
        return ''
    return """
/** Sidebar navigation — replace the items with your app's sections. */
const SidebarNav: React.FC = () => (
	<div style={styles.nav}>
		<div style={styles.navItem}>Overview</div>
		<div style={styles.navItem}>Activity</div>
		<div style={styles.navItem}>Settings</div>
	</div>
);
"""


def _app_jsx(o: FrameOptions, content: str) -> str:
    """The App component's JSX — AppLayout with the option-selected props wrapping
    either the raw content or the DocSplitLayout/DocTabs pane tree.

    Args:
        o: Frame options driving the composition.
        content: A single self-closing content element, e.g. '<Content />'.

    Returns:
        The JSX body of the root App component (no trailing newline).
    """
    # step: AppLayout props from the frame options
    props = (' sidebar={<SidebarNav />}' if o.sidebar else '') + (' showStatus' if o.status_footer else '')
    # step: plain frame — content fills the client area directly
    if not o.doc_tabs:
        return '	<AppLayout' + props + '>\n		' + content + '\n	</AppLayout>'
    # step: tabbed frame — the split tree renders a tab strip per pane
    return (
        '	<AppLayout'
        + props
        + '>\n'
        + '		<DocSplitLayout\n'
        + '			docs={docs}\n'
        + '			renderPane={(groupId) => (\n'
        + '				<>\n'
        + '					<DocTabs docs={docs} groupId={groupId} isActive />\n'
        + '					'
        + content
        + '\n'
        + '				</>\n'
        + '			)}\n'
        + '		/>\n'
        + '	</AppLayout>'
    )


# =============================================================================
# TEMPLATE BODIES
# =============================================================================


def _blank_app(v: TemplateVars, o: FrameOptions) -> str:
    """Blank template: a hello screen composed into the selected frame.

    Args:
        v: Substitution variables.
        o: Frame options composing the generated App.tsx.

    Returns:
        The src/App.tsx file content.
    """
    # step: header, imports, and the styles block (frame styles splice inline)
    head = (
        _TS_HEADER
        + '\n/**\n * '
        + v.app_name
        + ' — root component rendered by the RocketRide shell.\n */\n\n'
        + "import React from 'react';\n"
        + "import type { ShellAppProps } from 'shell';\n"
        + _shell_imports(o)
        + """

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: { padding: 40, fontFamily: 'var(--rr-font-family, system-ui)' },
	title: { fontSize: 22, fontWeight: 600, color: 'var(--rr-text-primary)' },
	sub: { marginTop: 8, fontSize: 13, color: 'var(--rr-text-secondary)' },"""
        + _frame_styles(o)
        + '\n};\n'
    )
    # step: optional documents model + component section with the framed JSX
    body = (
        _docs_model(o)
        + """
// =============================================================================
// COMPONENT
// =============================================================================
"""
        + _sidebar_nav(o)
        + '\n/** Client-area content — replace with your app. */\n'
        + 'const Content: React.FC<ShellAppProps> = ({ isConnected, identity }) => (\n'
        + '	<div style={styles.wrap}>\n'
        + '		<h1 style={styles.title}>'
        + v.app_name
        + '</h1>\n'
        + '		<p style={styles.sub}>Edit src/App.tsx and save — the preview reloads automatically.</p>\n'
        + "		<p style={styles.sub}>Connected: {isConnected ? 'yes' : 'no'} · User: {identity?.displayName ?? 'not signed in'}</p>\n"
        + '	</div>\n'
        + ');\n'
        + '\n'
        + '/**\n * Root view — AppLayout declares the frame the wizard selected; recompose\n * its props (`sidebar`, `showStatus`) to change it.\n */\n'
        + 'const App: React.FC<ShellAppProps> = (props) => (\n'
        + _app_jsx(o, '<Content {...props} />')
        + '\n);\n'
        + '\nexport default App;\n'
    )
    return head + body


def _dashboard_app(v: TemplateVars, o: FrameOptions) -> str:
    """Dashboard template: stat cards + a bar chart, token-styled, composed into the selected frame.

    Args:
        v: Substitution variables.
        o: Frame options composing the generated App.tsx.

    Returns:
        The src/App.tsx file content.
    """
    # step: header, imports, styles, and the demo series (frame styles splice inline)
    head = (
        _TS_HEADER
        + '\n/**\n * '
        + v.app_name
        + ' — dashboard root rendered by the RocketRide shell.\n */\n\n'
        + "import React from 'react';\n"
        + _shell_imports(o)
        + """

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
	bar: { flex: 1, background: 'var(--rr-brand)', opacity: 0.75, borderRadius: '3px 3px 0 0' },"""
        + _frame_styles(o)
        + """
};

// Demo series — replace with live data from your pipelines.
const SERIES = [42, 55, 38, 64, 71, 52, 60, 78, 66, 83, 74, 90];
"""
    )
    # step: optional documents model + component section with the framed JSX
    body = (
        _docs_model(o)
        + """
// =============================================================================
// COMPONENT
// =============================================================================
"""
        + _sidebar_nav(o)
        + '\n/** Dashboard content: three stat cards + a 12-point bar chart. */\n'
        + 'const Content: React.FC = () => (\n'
        + '	<div style={styles.wrap}>\n'
        + '		<div style={styles.title}>'
        + v.app_name
        + '</div>\n'
        + '		<div style={styles.sub}>Live overview</div>\n'
        + '		<div style={styles.row}>\n'
        + '			<div style={styles.card}><div style={styles.label}>Items</div><div style={styles.value}>12,408</div></div>\n'
        + '			<div style={styles.card}><div style={styles.label}>Success</div><div style={styles.value}>96.4%</div></div>\n'
        + '			<div style={styles.card}><div style={styles.label}>Pending</div><div style={styles.value}>37</div></div>\n'
        + '		</div>\n'
        + '		<div style={styles.chart}>\n'
        + '			<div style={styles.bars}>\n'
        + '				{SERIES.map((h, i) => (\n'
        + '					<div key={i} style={{ ...styles.bar, height: `${h}%` }} />\n'
        + '				))}\n'
        + '			</div>\n'
        + '		</div>\n'
        + '	</div>\n'
        + ');\n'
        + '\n'
        + '/**\n * Root view — AppLayout declares the frame the wizard selected; recompose\n * its props (`sidebar`, `showStatus`) to change it.\n */\n'
        + 'const App: React.FC = () => (\n'
        + _app_jsx(o, '<Content />')
        + '\n);\n'
        + '\nexport default App;\n'
    )
    return head + body


# =============================================================================
# RENDER
# =============================================================================


def _placeholder_icon() -> str:
    """The scaffolded placeholder icon — a neutral rounded tile with an abstract
    rocket mark. Deliberately generic: it exists so the PACKAGE tab's icon
    readiness starts green and tiles never render the bare fallback glyph;
    replacing it is the developer's first branding act.

    Returns:
        The icon.svg file content.
    """
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
        '\t<rect width="64" height="64" rx="14" fill="#4F46E5"/>\n'
        '\t<path d="M32 12c8 6 12 14 12 24l-6 8H26l-6-8c0-10 4-18 12-24z" fill="#FFFFFF"/>\n'
        '\t<circle cx="32" cy="30" r="5" fill="#4F46E5"/>\n'
        '\t<path d="M24 46l-4 8 8-4zM40 46l4 8-8-4z" fill="#C7D2FE"/>\n'
        '</svg>\n'
    )


def _readme_md(v: TemplateVars) -> str:
    """The scaffolded starter README — what the app does and how to work on it.
    Ships with every template so the PACKAGE tab's readme readiness starts
    green and the store listing has a document to grow into. The canonical
    authored copy is docs/README-template.md — keep the two in sync.

    Args:
        v: Substitution variables.

    Returns:
        The README.md file content.
    """
    return (
        '# '
        + v.app_name
        + '\n\n'
        + v.app_name
        + ' — a RocketRide app.\n\n'
        + '## What it does\n\n'
        + 'Describe your app here — this README ships with the app and appears on its store listing.\n\n'
        + '## Development\n\n'
        + 'Open the `.rrapp` file to launch the App Builder: live preview on the Design tab, identity and packaging on the Package tab, publishing on the Deploy tab.\n\n'
        + 'Platform guide for building apps: `.rocketride/docs/ROCKETRIDE_APPS.md` in this workspace.\n'
    )


def render_template(name: str, v: TemplateVars, frame: Optional[FrameOptions] = None) -> list[tuple[str, str]]:
    """Render a template into its file tree.

    Args:
        name: Template name from :data:`TEMPLATE_NAMES`.
        v: Substitution variables.
        frame: Frame options composing the generated App.tsx; defaults to
            the pre-options shape (status footer only).

    Returns:
        ``(path, content)`` pairs to write into the new app folder
        (project-relative POSIX paths).
    """
    o = frame if frame is not None else FrameOptions()
    return [
        ('package.json', _package_json(v)),
        # The app DOCUMENT (.pipe-style): opening this file is opening the
        # app in the App Builder; it carries the binding id as JSON.
        (v.app_id.split('.')[-1] + '.rrapp', json.dumps({'id': v.app_id}, indent=2, ensure_ascii=False) + '\n'),
        ('rsbuild.config.mts', _rsbuild_config(v)),
        ('tsconfig.json', _tsconfig_json()),
        # App-level ignore: the workspace root carries the full set, but the
        # app folder must stay self-protecting when copied or git-inited on
        # its own — node_modules/dist must never enter version control (the
        # deploy pack filter hard-excludes them regardless).
        ('.gitignore', 'node_modules/\ndist/\n'),
        # The manifest's icon/readme point at these — scaffolded so every new
        # app starts PACKAGE-ready instead of accumulating warnings.
        ('icon.svg', _placeholder_icon()),
        ('README.md', _readme_md(v)),
        ('src/index.ts', _async_boundary()),
        ('src/global.d.ts', _global_dts()),
        ('src/AppDescriptor.ts', _app_descriptor(v)),
        ('src/App.tsx', _dashboard_app(v, o) if name == 'Dashboard' else _blank_app(v, o)),
    ]


# =============================================================================
# CREATE (scaffold a new app)
# =============================================================================


def _noop_progress(line: str) -> None:
    """Swallow a progress line — the default when no ``on_progress`` is given.

    Args:
        line: The (discarded) progress line.
    """


def _vendor_one(
    base: str,
    ws_abs: str,
    route: str,
    dir_name: str,
    file_name: str,
    label: str,
    progress: Callable[[str], None],
) -> bool:
    """Vendor one server-matched platform package into ``.rocketride/``.

    Failures are non-fatal by the same doctrine as the App Builder: the
    scaffolded ``file:`` specs are the well-known locations and link on the
    next connected open.

    Args:
        base: HTTP(S) base of the development server (no trailing slash).
        ws_abs: Absolute workspace root that owns ``.rocketride/``.
        route: Server route serving the package tarball.
        dir_name: Directory under ``.rocketride/`` to vendor into.
        file_name: Tarball file name at that location.
        label: Human label for progress lines.
        progress: Per-step narration sink.

    Returns:
        True when the package is in place (freshly vendored or unchanged).
    """
    # step: fetch the tarball — any failure just narrates and skips
    try:
        url = urllib.parse.urljoin(base + '/', route)
        with urllib.request.urlopen(url, timeout=30) as res:
            tgz = res.read()
    except urllib.error.HTTPError as err:
        progress('vendoring ' + label + ' skipped — ' + base + '/' + route + ' returned HTTP ' + str(err.code))
        return False
    except (OSError, ValueError) as err:
        progress('vendoring ' + label + ' skipped — ' + str(err))
        return False

    # step: write only on change — an identical tarball keeps its mtime
    target = os.path.join(ws_abs, '.rocketride', dir_name, file_name)
    try:
        if os.path.exists(target):
            with open(target, 'rb') as f:
                if f.read() == tgz:
                    progress(label + ' unchanged')
                    return True
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as f:
            f.write(tgz)
    except OSError as err:
        progress('vendoring ' + label + ' skipped — ' + str(err))
        return False
    progress('vendored ' + label + ' (' + str(int(len(tgz) / 1024 + 0.5)) + ' KB)')
    return True


def create_app_workspace(
    workspace_root: str,
    slug: str,
    *,
    template: str = 'Blank',
    display_name: Optional[str] = None,
    developer_id: Optional[str] = None,
    sidebar: bool = False,
    status_footer: bool = True,
    doc_tabs: bool = False,
    install: bool = True,
    server_base_url: Optional[str] = None,
    on_progress: Optional[Callable[[str], None]] = None,
) -> dict:
    """Scaffold a new app — the programmatic twin of the App Builder's New App
    wizard, rendering the exact same templates. Writes the app under
    ``./apps/<slug>``, ensures the pnpm workspace file and ignore hygiene,
    vendors the server-matched platform packages when a server is reachable,
    and installs. Everything after the scaffold (editing, verify, deploy)
    is the normal app lifecycle.

    Args:
        workspace_root: The workspace folder that owns ./apps.
        slug: The app-name slug (lowercase; digits/-/_ after the first).
        template: Template to render (default 'Blank').
        display_name: Display name (default: the slug, title-cased).
        developer_id: Developer id for ``<developerId>.<slug>`` (default
            'local' — publishable beyond the workspace only after a real
            developer id is registered).
        sidebar: Two-column frame with a navigation sidebar on the left.
        status_footer: Status bar across the bottom of the app.
        doc_tabs: Document tab strip across the content area.
        install: Run ``pnpm install`` at the workspace root (default True).
        server_base_url: HTTP(S) base of the development server, used to
            vendor the server-matched shell + client packages.
            Omitted/unreachable = the scaffold still succeeds and the pins
            link on the next connected open.
        on_progress: Optional ``callable(line: str)`` receiving one line per
            step.

    Returns:
        The created app's identity and a report of what ran, with the same
        camelCase keys as the TypeScript ``CreatedApp``: ``appId``,
        ``folder`` (workspace-relative POSIX path), ``files``
        (project-relative paths written), ``vendored``
        (``{'shell': bool, 'client': bool}``), and ``installed``.

    Raises:
        ValueError: On an invalid slug/developer id/template or an existing
            folder.
    """
    progress = on_progress if on_progress is not None else _noop_progress
    ws_abs = os.path.abspath(workspace_root)

    # step: identity — validate both id halves before touching disk
    if not _SLUG_RE.match(slug):
        raise ValueError(f'App slug "{slug}" is invalid — lowercase letter first, then letters/digits/-/_.')
    dev_id = developer_id if developer_id is not None else 'local'
    if not _DEVELOPER_RE.match(dev_id):
        raise ValueError(f'Developer id "{dev_id}" is invalid — lowercase letters/underscores only.')
    app_id = f'{dev_id}.{slug}'
    if template not in TEMPLATE_NAMES:
        raise ValueError(f'Unknown template "{template}" — available: {", ".join(TEMPLATE_NAMES)}.')

    # step: destination — ./apps/<slug>, never over an existing folder
    folder_rel = f'apps/{slug}'
    folder_abs = os.path.join(ws_abs, 'apps', slug)
    if os.path.exists(folder_abs):
        raise ValueError(f'"{folder_rel}" already exists — pick another slug or remove the folder.')

    # step: render the canonical templates (identical to the wizard's)
    name = (
        display_name
        if display_name is not None
        else re.sub(r'\b[a-z]', lambda m: m.group(0).upper(), re.sub(r'[-_]+', ' ', slug))
    )
    # Deterministic dev port per slug so repeated scaffolds of one app keep
    # their launch config stable without colliding across apps.
    hash_value = 0
    for ch in slug:
        hash_value = (hash_value * 31 + ord(ch)) & 0xFFFFFFFF
    port = 3700 + (hash_value % 300)
    base = (server_base_url.rstrip('/') if server_base_url else '') or 'http://localhost:5565'
    files = render_template(
        template,
        TemplateVars(
            app_id=app_id,
            app_name=name,
            publisher=dev_id,
            module_id=re.sub(r'[.-]', '_', app_id),
            port=port,
            preview_url=f'{base}/?appid={app_id}&rrdev=1',
        ),
        FrameOptions(sidebar=sidebar, status_footer=status_footer, doc_tabs=doc_tabs),
    )
    for rel_path, content in files:
        abs_path = os.path.join(folder_abs, *rel_path.split('/'))
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        # newline='' so the generated bytes stay LF on every platform (the
        # TS emitters' templates are LF; byte-identity is the contract)
        with open(abs_path, 'w', encoding='utf-8', newline='') as f:
            f.write(content)
        progress(f'+ {folder_rel}/{rel_path}')

    # step: workspace hygiene — the pnpm workspace file that links every
    # app, and the ignore entries that keep credentials and outputs out
    # of git. Existing files are respected: the workspace yaml is only
    # CREATED when missing (never rewritten), ignores only appended.
    ws_yaml = os.path.join(ws_abs, 'pnpm-workspace.yaml')
    if not os.path.exists(ws_yaml):
        with open(ws_yaml, 'w', encoding='utf-8', newline='') as f:
            f.write("packages:\n  - 'apps/*'\n")
        progress('+ pnpm-workspace.yaml (claims apps/*)')
    else:
        with open(ws_yaml, 'r', encoding='utf-8', errors='replace') as f:
            yaml_text = f.read()
        if not re.search(r'apps/\*', yaml_text):
            progress(
                "warning: pnpm-workspace.yaml does not claim 'apps/*' — add it so the workspace install links this app"
            )
    gitignore_path = os.path.join(ws_abs, '.gitignore')
    wanted = ['.rocketride/', '.env', '**/node_modules/', '**/dist/']
    existing_ignore = ''
    if os.path.exists(gitignore_path):
        with open(gitignore_path, 'r', encoding='utf-8', errors='replace') as f:
            existing_ignore = f.read()
    ignore_lines = re.split(r'\r?\n', existing_ignore)
    missing = [entry for entry in wanted if not any(line.strip() == entry for line in ignore_lines)]
    if missing:
        prefix = (existing_ignore.rstrip('\n') + '\n') if existing_ignore else ''
        with open(gitignore_path, 'w', encoding='utf-8', newline='') as f:
            f.write(prefix + '\n'.join(missing) + '\n')
        progress(f'+ .gitignore ({", ".join(missing)})')

    # step: vendor the server-matched platform packages (stable names the
    # scaffolded file: specs point at). Failures are non-fatal by the same
    # doctrine as the App Builder: the specs are the well-known locations
    # and link on the next connected open.
    vendored = {'shell': False, 'client': False}
    if server_base_url:
        vendored['shell'] = _vendor_one(base, ws_abs, 'client/shell', 'shell', 'shell.tgz', 'shell package', progress)
        vendored['client'] = _vendor_one(
            base, ws_abs, 'client/typescript', 'client', 'rocketride.tgz', 'client SDK package', progress
        )
    else:
        progress('no server base URL — platform packages will vendor on the next connected open')

    # step: link everything (pnpm is the REQUIRED toolchain — npm is never
    # correct in an app workspace). Failure is non-fatal: the files are
    # valid and a later install links them.
    installed = False
    if install is not False:
        progress('pnpm install --prefer-offline')
        env = {**os.environ, 'NO_COLOR': '1'}
        try:
            # Single command string when a shell is involved (Windows needs
            # the shell to resolve pnpm.cmd), args list elsewhere — the same
            # split the TypeScript scaffold makes.
            if os.name == 'nt':
                proc = subprocess.run(
                    'pnpm install --prefer-offline',
                    cwd=ws_abs,
                    shell=True,
                    env=env,
                    capture_output=True,
                    timeout=300,
                )
            else:
                proc = subprocess.run(
                    ['pnpm', 'install', '--prefer-offline'],
                    cwd=ws_abs,
                    env=env,
                    capture_output=True,
                    timeout=300,
                )
            if proc.returncode != 0:
                progress(f'pnpm install exited {proc.returncode} — run it manually at the workspace root')
            installed = proc.returncode == 0
        except FileNotFoundError:
            progress('pnpm not found — install pnpm (npm install -g pnpm) and run pnpm install at the workspace root')
        except subprocess.TimeoutExpired:
            # the TS scaffold kills the hung install silently and reports
            # installed=False; mirror that
            pass

    progress(f'created {app_id} at {folder_rel} ({len(files)} files)')
    return {
        'appId': app_id,
        'folder': folder_rel,
        'files': [f'{folder_rel}/{rel_path}' for rel_path, _ in files],
        'vendored': vendored,
        'installed': installed,
    }
