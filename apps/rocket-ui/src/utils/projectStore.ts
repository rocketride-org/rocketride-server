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

/** Strip .pipe extension for display in tab labels and sidebar. */
export function displayName(path: string): string {
	const name = path.split('/').pop() ?? path;
	return name.endsWith('.pipe') ? name.slice(0, -5) : name;
}
