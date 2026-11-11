import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import remarkStripTitle from './remark-strip-title.mjs';

const h = (depth, text) => ({ type: 'heading', depth, children: [{ type: 'text', value: text }] });
const p = (text) => ({ type: 'paragraph', children: [{ type: 'text', value: text }] });
const run = (children, data = {}) => {
	const tree = { type: 'root', children };
	remarkStripTitle()(tree, { data });
	return tree.children;
};

describe('remarkStripTitle', () => {
	it('drops the leading h1', () => {
		assert.deepEqual(run([h(1, 'Title'), p('Body')]), [p('Body')]);
	});

	it('skips imports before the title', () => {
		const esm = { type: 'mdxjsEsm', value: "import X from 'x';" };
		assert.deepEqual(run([esm, h(1, 'Title'), p('Body')]), [esm, p('Body')]);
	});

	it('keeps an h1 that comes after another heading', () => {
		const tree = [h(2, 'Intro'), p('Body'), h(1, 'Appendix')];
		const before = structuredClone(tree);
		assert.deepEqual(run(structuredClone(tree)), before);
	});

	it('keeps an h1 that comes after a thematic break', () => {
		const tree = [p('Lead'), { type: 'thematicBreak' }, h(1, 'Later')];
		const before = structuredClone(tree);
		assert.deepEqual(run(structuredClone(tree)), before);
	});

	it('removes only the first of two h1 headings', () => {
		assert.deepEqual(run([h(1, 'A'), h(1, 'B')]), [h(1, 'B')]);
	});

	it('finds a title inside a wrapper element, like Docusaurus does', () => {
		const wrapper = { type: 'mdxJsxFlowElement', name: 'div', children: [h(1, 'Title'), p('x')] };
		assert.deepEqual(run([wrapper], { frontMatter: { title: 'T' } })[0].children, [p('x')]);
	});

	it('leaves hide_title pages alone', () => {
		const tree = [h(1, 'Title'), p('Body')];
		const before = structuredClone(tree);
		assert.deepEqual(run(structuredClone(tree), { frontMatter: { hide_title: true } }), before);
	});

	it('keeps the h1 when text comes before it and the page has no title', () => {
		const tree = [p('Lead text'), h(1, 'Heading')];
		const before = structuredClone(tree);
		assert.deepEqual(run(structuredClone(tree)), before);
	});

	it('drops an h1 after text when the front matter has a title', () => {
		assert.deepEqual(run([p('Lead text'), h(1, 'Heading')], { frontMatter: { title: 'T' } }), [p('Lead text')]);
	});

	it('skips comments before the title', () => {
		const note = { type: 'html', value: '<!-- note -->' };
		assert.deepEqual(run([note, h(1, 'Title'), p('Body')]), [note, p('Body')]);
	});

	it('skips a front matter node before the title (md pages keep it in the tree)', () => {
		const fm = { type: 'yaml', value: 'last_update:\n  date: 2026-09-15' };
		assert.deepEqual(run([fm, h(1, 'Title'), p('Body')]), [fm, p('Body')]);
	});
});
