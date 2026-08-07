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

'use strict';

// =============================================================================
// client-typescript:freeze — contract floors for the rocketride TypeScript SDK
// =============================================================================
//
// Backs the `./builder client-typescript:freeze` builder target. Bundles the
// SDK's public surface (src/client/index.ts) into a single self-contained
// .d.ts and stores it under packages/client-typescript/contract/versions/ as
// the floor for the CURRENT package version.
//
// Floors are keyed to the npm package version: the key is the MAJOR.MINOR of
// package.json at freeze time (1.3.0 -> versions/v1.3.d.ts). Re-freezing the
// same minor REPLACES that in-progress floor — the surface of an unreleased
// minor may still move. Every OLDER floor is immutable: there is no code path
// here that rewrites or drops one, and the package version moving past a
// minor is what seals it.
//
// Enforcement is structural, mirroring the shell's contract: the generated
// src/contract-check.generated.ts holds the live surface against EACH frozen
// version (per-version VALUE floors over the module's export namespace) and
// pins every exported TYPE against the earliest version that froze it.
// Removing or narrowing anything ever frozen fails the package's own
// `tsc --noEmit -p tsconfig.contract.json` — append-only by construction.
//
// Usage:  node freeze-client-api.js [--check | --regen | --floors]
//   (no flag)  full freeze — mints/replaces the floor for the current
//              MAJOR.MINOR and regenerates the derived artifacts.
//   --check    CI/publish mode — nonzero exit if the floors fail tsc, if no
//              floor exists for the current package version, or if the live
//              surface differs from that floor (no writes).
//   --regen    regenerate the DERIVED artifacts (contract barrels + check
//              file) from the immutable versions/*.d.ts, then verify the
//              floors still hold under tsc. Never bundles the live surface
//              and never touches versions/ — on a clean tree this is a no-op,
//              which CI pairs with `git diff --exit-code` so a hand-edited
//              floor or barrel cannot launder a breaking change past tsc.
//   --floors   floors-only gate — run the contract tsc and exit nonzero if
//              the live surface breaks any frozen floor (no writes). Used by
//              client-typescript:create-package so a breaking surface cannot
//              be packaged, while additive work-in-progress still packs.
// =============================================================================

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// =============================================================================
// PATHS
// =============================================================================

const SCRIPTS_DIR = __dirname; // packages/client-typescript/scripts
const PACKAGE_ROOT = path.resolve(SCRIPTS_DIR, '..'); // packages/client-typescript
const SRC_DIR = path.join(PACKAGE_ROOT, 'src');
const CLIENT_SRC_DIR = path.join(SRC_DIR, 'client');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..'); // rocketride-server
const SHELL_ROOT = path.join(REPO_ROOT, 'packages', 'shell');
const CONTRACT_TSCONFIG = path.join(PACKAGE_ROOT, 'tsconfig.contract.json');
const CONTRACT_DIR = path.join(PACKAGE_ROOT, 'contract');
const VERSIONS_DIR = path.join(CONTRACT_DIR, 'versions');
const INDEX_TS = path.join(CONTRACT_DIR, 'index.ts');
const LATEST_TS = path.join(CONTRACT_DIR, 'latest.ts');
const CONTRACT_CHECK = path.join(SRC_DIR, 'contract-check.generated.ts');
const PKG_JSON = path.join(PACKAGE_ROOT, 'package.json');
const TMP_DIR = path.join(CONTRACT_DIR, '.freeze-tmp');

// Markers wrapping the generated declaration body inside each version file, so
// the no-op comparison can isolate the bundle from the provenance header.
const BEGIN = '// ===== BEGIN FROZEN BUNDLE — do not edit =====';
const END = '// ===== END FROZEN BUNDLE =====';

// Reusable MIT license header for the hand-shaped generated files.
const MIT_HEADER = [
	'// MIT License',
	'//',
	'// Copyright (c) 2026 Aparavi Software AG',
	'//',
	'// Permission is hereby granted, free of charge, to any person obtaining a copy',
	'// of this software and associated documentation files (the "Software"), to deal',
	'// in the Software without restriction, including without limitation the rights',
	'// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
	'// copies of the Software, and to permit persons to whom the Software is',
	'// furnished to do so, subject to the following conditions:',
	'//',
	'// The above copyright notice and this permission notice shall be included in all',
	'// copies or substantial portions of the Software.',
	'//',
	'// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
	'// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
	'// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
	'// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
	'// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
	'// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
	'// SOFTWARE.',
].join('\n');

// =============================================================================
// BINARY RESOLUTION
// =============================================================================

/**
 * Resolve a workspace binary and its version by walking node_modules from the
 * SDK package root, falling back to the shell package. The SDK deliberately
 * does not declare dts-bundle-generator itself — the shell (the other contract
 * owner) pins it for the repo, so both freeze pipelines always run the SAME
 * bundler version and the published SDK package gains no dependency edge.
 *
 * @param {string} pkg - npm package name (e.g. 'typescript').
 * @param {string} binName - the bin entry to select when `bin` is a map.
 * @returns {{ binPath: string, version: string }}
 */
function resolveBin(pkg, binName) {
	// Locate the package's manifest, trying the SDK first, then the shell.
	const pkgJsonPath = require.resolve(`${pkg}/package.json`, { paths: [PACKAGE_ROOT, SHELL_ROOT] });
	const pkgDir = path.dirname(pkgJsonPath);
	const manifest = require(pkgJsonPath);
	// The `bin` field is either a string or a name→path map.
	const binRel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[binName];
	return { binPath: path.join(pkgDir, binRel), version: manifest.version };
}

const TSC = resolveBin('typescript', 'tsc');

// The TypeScript compiler API, used for the bundle post-processing passes.
const ts = require(require.resolve('typescript', { paths: [PACKAGE_ROOT] }));

// Strip non-public class members from the generated bundle so inlined classes
// compare STRUCTURALLY rather than nominally — a frozen class that kept its
// privates would only accept the exact declaring class, never the live one.
// Shared with the SDK's dist/types trim so both agree on "not public".
const { stripNonPublicMembers } = require('../../../scripts/lib/stripDts');

// =============================================================================
// ENUM REWRITE — freeze enums structurally so member growth stays additive
// =============================================================================
//
// Cross-declaration enum comparison in TypeScript is effectively INVARIANT:
// relating a live enum to a same-named frozen `declare enum` requires every
// member of the SOURCE enum to exist in the TARGET, so ADDING a member to the
// live enum breaks every older floor that mentions the enum in any position.
// That contradicts the floor semantics (additive growth must pass).
//
// The fix is in the SNAPSHOT ENCODING: each enum in the frozen bundle is
// rewritten into a structural pair —
//
//     export declare const EVENT_TYPE: { readonly NONE: 0; readonly DEBUGGER: 1; ... };
//     export type EVENT_TYPE = number;
//
// The const object floors the MEMBERS (removing a member or changing its wire
// value fails the value floor), while the type alias makes every frozen TYPE
// reference growth-tolerant: a live enum is always assignable to its base
// primitive, and — for numeric enums — the primitive is assignable back, so
// even strictly-checked callback parameters keep working. String enums are
// one-way (string is not assignable to a string enum), so a STRING enum must
// never appear as a parameter of an arrow-function-typed PROPERTY on the
// surface — method/function/constructor parameters compare bivariantly and
// are safe.

/**
 * Constant-fold an enum member initializer expression. Handles the literal
 * forms the SDK uses (numbers, strings, bit-shift flag math, references to
 * earlier members of the same enum).
 *
 * @param {object} expr - The initializer expression node.
 * @param {Map<string, number|string>} memberValues - Values of earlier members.
 * @returns {number|string|null} The folded value, or null if unsupported.
 */
function evalEnumInitializer(expr, memberValues) {
	if (ts.isNumericLiteral(expr)) return Number(expr.text);
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
	if (ts.isParenthesizedExpression(expr)) return evalEnumInitializer(expr.expression, memberValues);
	if (ts.isIdentifier(expr) && memberValues.has(expr.text)) return memberValues.get(expr.text);
	if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
		const v = evalEnumInitializer(expr.operand, memberValues);
		return typeof v === 'number' ? -v : null;
	}
	if (ts.isBinaryExpression(expr)) {
		const l = evalEnumInitializer(expr.left, memberValues);
		const r = evalEnumInitializer(expr.right, memberValues);
		if (typeof l !== 'number' || typeof r !== 'number') return null;
		switch (expr.operatorToken.kind) {
			case ts.SyntaxKind.LessThanLessThanToken: return l << r;
			case ts.SyntaxKind.GreaterThanGreaterThanToken: return l >> r;
			case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return l >>> r;
			case ts.SyntaxKind.BarToken: return l | r;
			case ts.SyntaxKind.AmpersandToken: return l & r;
			case ts.SyntaxKind.CaretToken: return l ^ r;
			case ts.SyntaxKind.PlusToken: return l + r;
			case ts.SyntaxKind.MinusToken: return l - r;
			case ts.SyntaxKind.AsteriskToken: return l * r;
			default: return null;
		}
	}
	return null;
}

/**
 * Rewrite every top-level enum declaration in the bundle into the structural
 * const + base-primitive alias pair (see the block comment above for why).
 * An enum whose members cannot be constant-folded is left nominal (invariant
 * floor) with a warning, rather than silently weakening the contract.
 *
 * @param {string} dtsText - The bundle body.
 * @returns {string} The bundle with enums rewritten structurally.
 */
function rewriteEnumsStructural(dtsText) {
	const sf = ts.createSourceFile('bundle.d.ts', dtsText, ts.ScriptTarget.Latest, true);
	const splices = [];
	for (const st of sf.statements) {
		if (!ts.isEnumDeclaration(st)) continue;
		// Fold every member to a concrete value; numeric members without an
		// initializer auto-increment from the previous member.
		const memberValues = new Map();
		let prevNumeric = -1;
		let folded = true;
		for (const m of st.members) {
			if (!ts.isIdentifier(m.name) && !ts.isStringLiteral(m.name)) { folded = false; break; }
			const name = m.name.text;
			let value;
			if (m.initializer) {
				value = evalEnumInitializer(m.initializer, memberValues);
				if (value === null) { folded = false; break; }
			} else {
				value = prevNumeric + 1;
			}
			if (typeof value === 'number') prevNumeric = value;
			memberValues.set(name, value);
		}
		if (!folded || memberValues.size === 0) {
			log(`WARNING: enum ${st.name.text} could not be folded — frozen nominally (member growth will read as breaking).`);
			continue;
		}
		// Base primitive for the type alias: numeric / string / heterogeneous.
		const kinds = new Set([...memberValues.values()].map((v) => typeof v));
		const base = kinds.size > 1 ? 'number | string' : kinds.has('string') ? 'string' : 'number';
		// Preserve the declaration's own modifiers (export/declare); enums that
		// are exported via a trailing `export { ... }` block keep working because
		// the one name binds BOTH the const value and the type alias.
		const mods = (ts.getModifiers(st) || []).map((m) => m.getText(sf));
		const prefix = mods.filter((m) => m !== 'const').join(' ');
		const constPrefix = prefix ? `${prefix} const` : 'const';
		const typePrefix = mods.includes('export') ? 'export type' : 'type';
		const lines = [];
		lines.push(`${constPrefix} ${st.name.text}: {`);
		for (const [name, value] of memberValues) {
			const lit = typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : String(value);
			lines.push(`\treadonly ${name}: ${lit};`);
		}
		lines.push('};');
		lines.push(`${typePrefix} ${st.name.text} = ${base};`);
		// getStart skips leading trivia, so the enum's doc comment survives.
		splices.push([st.getStart(sf), st.getEnd(), lines.join('\n')]);
	}
	return applySplices(dtsText, splices, 'enum');
}

// =============================================================================
// LITERAL-CONST WIDENING — floors pin types, not incidental values
// =============================================================================
//
// A `const SDK_VERSION = '1.3.0'` lands in the bundle LITERAL-typed; frozen
// as-is it would pin the exact string forever, so the very next version bump
// would break the floor. The contract cares that the const EXISTS with its
// base type, not what value it held at freeze time — so every literal-typed
// top-level const in the frozen bundle is widened to its base primitive.
// (Member values that ARE contract — enum wire values — are floored by the
// structural enum objects above, which this pass does not touch.)

/**
 * Widen literal-typed top-level `declare const` declarations in the bundle to
 * their base primitive type.
 *
 * @param {string} dtsText - The bundle body.
 * @returns {string} The bundle with literal consts widened.
 */
function widenLiteralConsts(dtsText) {
	const sf = ts.createSourceFile('bundle.d.ts', dtsText, ts.ScriptTarget.Latest, true);
	const splices = [];

	/**
	 * Base primitive name for a literal expression or literal type node.
	 *
	 * @param {object} node - Literal expression / literal type's literal.
	 * @returns {string|null} 'string' | 'number' | 'boolean' | 'bigint' | null.
	 */
	function baseOf(node) {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return 'string';
		if (ts.isNumericLiteral(node)) return 'number';
		if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
		if (ts.isBigIntLiteral(node)) return 'bigint';
		if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return 'number';
		return null;
	}

	for (const st of sf.statements) {
		if (!ts.isVariableStatement(st)) continue;
		for (const decl of st.declarationList.declarations) {
			if (decl.type && ts.isLiteralTypeNode(decl.type)) {
				// Annotation form: `declare const X: 'literal';` — swap the type node.
				const base = baseOf(decl.type.literal);
				if (base) splices.push([decl.type.getStart(sf), decl.type.getEnd(), base]);
			} else if (!decl.type && decl.initializer) {
				// Initializer form: `declare const X = 'literal';` — replace the
				// `= <literal>` tail with an explicit base annotation.
				const base = baseOf(decl.initializer);
				if (base) splices.push([decl.name.getEnd(), decl.initializer.getEnd(), `: ${base}`]);
			}
		}
	}
	return applySplices(dtsText, splices, 'literal const');
}

// =============================================================================
// MAP-GENERIC EXPANSION — freeze growth-tolerant snapshots
// =============================================================================
//
// A signature generic over a key map — `on<K extends keyof M>(e: K, p: M[K])`
// — is INVARIANT in M under plain assignability: TypeScript cannot relate the
// abstract indexed accesses `LiveM[K]` / `FrozenM[K]` per key and falls back
// to comparing the whole maps, so ADDING a key to the live map reads as a
// breaking change against every frozen floor. At freeze time every map-generic
// call signature is therefore expanded into per-key CONCRETE overloads — the
// live generic signature satisfies each concrete overload, a grown map passes,
// while removing a frozen key or changing its payload still fails the floor.
// (The SDK surface has no such signatures today; the pass no-ops until it
// gains one, keeping the snapshot encoding aligned with the shell's.)

/**
 * Expand map-generic call signatures in a d.ts bundle into per-key concrete
 * overloads (see the block comment above for why).
 *
 * Handles the three declaration forms a surface can use:
 *   - interface / type-literal METHOD signatures
 *   - class method declarations (inlined `declare class` members)
 *   - PROPERTY signatures whose type is a generic function type (arrow form) —
 *     these become an intersection of concrete function types.
 *
 * Only signatures with exactly ONE type parameter constrained to
 * `keyof <MapName>` are expanded, and only when <MapName> is an interface
 * declared in the same bundle whose members are all literal-keyed properties.
 *
 * @param {string} dtsText - The bundle body.
 * @returns {string} The bundle with map-generic signatures expanded.
 */
function expandMapGenerics(dtsText) {
	const sf = ts.createSourceFile('bundle.d.ts', dtsText, ts.ScriptTarget.Latest, true);
	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

	// ── Pass 1: collect literal-keyed interface maps: name -> keys ───────
	const maps = new Map();
	(function collect(node) {
		if (ts.isInterfaceDeclaration(node)) {
			const keys = [];
			let allLiteral = node.members.length > 0;
			for (const m of node.members) {
				if (ts.isPropertySignature(m) && m.name && (ts.isStringLiteral(m.name) || ts.isIdentifier(m.name))) {
					keys.push(m.name.text);
				} else {
					allLiteral = false;
				}
			}
			if (allLiteral) maps.set(node.name.text, keys);
		}
		ts.forEachChild(node, collect);
	})(sf);

	/**
	 * If the signature-like node is generic over `keyof <map>`, return the
	 * expansion facts; else null.
	 *
	 * @param {object} node - A node with optional typeParameters.
	 * @returns {{ paramName: string, keys: string[] } | null}
	 */
	function mapGenericOf(node) {
		const tps = node.typeParameters;
		if (!tps || tps.length !== 1) return null;
		const constraint = tps[0].constraint;
		if (!constraint || !ts.isTypeOperatorNode(constraint)) return null;
		if (constraint.operator !== ts.SyntaxKind.KeyOfKeyword) return null;
		const target = constraint.type;
		if (!ts.isTypeReferenceNode(target) || !ts.isIdentifier(target.typeName)) return null;
		const keys = maps.get(target.typeName.text);
		if (!keys || keys.length === 0) return null;
		return { paramName: tps[0].name.text, keys };
	}

	/**
	 * Produce a copy of a signature node with its type parameter substituted
	 * by a string-literal key and the typeParameters list dropped.
	 *
	 * @param {object} node - The generic signature-like node.
	 * @param {string} paramName - The type parameter to substitute.
	 * @param {string} key - The literal key to substitute in.
	 * @returns {object} The substituted, non-generic node.
	 */
	function substitute(node, paramName, key) {
		const f = ts.factory;
		const visit = (n) => {
			// Replace every TYPE REFERENCE to the type parameter with 'key'
			if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && n.typeName.text === paramName && !n.typeArguments) {
				return f.createLiteralTypeNode(f.createStringLiteral(key, true));
			}
			return ts.visitEachChild(n, visit, undefined);
		};
		const substituted = ts.visitEachChild(node, visit, undefined);
		// Drop the now-unused type parameter list per node kind
		if (ts.isMethodSignature(substituted)) {
			return f.updateMethodSignature(substituted, substituted.modifiers, substituted.name, substituted.questionToken, undefined, substituted.parameters, substituted.type);
		}
		if (ts.isMethodDeclaration(substituted)) {
			return f.updateMethodDeclaration(substituted, substituted.modifiers, substituted.asteriskToken, substituted.name, substituted.questionToken, undefined, substituted.parameters, substituted.type, substituted.body);
		}
		if (ts.isFunctionTypeNode(substituted)) {
			return f.createFunctionTypeNode(undefined, substituted.parameters, substituted.type);
		}
		return substituted;
	}

	// ── Pass 2: record text splices [start, end, replacement] ────────────
	const splices = [];
	(function scan(node) {
		// Interface/type-literal methods and class methods: N overloads
		if ((ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) && node.name) {
			const mg = mapGenericOf(node);
			if (mg) {
				const lines = mg.keys.map((k) => printer.printNode(ts.EmitHint.Unspecified, substitute(node, mg.paramName, k), sf));
				splices.push([node.getStart(sf), node.getEnd(), lines.join('\n')]);
				return; // no need to descend into a replaced signature
			}
		}
		// Property whose type is a generic function type: intersection form
		if (ts.isPropertySignature(node) && node.type && ts.isFunctionTypeNode(node.type)) {
			const mg = mapGenericOf(node.type);
			if (mg) {
				const parts = mg.keys.map((k) => `(${printer.printNode(ts.EmitHint.Unspecified, substitute(node.type, mg.paramName, k), sf)})`);
				const name = printer.printNode(ts.EmitHint.Unspecified, node.name, sf);
				const q = node.questionToken ? '?' : '';
				splices.push([node.getStart(sf), node.getEnd(), `${name}${q}: ${parts.join(' & ')};`]);
				return;
			}
		}
		ts.forEachChild(node, scan);
	})(sf);

	return applySplices(dtsText, splices, 'map-generic signature');
}

/**
 * Apply recorded [start, end, replacement] text splices back-to-front so
 * earlier offsets stay valid, logging how many landed.
 *
 * @param {string} text - The original text.
 * @param {Array<[number, number, string]>} splices - Recorded replacements.
 * @param {string} what - Human label for the log line.
 * @returns {string} The spliced text.
 */
function applySplices(text, splices, what) {
	splices.sort((a, b) => b[0] - a[0]);
	let out = text;
	for (const [start, end, replacement] of splices) {
		out = out.slice(0, start) + replacement + out.slice(end);
	}
	if (splices.length > 0) {
		log(`Rewrote ${splices.length} ${what}(s) in the frozen bundle.`);
	}
	return out;
}

// =============================================================================
// PROCESS HELPERS
// =============================================================================

/**
 * Run a Node CLI (resolved binary JS) and capture combined output.
 *
 * @param {string} binPath - Absolute path to the CLI's entry .js.
 * @param {string[]} args - CLI arguments.
 * @param {string} cwd - Working directory for the child process.
 * @returns {{ code: number, output: string }}
 */
function runNodeBin(binPath, args, cwd) {
	try {
		// execFileSync throws on a nonzero exit; capture stdout on success.
		const out = execFileSync(process.execPath, [binPath, ...args], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, output: out };
	} catch (err) {
		return { code: err.status || 1, output: `${err.stdout || ''}${err.stderr || ''}` };
	}
}

/** Prefixed console logger for freeze progress. */
function log(msg) {
	console.log(`[client-typescript:freeze] ${msg}`);
}

/** Read the current rocketride-server git commit (or 'unknown'). */
function gitCommit() {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
}

/** Remove the scratch directory used during generation. */
function cleanup() {
	try {
		fs.rmSync(TMP_DIR, { recursive: true, force: true });
	} catch {
		// Best-effort — a leftover temp dir is harmless.
	}
}

// =============================================================================
// VERSION KEYS — floors are keyed to the npm package MAJOR.MINOR
// =============================================================================

/**
 * The floor key for the CURRENT package version: MAJOR.MINOR of package.json.
 *
 * @returns {string} e.g. '1.3' for version 1.3.0.
 */
function currentKey() {
	const version = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8')).version;
	const m = /^(\d+)\.(\d+)\.\d+/.exec(version);
	if (!m) {
		console.error(`[client-typescript:freeze] Cannot parse package version '${version}' in ${PKG_JSON}`);
		cleanup();
		process.exit(1);
	}
	return `${m[1]}.${m[2]}`;
}

/**
 * Enumerate the frozen floor keys present in versions/, sorted ascending by
 * (major, minor) so "earliest version that froze a type" is well defined.
 *
 * @returns {string[]} Sorted keys, e.g. ['1.3', '1.4'].
 */
function listFrozenKeys() {
	if (!fs.existsSync(VERSIONS_DIR)) return [];
	return fs
		.readdirSync(VERSIONS_DIR)
		.map((f) => /^v(\d+\.\d+)\.d\.ts$/.exec(f))
		.filter(Boolean)
		.map((m) => m[1])
		.sort(compareKeys);
}

/**
 * Numeric (major, minor) comparator for floor keys.
 *
 * @param {string} a - Key like '1.3'.
 * @param {string} b - Key like '1.10'.
 * @returns {number} Standard comparator result.
 */
function compareKeys(a, b) {
	const [am, an] = a.split('.').map(Number);
	const [bm, bn] = b.split('.').map(Number);
	return am - bm || an - bn;
}

/**
 * Identifier-safe form of a floor key ('1.3' -> '1_3') for generated names.
 *
 * @param {string} key - The floor key.
 * @returns {string} The identifier fragment.
 */
function idFor(key) {
	return key.replace('.', '_');
}

// =============================================================================
// FREEZE STEPS
// =============================================================================

/**
 * Type-check the contract program (live surface + floors) with the package's
 * own tsc. A frozen floor must never be generated from a broken tree, and the
 * same command is the enforcement gate for --floors / --check / --regen.
 *
 * @param {string} [failureNote] Extra recovery instruction printed on failure
 *   (freeze mode passes one because its derived-file rewrite has already run).
 * @returns {boolean} True when the program compiled cleanly.
 */
function floorsHold(failureNote) {
	log('tsc --noEmit -p tsconfig.contract.json (live surface vs frozen floors)...');
	const r = runNodeBin(TSC.binPath, ['--noEmit', '-p', CONTRACT_TSCONFIG], PACKAGE_ROOT);
	if (r.code !== 0) {
		console.error('[client-typescript:freeze] Contract tsc FAILED:');
		console.error(r.output);
		if (failureNote) console.error(failureNote);
		return false;
	}
	log('Contract tsc passed.');
	return true;
}

/**
 * Bundle src/client/index.ts into a single self-contained .d.ts and return
 * its post-processed body. dts-bundle-generator resolves relative inputs from
 * its CWD, so it runs from src/client where the entry lives.
 *
 * @returns {string} The generated declaration body.
 */
function generateCandidate() {
	// The bundler is resolved lazily: --regen never needs it, so a missing
	// devDependency install must not break derived-artifact regeneration.
	const DBG = resolveBin('dts-bundle-generator', 'dts-bundle-generator');
	fs.mkdirSync(TMP_DIR, { recursive: true });
	const candidatePath = path.join(TMP_DIR, 'candidate.d.ts');
	const r = runNodeBin(DBG.binPath, ['--project', path.relative(CLIENT_SRC_DIR, CONTRACT_TSCONFIG), '--no-check', '--no-banner', '--export-referenced-types=false', '-o', candidatePath, 'index.ts'], CLIENT_SRC_DIR);
	if (r.code !== 0 || !fs.existsSync(candidatePath)) {
		console.error('[client-typescript:freeze] dts-bundle-generator FAILED:');
		console.error(r.output);
		cleanup();
		process.exit(1);
	}
	// Post-processing order: strip class privates (structural comparison),
	// widen literal consts (no value pinning), rewrite enums structurally
	// (member growth stays additive), expand map generics (key growth stays
	// additive), then normalize trailing whitespace so the no-op comparison
	// against an existing floor is stable.
	let body = stripNonPublicMembers(fs.readFileSync(candidatePath, 'utf8'), ts);
	body = widenLiteralConsts(body);
	body = rewriteEnumsStructural(body);
	body = expandMapGenerics(body);
	return `${body.replace(/\s+$/, '')}\n`;
}

/** Extract the declaration body between the BEGIN/END markers of a version file. */
function extractBundleBody(fileContent) {
	const start = fileContent.indexOf(BEGIN);
	const end = fileContent.indexOf(END);
	if (start === -1 || end === -1) return null;
	return fileContent.slice(start + BEGIN.length, end).trim();
}

/**
 * Build the provenance header stamped onto each frozen version file. No
 * timestamp on purpose: the in-progress floor is re-emitted by every freeze,
 * and a volatile field would churn the diff on byte-identical re-freezes.
 *
 * @param {string} key - The floor key.
 * @returns {string} The header text.
 */
function versionHeader(key) {
	return [
		MIT_HEADER,
		'',
		'// =============================================================================',
		`// FROZEN rocketride SDK contract — floor v${key} — never edit by hand`,
		'// =============================================================================',
		`// Floor key:     ${key} (MAJOR.MINOR of packages/client-typescript/package.json)`,
		`// Source commit: ${gitCommit()}`,
		`// Generator:     dts-bundle-generator@${resolveBin('dts-bundle-generator', 'dts-bundle-generator').version}`,
		'// Produced by:   ./builder client-typescript:freeze',
		'//',
		`// Mutable ONLY while ${key} is the in-progress package version: re-running`,
		'// client-typescript:freeze REPLACES this floor. Once the package version',
		'// moves past it, this file is immutable — the append-only contract floor',
		'// for every release of this minor.',
		'// =============================================================================',
	].join('\n');
}

/**
 * Write the frozen version snapshot for a floor key.
 *
 * @param {string} key - The floor key.
 * @param {string} candidateBody - The generated bundle body.
 */
function writeVersion(key, candidateBody) {
	fs.mkdirSync(VERSIONS_DIR, { recursive: true });
	const content = [versionHeader(key), '', BEGIN, candidateBody.trim(), END, ''].join('\n');
	fs.writeFileSync(path.join(VERSIONS_DIR, `v${key}.d.ts`), content);
}

/**
 * Regenerate contract/latest.ts and contract/index.ts from a set of floors.
 *
 * @param {string[]} keys - Ascending floor keys (must be non-empty).
 */
function regenerateBarrels(keys) {
	const generatedNote = ['', '// =============================================================================', '// GENERATED by `./builder client-typescript:freeze` — do not edit by hand.', '// =============================================================================', ''].join('\n');
	const newest = keys[keys.length - 1];

	// latest.ts re-exports the newest floor's full surface. `export type *`
	// (not `export *`) keeps this a pure type re-export: the floors exist only
	// as `.d.ts`, so a value re-export would emit a runtime import.
	fs.writeFileSync(LATEST_TS, `${MIT_HEADER}\n${generatedNote}export type * from './versions/v${newest}';\n`);

	// index.ts maps every floor key to its value-surface snapshot. `typeof`
	// over a type-only namespace import captures the module's VALUE exports —
	// the same shape the per-version value floors hold the live surface to.
	const imports = keys.map((k) => `import type * as ClientApiV${idFor(k)} from './versions/v${k}';`).join('\n');
	const mapEntries = keys.map((k) => `\t'${k}': typeof ClientApiV${idFor(k)};`).join('\n');
	const index = [
		MIT_HEADER,
		generatedNote.trimEnd(),
		'',
		imports,
		'',
		'/** Registry mapping each frozen SDK floor key (MAJOR.MINOR) to its value-surface snapshot. */',
		`export interface ClientApiVersions {\n${mapEntries}\n}`,
		'',
		'/**',
		' * The newest frozen SDK floor — a convenience alias for consumers.',
		' *',
		' * Accumulation is NOT an intersection of versions: the "nothing ever frozen',
		" * can be removed\" guarantee is the per-version floors in the package's",
		' * src/contract-check.generated.ts, which assert the live surface still',
		' * satisfies EACH frozen floor separately.',
		' */',
		`export type ClientApiLatest = ClientApiVersions['${newest}'];`,
		'',
		// Type-only re-export: everything here is types, so this must never
		// emit a runtime import (see latest.ts above).
		"export type * from './latest';",
		'',
	].join('\n');
	fs.writeFileSync(INDEX_TS, index);
}

/**
 * Parse a bundle with the TypeScript compiler API and return every
 * individually-exported TYPE name mapped to its generic arity (0 for
 * non-generics). Values re-exported through `export { Orig as Alias }` blocks
 * are kept out of the type floors (a value name in a type position is TS2749;
 * values are covered by the whole-namespace value floors), and generic types
 * carry their type-parameter count so the conformance floors can be emitted
 * APPLIED (`Frozen_X<any, …>`) — a bare generic in a floor is TS2314.
 *
 * @param {string} bundleBody - The bundle text.
 * @returns {Map<string, number>} exported type name -> generic arity.
 */
function parseExportedTypeInfo(bundleBody) {
	const sf = ts.createSourceFile('bundle.d.ts', bundleBody, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	// Every top-level TYPE declaration (exported or not): name -> arity.
	// Interface merging keeps the first arity (merged decls agree by rule).
	const declared = new Map();
	const isExported = (st) => (ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Export) !== 0;
	const info = new Map();
	for (const st of sf.statements) {
		if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
			const arity = st.typeParameters ? st.typeParameters.length : 0;
			if (!declared.has(st.name.text)) declared.set(st.name.text, arity);
			// Inline-exported declarations. Rewritten enums land here too via
			// their `export type X = <base>` alias, so a REMOVED enum still
			// fails its Current_ import in the conformance file.
			if (isExported(st)) info.set(st.name.text, arity);
		}
	}
	// Re-export blocks: `export { Orig as Alias, … }` — types only.
	for (const st of sf.statements) {
		if (!ts.isExportDeclaration(st) || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
		for (const el of st.exportClause.elements) {
			const original = el.propertyName ? el.propertyName.text : el.name.text;
			if (declared.has(original)) info.set(el.name.text, declared.get(original));
		}
	}
	return info;
}

/**
 * Map each individually-exported named type to the EARLIEST frozen floor that
 * declared it. Derived from the frozen version files (not the live surface),
 * so a type REMOVED from the barrel is still in the map — its `Current_`
 * import in the conformance file then fails, catching the removal. Only the
 * in-progress floor can legitimately drop a type, and only via a re-freeze.
 *
 * @param {string[]} keys - Ascending floor keys.
 * @returns {Map<string, {key: string, arity: number}>} type -> earliest floor.
 */
function collectFrozenTypes(keys) {
	const earliest = new Map();
	for (const key of keys) {
		const p = path.join(VERSIONS_DIR, `v${key}.d.ts`);
		if (!fs.existsSync(p)) continue;
		for (const [name, arity] of parseExportedTypeInfo(fs.readFileSync(p, 'utf8'))) {
			// Arity travels with the pin: floors for generics must be emitted
			// APPLIED, using the arity the freezing floor declared.
			if (!earliest.has(name)) earliest.set(name, { key, arity });
		}
	}
	return earliest;
}

/**
 * Regenerate the conformance file compiled by the package's own tsc (via
 * tsconfig.contract.json).
 *
 * Each frozen floor gets a VALUE floor over the whole export namespace of
 * src/client/index.ts — `typeof <frozen module>` against `typeof <live
 * module>` — plus per-TYPE floors pinning every individually-exported type
 * against the earliest floor that froze it. Types are drawn from the frozen
 * files (accumulated), never from the live surface, so a removal cannot be
 * erased by re-running.
 *
 * @param {string[]} keys - Ascending floor keys (must be non-empty).
 */
function generateConformance(keys) {
	const names = [...collectFrozenTypes(keys).entries()];
	const lines = [];
	lines.push('// =============================================================================');
	lines.push('// contract-check.generated.ts');
	lines.push('// =============================================================================');
	lines.push('// GENERATED by `./builder client-typescript:freeze` — do not edit by hand.');
	lines.push('//');
	lines.push("// Enforces the accumulated rocketride SDK contract under the package's own");
	lines.push('// tsc (tsconfig.contract.json):');
	lines.push('//  - a per-version VALUE floor: the live export surface of');
	lines.push('//    src/client/index.ts must satisfy EACH frozen floor separately.');
	lines.push('//  - a per-TYPE floor: each exported type, pinned to the earliest floor');
	lines.push('//    that froze it.');
	lines.push('// Removing or narrowing anything ever frozen breaks this file. Floors are');
	lines.push('// derived from the immutable versions/*.d.ts; only the floor keyed to the');
	lines.push('// in-progress package MAJOR.MINOR may be re-minted (client-typescript:freeze).');
	lines.push('// =============================================================================');
	lines.push('');
	lines.push("import type * as LiveClientApi from './client/index.js';");
	for (const key of keys) {
		lines.push(`import type * as ClientApiV${idFor(key)} from '../contract/versions/v${key}';`);
	}
	for (const [name, info] of names) {
		lines.push(`import type { ${name} as Frozen_${name} } from '../contract/versions/v${info.key}';`);
		lines.push(`import type { ${name} as Current_${name} } from './client/index.js';`);
	}
	lines.push('');
	lines.push('// VALUE floors — the live surface must still satisfy every frozen floor.');
	for (const key of keys) {
		lines.push(`const _floor_v${idFor(key)}: typeof ClientApiV${idFor(key)} = {} as typeof LiveClientApi;`);
		lines.push(`void _floor_v${idFor(key)};`);
	}
	lines.push('');
	lines.push('// TYPE floors — each frozen exported type must still be satisfied.');
	lines.push('// Generic floors are emitted APPLIED (<any, …> at the frozen arity):');
	lines.push('// a bare generic is TS2314, and an arity change surfaces as one here.');
	for (const [name, info] of names) {
		const args = info.arity > 0 ? `<${new Array(info.arity).fill('any').join(', ')}>` : '';
		lines.push(`const _t_${name}: Frozen_${name}${args} = {} as Current_${name}${args};`);
		lines.push(`void _t_${name};`);
	}
	lines.push('');
	fs.writeFileSync(CONTRACT_CHECK, lines.join('\n'));
}

/**
 * Regenerate ALL derived artifacts (barrels + conformance file) from a floor
 * set, stubbing them when the set is empty (first-ever freeze: the pre-check
 * must compile the live surface with no floors to hold it to yet).
 *
 * @param {string[]} keys - Ascending floor keys (may be empty).
 */
function regenerateDerived(keys) {
	if (keys.length > 0) {
		regenerateBarrels(keys);
		generateConformance(keys);
		return;
	}
	// No floors yet — write compile-clean stubs. All three are rewritten for
	// real once the first floor lands; a committed stub means a first freeze
	// was interrupted and re-running client-typescript:freeze repairs it.
	const stubNote = ['// =============================================================================', '// RESET STUB — transient state inside `./builder client-typescript:freeze`;', '// regenerated into the real file before the run completes. If you are reading', '// this in a committed tree, a freeze was interrupted: re-run', '// `./builder client-typescript:freeze`.', '// ============================================================================='].join('\n');
	fs.writeFileSync(CONTRACT_CHECK, `${stubNote}\nexport {};\n`);
	fs.mkdirSync(CONTRACT_DIR, { recursive: true });
	fs.writeFileSync(INDEX_TS, `${MIT_HEADER}\n\n${stubNote}\nexport {};\n`);
	fs.writeFileSync(LATEST_TS, `${MIT_HEADER}\n\n${stubNote}\nexport {};\n`);
}

/**
 * Refuse to run when package.json has moved BEHIND an existing floor — a
 * released minor's floor is immutable, and re-minting it from an older
 * checkout would silently rewrite history.
 *
 * @param {string} key - The current floor key.
 * @param {string[]} keys - Existing floor keys (ascending).
 */
function guardKeyOrder(key, keys) {
	const newer = keys.filter((k) => compareKeys(k, key) > 0);
	if (newer.length > 0) {
		console.error(`[client-typescript:freeze] package.json version (${key}) is OLDER than existing floor(s): ${newer.join(', ')}. Released floors are immutable — bump the package version instead.`);
		cleanup();
		process.exit(1);
	}
}

// =============================================================================
// MAIN
// =============================================================================

/** Orchestrates the freeze / --check / --regen / --floors run. */
function main() {
	const checkMode = process.argv.includes('--check');
	const regenMode = process.argv.includes('--regen');
	const floorsMode = process.argv.includes('--floors');

	// --floors: enforcement only — compile the committed conformance file
	// against the live surface. The packaging gate: breaking changes fail,
	// additive work-in-progress passes without demanding a freeze.
	if (floorsMode) {
		if (!floorsHold('[client-typescript:freeze --floors] The live SDK surface breaks a frozen contract floor. Breaking changes require a MAJOR/MINOR decision — see packages/client-typescript/contract/.')) {
			process.exit(1);
		}
		return;
	}

	// --regen: rebuild the DERIVED artifacts from the immutable floors, then
	// verify the floors still hold. Reads versions/*.d.ts only — never the
	// live surface, never package.json — so on a clean tree the output is
	// byte-identical and CI's `git diff --exit-code` proves no floor, barrel
	// or check line was hand-edited to launder a breaking change.
	if (regenMode) {
		const keys = listFrozenKeys();
		if (keys.length === 0) {
			// A missing baseline is a FAILURE, not a pass: an emptied versions/
			// directory would otherwise no-op straight through the tamper diff.
			console.error('[client-typescript:freeze --regen] No frozen floor exists. The SDK contract baseline is missing — restore packages/client-typescript/contract/versions/ or run `./builder client-typescript:freeze`.');
			process.exit(1);
		}
		regenerateDerived(keys);
		if (!floorsHold('[client-typescript:freeze --regen] The live SDK surface breaks a frozen floor.')) {
			process.exit(1);
		}
		log(`Regenerated derived artifacts from floor(s) ${keys.join(', ')} (no floor files touched).`);
		return;
	}

	const key = currentKey();
	const keys = listFrozenKeys();
	guardKeyOrder(key, keys);

	if (checkMode) {
		// CI/publish mode: never write. Fails when the floors break, when the
		// current package version has no floor, or when the live surface has
		// drifted from that floor (any drift — the in-progress floor is cheap
		// to re-mint, so exact agreement is required to pass).
		if (!floorsHold()) {
			cleanup();
			process.exit(1);
		}
		if (!keys.includes(key)) {
			console.error(`[client-typescript:freeze --check] No frozen floor for package version ${key}. Run \`./builder client-typescript:freeze\`.`);
			cleanup();
			process.exit(1);
		}
		const frozenBody = extractBundleBody(fs.readFileSync(path.join(VERSIONS_DIR, `v${key}.d.ts`), 'utf8'));
		const candidateBody = generateCandidate();
		if (frozenBody !== candidateBody.trim()) {
			console.error(`[client-typescript:freeze --check] The live SDK surface differs from floor v${key}. Run \`./builder client-typescript:freeze\`.`);
			cleanup();
			process.exit(1);
		}
		cleanup();
		log(`Up to date with floor v${key}.`);
		return;
	}

	// Full freeze. The floor for the CURRENT key is mutable, so the pre-check
	// must enforce only the IMMUTABLE floors: regenerate the derived files
	// from them first (a symbol only the in-progress floor pinned may
	// legitimately be gone). Every file written here is deterministic and
	// rewritten again from the full set below, so an interrupted run is
	// repaired by re-running — or by `git restore packages/client-typescript`.
	const immutable = keys.filter((k) => k !== key);
	regenerateDerived(immutable);
	if (!floorsHold('[client-typescript:freeze] The derived contract files were regenerated from the immutable floors during this run. Fix the reported errors and re-run `./builder client-typescript:freeze`, or return to the committed contract with: git restore packages/client-typescript/contract packages/client-typescript/src/contract-check.generated.ts')) {
		cleanup();
		process.exit(1);
	}

	const candidateBody = generateCandidate();
	const existingPath = path.join(VERSIONS_DIR, `v${key}.d.ts`);
	const existingBody = keys.includes(key) ? extractBundleBody(fs.readFileSync(existingPath, 'utf8')) : null;
	if (existingBody === candidateBody.trim()) {
		// Byte-identical surface: keep the existing floor file untouched so its
		// recorded provenance (source commit) is not churned by a no-op run.
		log(`Floor v${key} already matches the live surface — floor file kept as-is.`);
	} else {
		writeVersion(key, candidateBody);
		log(`${existingBody === null ? 'Minted' : 'Re-minted in-progress'} floor v${key} -> packages/client-typescript/contract/versions/v${key}.d.ts`);
	}

	// Derived artifacts from the FULL floor set (immutable + current).
	const allKeys = [...immutable, key].sort(compareKeys);
	regenerateDerived(allKeys);
	cleanup();

	// Summary.
	log(`Contract now floors ${allKeys.map((k) => `v${k}`).join(', ')} (immutable floors never rewritten).`);
	log('Updated packages/client-typescript/contract/{latest.ts,index.ts} and packages/client-typescript/src/contract-check.generated.ts.');
	log('Changes left uncommitted.');
}

main();
