// =============================================================================
// VIEWER REGISTRY — maps file categories to compatible viewer IDs
// =============================================================================

import type { FileCategory } from './mediaTypes';

/**
 * Viewer identifier.  Used as the key in the "Open with..." submenu
 * and stored in the editor's `viewState.viewerId` when the user picks
 * a non-default viewer.
 */
export type ViewerId =
	| 'monaco'
	| 'text'
	| 'json'
	| 'markdown'
	| 'hex'
	| 'image'
	| 'pdf'
	| 'docx'
	| 'spreadsheet'
	| 'video'
	| 'audio'
	| 'binary';

/** Display label for each viewer shown in the "Open with…" menu. */
export const VIEWER_LABELS: Record<ViewerId, string> = {
	monaco:      'Code Editor',
	text:        'Plain Text',
	json:        'JSON Viewer',
	markdown:    'Markdown Preview',
	hex:         'Hex Viewer',
	image:       'Image Viewer',
	pdf:         'PDF Viewer',
	docx:        'Document Viewer',
	spreadsheet: 'Spreadsheet Viewer',
	video:       'Video Player',
	audio:       'Audio Player',
	binary:      'Binary (unsupported)',
};

/**
 * For each file category, the ordered list of compatible viewers.
 * The first entry is the default viewer.
 */
const CATEGORY_VIEWERS: Record<FileCategory, ViewerId[]> = {
	text:        ['monaco', 'text', 'hex'],
	code:        ['monaco', 'text', 'hex'],
	json:        ['monaco', 'json', 'text', 'hex'],
	markdown:    ['markdown', 'monaco', 'text', 'hex'],
	image:       ['image', 'hex'],
	video:       ['video', 'hex'],
	audio:       ['audio', 'hex'],
	pdf:         ['pdf', 'hex'],
	docx:        ['docx', 'hex'],
	spreadsheet: ['spreadsheet', 'hex'],
	binary:      ['hex', 'binary'],
};

/**
 * Returns the list of viewer IDs compatible with a given file category.
 */
export function getCompatibleViewers(category: FileCategory): ViewerId[] {
	return CATEGORY_VIEWERS[category] ?? ['hex'];
}

/**
 * Returns the default viewer for a category (first in the compatibility list).
 */
export function getDefaultViewer(category: FileCategory): ViewerId {
	return CATEGORY_VIEWERS[category]?.[0] ?? 'hex';
}
