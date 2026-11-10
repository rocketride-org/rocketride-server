// =============================================================================
// projectStore — pipeline file VOCABULARY (extensions, display names)
// =============================================================================
//
// File I/O lives on the workspace view (createProjectVfs) — this module is
// deliberately down to the pure helpers that classify pipeline paths.

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
