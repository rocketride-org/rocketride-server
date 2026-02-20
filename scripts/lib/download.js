/**
 * Shared Download Utilities
 * 
 * Downloads are cached in the `downloads/` directory at project root.
 * This directory persists across `builder clean` commands.
 * 
 * Usage:
 *   const archivePath = await downloadFile(url, 'jdk-17.zip', task);
 *   await extractArchive(archivePath, destDir, { stripLevels: 1 });
 */
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');
const tar = require('tar');
const { exists, rm, mkdir, unlink, isFile, isDirectory, createWriteStream, writeFile } = require('./fs');
const { getState, setState } = require('./state');

// Persistent downloads directory (survives clean)
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DOWNLOADS_DIR = path.join(PROJECT_ROOT, 'downloads');

/**
 * Download a file (with caching)
 * 
 * Checks state.json downloads[filename] - if true, returns cached path.
 * Otherwise downloads the file, marks it in state, and returns path.
 * 
 * @param {string} url - URL to download from
 * @param {string} filename - Filename to save as (used as cache key)
 * @param {Object} task - Optional Listr2 task for progress output
 * @returns {Promise<string>} Full path to the downloaded file
 */
async function downloadFile(url, filename, task) {
    const destPath = path.join(DOWNLOADS_DIR, filename);
    // Escape dots in filename to prevent state key path issues (e.g., "maven-3.9.6.tar.gz" → "maven-3_9_6_tar_gz")
    const safeFilename = filename.replace(/\./g, '_');
    const stateKey = `downloads.${safeFilename}`;
    
    // Check if already downloaded (atomic read)
    if (await getState(stateKey) === true && await exists(destPath)) {
        return destPath;
    }
    
    // Ensure downloads directory exists
    await mkdir(DOWNLOADS_DIR);
    
    // Download the file
    await _download(url, destPath, task);
    
    // Mark as downloaded (atomic write)
    await setState(stateKey, true);
    
    return destPath;
}

/**
 * Internal: Perform the actual HTTP download
 */
async function _download(url, destPath, task) {
    const makeRequest = (currentUrl) => {
        return new Promise((resolve, reject) => {
            const protocol = currentUrl.startsWith('https') ? https : require('http');
            const req = protocol.get(currentUrl, { headers: { 'User-Agent': 'aparavi-build' } }, resolve);
            req.on('error', reject);
        });
    };
    
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    // Retry settings for 503/504 errors
    const MAX_RETRIES = 15;
    const RETRY_DELAY_MS = 1000;
    
    let response;
    let lastError;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // Follow redirects (up to 5)
        let currentUrl = url;
        for (let i = 0; i <= 5; i++) {
            response = await makeRequest(currentUrl);
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                // Destroy redirect response to close socket
                response.destroy();
                currentUrl = response.headers.location;
                continue;
            }
            break;
        }
        
        if (response.statusCode >= 300 && response.statusCode < 400) {
            response.destroy();
            throw new Error('Too many redirects');
        }
        
        // Retry on 503 (Service Unavailable) or 504 (Gateway Timeout)
        if (response.statusCode === 503 || response.statusCode === 504) {
            response.destroy();
            lastError = `HTTP ${response.statusCode}`;
            if (task) {
                task.output = `Server error (${response.statusCode}), retrying in 1s... (${attempt}/${MAX_RETRIES})`;
            }
            await sleep(RETRY_DELAY_MS);
            continue;
        }
        
        if (response.statusCode !== 200) {
            response.destroy();
            throw new Error(`Download failed: HTTP ${response.statusCode}`);
        }
        
        // Success - break out of retry loop
        break;
    }
    
    // If we exhausted retries
    if (response.statusCode === 503 || response.statusCode === 504) {
        throw new Error(`Download failed after ${MAX_RETRIES} retries: ${lastError}`);
    }
    
    // Download with progress
    const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
    let downloadedBytes = 0;
    let lastPercent = -1;  // Track last reported percentage to avoid duplicate updates
    const file = createWriteStream(destPath);
    
    try {
        await new Promise((resolve, reject) => {
            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (task && totalBytes) {
                    const percent = Math.round((downloadedBytes / totalBytes) * 100);
                    // Only update when percentage changes
                    if (percent !== lastPercent) {
                        lastPercent = percent;
                        const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
                        task.output = `Downloading: ${percent}% (${mb} MB)`;
                    }
                }
            });
            
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                // Destroy the response stream to close the underlying socket
                response.destroy();
                resolve();
            });
            file.on('error', (err) => {
                response.destroy();
                reject(err);
            });
            response.on('error', (err) => {
                response.destroy();
                reject(err);
            });
        });
    } catch (err) {
        file.close();
        response.destroy();
        await unlink(destPath);
        throw err;
    }
}

async function createArchive(archivePath, cwd, files) {
    if (archivePath.endsWith('.tar.gz')) {
        await tar.create({file: archivePath, cwd: cwd, gzip: true}, files);
    } else if (archivePath.endsWith('.zip')) {
        const zip = new AdmZip();
        for (const file of files) {
            const filepath = path.join(cwd, file);
            if (await isFile(filepath)) {
                zip.addLocalFile(filepath, '', file);
            } else if (await isDirectory(filepath)) {
                zip.addLocalFolder(filepath, file);
            } else {
                throw new Error(`File or directory not found: ${filepath}`);
            }
        }
        zip.writeZip(archivePath);
    } else {
        throw new Error(`Unsupported archive format: ${path.basename(archivePath)}`);
    }
}

/**
 * Extract an archive (zip or tar.gz) to a destination directory
 * 
 * @param {string} archivePath - Path to archive file
 * @param {string} destDir - Destination directory
 * @param {Object} options - Options
 * @param {number} options.stripLevels - Number of leading path components to strip
 */
async function extractArchive(archivePath, destDir, options = {}) {
    const { stripLevels = 0, resetDestDir = false } = options;
    
    // Remove dest if exists
    if (resetDestDir && await exists(destDir)) {
        await rm(destDir);
    }
    await mkdir(destDir);
    
    if (archivePath.endsWith('.zip')) {
        const zip = new AdmZip(archivePath);
        
        if (stripLevels > 0) {
            // Extract each entry with path stripping (no temp directory)
            const entries = zip.getEntries();
            for (const entry of entries) {
                // Split path and strip leading components
                const parts = entry.entryName.split('/').filter(p => p);
                if (parts.length <= stripLevels) continue; // Skip entries that would be stripped entirely
                
                const strippedPath = parts.slice(stripLevels).join('/');
                const targetPath = path.join(destDir, strippedPath);
                
                if (entry.isDirectory) {
                    await mkdir(targetPath);
                } else {
                    // Ensure parent directory exists
                    await mkdir(path.dirname(targetPath));
                    // Extract file content
                    const content = entry.getData();
                    await writeFile(targetPath, content);
                }
            }
        } else {
            // Extract directly
            zip.extractAllTo(destDir, true);
        }
    } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
        await mkdir(destDir);
        await tar.extract({
            file: archivePath,
            cwd: destDir,
            strip: stripLevels
        });
    } else {
        throw new Error(`Unknown archive format: ${archivePath}`);
    }
}

module.exports = {
    DOWNLOADS_DIR,
    downloadFile,
    createArchive,
    extractArchive
};
