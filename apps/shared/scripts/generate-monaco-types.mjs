// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * generate-monaco-types — regenerates reactTypes.generated.ts.
 *
 * The App Builder's Monaco TS service needs the pinned React type packages
 * (@types/react, @types/react-dom, csstype) as RUNTIME STRINGS (extraLibs
 * are declaration text, not code). Embedding them as a generated, committed
 * TypeScript module keeps every build path ordinary — no bundler rules, no
 * asset imports; the file compiles like any other source, in-repo and in
 * the server build worker alike.
 *
 * Run after bumping the @types pins:
 *   node apps/shared/scripts/generate-monaco-types.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(SHARED_ROOT, 'src', 'modules', 'monaco', 'reactTypes.generated.ts');

/** The embedded declaration files: [virtual extraLib path, package-relative source]. */
const LIBS = [
	['file:///node_modules/@types/react/index.d.ts', '@types/react/index.d.ts'],
	['file:///node_modules/@types/react/global.d.ts', '@types/react/global.d.ts'],
	['file:///node_modules/@types/react/jsx-runtime.d.ts', '@types/react/jsx-runtime.d.ts'],
	['file:///node_modules/@types/react/jsx-dev-runtime.d.ts', '@types/react/jsx-dev-runtime.d.ts'],
	['file:///node_modules/@types/react-dom/index.d.ts', '@types/react-dom/index.d.ts'],
	['file:///node_modules/@types/react-dom/client.d.ts', '@types/react-dom/client.d.ts'],
	['file:///node_modules/csstype/index.d.ts', 'csstype/index.d.ts'],
];

/**
 * Resolves one packaged file from shared's own node_modules (the packages
 * are shared's declared devDeps, so the symlinks exist at the pinned
 * workspace versions).
 *
 * @param {string} rel - Package-relative path ('@types/react/index.d.ts').
 * @returns {string} The file text.
 */
function readPackaged(rel) {
	const file = path.join(SHARED_ROOT, 'node_modules', ...rel.split('/'));
	return fs.readFileSync(fs.realpathSync(file), 'utf8');
}

// step: collect versions for the provenance header
const versionOf = (name) => JSON.parse(readPackaged(`${name}/package.json`)).version;
const versions = `@types/react ${versionOf('@types/react')}, @types/react-dom ${versionOf('@types/react-dom')}, csstype ${versionOf('csstype')}`;

// step: emit the module — one entry per lib, contents JSON-escaped
const entries = LIBS.map(([virtualPath, rel]) => `\t{\n\t\tpath: ${JSON.stringify(virtualPath)},\n\t\tcontent: ${JSON.stringify(readPackaged(rel))},\n\t},`).join('\n');

const output = `// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// GENERATED FILE — DO NOT EDIT.
// Regenerate with: node apps/shared/scripts/generate-monaco-types.mjs
// Embedded: ${versions}

/** One embedded declaration file for the editor's extraLibs. */
export interface EmbeddedTypeLib {
\t/** Virtual path (file:///node_modules/...). */
\tpath: string;
\t/** Declaration text. */
\tcontent: string;
}

/** The pinned React type packages, as bundle-resident declaration text. */
export const REACT_TYPE_LIBS: EmbeddedTypeLib[] = [
${entries}
];
`;

fs.writeFileSync(OUT_FILE, output, 'utf8');
console.log(`generate-monaco-types: wrote ${OUT_FILE} (${(output.length / 1024).toFixed(0)} KB; ${versions})`);
