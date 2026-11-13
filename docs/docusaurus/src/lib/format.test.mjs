import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatStars, markdownUrl, isExternal, withTrailingSlash } from './format.mjs';

describe('formatStars', () => {
	it('renders counts under 1000 verbatim', () => {
		assert.equal(formatStars(999), '999');
	});

	it('collapses thousands and trims a redundant .0', () => {
		assert.equal(formatStars(1000), '1k');
		assert.equal(formatStars(1500), '1.5k');
		assert.equal(formatStars(12000), '12k');
	});

	it('keeps the k suffix past 1M (no M branch by design)', () => {
		assert.equal(formatStars(999999), '1000k');
	});
});

describe('markdownUrl', () => {
	it('maps the root route to index.md', () => {
		assert.equal(markdownUrl('/'), '/index.md');
	});

	it('strips a trailing slash before appending .md', () => {
		assert.equal(markdownUrl('/nodes/x/'), '/nodes/x.md');
	});
});

describe('isExternal', () => {
	it('is true for absolute http/https urls', () => {
		assert.equal(isExternal('https://example.com'), true);
		assert.equal(isExternal('http://example.com'), true);
	});

	it('is false for internal routes', () => {
		assert.equal(isExternal('/quickstart'), false);
	});
});

describe('withTrailingSlash', () => {
	it('adds a slash to a URL that has none', () => {
		assert.equal(withTrailingSlash('https://docs.rocketride.org/quickstart'), 'https://docs.rocketride.org/quickstart/');
	});

	it('leaves a URL that already ends with a slash unchanged', () => {
		assert.equal(withTrailingSlash('https://docs.rocketride.org/quickstart/'), 'https://docs.rocketride.org/quickstart/');
	});

	it('returns a value that is not a string as it is', () => {
		assert.equal(withTrailingSlash(undefined), undefined);
		assert.equal(withTrailingSlash(null), null);
		const obj = { a: 1 };
		assert.equal(withTrailingSlash(obj), obj);
	});
});
