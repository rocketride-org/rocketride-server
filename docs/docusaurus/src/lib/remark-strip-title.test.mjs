import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import remarkStripTitle from './remark-strip-title.mjs';

const h = (depth, text) => ({ type: 'heading', depth, children: [{ type: 'text', value: text }] });
const p = (text) => ({ type: 'paragraph', children: [{ type: 'text', value: text }] });
// The trees are plain data, so a JSON round trip is a full copy.
const clone = (value) => JSON.parse(JSON.stringify(value));
const run = (children, data = {}, value) => {
	const tree = { type: 'root', children };
	remarkStripTitle()(tree, { data, value });
	return tree.children;
};

describe('remarkStripTitle', () => {
	it('drops the leading h1', () => {
		assert.deepEqual(run([h(1, 'Title'), p('Body')], {}, '# Title\n\nBody'), [p('Body')]);
	});

	it('skips imports before the title', () => {
		const esm = { type: 'mdxjsEsm', value: "import X from 'x';" };
		assert.deepEqual(run([esm, h(1, 'Title'), p('Body')], {}, "import X from 'x';\n\n# Title\n\nBody"), [esm, p('Body')]);
	});

	it('keeps an h1 that comes after another heading', () => {
		const tree = [h(2, 'Intro'), p('Body'), h(1, 'Appendix')];
		const before = clone(tree);
		assert.deepEqual(run(clone(tree)), before);
	});

	it('keeps an h1 that comes after a thematic break', () => {
		const tree = [p('Lead'), { type: 'thematicBreak' }, h(1, 'Later')];
		const before = clone(tree);
		assert.deepEqual(run(clone(tree)), before);
	});

	it('removes only the first of two h1 headings', () => {
		assert.deepEqual(run([h(1, 'A'), h(1, 'B')], {}, '# A\n\n# B'), [h(1, 'B')]);
	});

	it('finds a title inside a wrapper element, like Docusaurus does', () => {
		const wrapper = { type: 'mdxJsxFlowElement', name: 'div', children: [h(1, 'Title'), p('x')] };
		assert.deepEqual(run([wrapper], { frontMatter: { title: 'T' } })[0].children, [p('x')]);
	});

	it('keeps a nested h1 as an h2 when text comes before its wrapper and the front matter has a title', () => {
		const inner = { type: 'mdxJsxFlowElement', name: 'div', children: [h(1, 'Deep')] };
		const outer = { type: 'mdxJsxFlowElement', name: 'section', children: [p('Lead text'), inner] };
		const out = run([outer], { frontMatter: { title: 'T' } });
		assert.deepEqual(out[0].children[1].children, [h(2, 'Deep')]);
	});

	it('leaves hide_title pages alone', () => {
		const tree = [h(1, 'Title'), p('Body')];
		const before = clone(tree);
		assert.deepEqual(run(clone(tree), { frontMatter: { hide_title: true } }), before);
	});

	it('keeps the heading as an h2 when text comes before it and the page has no title', () => {
		assert.deepEqual(run([p('Lead text'), h(1, 'Heading')], {}, 'Lead text\n\n# Heading'), [p('Lead text'), h(2, 'Heading')]);
	});

	it('keeps an h1 after text and demotes it to h2 when the front matter has a title', () => {
		assert.deepEqual(run([p('Lead text'), h(1, 'Heading')], { frontMatter: { title: 'T' } }), [p('Lead text'), h(2, 'Heading')]);
	});

	it('demotes a later h1 when the front matter title differs from the leading h1 position', () => {
		const out = run([p('Intro'), h(1, 'Troubleshooting'), p('x')], { frontMatter: { title: 'Guide' } }, '');
		assert.deepEqual(out, [p('Intro'), h(2, 'Troubleshooting'), p('x')]);
	});

	it('drops a leading h1 that differs from the front matter title', () => {
		assert.deepEqual(run([h(1, 'Other'), p('Body')], { frontMatter: { title: 'T' } }), [p('Body')]);
	});

	it('drops the leading h1 when it follows an import and the front matter has a title', () => {
		const esm = { type: 'mdxjsEsm', value: "import X from 'x';" };
		assert.deepEqual(run([esm, h(1, 'Other'), p('Body')], { frontMatter: { title: 'T' } }), [esm, p('Body')]);
	});

	it('drops a setext h1 and an h1 with inline code when there is no front matter title', () => {
		assert.deepEqual(run([h(1, 'Title'), p('Body')], {}, 'Title\n=====\n\nBody'), [p('Body')]);
		const code = { type: 'heading', depth: 1, children: [{ type: 'inlineCode', value: 'cfg' }] };
		assert.deepEqual(run([code, p('Body')], {}, '# `cfg`\n\nBody'), [p('Body')]);
	});

	it('strips a leading h1 when the file text has front matter before it', () => {
		assert.deepEqual(run([h(1, 'Title'), p('Body')], {}, '---\nsidebar_position: 1\n---\n\n# Title\n\nBody'), [p('Body')]);
	});

	it('keeps the heading as an h2 when a comment, export or expression comes first and there is no title', () => {
		const note = { type: 'html', value: '<!-- note -->' };
		const exp = { type: 'mdxjsEsm', value: 'export const a = 1;' };
		const expr = { type: 'mdxFlowExpression', value: '/* c */' };
		for (const [node, value] of [[note, '<!-- note -->\n\n# Install'], [exp, 'export const a = 1;\n\n# Install'], [expr, '{/* c */}\n\n# Install']]) {
			assert.deepEqual(run([node, h(1, 'Install'), p('Body')], {}, value), [node, h(2, 'Install'), p('Body')]);
		}
	});

	it('skips comments before the title when the front matter has a title', () => {
		const note = { type: 'html', value: '<!-- note -->' };
		assert.deepEqual(run([note, h(1, 'Title'), p('Body')], { frontMatter: { title: 'T' } }), [note, p('Body')]);
	});

	it('does not need a value string to leave a page alone', () => {
		const tree = [h(1, 'Title')];
		const before = clone(tree);
		assert.deepEqual(run(clone(tree)), before);
	});

	it('skips a front matter node before the title (md pages keep it in the tree)', () => {
		const fm = { type: 'yaml', value: 'last_update:\n  date: 2026-09-15' };
		assert.deepEqual(run([fm, h(1, 'Title'), p('Body')], {}, '# Title\n\nBody'), [fm, p('Body')]);
	});
});
