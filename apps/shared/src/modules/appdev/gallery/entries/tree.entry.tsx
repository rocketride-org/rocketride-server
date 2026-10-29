// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Tree. */

import React, { useState } from 'react';
import { Tree } from 'shell';
import type { ITreeNode } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** The demo's nodes: pipeline components by lane. */
const NODES: ITreeNode[] = [
	{
		id: 'sources',
		label: 'Sources',
		meta: '3',
		children: [
			{ id: 's3', label: 'Amazon S3' },
			{
				id: 'gdrive',
				label: 'Google Drive',
				children: [
					{ id: 'gdocs', label: 'Docs' },
					{ id: 'gsheets', label: 'Sheets' },
				],
			},
			{ id: 'web', label: 'Web crawler', disabled: true },
		],
	},
	{
		id: 'transforms',
		label: 'Transforms',
		children: [
			{ id: 'chunk', label: 'Chunker' },
			{ id: 'embed', label: 'Embeddings' },
		],
	},
	{
		id: 'llms',
		label: 'LLMs',
		children: [
			{ id: 'claude', label: 'Claude' },
			{ id: 'gpt', label: 'GPT' },
		],
	},
	{ id: 'output', label: 'Output' },
];

/** Live demo: a selectable component tree. */
const TreeDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [selectedId, setSelectedId] = useState<string | null>('chunk');
	return (
		<div style={{ maxWidth: 280 }}>
			<Tree ariaLabel="Pipeline components" nodes={NODES} defaultExpanded={['sources', 'transforms']} selectedId={selectedId} onSelect={setSelectedId} dense={Boolean(knobs.dense)} />
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	let denseAttr = '';
	if (knobs.dense) denseAttr = ' dense';
	return `import { Tree } from 'shell';

<Tree
	ariaLabel="Pipeline components"
	nodes={[{ id: 'sources', label: 'Sources', children: [{ id: 's3', label: 'Amazon S3' }] }]}
	selectedId={selected}
	onSelect={setSelected}${denseAttr}
/>`;
}

/** The Tree gallery entry. */
export const treeEntry: IGalleryEntry = {
	id: 'tree',
	name: 'Tree',
	group: 'content',
	blurb: 'Generic expandable outline with the full WAI-ARIA tree keyboard. Explorer and DocExplorer stay the file trees; Tree is for any other hierarchy.',
	doc: 'One Tab stop. Up/Down move, Right expands or enters, Left collapses or goes to the parent, Home/End jump, Enter/Space select, * expands siblings, typing jumps. Clicking a parent selects and toggles it. Rows render flat with aria-level / setsize / posinset.',
	knobs: [{ id: 'dense', label: 'Dense', kind: 'boolean', defaultValue: false }],
	demo: TreeDemo,
	code: buildCode,
	props: [
		{ name: 'nodes', type: 'ITreeNode[]', dir: 'in', required: true, note: '{ id, label, icon?, meta?, children?, disabled? } - children present = expandable.' },
		{ name: 'ariaLabel', type: 'string', dir: 'in', required: true, note: 'A tree must be named.' },
		{ name: 'expanded / defaultExpanded', type: 'string[]', dir: 'in', note: 'Open ids, controlled / uncontrolled.' },
		{ name: 'selectedId', type: 'string | null', dir: 'in', note: 'Selected node.' },
		{ name: 'dense', type: 'boolean', dir: 'in', note: 'Tighter rows.' },
		{ name: 'onSelect', type: '(id: string) => void', dir: 'out', note: 'Fired with the chosen node.' },
		{ name: 'onExpandedChange', type: '(expanded: string[]) => void', dir: 'out', note: 'Fired with the new open ids.' },
	],
};
