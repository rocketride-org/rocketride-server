/**
 * Incremental Directory Sync Utility
 * 
 * Provides smart directory synchronization that only copies changed files.
 */
const path = require('path');
const { exists, stat, copyFileEnsure, unlink } = require('./fs');
const { setState, } = require('./state');
const { DIST_ROOT } = require('./paths');
const SERVER_DIR = path.join(DIST_ROOT, 'server');

/**
 * Incrementally sync source to destination directory (MIRROR or OVERLAY mode)
 * - Only copies files that are new or modified (based on mtime + size)
 * - Removes files in dest that don't exist in source in MIRROR mode (default)
 * - Ignores files and directories by specified patterns (default: '\*\*\/\_\_pycache\_\_\/\*\*')
 * 
 * Use this when you want dest to be an exact mirror of source.
 * 
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 * @param {Object} options - Options
 * @param {string[]} options.pattern - Glob pattern to match files (default: '**')
 * @param {string[]} options.ignore - Glob patterns to ignore (default: '\*\*\/\_\_pycache\_\_\/\*\*')
 * @param {boolean} options.mirror - Remove files in dest that don't exist in source (default)
 * @param {boolean} options.package - Package the files for the server artifact
 * @param {Object} stats - Shared stats object with number of changed (added, updated, deleted) and unchanged files
 * @returns {Promise<{ added: number, updated: number, deleted: number, changed: number, unchanged: number }>}
 */
async function syncDir(src, dest, options = {}, stats = { added: 0, updated: 0, deleted: 0, changed: 0, unchanged: 0 }) {
    const { glob } = require('glob');
    
    // Check source dir
    if (!(await stat(src)).isDirectory()) {
        throw new Error(`Source path ${src} is not a directory`);
    }

    // Check dest dir
    if (await exists(dest) && !(await stat(dest)).isDirectory()) {
        throw new Error(`Destination path ${dest} is not a directory`);
    }

    // Default stats
    stats.added = stats.added || 0;
    stats.updated = stats.updated || 0;
    stats.deleted = stats.deleted || 0;
    stats.changed = stats.changed || 0;
    stats.unchanged = stats.unchanged || 0;

    const pattern = options.pattern || '**';
    const ignore = options.ignore || ['**/__pycache__/**'];

    let changed = false;

    // Get source files
    const srcFiles = new Set(await glob(pattern, { cwd: src, nodir: true, ignore: ignore }));

    // Get dest files
    const destFiles = new Set(await glob(pattern, { cwd: dest, nodir: true, ignore: ignore }));

    // Process source files - copy new/modified
    for (const name of srcFiles) {
        const srcPath = path.join(src, name);
        const destPath = path.join(dest, name);

        if (destFiles.has(name)) {
            const srcStat = await stat(srcPath);
            const destStat = await stat(destPath);

            if (srcStat.size === destStat.size && srcStat.mtimeMs <= destStat.mtimeMs) {
                stats.unchanged++;
            } else {
                await copyFileEnsure(srcPath, destPath);
                ++stats.updated, ++stats.changed, (changed = true);
            }

            destFiles.delete(name);

        } else {
            await copyFileEnsure(srcPath, destPath);
            ++stats.added, ++stats.changed, (changed = true);
        }
    }

    // Remove dest files that don't exist in source
    if (options.mirror === undefined || options.mirror) {
        for (const name of destFiles) {
            const destPath = path.join(dest, name);
            await unlink(destPath);
            ++stats.deleted, ++stats.changed, changed = true;
        }
    }

    // Update list of dest files from this source for packaging
    if (options.package && changed) {
        const relPaths = Array.from(srcFiles, (name) => {
            const destPath = path.join(dest, name);
            const relPath = path.relative(SERVER_DIR, destPath);
            if (relPath.startsWith('..')) {
                throw new Error(`Destination path ${destPath} is not a subdirectory of ${SERVER_DIR}`);
            }
            return relPath;
        });
        await setState(['package', src], relPaths);
    }

    return stats;
}

async function syncFile(src, dest, options = {}, stats = { added: 0, updated: 0, deleted: 0, changed: 0, unchanged: 0 }) {
    // Check source file
    const srcStat = await stat(src);
    if (!srcStat.isFile()) {
        throw new Error(`Source path ${src} is not a file`);
    }

    // Check destination file
    const destStat = await exists(dest) ? await stat(dest) : null;
    if (destStat && !destStat.isFile()) {
        throw new Error(`Destination path ${dest} is not a file`);
    }

    // Default stats
    stats.added = stats.added || 0;
    stats.updated = stats.updated || 0;
    stats.deleted = stats.deleted || 0;
    stats.changed = stats.changed || 0;
    stats.unchanged = stats.unchanged || 0;

    let changed = false;

    // Process source file - copy new/modified
    if (destStat) {
        if (srcStat.size === destStat.size && srcStat.mtimeMs <= destStat.mtimeMs) {
            stats.unchanged++;
        } else {
            await copyFileEnsure(src, dest);
            ++stats.updated, ++stats.changed, (changed = true);
        }
    } else {
        await copyFileEnsure(src, dest);
        ++stats.added, ++stats.changed, (changed = true);
    }

    // Update list of dest files from this source for packaging
    if (options.package && changed) {
        const relPath = path.relative(SERVER_DIR, dest);
        if (relPath.startsWith('..')) {
            throw new Error(`Destination path ${dest} is not a subdirectory of ${SERVER_DIR}`);
        }
        await setState(['package', src], [ relPath ]);
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
    syncFile,
    formatSyncStats
};
