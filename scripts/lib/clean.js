/**
 * Shared Clean Utilities
 * 
 * Helper functions for cleaning build artifacts.
 * All functions are async.
 */
const path = require('path');
const { rm, rmdir, unlink, readDir, stat } = require('./fs');

// Mutex for directory removal - prevents concurrent removes on overlapping paths
const removeLocks = new Map();  // normalizedPath -> Promise

/**
 * Acquire a lock for a directory path (waits if parent/child is being removed)
 */
async function acquireRemoveLock(dirPath) {
    const normalized = path.normalize(dirPath).toLowerCase();
    
    // Wait for any overlapping paths to finish
    for (const [lockedPath, promise] of removeLocks.entries()) {
        if (normalized.startsWith(lockedPath) || lockedPath.startsWith(normalized)) {
            await promise;
        }
    }
    
    // Create our lock
    let resolve;
    const lockPromise = new Promise(r => { resolve = r; });
    removeLocks.set(normalized, lockPromise);
    
    return () => {
        removeLocks.delete(normalized);
        resolve();
    };
}

/**
 * Remove a directory if it exists
 * @param {string} dirPath - Path to directory
 * @param {Object} options - Options
 * @param {boolean} options.recursive - Remove recursively (default: true)
 * @returns {Promise<boolean>}
 */
async function removeDir(dirPath, options = {}) {
    const { recursive = true, ignoreErrors = false } = options;
    
    const unlock = await acquireRemoveLock(dirPath);
    try {
        await rm(dirPath, { recursive, force: true });
        return true;
    } catch (err) {
        if (err.code === 'ENOENT') return false;
        if (err.code === 'EPERM' || err.code === 'EBUSY') {
            // Windows: file/folder is locked by another process
            if (ignoreErrors) return false;
            console.warn(`Warning: Cannot remove ${dirPath} (${err.code}) - file may be in use`);
            return false;
        }
        throw err;
    } finally {
        unlock();
    }
}

/**
 * Remove multiple directories
 * @param {string[]} dirPaths - Array of directory paths
 * @param {Object} options - Options passed to removeDir
 * @returns {Promise<number>} Number of directories removed
 */
async function removeDirs(dirPaths, options = {}) {
    let removed = 0;
    for (const dirPath of dirPaths) {
        if (await removeDir(dirPath, options)) removed++;
    }
    return removed;
}

/**
 * Remove a file if it exists
 * @param {string} filePath - Path to file
 * @returns {Promise<boolean>} true if removed, false if file did not exist
 */
async function removeFile(filePath) {
    try {
        await unlink(filePath);
        return true;
    } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
    }
}

/**
 * Remove multiple files from a base path
 * @param {string} basePath - Base directory path
 * @param {string[]} files - Array of file names
 * @returns {Promise<number>} Number of files removed
 */
async function removeFiles(basePath, files) {
    let removed = 0;
    for (const file of files) {
        if (await removeFile(path.join(basePath, file))) removed++;
    }
    return removed;
}

/**
 * Remove files/directories matching a pattern in a directory
 * @param {string} dirPath - Directory to search in
 * @param {string|RegExp|Function} pattern - Pattern to match (string suffix, regex, or predicate function)
 * @param {Object} options - Options
 * @param {boolean} options.recursive - Also remove directories (default: true)
 * @returns {Promise<number>} Number of items removed
 */
async function removeMatching(dirPath, pattern, options = {}) {
    const { recursive = true } = options;
    
    let entries;
    try {
        entries = await readDir(dirPath, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') return 0;
        throw err;
    }
    
    let removed = 0;
    
    for (const entry of entries) {
        let matches = false;
        
        if (typeof pattern === 'string') {
            matches = entry.name.endsWith(pattern);
        } else if (pattern instanceof RegExp) {
            matches = pattern.test(entry.name);
        } else if (typeof pattern === 'function') {
            matches = pattern(entry.name);
        }
        
        if (matches) {
            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                if (recursive) {
                    await rm(fullPath, { recursive: true, force: true });
                    removed++;
                }
            } else {
                await unlink(fullPath);
                removed++;
            }
        }
    }
    
    return removed;
}

/**
 * Remove items (files or directories) - auto-detects type
 * @param {string} itemPath - Path to file or directory
 * @returns {Promise<boolean>}
 */
async function remove(itemPath) {
    try {
        const itemStat = await stat(itemPath);
        if (itemStat.isDirectory()) {
            await rm(itemPath, { recursive: true, force: true });
        } else {
            await unlink(itemPath);
        }
        return true;
    } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
    }
}

/**
 * Remove multiple items (files or directories)
 * @param {string[]} paths - Array of paths
 * @returns {Promise<number>} Number of items removed
 */
async function removeAll(paths) {
    let removed = 0;
    for (const p of paths) {
        if (await remove(p)) removed++;
    }
    return removed;
}

/**
 * Remove directories and clean up empty parent directories up to (but not including) basePath
 * @param {string} basePath - Base path that will NEVER be removed (e.g., PROJECT_ROOT)
 * @param {string|string[]} dirPaths - Directory path(s) to remove
 * @returns {Promise<number>} Number of directories removed
 */
async function removeDirAndParents(basePath, dirPaths) {
    const paths = Array.isArray(dirPaths) ? dirPaths : [dirPaths];
    let removed = 0;
    
    for (const dirPath of paths) {
        if (!await removeDir(dirPath)) continue;
        removed++;
        
        // Clean up empty parents up to (but not including) basePath
        let parent = path.dirname(dirPath);
        while (parent && parent !== basePath && parent.length > basePath.length && parent.startsWith(basePath)) {
            let entries;
            try {
                entries = await readDir(parent);
            } catch {
                break;
            }
            
            if (entries.length === 0) {
                try {
                    await rmdir(parent);
                } catch (err) {
                    if (err.code !== 'ENOENT') throw err;
                }
                parent = path.dirname(parent);
            } else {
                break;
            }
        }
    }
    return removed;
}

/**
 * Clean a directory but keep it (remove all contents)
 * @param {string} dirPath - Directory to clean
 * @returns {Promise<boolean>}
 */
async function cleanDir(dirPath) {
    let entries;
    try {
        entries = await readDir(dirPath, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
    }
    
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
            await rm(fullPath, { recursive: true, force: true });
        } else {
            await unlink(fullPath);
        }
    }
    return true;
}

module.exports = {
    removeDir,
    removeDirs,
    removeFile,
    removeFiles,
    removeMatching,
    remove,
    removeAll,
    removeDirAndParents,
    cleanDir
};
