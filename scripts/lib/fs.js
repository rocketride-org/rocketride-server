/**
 * Async File System Utilities
 *
 * Provides async wrappers for common filesystem operations.
 * All functions use fs.promises and handle common edge cases.
 *
 * Usage:
 *   const { exists, readFile, writeFile, mkdir } = require('../../../scripts/lib');
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// =============================================================================
// Existence Checks
// =============================================================================

/**
 * Check if a path exists
 * @param {string} filePath - Path to check
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
	try {
		await fsp.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a path exists and is a file
 * @param {string} filePath - Path to check
 * @returns {Promise<boolean>}
 */
async function isFile(filePath) {
	try {
		const stat = await fsp.stat(filePath);
		return stat.isFile();
	} catch {
		return false;
	}
}

/**
 * Check if a path exists and is a directory
 * @param {string} dirPath - Path to check
 * @returns {Promise<boolean>}
 */
async function isDirectory(dirPath) {
	try {
		const stat = await fsp.stat(dirPath);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

// =============================================================================
// Reading
// =============================================================================

/**
 * Read a file's contents
 * @param {string} filePath - Path to file
 * @param {string|Object} [options='utf8'] - Encoding or options object
 * @returns {Promise<string|Buffer>}
 */
async function readFile(filePath, options = 'utf8') {
	return fsp.readFile(filePath, options);
}

/**
 * Read a JSON file. Every caller reads a definition file - a services*.json, a
 * package.json, a manifest - so anything but an object is broken data, and the
 * path goes in the error since the contents alone cannot say which file it was.
 * @param {string} filePath - Path to JSON file
 * @returns {any}
 */
function readJsonSync(filePath) {
	const text = fs.readFileSync(filePath, 'utf8');

	let data;
	try {
		data = parseJson(text);
	} catch (err) {
		if (!err.jsoncErrors) throw err;

		// Only this side knows the path, and an offset alone cannot be acted on
		const { offset } = err.jsoncErrors[0];
		const lines = text.slice(0, offset).split('\n');
		const column = lines[lines.length - 1].length + 1;
		throw new SyntaxError(`${filePath}:${lines.length}:${column}: ${err.message}`);
	}

	if (!data || typeof data !== 'object' || Array.isArray(data))
		throw new Error(`${filePath}: expected a JSON object`);

	return data;
}

/**
 * Read a JSON file, for the async callers. Reads synchronously - definition
 * files are small, and this keeps one reader
 * @param {string} filePath - Path to JSON file
 * @returns {Promise<any>}
 */
async function readJson(filePath) {
	return readJsonSync(filePath);
}

/**
 * Read directory contents
 * @param {string} dirPath - Path to directory
 * @param {Object} [options] - Options
 * @param {boolean} [options.withFileTypes=false] - Return Dirent objects
 * @returns {Promise<string[]|fs.Dirent[]>}
 */
async function readDir(dirPath, options = {}) {
	return await fsp.readdir(dirPath, options);
}

/**
 * Read directory contents, returning empty array if it doesn't exist
 * @param {string} dirPath - Path to directory
 * @param {Object} [options] - Options
 * @param {boolean} [options.withFileTypes=false] - Return Dirent objects
 * @returns {Promise<string[]|fs.Dirent[]>}
 */
async function readDirSafe(dirPath, options = {}) {
	try {
		return await fsp.readdir(dirPath, options);
	} catch (err) {
		if (err.code === 'ENOENT') return [];
		throw err;
	}
}

// =============================================================================
// Writing
// =============================================================================

/**
 * Write content to a file
 * @param {string} filePath - Path to file
 * @param {string|Buffer} content - Content to write
 * @param {string|Object} [options='utf8'] - Encoding or options object
 * @returns {Promise<void>}
 */
async function writeFile(filePath, content, options = 'utf8') {
	return fsp.writeFile(filePath, content, options);
}

/**
 * Create a writable stream to a file
 * @param {string} filePath - Path to file
 * @param {Object} [options] - Options passed to fs.createWriteStream
 * @returns {fs.WriteStream}
 */
function createWriteStream(filePath, options) {
	return fs.createWriteStream(filePath, options);
}

/**
 * Write JSON to a file
 * @param {string} filePath - Path to file
 * @param {any} data - Data to write
 * @param {Object} [options] - Options
 * @param {number} [options.indent=2] - JSON indentation
 * @returns {Promise<void>}
 */
async function writeJson(filePath, data, options = {}) {
	const { indent = 2 } = options;
	const content = JSON.stringify(data, null, indent);
	return fsp.writeFile(filePath, content, 'utf8');
}

/**
 * Write content to a file, creating parent directories if needed
 * @param {string} filePath - Path to file
 * @param {string|Buffer} content - Content to write
 * @param {string|Object} [options='utf8'] - Encoding or options object
 * @returns {Promise<void>}
 */
async function writeFileEnsure(filePath, content, options = 'utf8') {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	return fsp.writeFile(filePath, content, options);
}

// =============================================================================
// Directory Operations
// =============================================================================

/**
 * Create a directory (and parent directories if needed)
 * @param {string} dirPath - Path to directory
 * @param {Object} [options] - Options
 * @param {boolean} [options.recursive=true] - Create parent directories
 * @returns {Promise<string|undefined>} The first directory path created, or undefined
 */
async function mkdir(dirPath, options = {}) {
	const { recursive = true, ...rest } = options;
	return fsp.mkdir(dirPath, { recursive, ...rest });
}

/**
 * Create a directory only if it doesn't exist
 * @param {string} dirPath - Path to directory
 * @returns {Promise<boolean>} True if created, false if already existed
 */
async function mkdirIfNotExists(dirPath) {
	try {
		await fsp.mkdir(dirPath, { recursive: true });
		return true;
	} catch (err) {
		if (err.code === 'EEXIST') return false;
		throw err;
	}
}

// =============================================================================
// Copy Operations
// =============================================================================

// Windows reports a path another process holds open as EBUSY or EPERM, and hands
// the error to whoever touches it second — the holder need not be writing: an
// editor's language server indexing dist/, a file watcher or an AV pass is
// enough. A sync that walks thousands of files meets that window eventually, so
// the operations that cross it retry briefly rather than failing a whole build
// on one busy millisecond. A path that stays locked still raises its real error.
//
// EACCES is deliberately not here: an exclusively held file reports EBUSY, while
// on Unix EACCES is a permission denial that must surface at once instead of after
// a second of retries. clean.js and vendor-shell.js classify a lock the same way.
const TRANSIENT_LOCK_CODES = new Set(['EBUSY', 'EPERM']);

/**
 * Run a filesystem operation, retrying while the path is transiently locked.
 *
 * The delay grows per attempt (delayMs, x2, x3, ...), so on the defaults a
 * genuinely held path costs one second before it reports. Anything that is not a
 * lock propagates at once — a missing file must not be retried into a slow failure.
 *
 * Callers whose operation has its own notion of "transient" pass their own set:
 * a directory swap also treats ENOTEMPTY as retryable, which is meaningless here.
 *
 * @template T
 * @param {() => Promise<T> | T} op - Operation to attempt
 * @param {object} [options] - Retry tuning
 * @param {number} [options.attempts] - Total attempts, including the first
 * @param {number} [options.delayMs] - Base delay, multiplied by the attempt number
 * @param {Set<string>} [options.codes] - Error codes treated as transient
 * @returns {Promise<T>} Whatever the operation returns
 */
async function retryTransientLock(op, { attempts = 5, delayMs = 100, codes = TRANSIENT_LOCK_CODES } = {}) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await op();
		} catch (err) {
			if (attempt >= attempts || !codes.has(err.code)) throw err;
			await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
		}
	}
}

/**
 * Copy a file
 * @param {string} src - Source file path
 * @param {string} dest - Destination file path
 * @param {number} [mode] - Copy mode flags
 * @returns {Promise<void>}
 */
async function copyFile(src, dest, mode) {
	return retryTransientLock(() => fsp.copyFile(src, dest, mode));
}

/**
 * Copy a file, creating destination directory if needed
 * @param {string} src - Source file path
 * @param {string} dest - Destination file path
 * @returns {Promise<void>}
 */
async function copyFileEnsure(src, dest) {
	await fsp.mkdir(path.dirname(dest), { recursive: true });

	return retryTransientLock(async () => {
		try {
			return await fsp.copyFile(src, dest);
		} catch (err) {
			// RO dest (e.g. part of JDK/JRE files) - force-remove RO dest and copy src in its place
			if (err.code === 'EACCES' || err.code === 'EPERM') {
				await fsp.access(src, fs.constants.R_OK);
				await fsp.rm(dest, { force: true });
				return await fsp.copyFile(src, dest);
			}

			throw err;
		}
	});
}

/**
 * Fill a buffer from a file handle, looping until it is full or EOF is hit.
 *
 * A single read() may return fewer bytes than requested even mid-file, so this
 * keeps reading into the same buffer until the requested window is complete.
 * That guarantees two files are compared on aligned byte boundaries.
 *
 * @param {import('fs/promises').FileHandle} fh - Open file handle
 * @param {Buffer} buf - Destination buffer to fill
 * @returns {Promise<number>} Bytes read into buf (0 once EOF is reached)
 */
async function readChunkFull(fh, buf) {
	let offset = 0;
	while (offset < buf.length) {
		const { bytesRead } = await fh.read(buf, offset, buf.length - offset, null);
		if (bytesRead === 0) break; // EOF
		offset += bytesRead;
	}
	return offset;
}

/**
 * Byte-compare the contents of two files.
 *
 * Used by the incremental sync to decide whether a file actually changed.
 * File size is a cheap pre-filter — differently-sized files are never equal,
 * so callers should skip this call when sizes differ. Same-size files must be
 * compared by content, because a same-length edit (e.g. a swapped
 * content-hash string in an index.html) does not change the size and cannot
 * be detected by size or mtime alone.
 *
 * The compare runs in bounded chunks and stops at the first mismatch, so it
 * never allocates two whole-file buffers — a large same-size asset costs two
 * fixed windows, not two full copies in memory.
 *
 * @param {string} a - First file path
 * @param {string} b - Second file path
 * @returns {Promise<boolean>} True if both files have identical bytes
 */
async function filesEqual(a, b) {
	const CHUNK_SIZE = 64 * 1024;
	// Open sequentially with nested try/finally. Opening both under Promise.all
	// would leak the first handle if the second open rejected (Promise.all
	// rejects at once, orphaning the resolved handle) — a slow FD leak that can
	// build to EMFILE across a large sync.
	const fhA = await retryTransientLock(() => fsp.open(a, 'r'));
	try {
		const fhB = await retryTransientLock(() => fsp.open(b, 'r'));
		try {
			const bufA = Buffer.allocUnsafe(CHUNK_SIZE);
			const bufB = Buffer.allocUnsafe(CHUNK_SIZE);
			for (;;) {
				const [readA, readB] = await Promise.all([readChunkFull(fhA, bufA), readChunkFull(fhB, bufB)]);
				// Divergent lengths (or one file hitting EOF first) => not equal.
				if (readA !== readB) return false;
				// Both reached EOF with every prior window equal => identical.
				if (readA === 0) return true;
				if (!bufA.subarray(0, readA).equals(bufB.subarray(0, readB))) return false;
			}
		} finally {
			await fhB.close();
		}
	} finally {
		await fhA.close();
	}
}

/**
 * Copy a directory recursively
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @param {Object} [options] - Options
 * @param {boolean} [options.recursive=true] - Copy recursively
 * @returns {Promise<void>}
 */
async function copyDir(src, dest, options = {}) {
	const { recursive = true, ...rest } = options;
	return fsp.cp(src, dest, { recursive, ...rest });
}

/**
 * Copy a directory, creating destination parent if needed
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @param {Object} [options] - Options
 * @returns {Promise<void>}
 */
async function copyDirEnsure(src, dest, options = {}) {
	await fsp.mkdir(path.dirname(dest), { recursive: true });
	return fsp.cp(src, dest, { recursive: true, ...options });
}

// =============================================================================
// Stat Operations
// =============================================================================

/**
 * Get file/directory stats
 * @param {string} filePath - Path to file or directory
 * @returns {Promise<fs.Stats>}
 */
async function stat(filePath) {
	return fsp.stat(filePath);
}

/**
 * Get file/directory stats, returning null if it doesn't exist
 * @param {string} filePath - Path to file or directory
 * @returns {Promise<fs.Stats|null>}
 */
async function statSafe(filePath) {
	try {
		return await fsp.stat(filePath);
	} catch (err) {
		if (err.code === 'ENOENT') return null;
		throw err;
	}
}

/**
 * Get symlink stats (doesn't follow symlinks)
 * @param {string} filePath - Path to file or directory
 * @returns {Promise<fs.Stats>}
 */
async function lstat(filePath) {
	return fsp.lstat(filePath);
}

// =============================================================================
// Link Operations
// =============================================================================

/**
 * Create a symbolic link
 * @param {string} target - Link target path
 * @param {string} linkPath - Path for the new symlink
 * @param {string} [type] - Type on Windows: 'file', 'dir', or 'junction'
 * @returns {Promise<void>}
 */
async function symlink(target, linkPath, type) {
	return fsp.symlink(target, linkPath, type);
}

/**
 * Read a symbolic link
 * @param {string} linkPath - Path to symlink
 * @returns {Promise<string>}
 */
async function readlink(linkPath) {
	return fsp.readlink(linkPath);
}

// =============================================================================
// Delete Operations (re-exported from clean.js for convenience)
// =============================================================================

/**
 * Remove a file
 * @param {string} filePath - Path to file
 * @returns {Promise<boolean>} True if removed, false if didn't exist
 */
async function unlink(filePath) {
	try {
		await fsp.unlink(filePath);
		return true;
	} catch (err) {
		if (err.code === 'ENOENT') return false;
		throw err;
	}
}

/**
 * Remove a file or directory
 * @param {string} filePath - Path to file or directory
 * @param {Object} [options] - Options
 * @param {boolean} [options.recursive=true] - Remove directories recursively
 * @param {boolean} [options.force=true] - Ignore errors if path doesn't exist
 * @returns {Promise<void>}
 */
async function rm(filePath, options = {}) {
	const { recursive = true, force = true } = options;
	return fsp.rm(filePath, { recursive, force });
}

/**
 * Remove an empty directory
 * @param {string} dirPath - Path to directory
 * @returns {Promise<void>}
 */
async function rmdir(dirPath) {
	return fsp.rmdir(dirPath);
}

// =============================================================================
// Rename/Move Operations
// =============================================================================

/**
 * Rename/move a file or directory
 * @param {string} oldPath - Current path
 * @param {string} newPath - New path
 * @returns {Promise<void>}
 */
async function rename(oldPath, newPath) {
	return fsp.rename(oldPath, newPath);
}

/**
 * Move a file or directory, creating destination directory if needed
 * @param {string} oldPath - Current path
 * @param {string} newPath - New path
 * @returns {Promise<void>}
 */
async function move(oldPath, newPath) {
	await fsp.mkdir(path.dirname(newPath), { recursive: true });
	return fsp.rename(oldPath, newPath);
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Get the real path (resolving symlinks)
 * @param {string} filePath - Path to resolve
 * @returns {Promise<string>}
 */
async function realpath(filePath) {
	return fsp.realpath(filePath);
}

/**
 * Truncate a file to a specified length
 * @param {string} filePath - Path to file
 * @param {number} [len=0] - Length to truncate to
 * @returns {Promise<void>}
 */
async function truncate(filePath, len = 0) {
	return fsp.truncate(filePath, len);
}

/**
 * Update file access and modification times
 * @param {string} filePath - Path to file
 * @param {Date|number} [atime=now] - Access time
 * @param {Date|number} [mtime=now] - Modification time
 * @returns {Promise<void>}
 */
async function utimes(filePath, atime = new Date(), mtime = new Date()) {
	return fsp.utimes(filePath, atime, mtime);
}

/**
 * Create or update a file's timestamp (like touch command)
 * @param {string} filePath - Path to file
 * @returns {Promise<void>}
 */
async function touch(filePath) {
	const now = new Date();
	try {
		await fsp.utimes(filePath, now, now);
	} catch (err) {
		if (err.code === 'ENOENT') {
			await fsp.writeFile(filePath, '');
		} else {
			throw err;
		}
	}
}

/**
 * Parse JSONC text - the comments and trailing commas that services*.json and
 * the vscode configs are written with. Throws on anything JSON.parse would
 * reject, including a truncated comment or two values run together; the thrown
 * error carries jsonc-parser's raw errors as `jsoncErrors` so a caller that
 * knows the file can say where the problem is.
 * @param {string} text - JSONC source
 * @returns {any}
 */
function parseJson(text) {
	// Required inline: deps-tasks.js pulls this file in before the builder has
	// run pnpm install (scripts/build.js requires it ahead of
	// checkDependencies), so a top-level import would break a fresh clone
	const { parse, printParseErrorCode } = require('jsonc-parser');

	// parse is lenient by contract - it reports problems instead of throwing,
	// so the errors are what makes malformed data fail here
	const errors = [];
	const data = parse(text, errors, { allowTrailingComma: true });
	if (errors.length) {
		const err = new SyntaxError(printParseErrorCode(errors[0].error));
		err.jsoncErrors = errors;
		throw err;
	}

	return data;
}

// =============================================================================
// Fingerprinting (for build caching)
// =============================================================================

/**
 * Never part of a directory's identity: caches and VCS bookkeeping.
 *
 * Permanent - `options.exclude` adds to this, it does not replace it. What a
 * build generates into its own sources goes there, being its own to know.
 */
const EXCLUDE_ALWAYS = ['node_modules', '.git', '__pycache__', '.pyc'];

/**
 * Every file under dirPath, sorted, with the path each hash is keyed by.
 *
 * @param {string} dirPath - Directory to walk
 * @param {string[]} [exclude] - Patterns to exclude on top of EXCLUDE_ALWAYS
 * @returns {Promise<{rel: string, full: string}[]|null>} null if dirPath is not there
 */
async function walkFiles(dirPath, exclude = []) {
	const skip = [...EXCLUDE_ALWAYS, ...exclude];
	const files = [];

	try {
		await fsp.access(dirPath);
	} catch {
		return null;
	}

	async function walk(dir, relativePath = '') {
		const items = await fsp.readdir(dir, { withFileTypes: true });

		for (const item of items) {
			if (skip.some((pattern) => item.name === pattern || item.name.endsWith(pattern))) {
				continue;
			}

			const fullPath = path.join(dir, item.name);
			const relPath = path.join(relativePath, item.name);

			if (item.isDirectory()) await walk(fullPath, relPath);
			// Forward slashes, so a hash means the same on either platform
			else if (item.isFile()) files.push({ rel: relPath.replace(/\\/g, '/'), full: fullPath });
		}
	}

	await walk(dirPath);
	files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

	return files;
}

/**
 * Generate a fingerprint for a directory based on file sizes and modification times.
 * This is fast (no file content reads) and catches most changes.
 *
 * Metadata, so the value is this machine's - compare it with one this machine
 * stored, never with one from elsewhere. contentHash is the portable one.
 *
 * @param {string} dirPath - Directory to fingerprint
 * @param {Object} [options] - Options
 * @param {string[]} [options.exclude] - Patterns to exclude on top of the permanent ones
 * @returns {Promise<string|null>} MD5 hash of the directory's fingerprint, or null if directory doesn't exist
 *
 * @example
 * const hash = await fingerprint('src/');
 * if (hash !== savedHash) {
 *   // Source changed, need to rebuild
 * }
 */
async function fingerprint(dirPath, options = {}) {
	const files = await walkFiles(dirPath, options.exclude);
	if (!files) return null;

	const entries = await Promise.all(
		files.map(async (file) => {
			const stats = await fsp.stat(file.full);
			return `${file.rel}:${stats.size}:${stats.mtimeMs}`;
		})
	);

	return crypto.createHash('md5').update(entries.join('\n')).digest('hex');
}

/**
 * Compute a SHA-256 content hash of all files in a directory tree.
 *
 * Uses the same exclusion patterns as fingerprint() but hashes actual
 * file contents rather than metadata, making it fully deterministic
 * across machines and git clones.
 *
 * Every file is read, so this is the slow one - cachedContentHash below is the
 * same value for the price of a fingerprint when nothing has moved.
 *
 * @param {string} dirPath - Directory to hash
 * @param {Object} [options] - Options
 * @param {string[]} [options.exclude] - Patterns to exclude on top of the permanent ones
 * @param {Object} [options.task] - Task to report progress on, as execCommand takes one
 * @returns {Promise<string|null>} Hex hash string, or null if directory doesn't exist
 */
async function contentHash(dirPath, options = {}) {
	const files = await walkFiles(dirPath, options.exclude);
	if (!files) return null;

	const hash = crypto.createHash('sha256');
	for (const file of files) {
		// CR stripped, so a CRLF checkout hashes as the LF one it came from
		const content = (await fsp.readFile(file.full, 'utf8')).replace(/\r/g, '');
		hash.update(file.rel);
		hash.update(content);
	}

	const digest = hash.digest('hex');
	if (options.task) {
		options.task.output = `contentHash: ${path.basename(dirPath)} (${files.length} files) -> ${digest}`;
	}

	return digest;
}

/**
 * The content hash of a directory, read from the cache when its fingerprint
 * says nothing has moved.
 *
 * Reading every file to learn that a tree is unchanged is the expensive way to
 * find out; file sizes and timestamps answer it in a fraction of the time. The
 * value is the same content hash either way, so a caller can still compare it
 * with one from another machine - only the work of arriving at it is skipped.
 *
 * @param {string} dirPath - Directory to hash
 * @param {string} stateKey - Where the fingerprint and the hash it belongs to are kept
 * @param {Object} [options] - Options, as contentHash takes them
 * @returns {Promise<string|null>} Hex hash string, or null if directory doesn't exist
 */
async function cachedContentHash(dirPath, stateKey, options = {}) {
	const { getState, setState } = require('./state');

	const current = await fingerprint(dirPath, options);
	if (current === null) return null;

	const cached = await getState(stateKey);
	if (cached?.fingerprint === current && cached.digest) {
		if (options.task) {
			options.task.output = `contentHash: ${path.basename(dirPath)} (cached) -> ${cached.digest}`;
		}

		return cached.digest;
	}

	const digest = await contentHash(dirPath, options);
	await setState(stateKey, { fingerprint: current, digest });

	return digest;
}

/**
 * Check if source has changed since last build.
 * Returns true if rebuild is needed, false if unchanged.
 *
 * @param {string} srcDir - Source directory to check
 * @param {string} stateKey - Key in state.json (e.g., 'client-typescript.srcHash')
 * @param {Object} [options] - Options for fingerprint
 * @returns {Promise<{changed: boolean, hash: string|null}>}
 *
 * @example
 * const { getState, setState } = require('./state');
 * const { changed, hash } = await hasSourceChanged('src/', 'client-typescript.srcHash');
 * if (!changed) {
 *   task.output = 'No changes detected';
 *   return;
 * }
 * // ... do build ...
 * await setState('client-typescript.srcHash', hash);
 */
async function hasSourceChanged(srcDir, stateKey, options = {}) {
	const { getState } = require('./state');

	const currentHash = await fingerprint(srcDir, options);

	// If directory doesn't exist, always consider it "changed" (needs build)
	if (currentHash === null) {
		return { changed: true, hash: null };
	}

	const savedHash = await getState(stateKey);

	return {
		changed: currentHash !== savedHash,
		hash: currentHash,
	};
}

/**
 * Save the source hash after a successful build.
 *
 * @param {string} stateKey - Key in state.json
 * @param {string|null} hash - Hash to save (null is ignored)
 * @returns {Promise<void>}
 */
async function saveSourceHash(stateKey, hash) {
	if (hash === null) return; // Don't save if directory didn't exist
	const { setState } = require('./state');
	await setState(stateKey, hash);
}

/**
 * Compute a combined MD5 hash of multiple source directories and individual files.
 * Uses fingerprint() (mtime+size) for speed.  Produces a single cache key for
 * build actions that depend on several inputs (e.g. own src/ + shared/src +
 * package.json).
 *
 * @param {string[]} dirs   - Directories to fingerprint.
 * @param {string[]} [files] - Individual files to include (e.g. package.json).
 * @returns {Promise<string>} Combined hex digest.
 */
async function buildInputHash(dirs, files = []) {
	const hash = crypto.createHash('md5');

	// Fingerprint each source directory
	for (const dir of dirs) {
		const fp = await fingerprint(dir);
		hash.update(dir);
		hash.update(fp ?? 'missing');
	}

	// Include individual files by size + mtime
	for (const file of files) {
		try {
			const st = await fsp.stat(file);
			hash.update(file);
			hash.update(`${st.size}:${st.mtimeMs}`);
		} catch (err) {
			if (err?.code === 'ENOENT') {
				hash.update(file);
				hash.update('missing');
				continue;
			}
			throw err;
		}
	}

	return hash.digest('hex');
}

/**
 * Check if any build inputs have changed since last build.
 *
 * @param {string}   stateKey - Key in state.json (e.g. 'models-ui.buildHash').
 * @param {string[]} dirs     - Source directories to fingerprint.
 * @param {string[]} [files]  - Individual files to include.
 * @returns {Promise<{changed: boolean, hash: string}>}
 */
async function hasBuildInputChanged(stateKey, dirs, files = []) {
	const { getState } = require('./state');
	const currentHash = await buildInputHash(dirs, files);
	const savedHash = await getState(stateKey);
	return { changed: currentHash !== savedHash, hash: currentHash };
}

module.exports = {
	// Existence
	exists,
	isFile,
	isDirectory,

	// Reading
	readFile,
	readJson,
	readJsonSync,
	readDir,
	readDirSafe,

	// Writing
	writeFile,
	writeJson,
	writeFileEnsure,
	createWriteStream,

	// Directories
	mkdir,
	mkdirIfNotExists,

	// Copying
	copyFile,
	copyFileEnsure,
	retryTransientLock,
	copyDir,
	copyDirEnsure,

	// Comparing
	filesEqual,

	// Stats
	stat,
	statSafe,
	lstat,

	// Links
	symlink,
	readlink,

	// Deletion
	unlink,
	rm,
	rmdir,

	// Rename/Move
	rename,
	move,

	// Utilities
	realpath,
	truncate,
	utimes,
	touch,
	parseJson,

	// Fingerprinting
	fingerprint,
	contentHash,
	cachedContentHash,
	hasSourceChanged,
	saveSourceHash,
	buildInputHash,
	hasBuildInputChanged,
};
