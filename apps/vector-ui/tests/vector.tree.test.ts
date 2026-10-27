// =============================================================================
// MIT License
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


// =============================================================================
// THE FOLDER TREE: folders from paths, counts, the visible items, the APG keys and the folder view
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IDocumentItem } from '../src/contract/types';
import { TREE_ALL, TREE_TRASH, TREE_UPLOADED, ancestorsOf, buildTree, collapsedAll, fileItemId, flatFolders, folderItemId, folderPrefixes, folderRows, treeItems, treeKey, typeAhead, viewItemId } from '../src/vector/tree';

/** A loaded document at a path. */
function doc(objectId: string, path: string): IDocumentItem {
	return { objectId, path, chunks: 1, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: null, modifyTime: null, ingestedAt: null, pointId: null };
}

const ROWS: IDocumentItem[] = [
	doc('a', 'C:/demo/handbooks/manual.pdf'),
	doc('b', 'C:/demo/handbooks/guide.md'),
	doc('c', 'C:/demo/handbooks/old/v1.md'),
	doc('d', 'C:/demo/greenhouse/orchids.md'),
	doc('e', 'notes.txt'),
	doc('f', '\\\\server\\share\\docs\\x.docx'),
	doc('g', '/home/ann/a.md'),
];

test('a folder prefix per separator; a drive, a share or a POSIX root stays part of its first folder', () => {
	assert.deepEqual(folderPrefixes('C:/demo/handbooks/'), ['C:/', 'C:/demo/', 'C:/demo/handbooks/']);
	assert.deepEqual(folderPrefixes('\\\\server\\share\\docs\\'), ['\\\\server\\', '\\\\server\\share\\', '\\\\server\\share\\docs\\']);
	assert.deepEqual(folderPrefixes('/home/ann/'), ['/home/', '/home/ann/']);
	assert.deepEqual(folderPrefixes('/'), ['/']);
});

test('the tree: a folder holding one folder and nothing else shows as one; counts include every folder below; bare names go to Uploaded', () => {
	const tree = buildTree(ROWS);
	assert.equal(tree.total, 7);
	assert.deepEqual(
		tree.folders.map((f) => [f.label, f.documents]),
		[
			['/home/ann/', 1],
			['\\\\server\\share\\docs\\', 1],
			['C:/demo/', 4],
		]
	);
	const demo = tree.folders[2]!;
	assert.deepEqual(
		demo.children.map((f) => [f.label, f.prefix, f.documents]),
		[
			['greenhouse/', 'C:/demo/greenhouse/', 1],
			['handbooks/', 'C:/demo/handbooks/', 3],
		]
	);
	const handbooks = demo.children[1]!;
	assert.deepEqual(handbooks.files.map((f) => f.objectId), ['b', 'a'], 'documents by name');
	assert.deepEqual(handbooks.children.map((f) => f.label), ['old/']);
	assert.deepEqual(tree.uploaded.map((f) => f.objectId), ['e']);
	const sum = (folders: typeof tree.folders): number => folders.reduce((n, f) => n + f.documents, 0);
	assert.equal(sum(tree.folders) + tree.uploaded.length, tree.total, 'every loaded document is counted once');
});

test('the flat view lists every folder that holds documents by its whole path', () => {
	assert.deepEqual(
		flatFolders(buildTree(ROWS)).map((f) => [f.label, f.documents]),
		[
			['/home/ann/', 1],
			['\\\\server\\share\\docs\\', 1],
			['C:/demo/greenhouse/', 1],
			['C:/demo/handbooks/', 2],
			['C:/demo/handbooks/old/', 1],
		]
	);
});

test('the visible items: All documents and Trash at level 1, what is open shows its children, with level, set size and position', () => {
	const tree = buildTree(ROWS);
	const closed = treeItems(tree, collapsedAll(), { flat: false, trash: 3 });
	assert.deepEqual(
		closed.map((i) => `${i.label}|${i.level}|${i.posinset}/${i.setsize}`),
		['All documents|1|1/2', '/home/ann/|2|1/4', '\\\\server\\share\\docs\\|2|2/4', 'C:/demo/|2|3/4', 'Uploaded|2|4/4', 'Trash|1|2/2']
	);
	const open = treeItems(tree, new Set([TREE_ALL, folderItemId('C:/demo/'), folderItemId('C:/demo/handbooks/'), TREE_UPLOADED]), { flat: false, trash: null });
	const at = (id: string): (typeof open)[number] => open.find((i) => i.id === id)!;
	assert.deepEqual([at(folderItemId('C:/demo/handbooks/')).level, at(folderItemId('C:/demo/handbooks/old/')).level, at(fileItemId('a')).level], [3, 4, 4]);
	assert.deepEqual([at(folderItemId('C:/demo/handbooks/old/')).posinset, at(fileItemId('b')).posinset, at(fileItemId('a')).posinset, at(fileItemId('a')).setsize], [1, 2, 3, 3], 'subfolders first, then documents');
	assert.equal(at(fileItemId('e')).level, 3, 'an uploaded document under Uploaded');
	const trash = at(TREE_TRASH);
	assert.ok(trash.kind === 'trash' && trash.count === null, 'no count where the store cannot count');
	assert.deepEqual(treeItems(tree, new Set(), { flat: false, trash: 0 }).map((i) => i.id), [TREE_ALL, TREE_TRASH], 'All closed');
});

test('the APG keys: Down and Up move, Right opens then enters, Left closes then goes to the parent, Home and End, Enter acts', () => {
	const tree = buildTree(ROWS);
	const items = treeItems(tree, new Set([TREE_ALL, folderItemId('C:/demo/')]), { flat: false, trash: 0 });
	const index = (id: string): number => items.findIndex((i) => i.id === id);
	const demo = index(folderItemId('C:/demo/'));
	const handbooks = index(folderItemId('C:/demo/handbooks/'));
	assert.deepEqual(treeKey(items, demo, 'ArrowDown'), { kind: 'move', index: demo + 1 });
	assert.deepEqual(treeKey(items, 0, 'ArrowUp'), { kind: 'move', index: 0 });
	assert.deepEqual(treeKey(items, demo, 'ArrowRight'), { kind: 'move', index: demo + 1 }, 'open: into its first child');
	assert.deepEqual(treeKey(items, handbooks, 'ArrowRight'), { kind: 'expand', id: folderItemId('C:/demo/handbooks/') }, 'closed: opens');
	assert.deepEqual(treeKey(items, handbooks, 'ArrowLeft'), { kind: 'move', index: demo }, 'closed: to its parent');
	assert.deepEqual(treeKey(items, demo, 'ArrowLeft'), { kind: 'collapse', id: folderItemId('C:/demo/') }, 'open: closes');
	assert.deepEqual(treeKey(items, 0, 'ArrowLeft'), { kind: 'collapse', id: TREE_ALL });
	assert.equal(treeKey(items, index(TREE_TRASH), 'ArrowRight'), null, 'a leaf does not open');
	assert.deepEqual(treeKey(items, 3, 'Home'), { kind: 'move', index: 0 });
	assert.deepEqual(treeKey(items, 3, 'End'), { kind: 'move', index: items.length - 1 });
	assert.deepEqual(treeKey(items, 3, 'Enter'), { kind: 'activate' });
	assert.equal(treeKey(items, 3, 'x'), null);
});

test('type-ahead: the next item starting with the letters, wrapping; the same letter again cycles', () => {
	const items = treeItems(buildTree(ROWS), new Set([TREE_ALL, folderItemId('C:/demo/')]), { flat: false, trash: 0 });
	const labels = items.map((i) => i.label);
	assert.equal(labels[typeAhead(items, 0, 'g')], 'greenhouse/');
	assert.equal(labels[typeAhead(items, typeAhead(items, 0, 'g'), 'gg')], 'greenhouse/', 'only one item starts with g: it stays');
	assert.equal(labels[typeAhead(items, 0, 'ha')], 'handbooks/');
	assert.equal(labels[typeAhead(items, items.length - 1, 'a')], 'All documents', 'wraps');
	assert.equal(typeAhead(items, 0, 'zz'), -1);
});

test('a folder view narrows what is loaded and asks the store for nothing; Uploaded keeps the bare names', () => {
	assert.equal(folderRows(ROWS, null), ROWS, 'no view: the rows themselves');
	assert.deepEqual(folderRows(ROWS, { kind: 'folder', prefix: 'C:/demo/handbooks/' }).map((r) => r.objectId), ['a', 'b', 'c'], 'its subfolders included');
	assert.deepEqual(folderRows(ROWS, { kind: 'uploaded' }).map((r) => r.objectId), ['e']);
	assert.equal(viewItemId(null), TREE_ALL);
	assert.equal(viewItemId({ kind: 'uploaded' }), TREE_UPLOADED);
	assert.equal(viewItemId({ kind: 'folder', prefix: 'C:/demo/' }), folderItemId('C:/demo/'));
	assert.deepEqual(ancestorsOf(buildTree(ROWS), 'C:/demo/handbooks/old/'), [TREE_ALL, folderItemId('C:/demo/'), folderItemId('C:/demo/handbooks/')]);
});
