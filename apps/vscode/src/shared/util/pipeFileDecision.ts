// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The decision half of the sidebar's `.pipe` watcher: given what a watched
 * file contains and which project_ids the other files use, say what, if
 * anything, should happen to it.
 *
 * Kept free of `vscode`, timers and the logger so it can be asserted directly
 * (see pipeFileDecision.test.ts). SidebarProvider keeps the side effects:
 * reading, waiting, prompting and writing.
 *
 * Why this exists (issue #2466): the watcher used to rewrite files it should
 * not have touched. A file read while another program was still saving it
 * reads as empty and was replaced by a skeleton, and a "created" event for a
 * file the cache already knew (git clone, checkout, rename, worktree) counted
 * the file's own id as a duplicate and replaced it, reformatting the whole
 * file on the way. Every write the watcher makes now goes through here first.
 */

import * as path from 'path';

/** Which watcher event the text was read for. */
export type PipeFileEvent = 'created' | 'changed';

/** The slice of the sidebar's parsed-file cache the decision needs. */
export interface KnownPipeFile {
	filePath: string;
	projectId?: string;
}

/** What the watcher knows at the moment it has to decide. */
export interface PipeFileDecisionInput {
	event: PipeFileEvent;
	/** Absolute path of the file the event is for. */
	filePath: string;
	/** The file's text as read from disk. */
	text: string;
	/** Every cached file. The event's own file may be in here; it is excluded. */
	known: readonly KnownPipeFile[];
	/**
	 * True on the second look at a file that first read as empty: the caller
	 * waited EMPTY_FILE_SETTLE_MS and read it again.
	 */
	settled?: boolean;
}

/** How long a file that read as empty gets to finish being written. */
export const EMPTY_FILE_SETTLE_MS = 500;

export type PipeFileDecision =
	/** Write nothing. `reason` is for the log line. */
	| { kind: 'leave'; reason: 'empty' | 'invalid-json' | 'not-a-pipeline' | 'id-ok' }
	/** Read as empty on create: wait, read again, decide again with `settled`. */
	| { kind: 'confirm-empty' }
	/** Still empty after settling: a genuinely new file, give it the skeleton. */
	| { kind: 'seed-empty' }
	/** A pipeline with no usable project_id: write one. */
	| { kind: 'assign-id' }
	/**
	 * The id is in use by `otherPaths`, as the cache has it: tell the user,
	 * write nothing. The handler confirms the candidates on disk first.
	 */
	| { kind: 'ask-duplicate'; projectId: string; otherPaths: string[] };

/**
 * Decide what the watcher should do with one file.
 *
 * @param input The event, the file, its text and the cached files.
 */
export function decidePipeFile(input: PipeFileDecisionInput): PipeFileDecision {
	const { event, filePath, text, known, settled = false } = input;

	// An empty read is the dangerous case: it is what a file looks like while
	// another program is still writing it. A changed file is never seeded. A
	// created one is, but only once it has had time to settle and is still
	// empty, which is what a file made through "New File" looks like.
	if (text.trim() === '') {
		if (event !== 'created') return { kind: 'leave', reason: 'empty' };
		return settled ? { kind: 'seed-empty' } : { kind: 'confirm-empty' };
	}

	const parsed = pipeTarget(text);
	if (typeof parsed === 'string') return { kind: 'leave', reason: parsed };

	const projectId = projectIdOf(parsed.target);
	if (projectId === null) return { kind: 'assign-id' };

	// The file's own cache entry is never a clash. That was the #2466 defect:
	// a create event for a file the cache already knew found its own id here.
	const otherPaths = otherFilesWithProjectId(filePath, projectId, known);
	if (otherPaths.length === 0) return { kind: 'leave', reason: 'id-ok' };

	// A genuine duplicate is never rewritten unasked (that was the behaviour
	// before #2466): the user is told and chooses.
	return { kind: 'ask-duplicate', projectId, otherPaths };
}

/**
 * The paths of the other cached files that carry `projectId`, in cache order,
 * empty when no other file does. The file's own entry never counts, whatever
 * spelling or normalisation its path has.
 *
 * Two files sharing an id cannot be told apart once they run: the server knows
 * a task by project_id and source id only, so a save of one file would find,
 * and restart, the other file's task (#2825). The watcher uses this both to
 * warn about the duplicate and to leave such a task alone. Every candidate is
 * returned, not the first: the cache can hold a renamed file's previous path
 * or another spelling of this file ahead of a genuine duplicate, so the
 * caller confirms them on disk in order and takes the first real one.
 *
 * @param filePath Absolute path of the file in question.
 * @param projectId Its project_id; a missing or blank one matches nothing.
 * @param known Every cached file. The file's own entry may be in here.
 */
export function otherFilesWithProjectId(filePath: string, projectId: string | undefined, known: readonly KnownPipeFile[]): string[] {
	// The parser copies project_id as it finds it, so a number or null can
	// arrive here under the string type; neither names a twin.
	if (typeof projectId !== 'string' || projectId.trim() === '') return [];
	return known.filter((f) => f.projectId === projectId && !samePath(f.filePath, filePath)).map((f) => f.filePath);
}

/**
 * What identifies a file on its volume, as `fs.promises.stat(path, { bigint:
 * true })` reports it. Bigints, not numbers: an NTFS file id is 64 bits wide
 * (a 48-bit record index under a 16-bit reuse count), so above 2^53 two
 * different files can round to the same double.
 */
export interface FileIdentity {
	dev: bigint;
	ino: bigint;
}

/**
 * Whether two stat results describe one file: the same inode on the same
 * device. Catches a case-only rename on a case-insensitive volume (the macOS
 * default), where two spellings of a path open the same file, and a hard
 * link, where a write through either path changes both. An inode of 0 means
 * the file system reports none (some Windows volumes), so it never matches.
 */
export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
	if (a.ino === 0n || b.ino === 0n) return false;
	return a.dev === b.dev && a.ino === b.ino;
}

/**
 * The file's project_id: a string when it has a usable one, null when it is a
 * pipeline without one, undefined when the text is not a pipeline at all.
 */
export function readPipeProjectId(text: string): string | null | undefined {
	const parsed = pipeTarget(text);
	return typeof parsed === 'string' ? undefined : projectIdOf(parsed.target);
}

/** `"project_id": "<value>"` as it appears in the file text, in three groups. */
const PROJECT_ID_PROPERTY = /("project_id"\s*:\s*")([^"]*)(")/g;

/**
 * `text` with `projectId` as the pipeline's project_id, or undefined when the
 * text is not a pipeline.
 *
 * A file that already has a project_id keeps its formatting: only the value
 * is swapped. A file without one is re-serialised with the id added, which is
 * the previous behaviour and in practice only applies to files the extension
 * itself just wrote (New Pipeline seeds `{ components: [] }` with no id).
 */
export function withProjectId(text: string, projectId: string): string | undefined {
	const parsed = pipeTarget(text);
	if (typeof parsed === 'string') return undefined;

	const current = projectIdOf(parsed.target);
	if (current !== null) {
		// Swap in place only when the text has exactly one occurrence and it
		// carries the value we parsed. More than one (an id nested in some
		// component's config), or a lone occurrence that is not the target's
		// (an escaped key such as "project\u005fid"), and the safe path is
		// the re-serialisation below.
		const matches = [...text.matchAll(PROJECT_ID_PROPERTY)];
		if (matches.length === 1 && matches[0][2] === current) {
			const updated = text.replace(PROJECT_ID_PROPERTY, `$1${projectId}$3`);
			// A nested id can have the same value as an escaped pipeline id.
			// Confirm that the swap changed the pipeline's id, not that nested one.
			if (readPipeProjectId(updated) === projectId) return updated;
		}
	}

	parsed.target.project_id = projectId;
	return JSON.stringify(parsed.root, null, 2) + (text.endsWith('\n') ? '\n' : '');
}

/** The starter content a genuinely new, empty file receives. */
export function emptyPipelineSkeleton(projectId: string): string {
	return JSON.stringify({ project_id: projectId, components: [] }, null, 2);
}

// --- internals ---------------------------------------------------------------

interface PipeTarget {
	/** The parsed document, written back whole when re-serialising. */
	root: Record<string, unknown>;
	/** The object that carries `components` and `project_id`. */
	target: Record<string, unknown>;
}

/** The pipeline object inside `text`, or the reason there is none. */
function pipeTarget(text: string): PipeTarget | 'invalid-json' | 'not-a-pipeline' {
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		return 'invalid-json';
	}
	if (!isPlainObject(root)) return 'not-a-pipeline';
	// Both shapes the parser accepts: bare, or wrapped in { pipeline: ... }.
	const target = isPlainObject(root.pipeline) ? root.pipeline : root;
	if (!Array.isArray(target.components)) return 'not-a-pipeline';
	return { root, target };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The usable project_id on `target`, or null when there is none. */
function projectIdOf(target: Record<string, unknown>): string | null {
	const id = target.project_id;
	return typeof id === 'string' && id.trim() !== '' ? id : null;
}

/**
 * Path equality as the file system sees it. Case is folded on Windows only.
 * macOS volumes are usually case-insensitive too, but VS Code reports one
 * consistent casing per file, and a mismatch cannot cost a false warning: the
 * handler compares the two paths' file identity before asking (see
 * sameFileIdentity), which also covers a hard link.
 */
function samePath(a: string, b: string): boolean {
	const na = path.normalize(a);
	const nb = path.normalize(b);
	// path.sep, not process.platform: this module is also type-checked under
	// the webview config, where process is a stub without platform.
	return path.sep === '\\' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}
