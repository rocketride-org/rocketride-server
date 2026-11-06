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
// TYPESCRIPT SETUP — the App Builder's TS language service configuration
// =============================================================================

/**
 * Configures Monaco's TypeScript defaults for the App Builder design loop:
 *
 *  - Compiler options mirror the app scaffold's tsconfig (automatic JSX —
 *    the same transform the server build uses, zero dev/deploy skew) with
 *    isolatedModules on (the loop emits per file).
 *  - The React type packages (@types/react, @types/react-dom, csstype)
 *    ride as a GENERATED, COMMITTED module (reactTypes.generated.ts — an
 *    ordinary TypeScript file, so every build path treats it like any
 *    other source) and are registered as extraLibs at node_modules paths —
 *    version-locked to the exact React the platform was built with; no
 *    download, no unpack. Server-versioned surfaces (shell.d.ts, the
 *    vendored SDK types) are fetched by the host's types feed; third-party
 *    dependency types arrive through automatic type acquisition (the host's
 *    ATA engine feeding addExtraLib).
 */

import { REACT_TYPE_LIBS } from './reactTypes.generated';
import type { Monaco } from './loader';

// =============================================================================
// TYPES — structural view of monaco.languages.typescript
// =============================================================================

// monaco 0.55's editor.api.d.ts stubs `languages.typescript` as
// `{ deprecated: true }` (the real surface arrives with the language
// contribution at runtime), and which declaration a consumer's tsconfig
// resolves varies. A STRUCTURAL type of exactly the members used here is
// deterministic everywhere.

/** The typescriptDefaults members the App Builder drives. */
interface MonacoTsDefaults {
	setCompilerOptions(options: Record<string, unknown>): void;
	setEagerModelSync(value: boolean): void;
	addExtraLib(content: string, filePath?: string): { dispose: () => void };
}

/** The TS worker members the emit path drives. */
interface MonacoTsWorker {
	getEmitOutput(uri: string): Promise<{ outputFiles: Array<{ name: string; text: string }> }>;
}

/** The languages.typescript namespace, structurally. */
interface MonacoTypescriptNs {
	typescriptDefaults: MonacoTsDefaults;
	ScriptTarget: Record<string, number>;
	ModuleKind: Record<string, number>;
	ModuleResolutionKind: Record<string, number>;
	JsxEmit: Record<string, number>;
	getTypeScriptWorker(): Promise<(uri: import('monaco-editor').Uri) => Promise<MonacoTsWorker>>;
}

/** The runtime namespace behind the api stub. */
function typescriptNs(monaco: Monaco): MonacoTypescriptNs {
	return monaco.languages.typescript as unknown as MonacoTypescriptNs;
}

// =============================================================================
// SETUP
// =============================================================================

/** One registered extraLib disposer set. */
export interface TypescriptSetupHandle {
	/** Adds one more declaration lib (the host's types feed / dep types). */
	addExtraLib: (content: string, path: string) => { dispose: () => void };
	/** Disposes everything this setup registered. */
	dispose: () => void;
}

/**
 * Applies the App Builder's TS configuration to a loaded Monaco.
 * Idempotent per page (extraLibs re-register replaces by path).
 *
 * @param monaco - The Monaco API namespace.
 * @returns A handle for adding host-fed libs and disposing.
 */
export function setupAppTypescript(monaco: Monaco): TypescriptSetupHandle {
	const ts = typescriptNs(monaco);
	const defaults = ts.typescriptDefaults;

	// step: compiler options — the scaffold tsconfig's shape (automatic JSX,
	// bundler-style resolution, per-file emit discipline)
	defaults.setCompilerOptions({
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.NodeJs,
		jsx: ts.JsxEmit.ReactJSX,
		jsxImportSource: 'react',
		strict: true,
		isolatedModules: true,
		esModuleInterop: true,
		allowSyntheticDefaultImports: true,
		skipLibCheck: true,
		allowNonTsExtensions: true,
		sourceMap: true,
		lib: ['es2022', 'dom', 'dom.iterable'],
	});
	defaults.setEagerModelSync(true);

	// step: register the bundle-resident React type packages
	const disposers: Array<{ dispose: () => void }> = [];
	for (const lib of REACT_TYPE_LIBS) {
		disposers.push(defaults.addExtraLib(lib.content, lib.path));
	}

	return {
		addExtraLib: (content: string, path: string) => {
			const disposer = defaults.addExtraLib(content, path);
			disposers.push(disposer);
			return disposer;
		},
		dispose: () => {
			for (const d of disposers) d.dispose();
		},
	};
}

/**
 * The TS worker's per-file transpile output.
 */
export interface EmitOutput {
	/** The emitted JavaScript ('' when emit was skipped). */
	js: string;
	/** The source map JSON, when emitted. */
	map?: string;
}

/**
 * Emits one model through the TS worker (getEmitOutput — transpile only,
 * no type-gate; diagnostics surface separately in the editor).
 *
 * @param monaco - The Monaco API namespace.
 * @param uri - The model's URI.
 * @returns The emit output.
 */
export async function emitModel(monaco: Monaco, uri: import('monaco-editor').Uri): Promise<EmitOutput> {
	const workerFactory = await typescriptNs(monaco).getTypeScriptWorker();
	const worker = await workerFactory(uri);
	const result = await worker.getEmitOutput(uri.toString());
	let js = '';
	let map: string | undefined;
	for (const file of result.outputFiles) {
		if (file.name.endsWith('.js.map')) map = file.text;
		else if (file.name.endsWith('.js')) js = file.text;
	}
	return { js, map };
}
