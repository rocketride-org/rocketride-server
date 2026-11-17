import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import markdown from '../../scripts/lib/markdown.js';

const { fenceOpener, fenceCloses, codeSpanEnd, codeSpanStop, frontMatterTitle } = markdown;

describe('fenceOpener', () => {
	it('reads backtick and tilde fences with their length', () => {
		assert.deepEqual(fenceOpener('```js'), { ch: '`', len: 3 });
		assert.deepEqual(fenceOpener('  ~~~~'), { ch: '~', len: 4 });
	});

	it('does not open on a backtick in the info string of a backtick fence', () => {
		assert.equal(fenceOpener('```a`b'), null);
		assert.deepEqual(fenceOpener('~~~a`b'), { ch: '~', len: 3 });
	});

	it('does not open on prose, or on a CRLF line that is not a fence', () => {
		assert.equal(fenceOpener('text ```'), null);
		assert.deepEqual(fenceOpener('```\r'), { ch: '`', len: 3 });
	});
});

describe('fenceCloses', () => {
	const open = { ch: '`', len: 4 };

	it('needs the same character and at least as many marks', () => {
		assert.equal(fenceCloses('````', open), true);
		assert.equal(fenceCloses('`````', open), true);
		assert.equal(fenceCloses('```', open), false);
		assert.equal(fenceCloses('~~~~', open), false);
	});

	it('does not close on a line with an info string, and ignores a trailing CR', () => {
		assert.equal(fenceCloses('```` js', open), false);
		assert.equal(fenceCloses('````\r', open), true);
	});
});

describe('codeSpanEnd', () => {
	it('ends at the next run of the same length', () => {
		assert.equal(codeSpanEnd('`a` b', 0), 3);
		assert.equal(codeSpanEnd('``a`b`` c', 0), 7);
		assert.equal(codeSpanEnd('``a` b', 0), -1);
	});

	it('does not cross a blank line', () => {
		assert.equal(codeSpanEnd('`a\n\nb`', 0), -1);
		assert.equal(codeSpanEnd('`a\nb`', 0), 5);
	});

	it('stops at the end of a heading line', () => {
		assert.equal(codeSpanEnd('## Use ` here\nnext `x`', 7), -1);
		assert.equal(codeSpanEnd('text ` here\nnext `x`', 5), 18);
	});
});

describe('codeSpanStop', () => {
	it('returns the span end, or just the backtick run when it never closes', () => {
		assert.equal(codeSpanStop('`a` b', 0), 3);
		assert.equal(codeSpanStop('``a b', 0), 2);
	});
});

describe('frontMatterTitle', () => {
	it('reads a plain, quoted or CRLF title', () => {
		assert.equal(frontMatterTitle('---\ntitle: My Page\n---\nBody'), 'My Page');
		assert.equal(frontMatterTitle('---\ntitle: "Quoted: Page"\n---\n'), 'Quoted: Page');
		assert.equal(frontMatterTitle('---\r\ntitle: Win\r\n---\r\nBody'), 'Win');
	});

	it('returns null without front matter or without a title', () => {
		assert.equal(frontMatterTitle('# Just a heading\n'), null);
		assert.equal(frontMatterTitle('---\ndescription: x\n---\n'), null);
	});
});
