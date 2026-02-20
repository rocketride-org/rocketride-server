/**
 * Incremental Directory Sync Utility
 * 
 * Provides smart directory synchronization that only copies changed files.
 */
const path = require('path');
const { mkdir, readDir, stat, copyFile, rm, unlink } = require('./fs');

/**
 * Incrementally sync source to destination directory (MIRROR mode)
 * - Only copies files that are new or modified (based on mtime + size)
 * - Removes files in dest that don't exist in source
 * - Skips specified directories (default: __pycache__)
 * 
 * Use this when you want dest to be an exact mirror of source.
 * 
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @param {Object} options - Options
 * @param {string[]} options.skipDirs - Directory names to skip (default: ['__pycache__'])
 * @param {Object} stats - Internal stats object (don't pass externally)
 * @returns {Promise<{ added: number, updated: number, deleted: number, unchanged: number }>}
 */
async function syncDir(src, dest, options = {}, stats = { added: 0, updated: 0, deleted: 0, unchanged: 0 }) {
    const skipDirs = options.skipDirs || ['__pycache__'];
    
    await mkdir(dest);
    
    // Get source entries
    const srcEntries = new Map();
    try {
        const entries = await readDir(src, { withFileTypes: true });
        for (const entry of entries) {
            if (skipDirs.includes(entry.name)) continue;
            srcEntries.set(entry.name, entry);
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    
    // Get dest entries
    const destEntries = new Map();
    try {
        const entries = await readDir(dest, { withFileTypes: true });
        for (const entry of entries) {
            destEntries.set(entry.name, entry);
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    
    // Process source entries - copy new/modified
    for (const [name, srcEntry] of srcEntries) {
        const srcPath = path.join(src, name);
        const destPath = path.join(dest, name);
        
        if (srcEntry.isDirectory()) {
            await syncDir(srcPath, destPath, options, stats);
        } else {
            let needsCopy = true;
            let isNew = !destEntries.has(name);
            
            if (destEntries.has(name)) {
                const destEntry = destEntries.get(name);
                if (!destEntry.isDirectory()) {
                    // Compare mtime and size
                    const srcStat = await stat(srcPath);
                    const destStat = await stat(destPath);
                    
                    if (srcStat.size === destStat.size && 
                        srcStat.mtimeMs <= destStat.mtimeMs) {
                        needsCopy = false;
                        stats.unchanged++;
                    }
                }
            }
            
            if (needsCopy) {
                await copyFile(srcPath, destPath);
                if (isNew) {
                    stats.added++;
                } else {
                    stats.updated++;
                }
            }
        }
    }
    
    // Remove dest entries that don't exist in source
    for (const [name, destEntry] of destEntries) {
        if (!srcEntries.has(name)) {
            const destPath = path.join(dest, name);
            if (destEntry.isDirectory()) {
                await rm(destPath, { recursive: true, force: true });
            } else {
                await unlink(destPath);
            }
            stats.deleted++;
        }
    }
    
    return stats;
}

/**
 * Overlay directory - copy only new/changed files (OVERLAY mode)
 * - Creates directories in dest if they don't exist
 * - Copies files that are new or modified (based on mtime + size)
 * - NEVER removes files or directories from dest
 * - Skips specified directories (default: __pycache__)
 * 
 * Use this when you want to overlay source onto dest without removing anything.
 * 
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @param {Object} options - Options
 * @param {string[]} options.skipDirs - Directory names to skip (default: ['__pycache__'])
 * @param {Object} stats - Internal stats object (don't pass externally)
 * @returns {Promise<{ added: number, updated: number, unchanged: number }>}
 */
async function overlayDir(src, dest, options = {}, stats = { added: 0, updated: 0, unchanged: 0 }) {
    const skipDirs = options.skipDirs || ['__pycache__'];
    
    // Ensure destination directory exists
    await mkdir(dest);
    
    // Get source entries
    let srcEntries = [];
    try {
        srcEntries = await readDir(src, { withFileTypes: true });
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return stats;  // Source doesn't exist, nothing to copy
    }
    
    // Process each source entry
    for (const entry of srcEntries) {
        if (skipDirs.includes(entry.name)) continue;
        
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        
        if (entry.isDirectory()) {
            await overlayDir(srcPath, destPath, options, stats);
        } else {
            let needsCopy = true;
            let isNew = true;
            
            try {
                const srcStat = await stat(srcPath);
                const destStat = await stat(destPath);
                isNew = false;
                
                // Only skip copy if dest has same size and is same age or newer
                if (srcStat.size === destStat.size && srcStat.mtimeMs <= destStat.mtimeMs) {
                    needsCopy = false;
                    stats.unchanged++;
                }
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
                // Dest file doesn't exist, need to copy
            }
            
            if (needsCopy) {
                await copyFile(srcPath, destPath);
                if (isNew) {
                    stats.added++;
                } else {
                    stats.updated++;
                }
            }
        }
    }
    
    return stats;
}

/**
 * Format sync/copy stats for display
 * @param {{ added: number, updated: number, deleted?: number, unchanged: number }} stats
 * @returns {string}
 */
function formatSyncStats(stats) {
    const changed = (stats.added || 0) + (stats.updated || 0) + (stats.deleted || 0);
    if (changed === 0) {
        return `No changes (${stats.unchanged || 0} files up to date)`;
    }
    
    const parts = [];
    if (stats.added > 0) parts.push(`+${stats.added} added`);
    if (stats.updated > 0) parts.push(`~${stats.updated} updated`);
    if (stats.deleted > 0) parts.push(`-${stats.deleted} deleted`);
    if (stats.unchanged > 0) parts.push(`${stats.unchanged} unchanged`);
    return parts.join(', ');
}

module.exports = {
    syncDir,
    overlayDir,
    formatSyncStats
};
