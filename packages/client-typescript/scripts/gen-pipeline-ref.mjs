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

	const preamble = [
		'---',
		'title: Pipeline JSON Reference',
		'slug: /pipeline-reference',
		'---',
		'',
		'# Pipeline JSON Reference',
		'',
		'A `.pipe` file is JSON conforming to the interfaces below. The schema is the',
		'contract the [engine](/concepts/runtime-engine) loads and the SDKs send over',
		'the [WebSocket protocol](/protocols/websocket) — the same JSON whether you',
		'author it visually or by hand. For the concepts behind these fields, see',
		'[Pipelines](/concepts/pipelines) and the [Execution model](/concepts/execution-model).',
		'',
		'## Top-level shape',
		'',
		'A pipeline is an object with a `components` array (the nodes of the graph) and,',
		'when agents or other invokers are involved, a `control` array describing the',
		'invoke connections. Each component declares its `id`, `provider`, `config`, and',
		'the input lanes it consumes.',
		'',
		'```json',
		'{',
		'  "components": [',
		'    { "id": "in", "provider": "webhook", "config": {} },',
		'    {',
		'      "id": "out",',
		'      "provider": "response",',
		'      "config": { "laneName": "text" },',
		'      "input": [{ "lane": "text", "from": "in" }]',
		'    }',
		'  ]',
		'}',
		'```',
		'',
		'## Interfaces',
		'',
		'The definitions below are generated from the `.pipe` schema types in',
		'`packages/client-typescript/src/client/types/pipeline.ts`; a `.pipe` file is JSON',
		'conforming to them.',
		'',
	];
	const out = [...preamble];

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
