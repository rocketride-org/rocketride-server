import { createRequire } from 'node:module';

// @docusaurus/utils is not a direct dependency, so resolve it through @docusaurus/core.
const require = createRequire(import.meta.url);
const { parseMarkdownContentTitle } = createRequire(require.resolve('@docusaurus/core/package.json'))('@docusaurus/utils');

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
 * `title`, or else from the content title that Docusaurus itself finds
 * (`parseMarkdownContentTitle`: the text, after front matter and imports, must
 * start with an h1). Without a front matter title, the heading is removed only
 * when Docusaurus took it as the title. With a front matter title, the heading is
 * removed only when it is the first content block; otherwise it is a real section
 * heading, so it stays and is demoted to an h2 to keep one <h1> on the page.
 *
 * @return A remark transformer.
 */
export default function remarkStripTitle() {
	return (tree, file) => {
		if (file.data?.frontMatter?.hide_title) return;
		const first = findFirst(tree);
		if (!first || first.node.type !== 'heading' || first.node.depth !== 1) return;
		if (hasTitle(file)) {
			if (isFirstBlock(tree, first)) first.parent.children.splice(first.index, 1);
			else first.node.depth = 2;
		} else if (hasContentTitle(file)) {
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

/** True when Docusaurus finds a content title (a leading h1) in the file text, which is what it uses as the page title. */
function hasContentTitle(file) {
	if (typeof file.value !== 'string') return false;
	const text = file.value.replace(/^---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/, '');
	return Boolean(parseMarkdownContentTitle(text, { removeContentTitle: false }).contentTitle);
}

/** True for nodes that render nothing visible before the title: front matter, imports and exports, expressions, comments. */
function isSilent(node) {
	return node.type === 'yaml' || node.type === 'mdxjsEsm' || node.type === 'mdxFlowExpression' || (node.type === 'html' && /^\s*<!--/.test(node.value));
}

/** True when nothing but silent nodes come before the heading, also inside a wrapper element that holds it. */
function isFirstBlock(tree, { parent, index }) {
	if (!parent.children.slice(0, index).every(isSilent)) return false;
	if (parent === tree) return true;
	const top = tree.children.findIndex((node) => containsNode(node, parent));
	return top >= 0 && tree.children.slice(0, top).every(isSilent);
}

function containsNode(node, target) {
	return node === target || (node.children || []).some((child) => containsNode(child, target));
}
