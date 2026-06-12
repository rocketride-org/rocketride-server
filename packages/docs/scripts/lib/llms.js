/**
 * docs:index — generate the node catalog landing page and the LLM surface.
 *
 *   /nodes            generated catalog of every node page
 *   /llms.txt         per-section index with links to each page's .md sibling
 *   /llms-full.txt    full concatenation of every page's raw markdown
 *
 * Consumes the manifest that docs:gather persists at <contentDir>/.manifest.json.
 */

const path = require('path');
const { exists, readFile, writeFileEnsure } = require('../../../../scripts/lib');
const { sections, sectionFor } = require('./spine');

const SITE_TITLE = 'RocketRide Documentation';
const SITE_DESC = 'Build, run, and ship data + AI pipelines with the RocketRide toolchain.';

function nodeCatalogMarkdown(nodes) {
	// Title comes from front matter (theme renders it); no body H1 to avoid a
	// duplicate heading. The catalog is grouped by category and ordered to match
	// the sidebar dropdown.
	const lines = ['---', 'title: Overview', 'slug: /nodes', 'sidebar_position: 0', '---', ''];
	if (!nodes.length) {
		lines.push('_No node documentation has been migrated yet._', '');
		return lines.join('\n');
	}
	lines.push(`${nodes.length} nodes, grouped by type.`, '');
	const groups = new Map(); // category label -> { order, items }
	for (const n of nodes) {
		const label = n.category || 'Other';
		if (!groups.has(label)) groups.set(label, { order: n.categoryOrder ?? 999, items: [] });
		groups.get(label).items.push(n);
	}
	const ordered = [...groups.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
	for (const [label, group] of ordered) {
		lines.push(`## ${label}`, '');
		for (const n of group.items.sort((a, b) => a.title.localeCompare(b.title))) {
			lines.push(`- [${n.title}](${n.route})`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

/** Order manifest entries by spine section, then by route. */
function ordered(manifest) {
	const order = sections().map((s) => s.label);
	return [...manifest].sort((a, b) => {
		const sa = order.indexOf(sectionFor(a.id));
		const sb = order.indexOf(sectionFor(b.id));
		if (sa !== sb) return sa - sb;
		return a.route.localeCompare(b.route);
	});
}

function llmsIndex(manifest) {
	const lines = [`# ${SITE_TITLE}`, '', `> ${SITE_DESC}`, ''];
	const order = sections().map((s) => s.label);
	const bySection = new Map();
	for (const e of manifest) {
		const sec = sectionFor(e.id);
		if (!bySection.has(sec)) bySection.set(sec, []);
		bySection.get(sec).push(e);
	}
	for (const label of [...order, 'Other']) {
		const entries = bySection.get(label);
		if (!entries || !entries.length) continue;
		lines.push(`## ${label}`, '');
		for (const e of entries.sort((a, b) => a.route.localeCompare(b.route))) {
			lines.push(`- [${e.title}](${e.mdSibling})`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

async function llmsFull(manifest, generated) {
	const parts = [`# ${SITE_TITLE}`, '', `> ${SITE_DESC}`, ''];
	for (const e of ordered(manifest)) {
		let content = generated.get(e.id);
		if (content == null && e.source && (await exists(e.source))) content = await readFile(e.source);
		if (content == null) continue;
		parts.push('', '---', '', `# ${e.title}`, '', `Route: ${e.route}`, '', String(content).trim(), '');
	}
	return parts.join('\n');
}

/**
 * @param {object} args
 * @param {string} args.contentDir
 * @param {string} args.staticDir
 * @param {object} [args.task]
 */
async function buildIndex({ contentDir, staticDir, task }) {
	const manifestPath = path.join(contentDir, '.manifest.json');
	const manifest = (await exists(manifestPath)) ? JSON.parse(await readFile(manifestPath)) : [];

	// Generated content kept in memory so llms-full can include it.
	const generated = new Map();

	// Node catalog -> overwrite the gather placeholder + add to the manifest.
	const nodes = manifest.filter((e) => e.node);
	const catalog = nodeCatalogMarkdown(nodes);
	await writeFileEnsure(path.join(contentDir, 'nodes', 'index.md'), catalog);
	await writeFileEnsure(path.join(staticDir, 'nodes.md'), catalog);
	const withCatalog = manifest.filter((e) => e.id !== 'nodes');
	withCatalog.push({ id: 'nodes', route: '/nodes', title: 'Overview', mdSibling: '/nodes.md' });
	generated.set('nodes', catalog);

	await writeFileEnsure(path.join(staticDir, 'llms.txt'), llmsIndex(withCatalog));
	await writeFileEnsure(path.join(staticDir, 'llms-full.txt'), await llmsFull(withCatalog, generated));

	if (task) task.output = `Indexed ${withCatalog.length} pages (${nodes.length} nodes)`;
}

module.exports = { buildIndex };
