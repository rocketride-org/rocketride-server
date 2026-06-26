// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Explorer types — virtual file system interface and document tree types.
 *
 * IVirtualFileSystem is the single abstraction for all file operations.
 * It is created by the hosting container (RocketSidebar, VS Code sidebar)
 * and threaded through SidebarView → Explorer → Documents singleton
 * as one prop.
 */

import type { ReactNode } from 'react';

// =============================================================================
// VIRTUAL FILE SYSTEM
// =============================================================================

/**
 * Virtual file system interface — the single abstraction for all file I/O.
 *
 * Created by the hosting container and passed as one prop through the
 * entire component stack.  Both Explorer (file tree UI) and the
 * Documents singleton (content lifecycle) use this interface.
 *
 * Implementations:
 *   - RocketVFS:  client.fsListDir / fsReadJson / fsWriteJson / fsRename / fsDelete / fsMkdir
 *   - VSCodeVFS:  postMessage to extension host
 *   - ImageVFS:   REST API calls
 *   - LocalVFS:   browser File System Access API
 */
export interface IVirtualFileSystem {
	/**
	 * Lists the contents of a directory.
	 *
	 * @param dir - Relative directory path ('' for root).
	 * @returns Array of entries with name and type.
	 */
	list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]>;

	/**
	 * Reads the content of a file.  Returns the content as-is — the VFS
	 * implementation decides the type (object, string, ArrayBuffer, etc.).
	 *
	 * @param path - Relative file path.
	 * @returns The file content (any serializable value).
	 */
	read(path: string): Promise<unknown>;

	/**
	 * Writes content to a file.  The content type matches what read() returns.
	 *
	 * @param path    - Relative file path.
	 * @param content - The content to write.
	 */
	write(path: string, content: unknown): Promise<void>;

	/**
	 * Renames a file or directory.
	 *
	 * @param oldPath - Current relative path.
	 * @param newPath - New relative path.
	 */
	rename(oldPath: string, newPath: string): Promise<void>;

	/**
	 * Deletes a file or directory.
	 *
	 * @param path - Relative path to delete.
	 */
	delete(path: string): Promise<void>;

	/**
	 * Creates a directory.
	 *
	 * @param path - Relative directory path to create.
	 */
	mkdir(path: string): Promise<void>;
}

// =============================================================================
// EXPLORER ENTRY TYPES
// =============================================================================

/**
 * A file or directory entry in the document tree.
 *
 * The host builds a flat array of these; Explorer derives the directory
 * hierarchy on the fly via path parsing (S3-style).
 */
export interface ExplorerEntry {
	/** Full relative path (e.g. 'ingest/analyze.pipe' or 'photos/vacation'). */
	path: string;
	/** Entry type — 'file' (default) or 'dir'. */
	type?: 'file' | 'dir';
	/** Optional unique identifier for the document. */
	documentId?: string;
	/**
	 * Optional child items displayed under this entry when expanded.
	 * For pipeline apps: source components.  For other apps: layers, tracks, etc.
	 */
	children?: ExplorerChild[];
}

/**
 * A child item under a document entry.
 */
export interface ExplorerChild {
	/** Unique child ID. */
	id: string;
	/** Display name. */
	name: string;
	/** Optional type/category label. */
	provider?: string;
}

/**
 * Status for a single entry or child item.
 */
export interface ExplorerStatus {
	/** Whether the entry/child is actively running/processing. */
	running: boolean;
	/** Error messages. */
	errors: string[];
	/** Warning messages. */
	warnings: string[];
}

/**
 * Synthesized directory node — returned by deriveChildren, never stored.
 */
export interface DirNode {
	/** Directory name. */
	name: string;
	/** Full directory path. */
	path: string;
	/** Always 'dir'. */
	type: 'dir';
}

// =============================================================================
// EXPLORER CONFIG
// =============================================================================

/**
 * Configuration for the Explorer component.
 *
 * Allows the host to customise labels, file extension handling, and
 * which features are enabled.
 */
export interface ExplorerConfig {
	/** Section header title (e.g. "Pipelines", "Photos", "Files"). */
	title: string;
	/** File extensions to filter/display (e.g. ['.pipe']). Null = show all. */
	extensions?: string[] | null;
	/**
	 * Custom display name formatter.  Receives the filename (not full path)
	 * and returns the display string.  Default strips known extensions.
	 *
	 * @param filename - The raw filename.
	 * @returns The display name.
	 */
	displayName?: (filename: string) => string;
	/** Placeholder text for the inline create input. Default: 'file name'. */
	createPlaceholder?: string;
	/** Empty state message. Default: 'No files'. */
	emptyMessage?: string;
	/** Whether to show the "New Folder" action. Default: true. */
	allowFolders?: boolean;
}

// =============================================================================
// EXPLORER PROPS
// =============================================================================

/**
 * A custom action injected by the host into a file row's kebab menu.
 *
 * The Explorer is action-agnostic: it renders whatever actions the host
 * supplies and calls `onSelect(path)` when one is chosen. SaaS hosts use this
 * for features (e.g. Export/Download) that must stay out of the VS Code
 * bundle — hosts that omit `fileActions` show only the built-in rename/delete.
 */
export interface ExplorerFileAction {
	/** Stable identifier; also used as the React key. */
	id: string;
	/** Menu item label. */
	label: string;
	/** Optional leading icon node. */
	icon?: ReactNode;
	/** Invoked with the row's file path when the item is chosen. Omit if using children. */
	onSelect?: (path: string) => void;
	/** Submenu items — when present, hovering the item opens a nested menu. May be a static array or a function that receives the file path. */
	children?: ExplorerFileAction[] | ((path: string) => ExplorerFileAction[]);
}

/**
 * Props for the Explorer component.
 */
export interface IExplorerProps {
	/** Virtual file system provider for all file operations. */
	vfs: IVirtualFileSystem;

	/** Component configuration (title, extensions, display names). */
	config: ExplorerConfig;

	/** Flat array of entries (host-provided). */
	entries: ExplorerEntry[];

	/** Status per entry/child, keyed by a string identifier. */
	statuses?: Map<string, ExplorerStatus>;

	/** Whether the host is connected (enables/disables action buttons). */
	isConnected: boolean;

	/** Whether child action buttons should be shown (e.g. subscription check). */
	showChildActions?: boolean;

	/** Currently active/open file path (for highlight). */
	activeFilePath?: string;

	/** Called when the user clicks a file entry to open it. */
	onOpenFile: (path: string) => void;

	/**
	 * Called for file management operations (rename, delete, create).
	 * Optional — when absent, file management UI is hidden (display-only).
	 */
	onFileManage?: (action: 'rename' | 'delete' | 'createFolder' | 'createFile', path: string, newName?: string) => void;

	/**
	 * Called when a child item action button is clicked (e.g. run/stop).
	 * Optional — when absent, no action buttons are shown on children.
	 */
	onChildAction?: (action: 'run' | 'stop', filePath: string, childId: string, documentId?: string) => void;

	/**
	 * Host-injected extra actions appended to each file row's kebab menu
	 * (e.g. Export). Optional — omitted hosts (VS Code) show only rename/delete.
	 */
	fileActions?: ExplorerFileAction[];

	/** Called when the user clicks the refresh button. */
	onRefresh: () => void;

	/**
	 * Called when a file or directory is dragged and dropped onto a directory.
	 * Optional — when absent, internal drag-to-move is disabled.
	 */
	onMove?: (sourcePath: string, targetDir: string) => void;

	/**
	 * Called when files are dropped from the OS onto the file tree.
	 * Optional — when absent, upload-by-drop is disabled.
	 *
	 * @param files     - The dropped File objects.
	 * @param targetDir - The directory path they were dropped onto ('' for root).
	 */
	onUpload?: (files: File[], targetDir: string) => void;
}
