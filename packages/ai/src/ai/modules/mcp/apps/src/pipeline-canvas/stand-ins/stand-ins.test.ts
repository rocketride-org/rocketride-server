/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Each stand-in must export every value the reused builder files import
 * from the file it replaces. tsc checks the types against the real files;
 * this checks the runtime names, so a builder change that imports a new
 * value from a replaced file fails here with the file and the name.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { describe, expect, it } from 'vitest';

import { PACKAGE_STAND_INS, STAND_INS } from '../../../resolve';

const REPO_ROOT = resolve(__dirname, '../../../../../../../../../..');
const SHARED_SRC = resolve(REPO_ROOT, 'apps/shared/src');
const CANVAS = resolve(SHARED_SRC, 'tools/pipelines/panels/design/canvas');

/**
 * The builder files the canvas bundle draws with: CanvasApp.tsx imports the
 * first five, and the rest are what they import that is not replaced.
 */
const REUSED = ['components/node/node-component/NodeComponent.tsx', 'components/node/node-group/NodeGroup.tsx', 'components/node/node-annotation/NodeAnnotation.tsx', 'components/edge/FlowEdge.tsx', 'util/Icon.tsx', 'util/graph.ts', 'util/helpers.tsx', 'types.ts', 'components/ConditionalRender.tsx', 'components/handles/LaneHandle.tsx', 'components/handles/InvokeHandle.tsx', 'components/node/node-component/header/NodeHeader.tsx', 'components/node/node-component/lanes/NodeLanes.tsx', 'components/node/node-component/lanes/InsideLines.tsx', 'components/node/node-component/top/NodeTop.tsx', 'components/node/node-component/status/index.tsx', 'components/node/node-component/run-button/index.tsx', 'components/node/node-component/header/more-menu/index.tsx', 'hooks/useNodeActionLabels.ts'].map((file) => resolve(CANVAS, file));

const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveSpecifier(specifier: string, importer: string): string | null {
	let base: string;
	if (specifier.startsWith('.')) base = resolve(dirname(importer), specifier);
	else if (specifier.startsWith('shared/')) base = resolve(SHARED_SRC, specifier.slice('shared/'.length));
	else if (specifier.startsWith('@app-shared/')) base = resolve(SHARED_SRC, specifier.slice('@app-shared/'.length));
	else return null;
	for (const ext of EXTENSIONS) {
		if (existsSync(base + ext) && (ext || /\.[cm]?[jt]sx?$/.test(base))) return base + ext;
	}
	return null;
}

interface ValueImport {
	importer: string;
	specifier: string;
	names: string[];
}

/** Value (not type-only) imports and re-exports in one file. */
function valueImports(file: string): ValueImport[] {
	const source = readFileSync(file, 'utf8');
	const out: ValueImport[] = [];
	// The clause never holds a quote or a semicolon, so a side-effect import
	// (`import './x.css';`) cannot run into the next statement.
	const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s+from\s+'([^']+)'/g;
	for (const match of source.matchAll(pattern)) {
		const [, keyword, typeOnly, clause, specifier] = match;
		if (typeOnly) continue;
		const names: string[] = [];
		const braces = /\{([\s\S]*?)\}/.exec(clause);
		if (braces) {
			for (const part of braces[1].split(',')) {
				const name = part.trim();
				if (!name || name.startsWith('type ')) continue;
				names.push(name.split(/\s+as\s+/)[0].trim());
			}
		}
		const head = clause
			.replace(/\{[\s\S]*\}/, '')
			.replace(/,/g, ' ')
			.trim();
		if (keyword === 'import' && head && !head.startsWith('*')) names.push('default');
		if (head.startsWith('*')) names.push('*');
		out.push({ importer: file, specifier, names });
	}
	return out;
}

/** True when `file` declares `name` as an interface or a type alias: erased at runtime. */
function isTypeOnly(file: string, name: string): boolean {
	if (!existsSync(file)) return false;
	return new RegExp(`export\\s+(interface|type)\\s+${name}\\b`).test(readFileSync(file, 'utf8'));
}

describe('canvas stand-ins', () => {
	it('lists only builder files that exist', () => {
		for (const file of [...REUSED, ...Object.keys(STAND_INS)]) expect(existsSync(file), file).toBe(true);
	});

	it('export every value the reused files import from the files they replace', async () => {
		const missing: string[] = [];
		let checked = 0;
		for (const file of REUSED) {
			for (const { specifier, names } of valueImports(file)) {
				const real = resolveSpecifier(specifier, file) ?? '';
				const replaced = PACKAGE_STAND_INS[specifier] ?? STAND_INS[real];
				if (!replaced) continue;
				const module = (await import(/* @vite-ignore */ replaced)) as Record<string, unknown>;
				for (const name of names) {
					checked += 1;
					if (name === '*' || isTypeOnly(real, name)) continue;
					if (!(name in module)) missing.push(`${file.slice(CANVAS.length + 1)} imports '${name}' from '${specifier}'`);
				}
			}
		}
		expect(missing).toEqual([]);
		// Guard against a parser that silently finds nothing.
		expect(checked).toBeGreaterThan(10);
	});

	it('the read-only contexts lock the canvas and make edits do nothing', async () => {
		const graph = await import('./FlowGraphContext');
		const project = await import('./FlowProjectContext');
		const preferences = await import('./FlowPreferencesContext');

		const value = graph.readOnlyGraph([], [], { current: null });
		expect(value.isValidConnection({ source: 'a', target: 'b', sourceHandle: null, targetHandle: null })).toBe(false);
		expect(value.addNode({ provider: 'x', config: {} })).toBe('');
		expect(value.updateNode('a', {})).toBeUndefined();
		expect(value.loadData({ components: [] } as never)).toBe(0);
		expect(value.editingNodeId).toBeUndefined();
		expect(value.quickAddState).toBeNull();

		const projectValue = project.readOnlyProject({ components: [] } as never, {});
		expect(projectValue.isReadonly).toBe(true);
		expect(projectValue.isPipelineRunning).toBe(false);
		expect(projectValue.onRunPipeline).toBeUndefined();
		expect(projectValue.onOpenLink).toBeUndefined();
		expect(projectValue.taskStatuses).toBeUndefined();

		expect(preferences.READ_ONLY_PREFERENCES.isReadonly).toBe(true);
		expect(preferences.READ_ONLY_PREFERENCES.isLocked).toBe(true);
	});
});
