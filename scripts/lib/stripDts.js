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
// stripDts — remove private/protected members from .d.ts declarations
// =============================================================================
//
// A class with private/protected members is compared NOMINALLY by TypeScript,
// so those members are load-bearing type identity — which is exactly why they
// break structural comparisons (e.g. a class exposed in a contravariant React
// FC prop, or an inlined snapshot compared against the live class). Removing
// them from the EMITTED declarations makes the public type purely structural
// without touching the source (private members are implementation detail that
// no consumer can access anyway).
//
// This is the same transform the shell-api freeze runs over its snapshot; it
// lives here so the SDK's own `dist/types` can be trimmed at build time (making
// BOTH sides of the freeze's structural comparison private-free), and both
// callers share one definition of "not public".
// =============================================================================

const fs = require('fs');
const path = require('path');

/**
 * Remove `private`/`protected` members from every class declaration in a
 * `.d.ts` source string. Files with nothing to strip are returned UNCHANGED
 * (byte-for-byte) so clean declaration files are never reformatted.
 *
 * @param {string} dtsText - The declaration file contents.
 * @param {object} ts - The TypeScript compiler module (caller-resolved).
 * @returns {string} The trimmed declarations, or the original text unchanged.
 */
function stripNonPublicMembers(dtsText, ts) {
	const sourceFile = ts.createSourceFile('decl.d.ts', dtsText, ts.ScriptTarget.Latest, true);

	// True when a class member is non-public: a `private`/`protected` modifier,
	// OR an ECMAScript private name (`#field`) — TypeScript types both nominally,
	// so both must be stripped for the class to compare structurally.
	const isNonPublic = (member) => {
		if (member.name && ts.isPrivateIdentifier(member.name)) return true;
		const mods = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
		return (
			!!mods &&
			mods.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)
		);
	};

	// Track whether anything was actually removed — only then do we reprint (a
	// reprint reformats the whole file, so we avoid it for clean files).
	let changed = false;
	const transformer = (context) => (root) => {
		const visit = (node) => {
			if (ts.isClassDeclaration(node)) {
				const kept = node.members.filter((m) => !isNonPublic(m));
				if (kept.length !== node.members.length) {
					changed = true;
					return ts.factory.updateClassDeclaration(
						node,
						node.modifiers,
						node.name,
						node.typeParameters,
						node.heritageClauses,
						kept,
					);
				}
				return node;
			}
			return ts.visitEachChild(node, visit, context);
		};
		return ts.visitNode(root, visit);
	};

	const result = ts.transform(sourceFile, [transformer]);
	// Unchanged files keep their exact original bytes; changed files are
	// reprinted (comments preserved) with the non-public members gone.
	const out = changed
		? ts.createPrinter({ removeComments: false, newLine: ts.NewLineKind.LineFeed }).printFile(result.transformed[0])
		: dtsText;
	result.dispose();
	return out;
}

/**
 * Strip private/protected members from every `.d.ts` under a directory
 * (recursive). A file that actually changes has its stale declaration map
 * (`.d.ts.map`) removed, since the reprint invalidates the mappings.
 *
 * @param {string} dir - Directory to walk (e.g. a package's `dist/types`).
 * @param {object} ts - The TypeScript compiler module (caller-resolved).
 * @returns {number} The count of `.d.ts` files rewritten.
 */
function stripDtsDir(dir, ts) {
	let rewritten = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// Recurse into nested declaration folders (core/, types/, schema/, ...).
			rewritten += stripDtsDir(full, ts);
		} else if (entry.name.endsWith('.d.ts')) {
			const src = fs.readFileSync(full, 'utf8');
			const out = stripNonPublicMembers(src, ts);
			if (out !== src) {
				fs.writeFileSync(full, out);
				rewritten++;
				// The declaration map no longer lines up with the reprinted file;
				// drop it rather than ship stale mappings.
				const map = `${full}.map`;
				if (fs.existsSync(map)) fs.rmSync(map);
			}
		}
	}
	return rewritten;
}

module.exports = { stripNonPublicMembers, stripDtsDir };
