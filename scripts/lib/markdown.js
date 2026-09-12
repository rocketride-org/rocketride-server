// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

const RAW_BASE = 'https://raw.githubusercontent.com';

/** True for links that must be left alone: absolute URLs, protocol-relative, root-absolute, data URIs, anchors. */
function isExternal(target) {
	return /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(target);
}

/**
 * Rewrite every relative image reference in a markdown document to the
 * absolute raw-GitHub URL of the same file on `ref`, so the document renders
 * identically after it is copied out of the repo (npm, PyPI, the VS Code
 * marketplace). Handles the markdown form `![alt](path)` and the HTML form
 * `<img src="path">`. Non-image links are untouched.
 * Handles `./x` and `x` relative targets; `../x` is left in the joined
 * string as-is and relies on client-side URL normalization to resolve
 * correctly. Not rewritten: reference-style images (`![a][ref]`), titled
 * markdown images (`![alt](path "title")`), and single-quoted
 * `<img src='...'>` attributes.
 *
 * @param {string} markdown - The document text.
 * @param {string} sourceDir - Repo-relative directory the document lives in (posix, no trailing slash), e.g. `docs/public/typescript`.
 * @param {{repo?: string, ref?: string}} [options]
 * @returns {string}
 */
function absolutizeImageLinks(markdown, sourceDir, options = {}) {
	const repo = options.repo || 'rocketride-org/rocketride-server';
	const ref = options.ref || 'main';
	const base = `${RAW_BASE}/${repo}/${ref}/${sourceDir.replace(/^\/+|\/+$/g, '')}/`;
	const resolve = (target) => (isExternal(target) ? target : base + target.replace(/^\.\//, ''));
	return markdown
		.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (m, open, target, close) => open + resolve(target) + close)
		.replace(/(<img\b[^>]*(?<![\w-])src=")([^"]+)(")/g, (m, open, target, close) => open + resolve(target) + close);
}

module.exports = { absolutizeImageLinks };
