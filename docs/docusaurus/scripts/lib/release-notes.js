/**
 * docs:release-notes — generate /support/release-notes from GitHub releases.
 *
 * Runs after docs:gather (which stages a placeholder for the slot) and before
 * docs:index (so llms-full.txt inlines the generated page). Fetches the repo's
 * releases from the public GitHub API, keeps stable releases only, and writes
 * one reverse-chronological page. On any fetch failure the gather placeholder
 * stays in place, so offline and unauthenticated builds never break.
 */

const path = require('path');
const { exists, readFile, writeFileEnsure } = require('../../../../scripts/lib');

const REPO = 'rocketride-org/rocketride-server';
const DOC_ID = 'support/release-notes';

// Release tags are `<component>-v<semver>`; map each component prefix to the
// label used on the page. An unknown prefix falls back to the prefix itself so
// a new component shows up rather than being dropped.
const COMPONENT_LABELS = {
	server: 'Server',
	'client-typescript': 'TypeScript SDK',
	'client-python': 'Python SDK',
	'client-mcp': 'MCP Client',
	vscode: 'VS Code Extension',
	'n8n-nodes': 'n8n Nodes',
};

/** Split a `<component>-v<semver>` tag into its component prefix and version. */
function parseTag(tag) {
	const m = /^(.*)-(v\d.*)$/.exec(tag || '');
	if (!m) return { component: tag || '', version: '' };
	return { component: m[1], version: m[2] };
}

/**
 * Demote body headings so they nest under the per-release `## <name>` heading:
 * `#` and `##` lines become `###`; deeper headings are left alone. Fenced code
 * blocks are skipped so a commented `# shell` line is not rewritten.
 * @param {string} body - raw release body markdown.
 * @return {string}
 */
function demoteHeadings(body) {
	let inFence = false;
	return body
		.split('\n')
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
			if (inFence) return line;
			return line.replace(/^(#{1,2})(?=\s)/, '###');
		})
		.join('\n');
}

/** Strip HTML comments (release templates leave them behind). */
function stripComments(body) {
	return body.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Fetch the repo's releases from the GitHub REST API.
 * @param {object} [args]
 * @param {string} [args.repo] - `owner/name`, defaults to this repo.
 * @param {Function} [args.fetchImpl] - injectable fetch for tests.
 * @return {Promise<Array<object>|null>} release objects, or null on any failure.
 */
async function fetchReleases({ repo = REPO, fetchImpl = fetch } = {}) {
	const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'rocketride-docs-build' };
	// The repo is public so no token is required; honouring one when present
	// avoids the unauthenticated rate limit in CI.
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;
	try {
		const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
		if (!res.ok) return null;
		const releases = await res.json();
		return Array.isArray(releases) ? releases : null;
	} catch {
		return null;
	}
}

/**
 * Render the release-notes page: stable releases, newest first, each with a
 * component/version/date byline and its (demoted) release body.
 *
 * Front matter pins `format: md` so bodies render as CommonMark — release
 * notes are authored on GitHub and are not MDX-safe (raw HTML, braces).
 * @param {Array<object>} releases - GitHub release objects.
 * @return {string} the full Markdown document.
 */
function releaseNotesMarkdown(releases) {
	const lines = ['---', 'title: Release Notes', 'description: What shipped in each RocketRide release, generated from GitHub releases.', 'format: md', '---', '', '# Release Notes', '', `Stable releases of every RocketRide component, generated from [GitHub releases](https://github.com/${REPO}/releases)`, 'at build time — newest first. Components version independently, so entries interleave.', ''];
	const stable = (releases || []).filter((r) => r && !r.draft && !r.prerelease).sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
	for (const r of stable) {
		const { component, version } = parseTag(r.tag_name);
		const label = COMPONENT_LABELS[component] || component;
		const date = new Date(r.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
		lines.push(`## ${r.name || r.tag_name}`, '');
		lines.push(`**${label}** · ${version || r.tag_name} · ${date} · [View on GitHub](${r.html_url})`, '');
		const body = demoteHeadings(stripComments(r.body || '')).trim();
		if (body) lines.push(body, '');
		lines.push('---', '');
	}
	// Drop the trailing rule so the page does not end on a divider.
	if (lines[lines.length - 2] === '---') lines.splice(lines.length - 2, 1);
	return lines.join('\n');
}

/**
 * Generate the page into the assembled content tree, overwriting the gather
 * placeholder, and update the persisted manifest entry to match. Leaves the
 * placeholder untouched when the API is unreachable.
 * @param {object} args
 * @param {string} args.contentDir - assembled content directory.
 * @param {string} args.staticDir - directory for raw `.md` siblings.
 * @param {object} [args.task] - builder task for progress output.
 * @param {Function} [args.fetchImpl] - injectable fetch for tests.
 */
async function buildReleaseNotes({ contentDir, staticDir, task, fetchImpl }) {
	const releases = await fetchReleases({ fetchImpl });
	if (!releases) {
		if (task) task.output = 'GitHub releases unreachable — /support/release-notes ships as the placeholder';
		return;
	}
	const page = releaseNotesMarkdown(releases);
	await writeFileEnsure(path.join(contentDir, `${DOC_ID}.md`), page);
	await writeFileEnsure(path.join(staticDir, `${DOC_ID}.md`), page);

	const manifestPath = path.join(contentDir, '.manifest.json');
	if (await exists(manifestPath)) {
		const manifest = JSON.parse(await readFile(manifestPath));
		for (const entry of manifest) {
			if (entry.id !== DOC_ID) continue;
			delete entry.placeholder;
			entry.title = 'Release Notes';
			entry.description = 'What shipped in each RocketRide release, generated from GitHub releases.';
		}
		await writeFileEnsure(manifestPath, JSON.stringify(manifest));
	}

	const count = releases.filter((r) => r && !r.draft && !r.prerelease).length;
	if (task) task.output = `Generated /support/release-notes from ${count} stable releases`;
}

module.exports = { buildReleaseNotes, fetchReleases, releaseNotesMarkdown, demoteHeadings, parseTag };
