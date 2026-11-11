/**
 * Remark plugin: drop the page's leading `# Title` so each page has a single
 * <h1> (it must run before Docusaurus wraps the heading in a <header>). The
 * DocItem/Content swizzle renders the page title itself (from `metadata.title`,
 * which Docusaurus derives from the raw markdown before this runs), so the body
 * heading would be a duplicate. Pages that set `hide_title: true` have no custom
 * header and keep their body heading.
 *
 * "Leading" follows the rule Docusaurus uses for its own content title
 * (mdx-loader `remark/contentTitle`): the first heading in the document, and
 * only if it is an h1 that comes before any thematic break. An `# ` heading
 * further down the page, or after a `## ` heading, is never touched.
 *
 * One more guard: the page title shown by the header comes from the front matter
 * `title`, or else from the first `# ` heading. Without a front matter title, the
 * heading is removed only when it is the first content block (after front matter,
 * imports, exports and comments). If text comes first, Docusaurus does not treat the
 * heading as the title, so removing it would lose the page title.
 *
 * @return A remark transformer.
 */
export default function remarkStripTitle() {
	return (tree, file) => {
		if (file.data?.frontMatter?.hide_title) return;
		const first = findFirst(tree);
		if (first && first.node.type === 'heading' && first.node.depth === 1 && (hasTitle(file) || isFirstBlock(tree, first))) {
			first.parent.children.splice(first.index, 1);
		}
	};
}

/** First heading or thematic break in document order, with its parent and index. */
function findFirst(parent) {
	const children = parent.children || [];
	for (let index = 0; index < children.length; index++) {
		const node = children[index];
		if (node.type === 'heading' || node.type === 'thematicBreak') return { node, parent, index };
		const inner = findFirst(node);
		if (inner) return inner;
	}
	return null;
}

function hasTitle(file) {
	return Boolean(file.data?.frontMatter?.title);
}

/** True when the heading sits at the top level and only imports, exports or comments come before it. */
function isFirstBlock(tree, { parent, index }) {
	if (parent !== tree) return false;
	return tree.children.slice(0, index).every((node) => node.type === 'yaml' || node.type === 'mdxjsEsm' || node.type === 'mdxFlowExpression' || (node.type === 'html' && /^\s*<!--/.test(node.value)));
}
