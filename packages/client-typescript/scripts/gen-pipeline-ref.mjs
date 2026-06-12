/**
 * client-typescript:gen-pipeline-ref — generate the Pipeline JSON reference from
 * the .pipe schema's owning types (src/client/types/pipeline.ts) using the
 * TypeScript compiler API. Deposited in-tree at docs/reference/pipeline/index.md
 * and mounted to /pipeline-reference by the docs shell.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');
const SOURCE = path.join(PKG, 'src', 'client', 'types', 'pipeline.ts');
const OUT_DIR = path.join(PKG, 'docs', 'reference', 'pipeline');
const OUT = path.join(OUT_DIR, 'index.md');

function jsdocText(node) {
	const docs = ts.getJSDocCommentsAndTags(node).filter((d) => ts.isJSDoc(d));
	const text = docs
		.map((d) => (typeof d.comment === 'string' ? d.comment : ts.getTextOfJSDocComment(d.comment) || ''))
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
	return text;
}

function memberRow(member, source) {
	const name = member.name?.getText(source) ?? '';
	const optional = member.questionToken ? 'No' : 'Yes';
	const type = member.type ? member.type.getText(source).replace(/\s+/g, ' ') : 'unknown';
	const doc = jsdocText(member).replace(/\|/g, '\\|');
	return `| \`${name}\` | \`${type.replace(/\|/g, '\\|')}\` | ${optional} | ${doc} |`;
}

function main() {
	const source = ts.createSourceFile(SOURCE, readFileSync(SOURCE, 'utf8'), ts.ScriptTarget.Latest, true);

	const out = ['---', 'title: Pipeline JSON Reference', 'slug: /pipeline-reference', '---', '', '# Pipeline JSON Reference', '', 'Generated from the `.pipe` schema types in `packages/client-typescript/src/client/types/pipeline.ts`. A `.pipe` file is JSON conforming to these interfaces.', ''];

	ts.forEachChild(source, (node) => {
		if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) return;
		const isExported = (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
		if (!isExported) return;

		out.push(`## ${node.name.text}`, '');
		const doc = jsdocText(node);
		if (doc) out.push(doc, '');

		if (ts.isInterfaceDeclaration(node)) {
			const members = node.members.filter(ts.isPropertySignature);
			if (members.length) {
				out.push('| Field | Type | Required | Description |', '| --- | --- | --- | --- |');
				for (const m of members) out.push(memberRow(m, source));
				out.push('');
			}
		} else {
			out.push('```ts', node.getText(source), '```', '');
		}
	});

	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(OUT, out.join('\n'));
	console.log(`gen-pipeline-ref: wrote ${path.relative(PKG, OUT)}`);
}

main();
