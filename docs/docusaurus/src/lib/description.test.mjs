import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import description from '../../scripts/lib/description.js';

const { describePage } = description;

describe('describePage', () => {
	it('joins a hard-wrapped paragraph', () => {
		assert.equal(describePage('# T\n\nFirst line of the\nparagraph ends here.\n\nSecond.'), 'First line of the paragraph ends here.');
	});

	it('skips HTML comments, head blocks, tables, lists and fences', () => {
		const body = '<!-- a comment\nover lines -->\n<head><title>x</title></head>\n\n| a | b |\n|---|---|\n\n- item\n\n```\ncode\n```\n\nThe real text.\n';
		assert.equal(describePage(body), 'The real text.');
	});

	it('strips links, code marks and emphasis', () => {
		assert.equal(describePage('See [the **guide**](/x) for `use()` and A &amp; B.'), 'See the guide for use() and A & B.');
	});

	it('keeps whole sentences up to 160 characters', () => {
		const s1 = 'A'.repeat(70) + '.';
		const s2 = 'B'.repeat(70) + '.';
		const s3 = 'C'.repeat(70) + '.';
		assert.equal(describePage(`${s1} ${s2} ${s3}`), `${s1} ${s2}`);
	});

	it('cuts a single long sentence at a word boundary with an ellipsis', () => {
		const out = describePage('word '.repeat(60).trim() + '.');
		assert.ok(out.length <= 160);
		assert.match(out, /word…$/);
	});

	it('cuts a long sentence at a semicolon when there is one', () => {
		const a = 'A directory of nodes for raw HTTP intake and browser chat and upload interfaces';
		assert.equal(describePage(`${a}; choose the service that matches how a client should enter the pipeline and more words.`), `${a}.`);
	});

	it('ends a paragraph that introduces a list with a period', () => {
		assert.equal(describePage('Steps to follow:\n\n- one'), 'Steps to follow.');
	});

	it('skips imports and JSX lines on mdx pages', () => {
		assert.equal(describePage("import X from 'x';\n\n<Hero a=\"1\" />\n\nBuild things.\n"), 'Build things.');
	});

	it('does not end a sentence after e.g., i.e., etc. or vs.', () => {
		// The first paragraph of docs/public/python/storage.md (it used to end at "(e.g.").
		const storage = [
			"Read, write, and manage files in your account's server-side store. All paths are",
			'**relative** to the store root (e.g. `"docs/readme.md"`); `..` traversal is',
			'rejected client-side, and `fs_rmdir`, `fs_rename`, `fs_get_url`, and',
			'`fs_read_many` additionally reject absolute-like paths (leading `/` or `\\`). Method tables in the',
			'[API reference](/clients/python/reference#store-file-access).',
		].join('\n');
		assert.equal(describePage(storage), "Read, write, and manage files in your account's server-side store.");
		assert.doesNotMatch(describePage(`Short lead sentence. All paths are relative (e.g. a file) and then more text follows ${'q '.repeat(30)}end.`), /e\.g\.$/);
		assert.equal(describePage(`Use a tool, i.e. A or B ${'x '.repeat(20)}and more, etc. Then ${'y '.repeat(40)}end.`).slice(0, 20), 'Use a tool, i.e. A o');
		assert.match(describePage(`Fast vs. Slow ${'z '.repeat(30)}ends here. ${'w '.repeat(30)}done.`), /^Fast vs\. Slow /);
	});

	it('keeps the text inside inline code, including angle brackets', () => {
		assert.equal(describePage('Replace `<your-api-key>` with your key.'), 'Replace <your-api-key> with your key.');
		assert.equal(describePage('Returns a `Promise<Result>` object.'), 'Returns a Promise<Result> object.');
		assert.equal(describePage('Use ``a ` b`` here.'), 'Use a ` b here.');
	});

	it('keeps underscores and stars inside inline code', () => {
		assert.equal(describePage('Implement `__init__` and match `*.pdf` files.'), 'Implement __init__ and match *.pdf files.');
	});

	it('drops an inline image completely', () => {
		assert.equal(describePage('See ![diagram](/a.png) above.'), 'See above.');
	});

	it('returns an empty string when there is no prose', () => {
		assert.equal(describePage('# Title\n\n| a |\n'), '');
	});

	it('stays inside a four-backtick block that holds a three-backtick line', () => {
		const body = '# T\n\n````md\n```js\ncode();\n```\nmore code\n````\n\nReal prose.\n';
		assert.equal(describePage(body), 'Real prose.');
	});
});
