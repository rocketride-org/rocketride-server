// =============================================================================
// FILE ICON — a folder, or a page with its extension on a coloured badge
// =============================================================================
// The icon every file browser uses: the type is readable at a glance from the
// badge ("PDF", "XLS", "JPG"), and its colour groups kinds of files the way
// the Fuse file manager does (red PDF, green sheets, blue documents, amber
// images, and more for pipelines, data and code), so the colour is never
// the only cue.
// =============================================================================

import React from 'react';
import { BxFile, BxFolder } from '../BoxIcon';

/** Props for the {@link FileIcon} component. */
export interface IFileIconProps {
	/** The file or folder name; the badge shows its extension. */
	name: string;
	/** Draw a folder instead of a page. */
	isFolder?: boolean;
	/** Icon size in px. Defaults to 40. */
	size?: number;
}

/** One kind of file: its badge colour, the badge's text colour, and its extensions. */
interface IFileKind {
	color: string;
	textColor: string;
	extensions: string[];
}

// Light text on the darker fills, dark text on amber, so every badge reads in
// both themes. Mixed from named colours rather than theme text tokens, which
// flip between themes while these fills do not.
const LIGHT_TEXT = 'color-mix(in srgb, white 94%, transparent)';
const DARK_TEXT = 'color-mix(in srgb, black 82%, transparent)';

/**
 * Fuse-style colour coding: red PDF, green sheets, blue documents, amber
 * images, then a colour each for the kinds a RocketRide store is full of
 * (pipelines, data, code, logs), so a folder of them is not all grey.
 */
const FILE_KINDS: IFileKind[] = [
	{ color: 'var(--rr-color-error)', textColor: LIGHT_TEXT, extensions: ['pdf'] },
	{ color: 'var(--rr-color-success)', textColor: LIGHT_TEXT, extensions: ['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ods'] },
	{ color: 'var(--rr-color-info)', textColor: LIGHT_TEXT, extensions: ['doc', 'docx', 'rtf', 'odt', 'ppt', 'pptx', 'odp'] },
	{ color: 'var(--rr-color-warning)', textColor: DARK_TEXT, extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'heic'] },
	{ color: 'var(--rr-chart-series-5)', textColor: LIGHT_TEXT, extensions: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'ogg', 'flac', 'm4a'] },
	{ color: 'var(--rr-chart-series-3)', textColor: LIGHT_TEXT, extensions: ['zip', 'gz', 'tgz', 'tar', 'rar', '7z'] },
	// RocketRide pipelines: the brand's dark ink.
	{ color: 'color-mix(in srgb, black 82%, var(--rr-accent))', textColor: LIGHT_TEXT, extensions: ['pipe'] },
	{ color: 'var(--rr-chart-series-2)', textColor: DARK_TEXT, extensions: ['json', 'jsonl', 'ndjs', 'yaml', 'yml', 'xml', 'toml', 'parq', 'avro'] },
	{ color: 'var(--rr-chart-series-6)', textColor: DARK_TEXT, extensions: ['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'sh', 'ps1', 'sql', 'html', 'css', 'ipyn'] },
	{ color: 'color-mix(in srgb, black 62%, white)', textColor: LIGHT_TEXT, extensions: ['txt', 'log', 'md', 'rst', 'ini', 'cfg', 'conf', 'env'] },
];

/** A neutral grey for anything else. */
const OTHER_KIND: IFileKind = { color: 'color-mix(in srgb, black 45%, white)', textColor: LIGHT_TEXT, extensions: [] };

/**
 * The upper-case extension of a name, at most four letters, or '' when it has none.
 *
 * @param name - A file name.
 * @returns The badge text.
 */
export function extensionBadge(name: string): string {
	const dot = name.lastIndexOf('.');
	if (dot <= 0 || dot === name.length - 1) return '';
	return name
		.slice(dot + 1)
		.slice(0, 4)
		.toUpperCase();
}

/** The kind of file a name's extension says it is. */
function kindOf(name: string): IFileKind {
	const extension = extensionBadge(name).toLowerCase();
	for (const kind of FILE_KINDS) {
		if (kind.extensions.includes(extension)) return kind;
	}
	return OTHER_KIND;
}

/**
 * Renders a folder, or a page with its extension badge.
 *
 * @param props - {@link IFileIconProps}.
 * @returns The icon element.
 */
export function FileIcon({ name, isFolder = false, size = 40 }: IFileIconProps): React.ReactElement {
	if (isFolder) {
		return (
			<span className="rr-file-icon rr-file-icon--folder" aria-hidden="true">
				<BxFolder size={size} />
			</span>
		);
	}
	const badge = extensionBadge(name);
	const kind = kindOf(name);
	// Small icons (the list view) have no room for a badge: the page itself
	// takes the kind's colour instead, and the Type column says the rest.
	if (size < 28 || badge === '') {
		let color: string | undefined;
		if (badge !== '') color = kind.color;
		return (
			<span className="rr-file-icon" style={{ color }} aria-hidden="true">
				<BxFile size={size} />
			</span>
		);
	}
	return (
		<span className="rr-file-icon" aria-hidden="true">
			<BxFile size={size} />
			<span className="rr-file-icon__badge" style={{ background: kind.color, color: kind.textColor }}>
				{badge}
			</span>
		</span>
	);
}
