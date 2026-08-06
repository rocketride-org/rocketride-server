// =============================================================================
// projectStore — Project file operations (prepends PROJECT_DIR transparently)
// =============================================================================

import { type RocketRideClient, PROJECT_DIR } from 'shell/client';

/** Read a project file. path is relative, e.g. "Chat.pipe" or "dir1/Chat.pipe" */
export function loadProject(client: RocketRideClient, path: string): Promise<any> {
	return client.fsReadJson(`${PROJECT_DIR}/${path}`);
}

/** Write a project file. path is relative, e.g. "Chat.pipe" or "dir1/Chat.pipe" */
export function saveProject(client: RocketRideClient, path: string, data: any): Promise<void> {
	return client.fsWriteJson(`${PROJECT_DIR}/${path}`, data);
}

/** Delete a project file. path is relative, e.g. "Chat.pipe" */
export function deleteProject(client: RocketRideClient, path: string): Promise<void> {
	return client.fsDelete(`${PROJECT_DIR}/${path}`);
}

/** Rename a file or directory. Both paths are relative, e.g. "old.pipe" → "new.pipe" */
export function renameProject(client: RocketRideClient, oldPath: string, newPath: string): Promise<void> {
	return client.fsRename(`${PROJECT_DIR}/${oldPath}`, `${PROJECT_DIR}/${newPath}`);
}

/** List a directory inside the project store. path is relative ("" for root, "dir1" for subdir) */
export function listProjectDir(client: RocketRideClient, path: string): Promise<any> {
	const storePath = path ? `${PROJECT_DIR}/${path}` : PROJECT_DIR;
	return client.fsListDir(storePath);
}

/** Create a directory inside the project store. path is relative, e.g. "myFolder" or "a/b" */
export function mkdirProject(client: RocketRideClient, path: string): Promise<void> {
	return client.fsMkdir(`${PROJECT_DIR}/${path}`);
}

/** Recursively delete a directory inside the project store. path is relative, e.g. "myFolder" or "a/b" */
export function rmdirProject(client: RocketRideClient, path: string): Promise<void> {
	return client.fsRmdir(`${PROJECT_DIR}/${path}`, true);
}

// =============================================================================
// PIPELINE EXTENSION VOCABULARY
// =============================================================================

/** Recognized pipeline file extensions — both spellings are valid on disk. */
export const PIPELINE_EXTENSIONS = ['.pipe', '.pipe.json'];

/**
 * Whether a path names a pipeline file (carries one of {@link PIPELINE_EXTENSIONS}).
 *
 * @param path - Relative or absolute file path.
 * @returns True when the path ends with a pipeline extension.
 */
export function isPipelineFile(path: string): boolean {
	return PIPELINE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * The pipeline extension a path carries.
 *
 * @param path - Relative or absolute file path.
 * @returns The matching extension (e.g. ".pipe.json"), or '' for non-pipeline paths.
 */
export function pipelineExtension(path: string): string {
	return PIPELINE_EXTENSIONS.find((ext) => path.endsWith(ext)) ?? '';
}

/**
 * Strip the pipeline extension for display in tab labels and sidebar.
 *
 * @param path - Relative or absolute file path.
 * @returns The leaf name with any pipeline extension removed.
 */
export function displayName(path: string): string {
	const name = path.split('/').pop() ?? path;
	const ext = pipelineExtension(name);
	return ext ? name.slice(0, -ext.length) : name;
}
