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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import releaseNotes from '../../scripts/lib/release-notes.js';

const { releaseNotesMarkdown, demoteHeadings, parseTag, buildReleaseNotes } = releaseNotes;

function release(overrides = {}) {
	return {
		tag_name: 'server-v3.3.1',
		name: 'RocketRide Server v3.3.1',
		published_at: '2026-07-07T05:20:54Z',
		html_url: 'https://github.com/rocketride-org/rocketride-server/releases/tag/server-v3.3.1',
		body: 'Fixes.',
		draft: false,
		prerelease: false,
		...overrides,
	};
}

describe('parseTag', () => {
	it('splits component-prefixed tags', () => {
		assert.deepEqual(parseTag('client-typescript-v1.3.0'), { component: 'client-typescript', version: 'v1.3.0' });
		assert.deepEqual(parseTag('server-v3.3.1'), { component: 'server', version: 'v3.3.1' });
	});

	it('degrades gracefully on an unprefixed tag', () => {
		assert.deepEqual(parseTag('oddball'), { component: 'oddball', version: '' });
	});
});

describe('demoteHeadings', () => {
	it('pushes h1/h2 to h3 and leaves deeper headings alone', () => {
		assert.equal(demoteHeadings('# Top\n## Second\n### Third'), '### Top\n### Second\n### Third');
	});

	it('does not rewrite comment lines inside code fences', () => {
		const body = '```sh\n# a shell comment\n```\n## Real heading';
		assert.equal(demoteHeadings(body), '```sh\n# a shell comment\n```\n### Real heading');
	});
});

describe('releaseNotesMarkdown', () => {
	it('renders stable releases newest-first with component bylines', () => {
		const page = releaseNotesMarkdown([release(), release({ tag_name: 'vscode-v1.3.0', name: 'RocketRide VS Code Extension v1.3.0', published_at: '2026-07-07T03:22:33Z' })]);
		assert.match(page, /format: md/);
		assert.match(page, /## RocketRide Server v3\.3\.1/);
		assert.match(page, /\*\*Server\*\* · v3\.3\.1 · July 7, 2026 · \[View on GitHub\]/);
		assert.match(page, /\*\*VS Code Extension\*\* · v1\.3\.0/);
		// Newer server release sorts before the older vscode one.
		assert.ok(page.indexOf('Server v3.3.1') < page.indexOf('VS Code Extension v1.3.0'));
	});

	it('drops drafts and prereleases', () => {
		const page = releaseNotesMarkdown([release({ prerelease: true, name: 'Prerelease' }), release({ draft: true, name: 'Draft' })]);
		assert.doesNotMatch(page, /Prerelease|Draft/);
	});
});

describe('buildReleaseNotes', () => {
	async function tmpTree() {
		const root = await mkdtemp(path.join(os.tmpdir(), 'rr-relnotes-'));
		const contentDir = path.join(root, 'content');
		const staticDir = path.join(root, 'static');
		await mkdir(path.join(contentDir, 'support'), { recursive: true });
		await mkdir(staticDir, { recursive: true });
		const placeholder = '---\ntitle: Release Notes\n---\n\nComing soon.\n';
		await writeFile(path.join(contentDir, 'support', 'release-notes.md'), placeholder);
		await writeFile(path.join(contentDir, '.manifest.json'), JSON.stringify([{ id: 'support/release-notes', route: '/support/release-notes', title: 'Release Notes', mdSibling: '/support/release-notes.md', placeholder: true }]));
		return { root, contentDir, staticDir };
	}

	it('overwrites the placeholder and clears its manifest flag on success', async () => {
		const { root, contentDir, staticDir } = await tmpTree();
		try {
			const fetchImpl = async () => ({ ok: true, json: async () => [release()] });
			const task = {};
			await buildReleaseNotes({ contentDir, staticDir, task, fetchImpl });
			const page = await readFile(path.join(contentDir, 'support', 'release-notes.md'), 'utf8');
			assert.match(page, /RocketRide Server v3\.3\.1/);
			const sibling = await readFile(path.join(staticDir, 'support', 'release-notes.md'), 'utf8');
			assert.equal(sibling, page);
			const manifest = JSON.parse(await readFile(path.join(contentDir, '.manifest.json'), 'utf8'));
			assert.equal(manifest[0].placeholder, undefined);
			assert.match(task.output, /1 stable release/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('leaves the placeholder untouched when the API is unreachable', async () => {
		const { root, contentDir, staticDir } = await tmpTree();
		try {
			const fetchImpl = async () => {
				throw new Error('offline');
			};
			const task = {};
			await buildReleaseNotes({ contentDir, staticDir, task, fetchImpl });
			const page = await readFile(path.join(contentDir, 'support', 'release-notes.md'), 'utf8');
			assert.match(page, /Coming soon\./);
			const manifest = JSON.parse(await readFile(path.join(contentDir, '.manifest.json'), 'utf8'));
			assert.equal(manifest[0].placeholder, true);
			assert.match(task.output, /unreachable/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
