/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * One module-resolution setup for the widget build (vite.config.ts) and the
 * widget tests (vitest.config.ts). tsconfig.json repeats the aliases as
 * `paths` (tsc cannot import this file), so keep the three in step.
 *
 * The pipeline canvas reuses the builder's node and edge components. Those
 * import the builder's editor contexts, hooks and config-form code, which a
 * read-only widget neither needs nor can carry. `canvasStandIns()` swaps
 * exactly those files for widget-owned stand-ins at resolve time; every
 * other builder file is used as is.
 */
import { resolve } from 'path';
import type { Alias, Plugin } from 'vite';

const APPS_ROOT = __dirname;
const REPO_ROOT = resolve(APPS_ROOT, '../../../../../../..');
const SHARED_SRC = resolve(REPO_ROOT, 'apps/shared/src');
const CANVAS = resolve(SHARED_SRC, 'tools/pipelines/panels/design/canvas');
const STAND_INS_DIR = resolve(APPS_ROOT, 'src/pipeline-canvas/stand-ins');

export const aliases: Alias[] = [
	// Bare 'shell' resolves to a small stand-in: the real barrel pulls about
	// 85 modules, including auth and Module Federation (see shell/src/api.ts).
	{ find: /^shell$/, replacement: resolve(APPS_ROOT, 'src/shared/shell-shim.ts') },
	// Deep shell imports (the shim, the theme CSS and the theme token sets).
	{ find: /^shell\/src\//, replacement: resolve(REPO_ROOT, 'apps/shared/node_modules/shell/src') + '/' },
	{ find: /^shell\/public\//, replacement: resolve(REPO_ROOT, 'apps/shared/node_modules/shell/public') + '/' },
	// The shell's project types re-export the TypeScript SDK's pipeline and
	// task types. Resolve them from the SDK's source, so the widgets do not
	// depend on a built SDK.
	{ find: /^rocketride$/, replacement: resolve(REPO_ROOT, 'packages/client-typescript/src/client/types/index.ts') },
	// The shared app source tree (trace components, canvas components).
	{ find: /^@app-shared\//, replacement: SHARED_SRC + '/' },
	// apps/shared uses its own 'shared/' alias internally, so a consumer of
	// that tree has to resolve it too.
	{ find: /^shared\//, replacement: SHARED_SRC + '/' },
];

/**
 * Builder files the canvas replaces, keyed by the real file, valued by the
 * widget's stand-in. Each stand-in types itself against the real file with
 * `import type`, so tsc reports drift.
 */
export const STAND_INS: Record<string, string> = {
	[resolve(CANVAS, 'context/FlowGraphContext.tsx')]: resolve(STAND_INS_DIR, 'FlowGraphContext.tsx'),
	[resolve(CANVAS, 'context/FlowProjectContext.tsx')]: resolve(STAND_INS_DIR, 'FlowProjectContext.tsx'),
	[resolve(CANVAS, 'context/FlowPreferencesContext.tsx')]: resolve(STAND_INS_DIR, 'FlowPreferencesContext.tsx'),
	[resolve(CANVAS, 'hooks/index.ts')]: resolve(STAND_INS_DIR, 'hooks.ts'),
	[resolve(SHARED_SRC, 'components/node-config/index.tsx')]: resolve(STAND_INS_DIR, 'node-config.ts'),
	[resolve(CANVAS, 'components/node/node-component/run-button/RunButton.tsx')]: resolve(STAND_INS_DIR, 'RenderNothing.tsx'),
	[resolve(CANVAS, 'components/node/node-component/status/NodeStatus.tsx')]: resolve(STAND_INS_DIR, 'RenderNothing.tsx'),
	[resolve(CANVAS, 'components/node/node-component/header/more-menu/MoreMenu.tsx')]: resolve(STAND_INS_DIR, 'RenderNothing.tsx'),
};

/**
 * Packages the canvas replaces, keyed by the import specifier. A note's code
 * block is the only user of the syntax highlighter, and its full Prism build
 * is about 1 MB of grammars.
 */
export const PACKAGE_STAND_INS: Record<string, string> = {
	'react-syntax-highlighter': resolve(STAND_INS_DIR, 'syntax-highlighter.tsx'),
	'react-syntax-highlighter/dist/esm/styles/prism': resolve(STAND_INS_DIR, 'syntax-highlighter.tsx'),
};

const STAND_IN_FILES = new Set([...Object.values(STAND_INS), ...Object.values(PACKAGE_STAND_INS)]);

/** Drop a query or hash suffix, so `x.tsx?v=1` still matches `x.tsx`. */
function cleanId(id: string): string {
	return id.replace(/[?#].*$/, '');
}

/**
 * Return the stand-in for a package in `PACKAGE_STAND_INS`. Otherwise
 * resolve each import normally, then return the stand-in when the resolved
 * file is one of `STAND_INS`. Imports made by a stand-in itself are left
 * alone, so a stand-in can still reach the real file when it must.
 */
export function canvasStandIns(): Plugin {
	return {
		name: 'rocketride-canvas-stand-ins',
		enforce: 'pre',
		async resolveId(source, importer, options) {
			if (!importer || STAND_IN_FILES.has(cleanId(importer))) return null;
			if (PACKAGE_STAND_INS[source]) return PACKAGE_STAND_INS[source];
			const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
			if (!resolved) return null;
			return STAND_INS[cleanId(resolved.id)] ?? null;
		},
	};
}
