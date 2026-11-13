import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import twin from '../../scripts/lib/twin.js';

const { cleanTwin } = twin;
const mdx = (s) => cleanTwin(s, { mdx: true });

describe('cleanTwin', () => {
	it('drops front matter, adds the index pointer and the title when the body has none', () => {
		const out = cleanTwin('---\ntitle: My Page\n---\nHello\n', { indexUrl: 'https://x/llms.txt' });
		assert.equal(out, '> Documentation index for agents: https://x/llms.txt\n\n# My Page\n\nHello\n');
	});

	it('does not count a comment inside a code fence as the title', () => {
		const src = '---\ntitle: Analytics\n---\nText\n\n```python\n# not a title\nx = 1\n```\n';
		assert.match(cleanTwin(src), /^# Analytics\n\nText/);
	});

	it('ends a code span at the end of a heading line, so a stray backtick does not hide the next line', () => {
		assert.equal(mdx('## Use ` here\n<b>bold</b> and `x`\n'), '## Use ` here\nbold and `x`\n');
	});

	it('leaves .md sources alone apart from front matter', () => {
		assert.equal(cleanTwin('Use <name> here\nimport x from "y"\n'), 'Use <name> here\nimport x from "y"\n');
	});
});

describe('cleanTwin mdx: links', () => {
	it('keeps the link of a hand-written <a> as a markdown link', () => {
		assert.equal(mdx('<a className="btn" href="/quickstart/">Get Started</a>\n'), '[Get Started](/quickstart/)\n');
	});

	it('turns a multi-line <a> card into a titled list item with its body', () => {
		const src = [
			'<div className="grid">',
			'',
			'<a className="rr-side-card" href="/clients/python/configuration/">',
			'  <span className="rr-side-card__head"><LuSettings className="icon" /><span className="rr-side-card__title">Configuration</span></span>',
			'  <span className="rr-side-card__body">Constructor options, and <code>use()</code>.</span>',
			'</a>',
			'',
			'</div>',
		].join('\n');
		assert.equal(mdx(src), '- [Configuration](/clients/python/configuration/): Constructor options, and use().\n');
	});

	it('turns the site Card component into a link line', () => {
		assert.equal(mdx('<Card href="/x/" title="Thing" icon={<Icon />}>\n'), '- [Thing](/x/)\n');
	});

	it('keeps nested list indentation after a self-closing Card', () => {
		const out = mdx('<Card href="/x/" title="T" />\n\n- one\n  - nested\n  - nested2\n');
		assert.match(out, /- one\n {2}- nested\n {2}- nested2/);
	});
});

describe('cleanTwin mdx: robustness', () => {
	it('handles double-backtick inline code', () => {
		assert.equal(mdx('Use `` a ` b <Foo> `` now\n'), 'Use `` a ` b <Foo> `` now\n');
	});

	it('drops a multi-line export const', () => {
		assert.equal(mdx('export const x = {\n  a: 1,\n  b: [2],\n};\n\nText\n'), 'Text\n');
	});

	it('drops multi-line and single-line imports', () => {
		assert.equal(mdx("import { A,\n  B } from 'x';\nimport C from 'c';\n\nText\n"), 'Text\n');
	});

	it('leaves an export that never balances exactly as written', () => {
		const src = 'export const x = {\n  a: 1,\n\nText\n';
		assert.equal(mdx(src), src);
	});

	it('keeps prose that merely starts with the word import', () => {
		assert.equal(mdx('import the data first\n'), 'import the data first\n');
	});

	it('handles > inside an attribute string and inside an expression', () => {
		assert.equal(mdx('A <Foo title="a > b" /> B\n'), 'A  B\n');
		assert.equal(mdx('A <Foo f={(x) => x > 1} /> B\n'), 'A  B\n');
	});

	it('removes a multi-line opening tag', () => {
		assert.equal(mdx('<div\n  className="x"\n>\nText\n</div>\n'), 'Text\n');
	});

	it('removes a tag whose attribute holds an object', () => {
		assert.equal(mdx('<Img sources={{ light: a(), dark: b() }} />\nText\n'), 'Text\n');
	});

	it('keeps a three-backtick fence inside a four-backtick fence untouched', () => {
		const src = '````md\n```\n<Foo />\nimport x from "y"\n```\n````\n\n<Bar />After\n';
		assert.equal(mdx(src), '````md\n```\n<Foo />\nimport x from "y"\n```\n````\n\nAfter\n');
	});

	it('keeps an unclosed fence to the end of the page', () => {
		assert.equal(mdx('Text\n\n```js\n<Foo />\n'), 'Text\n\n```js\n<Foo />\n');
	});

	it('decodes HTML entities in text but not in code', () => {
		assert.equal(mdx('Resources &amp; Widgets, `&amp;`\n'), 'Resources & Widgets, `&amp;`\n');
	});

	it('leaves comments, autolinks and a lone < alone', () => {
		const src = 'Text <!-- hidden <Foo> --> and {/* <Bar /> */}\n<https://x.dev/a> and 1 < 2\n';
		assert.equal(mdx(src), src);
	});

	it('leaves an unclosed tag as written', () => {
		assert.equal(mdx('Text <Foo bar="x\nmore\n'), 'Text <Foo bar="x\nmore\n');
	});

	it('trims wrapper indentation but not list indentation outside wrappers', () => {
		assert.equal(mdx('<Tabs>\n    <TabItem>\n    Body\n    </TabItem>\n</Tabs>\n'), 'Body\n');
	});

	it('keeps nested list indentation inside wrappers', () => {
		const src = '<Tabs>\n  <TabItem value="a">\n    - one\n      - nested\n    - two\n  </TabItem>\n</Tabs>\n';
		assert.equal(mdx(src), '- one\n  - nested\n- two\n');
	});

	it('turns a <br> into a space', () => {
		assert.equal(mdx('line<br>next and one<br />two\n'), 'line next and one two\n');
	});

	it('does not leave a space inside bold when an icon is dropped', () => {
		assert.equal(mdx('**<LuPlay /> Run button** and **Stop <LuStop />**\n'), '**Run button** and **Stop**\n');
	});

	it('does not leave empty parentheses when an image component is dropped', () => {
		assert.equal(mdx('Click the logo\n(<ThemedImage alt="x" sources={{ light: \'/a.svg\' }} />)\nicon now\n'), 'Click the logo\nicon now\n');
	});

	it('strips empty front matter', () => {
		assert.equal(cleanTwin('---\n---\nHello\n'), 'Hello\n');
	});

	it('can leave out the title it would add from the front matter', () => {
		assert.equal(cleanTwin('---\ntitle: T\n---\nHello\n', { addTitle: false }), 'Hello\n');
	});
});

describe('cleanTwin: code fences, escapes and brace links', () => {
	it('keeps blank lines inside a fenced code block', () => {
		const code = '```python\nimport x\n\n\nasync def main():\n    pass\n```';
		const src = `Intro\n\n\n\n${code}\n\nOutro\n`;
		assert.equal(cleanTwin(src), `Intro\n\n${code}\n\nOutro\n`);
		assert.equal(mdx(src), `Intro\n\n${code}\n\nOutro\n`);
	});

	it('removes a tag whose brace expression holds an escaped quote', () => {
		assert.equal(mdx("Before\n<Widget label={'it\\'s'} />\nAfter\n"), 'Before\nAfter\n');
	});

	it('skips an import whose string holds an escaped quote', () => {
		assert.equal(mdx("import x from 'a\\'b';\n\nText\n"), 'Text\n');
	});

	it('does not run a stray apostrophe in an export line into the next paragraphs', () => {
		const src = "export const Note = () => <p>Don't do this</p>;\n\nFirst paragraph.\n\nIt's the second paragraph.\n";
		const out = mdx(src);
		assert.ok(out.startsWith('export const Note = () =>'));
		assert.ok(out.endsWith("\n\nFirst paragraph.\n\nIt's the second paragraph.\n"));
	});

	it('does not let a stray apostrophe in a brace expression close at a later quote', () => {
		const src = "<Widget label={Don't}>\nIt's kept }\n</Widget>\n";
		const out = mdx(src);
		assert.ok(out.includes("Don't"));
		assert.ok(out.includes("It's kept }"));
	});

	it('still lets a template literal span lines in an export', () => {
		assert.equal(mdx('export const x = `a\nb`;\n\nText\n'), 'Text\n');
	});

	it('reads a brace-wrapped string literal as the link target', () => {
		assert.equal(mdx("<a href={'/quickstart'}>Start</a>\n"), '[Start](/quickstart)\n');
		assert.equal(mdx('<a href={"/quickstart"}>Start</a>\n'), '[Start](/quickstart)\n');
	});

	it('leaves the text of a link whose href is not a literal, without a link target', () => {
		assert.equal(mdx('<a href={url}>Start</a>\n'), 'Start\n');
	});
});
