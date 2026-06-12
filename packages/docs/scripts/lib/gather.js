/**
 * docs:gather — discover co-located documentation, validate it against the
 * spine, and assemble the Docusaurus content tree.
 *
 * Sources:
 *   - nodes/src/nodes/<name>/doc.md          -> /nodes/<name>   (built-in contributor)
 *   - <pkg>/<source>/**\/*.{md,mdx}          -> /<mount>/...    (declared per package)
 *
 * A package declares its mounts on its module export in scripts/tasks.js:
 *   module.exports = { name, description, docs: [{ source: 'docs', mount: 'develop/typescript' }], actions: [...] }
 *
 * For every staged page a raw pre-MDX `.md` sibling is emitted under static/ so
 * the LLM surface (Phase 3) and copy-as-markdown control can fetch it.
 */

const path = require('path');
const { glob } = require('glob');
const { exists, mkdir, rm, copyFile, copyFileEnsure, writeFileEnsure, readFile, readDir, symlink } = require('../../../../scripts/lib');
const { allDocIds, docTitles, isValidMount, mountSlots, NODES_DIR } = require('./spine');

const NODES_GLOB = 'nodes/src/nodes/*/doc.md';
const DOCS_GLOB = '{nodes,packages,apps}/**/docs/**/*.{md,mdx}';
const IGNORE = ['**/node_modules/**', '**/build/**', '**/dist/**', 'packages/docs/**'];

const PLACEHOLDER_NOTE = '> **Placeholder.** Generated stub for the documentation spine. Real content lands in a later phase.';

function toPosix(p) {
	return p.split(path.sep).join('/');
}

/** Extract a `title:` from a leading YAML front-matter block, if present. */
function frontMatterTitle(content) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!m) return null;
	const t = /(^|\n)title:\s*(.+?)\s*(\n|$)/.exec(m[1]);
	return t ? t[2].replace(/^['"]|['"]$/g, '') : null;
}

/** First markdown heading, as a title fallback. */
function headingTitle(content) {
	const m = /^#\s+(.+?)\s*$/m.exec(content);
	return m ? m[1] : null;
}

/**
 * Compute the Docusaurus doc id (== route minus leading slash) for a file at
 * `rel` under `mount`. `index` files collapse to their directory.
 */
function docIdFor(mount, rel) {
	let relNoExt = rel.replace(/\.(md|mdx)$/i, '');
	const base = path.posix.basename(relNoExt);
	if (base === 'index') {
		const dir = path.posix.dirname(relNoExt);
		relNoExt = dir === '.' ? '' : dir;
	}
	return relNoExt ? `${mount}/${relNoExt}` : mount;
}

/** Discover contributing packages from the registry's declared `docs` mounts. */
function discoverContributors() {
	const registry = require('../../../../scripts/lib/registry');
	const contributors = [];
	for (const name of registry.names()) {
		const mod = registry.get(name);
		if (!mod || !Array.isArray(mod.docs)) continue;
		// mod._path is <pkg>/scripts. pnpm may have registered the module via a
		// symlinked copy under node_modules, so resolve to the real location.
		let scriptsDir = mod._path;
		try {
			scriptsDir = require('fs').realpathSync(mod._path);
		} catch {
			/* keep mod._path */
		}
		const pkgRoot = path.dirname(scriptsDir);
		for (const entry of mod.docs) {
			if (!entry || !entry.mount) continue;
			const mount = String(entry.mount).replace(/^\/+|\/+$/g, '');
			if (!isValidMount(mount)) {
				throw new Error(`docs:gather: module "${name}" declares mount "${entry.mount}" which does not resolve to a spine slot.\n  Valid slots: ${mountSlots().join(', ')}`);
			}
			contributors.push({ module: name, mount, sourceDir: path.join(pkgRoot, entry.source || 'docs') });
		}
	}
	return contributors;
}

/** Remove generated artifacts from static/ (keep .gitkeep and img/). */
async function clearGeneratedStatic(staticDir) {
	if (!(await exists(staticDir))) return;
	for (const name of await readDir(staticDir)) {
		if (name === '.gitkeep' || name === 'img') continue;
		await rm(path.join(staticDir, name));
	}
}

async function stageFile({ srcAbs, destAbs, siblingAbs, content, mode }) {
	await mkdir(path.dirname(destAbs));
	if (mode === 'symlink') {
		await rm(destAbs);
		try {
			await symlink(srcAbs, destAbs, 'file');
		} catch {
			await copyFile(srcAbs, destAbs); // Windows symlink may need privilege
		}
	} else {
		await copyFile(srcAbs, destAbs);
	}
	// Raw pre-MDX sibling for the LLM surface.
	await writeFileEnsure(siblingAbs, content);
}

/**
 * @param {object} args
 * @param {string} args.projectRoot
 * @param {string} args.contentStaticDir  shell-authored spine pages
 * @param {string} args.contentDir        assembled output Docusaurus reads
 * @param {string} args.staticDir         where raw .md siblings are written
 * @param {'copy'|'symlink'} [args.mode]
 * @param {object} [args.task]
 * @returns {Promise<Array>} manifest entries
 */
async function gather({ projectRoot, contentStaticDir, contentDir, staticDir, mode = 'copy', task }) {
	await rm(contentDir);
	await mkdir(contentDir);
	await clearGeneratedStatic(staticDir);

	const routes = new Map(); // docId -> source (collision guard)
	const manifest = [];

	function claim(docId, source) {
		if (routes.has(docId)) {
			throw new Error(`docs:gather: route collision at "/${docId}"\n  between ${routes.get(docId)}\n  and     ${source}`);
		}
		routes.set(docId, source);
	}

	// 1. Shell-authored static pages (copied first; they own the spine).
	if (await exists(contentStaticDir)) {
		const staticFiles = await glob('**/*.{md,mdx}', { cwd: contentStaticDir, nodir: true });
		for (const rel of staticFiles) {
			const srcAbs = path.join(contentStaticDir, rel);
			const content = await readFile(srcAbs);
			const docId = docIdFor('', toPosix(rel)).replace(/^\//, '');
			claim(docId, srcAbs);
			const ext = path.extname(rel) || '.md';
			const destAbs = path.join(contentDir, `${docId || 'index'}${ext}`);
			const siblingAbs = path.join(staticDir, `${docId || 'index'}.md`);
			await stageFile({ srcAbs, destAbs, siblingAbs, content, mode });
			manifest.push({ id: docId || 'index', route: docId ? `/${docId}` : '/', title: frontMatterTitle(content) || headingTitle(content) || docId || 'Home', mdSibling: `/${docId || 'index'}.md`, source: srcAbs });
		}
	}

	// 2. Built-in nodes contributor.
	const nodeDocs = await glob(NODES_GLOB, { cwd: projectRoot, nodir: true });
	for (const rel of nodeDocs) {
		const name = toPosix(rel).split('/').slice(-2)[0]; // nodes/src/nodes/<name>/doc.md
		const srcAbs = path.join(projectRoot, rel);
		const content = await readFile(srcAbs);
		const docId = `${NODES_DIR}/${name}`;
		claim(docId, srcAbs);
		const ext = path.extname(rel) || '.md';
		const destAbs = path.join(contentDir, `${docId}${ext}`);
		const siblingAbs = path.join(staticDir, `${docId}.md`);
		await stageFile({ srcAbs, destAbs, siblingAbs, content, mode });
		manifest.push({ id: docId, route: `/${docId}`, title: frontMatterTitle(content) || headingTitle(content) || name, mdSibling: `/${docId}.md`, source: srcAbs, node: name });
	}

	// 3. Declared per-package mounts.
	const contributors = discoverContributors();
	const allDocsFiles = await glob(DOCS_GLOB, { cwd: projectRoot, nodir: true, ignore: IGNORE });
	for (const rel of allDocsFiles) {
		const abs = path.join(projectRoot, rel);
		const owner = contributors.find((c) => `${abs}${path.sep}`.startsWith(`${c.sourceDir}${path.sep}`));
		if (!owner) {
			throw new Error(`docs:gather: ${rel} lives under a docs/ tree but no package declares a mount covering it. Add a docs mount in the owning package's scripts/tasks.js.`);
		}
		const relUnder = toPosix(path.relative(owner.sourceDir, abs));
		const content = await readFile(abs);
		const docId = docIdFor(owner.mount, relUnder);
		claim(docId, abs);
		const ext = path.extname(relUnder) || '.md';
		const destAbs = path.join(contentDir, `${docId}${ext}`);
		const siblingAbs = path.join(staticDir, `${docId}.md`);
		await stageFile({ srcAbs: abs, destAbs, siblingAbs, content, mode });
		manifest.push({ id: docId, route: `/${docId}`, title: frontMatterTitle(content) || headingTitle(content) || docId, mdSibling: `/${docId}.md`, source: abs, module: owner.module });
	}

	// 4. Placeholders for spine slots still lacking content (keeps the build green).
	await ensurePlaceholders({ contentDir, staticDir, routes, manifest });

	// 5. Persist the manifest for docs:index (Phase 3).
	await writeFileEnsure(path.join(contentDir, '.manifest.json'), JSON.stringify(manifest, null, 2));

	if (task) task.output = `Staged ${manifest.length} pages, ${nodeDocs.length} nodes, ${contributors.length} mounts`;
	return manifest;
}

async function docExists(contentDir, id) {
	return (await exists(path.join(contentDir, `${id}.md`))) || (await exists(path.join(contentDir, `${id}.mdx`))) || (await exists(path.join(contentDir, id, 'index.md'))) || (await exists(path.join(contentDir, id, 'index.mdx')));
}

async function ensurePlaceholders({ contentDir, staticDir, routes, manifest }) {
	const titles = docTitles();
	for (const id of allDocIds()) {
		if (id === 'index') continue;
		if (routes.has(id) || (await docExists(contentDir, id))) continue;
		const title = titles[id] || id;
		const content = `---\ntitle: ${title}\n---\n\n# ${title}\n\n${PLACEHOLDER_NOTE}\n`;
		const contentFile = path.join(contentDir, `${id}.md`);
		await writeFileEnsure(contentFile, content);
		await writeFileEnsure(path.join(staticDir, `${id}.md`), content);
		routes.set(id, contentFile);
		manifest.push({ id, route: `/${id}`, title, mdSibling: `/${id}.md`, source: contentFile, placeholder: true });
	}

	// Nodes catalog: ensure a landing page (docs:index overwrites it); a
	// placeholder entry only if no real node pages exist.
	const nodesDir = path.join(contentDir, NODES_DIR);
	if (!(await exists(path.join(nodesDir, 'index.md')))) {
		await writeFileEnsure(path.join(nodesDir, 'index.md'), `---\ntitle: Nodes & Connectors\nslug: /${NODES_DIR}\nsidebar_position: 0\n---\n\n# Nodes & Connectors\n\n${PLACEHOLDER_NOTE}\n`);
	}
	const hasNodePages = (await glob('*.md', { cwd: nodesDir, nodir: true })).some((f) => f !== 'index.md');
	if (!hasNodePages) {
		const content = `---\ntitle: Example node\nsidebar_position: 1\n---\n\n# Example node\n\n${PLACEHOLDER_NOTE}\n`;
		const contentFile = path.join(nodesDir, 'example.md');
		await writeFileEnsure(contentFile, content);
		await writeFileEnsure(path.join(staticDir, `${NODES_DIR}/example.md`), content);
		manifest.push({ id: `${NODES_DIR}/example`, route: `/${NODES_DIR}/example`, title: 'Example node', mdSibling: `/${NODES_DIR}/example.md`, source: contentFile, node: 'example', placeholder: true });
	}
}

module.exports = { gather, docIdFor };
