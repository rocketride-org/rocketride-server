import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import description from '../../scripts/lib/description.js';

const { describePage, firstParagraph } = description;

describe('describePage', () => {
	it('skips a multi-line import or export up to the next blank line', () => {
		assert.equal(describePage("import {\n\tA,\n\tB,\n} from 'x';\n\nReal prose.\n"), 'Real prose.');
		assert.equal(describePage('export const x = {\n\ta: 1,\n\tb: 2,\n};\n\nReal prose.\n'), 'Real prose.');
	});

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

	it('skips a JSX tag whose attributes run over several lines', () => {
		assert.equal(describePage('<Hero\n  title="Overview"\n/>\n\nReal prose.\n'), 'Real prose.');
		assert.equal(describePage('<Hero\n  title="Overview" />\nReal prose.\n'), 'Real prose.');
	});

	it('does not end a multi-line tag at a > inside a quoted value or an expression', () => {
		assert.equal(describePage('<Hero\n  title="a > b"\n  show={(x) => x > 1}\n/>\n\nReal prose.\n'), 'Real prose.');
	});

	it('does not let a tag that never closes run past a blank line', () => {
		assert.equal(describePage('<Hero title="x\nstill the tag\n\nReal prose.\n'), 'Real prose.');
	});

	it('does not close a fence on a marker indented four spaces', () => {
		assert.equal(describePage('```html\n    ```\ncode text\n<Widget />\n```\n\nReal prose.'), 'Real prose.');
	});
});

describe('firstParagraph', () => {
	it('skips a line that starts with an image', () => {
		assert.equal(firstParagraph('![Logo](/logo.png)\n\nThe real text.\n'), 'The real text.');
	});

	it('closes a fence only on the same character with at least the same length', () => {
		const body = '````md\n```\ninner\n```\n````\n\nAfter the fence.\n';
		assert.equal(firstParagraph(body), 'After the fence.');
	});

	it('keeps a comment opener inside code and strips a real comment', () => {
		assert.equal(firstParagraph('Use `<!--` to open.\n'), 'Use `<!--` to open.');
		assert.equal(firstParagraph('<!-- note -->\nVisible text.\n'), 'Visible text.');
	});

	it('does not let a four-space marker close a fence early and select code as prose', () => {
		assert.equal(firstParagraph('```html\n    ```\ncode text\n<Widget />\n```\n\nReal prose.'), 'Real prose.');
	});

	it('keeps a single-line tag skipped with the text after it on the same line', () => {
		assert.equal(firstParagraph('<Hero title="x" /> lead-in\n\nReal prose.\n'), 'Real prose.');
	});
});

describe('describePage: code spans and escapes', () => {
	it('keeps the text of a span that holds markup and drops the backticks', () => {
		assert.equal(describePage('Use the `**client**` and *bold* text.'), 'Use the **client** and bold text.');
	});

	it('does not let an escaped backtick open a code span', () => {
		assert.equal(describePage('What is \\`? Use the `**client**` and *bold* text.'), 'What is `? Use the **client** and bold text.');
	});

	it('pairs backticks the way CommonMark does', () => {
		assert.equal(describePage('A stray ` here and `x` there.'), 'A stray here andx` there.');
	});

	it('keeps an unclosed backtick run as written', () => {
		assert.equal(describePage('Press ``` to open a fence.'), 'Press ``` to open a fence.');
	});

	it('unescapes punctuation', () => {
		assert.equal(describePage('Pass \\*args and \\_name.'), 'Pass *args and _name.');
	});

	it('does not read an import or export in the middle of a paragraph as ESM', () => {
		assert.equal(describePage('With the CLI you can\nimport pipelines from a folder.\n'), 'With the CLI you can import pipelines from a folder.');
		assert.equal(describePage('The engine can\nexport default settings.\n'), 'The engine can export default settings.');
	});

	it('still skips an import at the start of a block', () => {
		assert.equal(describePage("import A from 'a';\nimport B from 'b';\n\nReal prose.\n"), 'Real prose.');
	});

	it('cuts a long single sentence at an em dash clause', () => {
		const lead = 'The engine reads every file that matches the pattern in the folder you name';
		const text = `${lead} — and then it keeps going with a very long tail that has no stop in it for a long while indeed.`;
		assert.equal(describePage(text), `${lead}.`);
	});
});
