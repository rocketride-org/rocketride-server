// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MarkdownRenderer URL handling: relative sources resolve against `baseUrl`,
 * same-origin artifact paths are admitted, scriptable URLs stay stripped, and
 * without a base nothing changes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownRenderer } from './MarkdownRenderer';

const README_URL = '/pipelines/acme.docBrain/v3/README.md';

test('a relative image source resolves against the base URL directory', () => {
	const markup = renderToStaticMarkup(<MarkdownRenderer content="![shot](./assets/shot.png)" baseUrl={README_URL} />);
	assert.match(markup, /src="\/pipelines\/acme\.docBrain\/v3\/assets\/shot\.png"/);
});

test('a relative link resolves against the base URL and is followed', () => {
	const markup = renderToStaticMarkup(<MarkdownRenderer content="[docs](docs/guide.md)" baseUrl={README_URL} />);
	assert.match(markup, /href="\/pipelines\/acme\.docBrain\/v3\/docs\/guide\.md"/);
});

test('an artifact path is admitted as an image source and as a link', () => {
	const markup = renderToStaticMarkup(<MarkdownRenderer content={'![a](/pipelines/x/v1/a.png)\n\n[b](/apps/y/v2/README.md)'} />);
	assert.match(markup, /src="\/pipelines\/x\/v1\/a\.png"/);
	assert.match(markup, /href="\/apps\/y\/v2\/README\.md"/);
});

test('scriptable URLs are stripped, with and without a base', () => {
	for (const baseUrl of [undefined, README_URL]) {
		const markup = renderToStaticMarkup(<MarkdownRenderer content={'[x](javascript:alert(1))\n\n<img src="data:text/html,evil">\n\n[y](vbscript:evil)'} baseUrl={baseUrl} />);
		assert.doesNotMatch(markup, /javascript:/);
		assert.doesNotMatch(markup, /data:text\/html/);
		assert.doesNotMatch(markup, /vbscript:/);
	}
});

test('a page-relative path that is not an artifact path is not a followed link', () => {
	// Today's behaviour: the anchor renderer follows http(s)/mailto/tel and
	// artifact paths only; any other path keeps its text and drops the href.
	const markup = renderToStaticMarkup(<MarkdownRenderer content="[x](/settings/account)" />);
	assert.doesNotMatch(markup, /href=/);
	assert.match(markup, />x</);
});

test('without a base URL a relative image source is left as written', () => {
	const markup = renderToStaticMarkup(<MarkdownRenderer content="![shot](./assets/shot.png)" />);
	assert.match(markup, /src="\.\/assets\/shot\.png"/);
});

test('data:image sources still pass', () => {
	const markup = renderToStaticMarkup(<MarkdownRenderer content='<img src="data:image/png;base64,QUJD">' baseUrl={README_URL} />);
	assert.match(markup, /src="data:image\/png;base64,QUJD"/);
});

test('resolution keeps the base shape and leaves absolute and fragment URLs alone', () => {
	// A path-only base gives a path-only result, `..` included.
	assert.match(renderToStaticMarkup(<MarkdownRenderer content="![i](../icon.svg)" baseUrl="/apps/a/v1/docs/README.md" />), /src="\/apps\/a\/v1\/icon\.svg"/);
	// An absolute base gives an absolute result.
	assert.match(renderToStaticMarkup(<MarkdownRenderer content="![i](icon.svg)" baseUrl="https://rr.example/apps/a/v1/README.md" />), /src="https:\/\/rr\.example\/apps\/a\/v1\/icon\.svg"/);
	// An absolute source is never rebased; a fragment link stays a fragment.
	assert.match(renderToStaticMarkup(<MarkdownRenderer content="![i](https://other.example/x.png)" baseUrl={README_URL} />), /src="https:\/\/other\.example\/x\.png"/);
	assert.match(renderToStaticMarkup(<MarkdownRenderer content="[s](#section)" baseUrl={README_URL} />), />s</);
});

test('a scheme-relative source keeps its host under either base shape', () => {
	// A path-only base cannot know the scheme: the result stays scheme-relative, never cut down to a path.
	assert.match(renderToStaticMarkup(<MarkdownRenderer content="![i](//cdn.example/shot.png)" baseUrl={README_URL} />), /src="\/\/cdn\.example\/shot\.png"/);
	// An absolute base lends its scheme.
	assert.match(renderToStaticMarkup(<MarkdownRenderer content="![i](//cdn.example/shot.png)" baseUrl="https://rr.example/apps/a/v1/README.md" />), /src="https:\/\/cdn\.example\/shot\.png"/);
});

test('a scheme-relative link stays clickable under a path-only base', () => {
	// No page scheme here (no window): https is the scheme a network-path
	// reference gets, under either base shape and with none
	for (const baseUrl of [undefined, README_URL, 'https://rr.example/apps/a/v1/README.md']) {
		assert.match(renderToStaticMarkup(<MarkdownRenderer content="[Guide](//docs.example/guide)" baseUrl={baseUrl} />), /href="https:\/\/docs\.example\/guide"/);
	}
});

test('a foreign origin never qualifies as an artifact path, artifact-shaped or not', () => {
	// The anchor renderer follows it because it is https (today's rule), not
	// because of the artifact rule: a path that only LOOKS like an artifact on
	// another origin gets no special admission.
	const markup = renderToStaticMarkup(<MarkdownRenderer content="[x](https://evil.example/pipelines/x/v1/a.png)" />);
	assert.match(markup, /href="https:\/\/evil\.example\/pipelines\/x\/v1\/a\.png"/);
	assert.match(markup, /rel="noopener noreferrer"/);
});
