/**
 * Information-architecture spine (single source of truth).
 *
 * Both `sidebars.ts` (rendered navigation) and `docs:gather` (mount validation +
 * placeholder generation) consume this module, so the sidebar and the set of
 * valid mount slots can never drift apart.
 *
 * Node shapes:
 *   { id, label }                        a single authored doc page (leaf)
 *   { id, label, mount: true }           a leaf that packages may mount into
 *   { id, label, mount: true, nest: true } a mount rendered as a sidebar category
 *                                          listing every page staged under it
 *                                          (ordered by sidebar_position)
 *   { label, items: [...] }              a category of leaves / nested categories
 *   { label, autogen: 'nodes' }          a category whose pages are generated
 *
 * `id` doubles as the Docusaurus doc id and the route (routeBasePath is '/').
 */

const NODES_DIR = 'nodes';

// IA restructure phase 3 (claude/tasks/docs-ia-restructure/plan.md):
// journey-ordered sections whose ids now match their section prefixes — the
// docs/public/product/ folder tree, the doc ids, and the public URLs are one
// namespace again. Old routes 301 via packages/docs/redirects.ts.
const SPINE = [
	{ id: 'index', label: 'Home' },
	{
		// The category itself renders no link (toSidebar emits no `link` for a
		// category), so the overview is a plain leaf whose id is `quickstart` —
		// docIdFor() collapses quickstart/index.mdx to that id, keeping /quickstart.
		label: 'Get Started',
		items: [
			{ id: 'quickstart', label: 'Overview' },
			{ id: 'quickstart/ide-walkthrough', label: 'Build in your IDE' },
			{ id: 'quickstart/sdk-integration', label: 'Integrate with an SDK' },
			{ id: 'quickstart/cli', label: 'Run from the CLI' },
		],
	},
	{
		label: 'Concepts',
		items: [
			{ id: 'concepts', label: 'Understanding RocketRide' },
			{ id: 'concepts/pipelines', label: 'Pipelines' },
			{ id: 'concepts/runtime-engine', label: 'Runtime & Engine' },
			{ id: 'concepts/nodes', label: 'Nodes' },
			{ id: 'concepts/agents-tools-skills', label: 'Agents & Tools' },
			{ id: 'concepts/execution-model', label: 'Execution Model' },
		],
	},
	{
		label: 'Clients',
		items: [
			{ id: 'clients', label: 'Overview' },
			{ id: 'clients/typescript', label: 'TypeScript SDK', mount: true, nest: true },
			{ id: 'clients/python', label: 'Python SDK', mount: true, nest: true },
			{ id: 'clients/vscode', label: 'VS Code Extension', mount: true, nest: true },
		],
	},
	{
		label: 'Guides',
		items: [
			{ id: 'guides/error-handling', label: 'Error Handling' },
			{ id: 'guides/performance', label: 'Performance' },
			{ id: 'guides/advanced-agents', label: 'Advanced Agents' },
			{ id: 'guides/best-practices', label: 'Best Practices' },
			// Placeholder until the content pass (plan phase 2).
			{ id: 'guides/observability', label: 'Observability' },
			{
				label: 'Shell Apps',
				items: [
					{ id: 'guides/apps', label: 'Guide' },
					{ id: 'guides/apps/reference', label: 'Reference' },
				],
			},
		],
	},
	{
		label: 'Examples',
		items: [
			{ id: 'examples/rag-pipeline', label: 'RAG Pipeline' },
			{ id: 'examples/webhook-pipeline', label: 'Webhook Pipeline' },
			{ id: 'examples/document-extraction', label: 'Document Extraction' },
		],
	},
	{ label: 'Nodes', autogen: NODES_DIR },
	{
		label: 'Connect',
		items: [
			{ id: 'connect/mcp', label: 'MCP', mount: true },
			{ id: 'connect/cli', label: 'CLI' },
			{ id: 'connect/websocket', label: 'WebSocket' },
			{ id: 'connect/websocket/observability', label: 'WebSocket Events' },
			{ id: 'connect/n8n', label: 'n8n' },
		],
	},
	{
		label: 'Deploy & Operate',
		items: [
			{ id: 'operate', label: 'Choose How to Run' },
			{ id: 'operate/cloud', label: 'Cloud' },
			{
				label: 'Self-hosting',
				items: [
					{ id: 'operate/self-hosting', label: 'Overview' },
					// Docker/Kubernetes are placeholders until the content pass
					// (plan phase 2); production is seeded from the old
					// performance page's topology section.
					{ id: 'operate/self-hosting/docker', label: 'Docker' },
					{ id: 'operate/self-hosting/kubernetes', label: 'Kubernetes' },
					{ id: 'operate/self-hosting/production', label: 'Production' },
				],
			},
			{ id: 'operate/security', label: 'Security' },
		],
	},
	{
		label: 'Reference',
		items: [
			{ id: 'reference/pipeline-reference', label: 'Pipeline JSON Reference', mount: true },
			{ id: 'reference/glossary', label: 'Glossary' },
		],
	},
	{
		label: 'Support & Community',
		items: [
			{ id: 'support/troubleshooting', label: 'Troubleshooting' },
			// Placeholders until the content pass; release-notes later becomes a
			// generated page (plan phase 4, deferred).
			{ id: 'support/get-help', label: 'FAQ / Get Help' },
			{ id: 'support/contributing', label: 'Contributing' },
			{ id: 'support/security-policy', label: 'Security Policy' },
			{ id: 'support/release-notes', label: 'Release Notes' },
		],
	},
];

/** Walk every leaf node (depth-first), invoking fn(node). */
function walkLeaves(fn, nodes = SPINE) {
	for (const node of nodes) {
		if (node.items) {
			walkLeaves(fn, node.items);
		} else if (node.id) {
			fn(node);
		}
	}
}

/** All authored doc ids (excludes the autogenerated nodes catalog). */
function allDocIds() {
	const ids = [];
	walkLeaves((n) => ids.push(n.id));
	return ids;
}

/** Map of doc id -> human label, for placeholder titles. */
function docTitles() {
	const map = {};
	walkLeaves((n) => {
		map[n.id] = n.label;
	});
	return map;
}

/**
 * Slot prefixes that packages may mount into. A declared mount is valid when it
 * equals one of these or is a descendant path (e.g. 'develop/typescript/reference').
 * The autogenerated nodes catalog is always a valid mount root.
 */
function mountSlots() {
	const slots = [NODES_DIR];
	walkLeaves((n) => {
		if (n.mount) slots.push(n.id);
	});
	return slots;
}

/** True if `mount` resolves to a known spine slot (exact or descendant). */
function isValidMount(mount) {
	const clean = String(mount).replace(/^\/+|\/+$/g, '');
	return mountSlots().some((slot) => clean === slot || clean.startsWith(`${slot}/`));
}

/** Top-level sections with the doc-id prefixes they own, in spine order. */
function sections() {
	return SPINE.map((node) => {
		const prefixes = [];
		if (node.autogen) prefixes.push(node.autogen);
		else if (node.id) prefixes.push(node.id);
		else if (node.items) walkLeaves((n) => prefixes.push(n.id), node.items);
		return { label: node.label, prefixes };
	});
}

/** Top-level section label that owns a doc id (or 'Other'). */
function sectionFor(docId) {
	const clean = String(docId).replace(/^\/+/, '');
	for (const { label, prefixes } of sections()) {
		if (prefixes.some((p) => clean === p || clean.startsWith(`${p}/`))) return label;
	}
	return 'Other';
}

/** Build the Docusaurus sidebar config from the spine. */
function toSidebar() {
	function render(node) {
		if (node.autogen) {
			return {
				type: 'category',
				label: node.label,
				items: [{ type: 'autogenerated', dirName: node.autogen }],
			};
		}
		if (node.items) {
			return { type: 'category', label: node.label, items: node.items.map(render) };
		}
		// Multi-page mount: a category over everything staged under the slot, so
		// mounted subpages live in the sidebar tree. The slot's index page is the
		// first item (its own sidebar_position / sidebar_label front matter apply).
		if (node.mount && node.nest) {
			// The category itself links to the slot's index page (the only category
			// with a link on the site — a mount's landing IS its overview), and the
			// autogenerated items list the remaining pages by sidebar_position.
			return { type: 'category', label: node.label, link: { type: 'doc', id: node.id }, items: [{ type: 'autogenerated', dirName: node.id }] };
		}
		// Leaf: honor the spine label so it (not the mounted doc's front matter)
		// drives the sidebar entry — the spine is the single source of truth.
		return node.label ? { type: 'doc', id: node.id, label: node.label } : node.id;
	}
	return { docsSidebar: SPINE.map(render) };
}

module.exports = {
	SPINE,
	NODES_DIR,
	allDocIds,
	docTitles,
	mountSlots,
	isValidMount,
	sections,
	sectionFor,
	toSidebar,
};
