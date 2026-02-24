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
 * Read a JSON file
 * @param {string} filePath - Path to JSON file
 * @returns {Promise<any>}
 */
async function readJson(filePath) {
    const content = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(content);
}

/**
 * Read a JSON file, returning default value if it doesn't exist
 * @param {string} filePath - Path to JSON file
 * @param {any} defaultValue - Value to return if file doesn't exist
 * @returns {Promise<any>}
 */
async function readJsonSafe(filePath, defaultValue = null) {
    try {
        const content = await fsp.readFile(filePath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        if (err.code === 'ENOENT') return defaultValue;
        throw err;
    }
}

/**
 * Read directory contents
 * @param {string} dirPath - Path to directory
 * @param {Object} [options] - Options
 * @param {boolean} [options.withFileTypes=false] - Return Dirent objects
 * @returns {Promise<string[]|fs.Dirent[]>}
 */
async function readDir(dirPath, options = {}) {
    return fsp.readdir(dirPath, options);
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

/**
 * Copy a file
 * @param {string} src - Source file path
 * @param {string} dest - Destination file path
 * @param {number} [mode] - Copy mode flags
 * @returns {Promise<void>}
 */
async function copyFile(src, dest, mode) {
    return fsp.copyFile(src, dest, mode);
}

/**
 * Copy a file, creating destination directory if needed
 * @param {string} src - Source file path
 * @param {string} dest - Destination file path
 * @returns {Promise<void>}
 */
async function copyFileEnsure(src, dest) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    return fsp.copyFile(src, dest);
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
// Permission Operations
// =============================================================================

/**
 * Change file/directory mode (permissions)
 * @param {string} filePath - Path to file or directory
 * @param {number|string} mode - New mode (e.g., 0o755 or '755')
 * @returns {Promise<void>}
 */
async function chmod(filePath, mode) {
    return fsp.chmod(filePath, mode);
}

/**
 * Change file/directory owner
 * @param {string} filePath - Path to file or directory
 * @param {number} uid - User ID
 * @param {number} gid - Group ID
 * @returns {Promise<void>}
 */
async function chown(filePath, uid, gid) {
    return fsp.chown(filePath, uid, gid);
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
// Utility Functions
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

// =============================================================================
// Fingerprinting (for build caching)
// =============================================================================

/**
 * Generate a fingerprint for a directory based on file sizes and modification times.
 * This is fast (no file content reads) and catches most changes.
 * 
 * @param {string} dirPath - Directory to fingerprint
 * @param {Object} [options] - Options
 * @param {string[]} [options.exclude] - Patterns to exclude (e.g., ['node_modules', '.git'])
 * @returns {Promise<string|null>} MD5 hash of the directory's fingerprint, or null if directory doesn't exist
 * 
 * @example
 * const hash = await fingerprint('src/');
 * if (hash !== savedHash) {
 *   // Source changed, need to rebuild
 * }
 */
async function fingerprint(dirPath, options = {}) {
    const { exclude = ['node_modules', '.git', '__pycache__', '.pyc'] } = options;
    const entries = [];
    
    // Check if directory exists
    try {
        await fsp.access(dirPath);
    } catch {
        return null;  // Directory doesn't exist
    }
    
    async function walk(dir, relativePath = '') {
        const items = await fsp.readdir(dir, { withFileTypes: true });
        
        for (const item of items) {
            // Skip excluded patterns
            if (exclude.some(pattern => item.name === pattern || item.name.endsWith(pattern))) {
                continue;
            }
            
            const fullPath = path.join(dir, item.name);
            const relPath = path.join(relativePath, item.name);
            
            if (item.isDirectory()) {
                await walk(fullPath, relPath);
            } else if (item.isFile()) {
                const stats = await fsp.stat(fullPath);
                // Use forward slashes for consistency across platforms
                entries.push(`${relPath.replace(/\\/g, '/')}:${stats.size}:${stats.mtimeMs}`);
            }
        }
    }
    
    await walk(dirPath);
    
    // Sort for consistent ordering
    entries.sort();
    
    // Hash the combined entries
    const content = entries.join('\n');
    return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Compute a SHA-256 content hash of all files in a directory tree.
 *
 * Uses the same exclusion patterns as fingerprint() but hashes actual
 * file contents rather than metadata, making it fully deterministic
 * across machines and git clones.
 *
 * @param {string} dirPath - Directory to hash
 * @param {Object} [options] - Options
 * @param {string[]} [options.exclude] - Patterns to exclude
 * @returns {Promise<string|null>} Hex hash string, or null if directory doesn't exist
 */
async function contentHash(dirPath, options = {}) {
    const { exclude = ['node_modules', '.git', '__pycache__', '.pyc'] } = options;
    const files = [];

    try {
        await fsp.access(dirPath);
    } catch {
        return null;
    }

    async function walk(dir, relativePath = '') {
        const items = await fsp.readdir(dir, { withFileTypes: true });

        for (const item of items) {
            if (exclude.some(pattern => item.name === pattern || item.name.endsWith(pattern))) {
                continue;
            }

            const fullPath = path.join(dir, item.name);
            const relPath = path.join(relativePath, item.name);

            if (item.isDirectory()) {
                await walk(fullPath, relPath);
            } else if (item.isFile()) {
                files.push({ rel: relPath.replace(/\\/g, '/'), full: fullPath });
            }
        }
    }

    await walk(dirPath);
    files.sort((a, b) => a.rel.localeCompare(b.rel));

    const hash = crypto.createHash('sha256');
    for (const f of files) {
        hash.update(f.rel);
        hash.update(await fsp.readFile(f.full));
    }
    return hash.digest('hex');
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
        hash: currentHash
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
    if (hash === null) return;  // Don't save if directory didn't exist
    const { setState } = require('./state');
    await setState(stateKey, hash);
}

module.exports = {
    // Existence
    exists,
    isFile,
    isDirectory,
    
    // Reading
    readFile,
    readJson,
    readJsonSafe,
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
    copyDir,
    copyDirEnsure,
    
    // Stats
    stat,
    statSafe,
    lstat,
    
    // Permissions
    chmod,
    chown,
    
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
    
    // Fingerprinting
    fingerprint,
    contentHash,
    hasSourceChanged,
    saveSourceHash
};

