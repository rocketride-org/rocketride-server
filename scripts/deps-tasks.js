/**
 * Dependencies Check
 * 
 * Checks package.json hashes and runs pnpm install if needed.
 * Called on builder startup - silent if no changes needed.
 */
const path = require('path');
const crypto = require('crypto');
const { 
    execCommand, getState, setState, PROJECT_ROOT,
    readDir, readFile
} = require('./lib');

// ============================================================================
// Package.json Hash Detection
// ============================================================================

async function findPackageJsonFiles(dir, files = []) {
    const entries = await readDir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        // Skip directories we don't care about
        if (entry.isDirectory()) {
            if (['node_modules', '.git', 'build', 'dist', 'vcpkg'].includes(entry.name)) {
                continue;
            }
            await findPackageJsonFiles(fullPath, files);
        } else if (entry.name === 'package.json') {
            files.push(fullPath);
        }
    }
    
    return files;
}

async function hashDependencies(filePath) {
    try {
        const content = await readFile(filePath);
        const pkg = JSON.parse(content);
        
        // Extract only dependency-related fields
        const depsToHash = {
            dependencies: pkg.dependencies || {},
            devDependencies: pkg.devDependencies || {},
            peerDependencies: pkg.peerDependencies || {},
            optionalDependencies: pkg.optionalDependencies || {}
        };
        
        // Create deterministic string
        const normalized = JSON.stringify(depsToHash);
        return crypto.createHash('md5').update(normalized).digest('hex');
    } catch {
        // If we can't parse, hash the whole file as fallback
        const content = await readFile(filePath, null);
        return crypto.createHash('md5').update(content).digest('hex');
    }
}

async function getPackageJsonHashes() {
    const files = await findPackageJsonFiles(PROJECT_ROOT);
    const hashes = {};
    
    for (const file of files) {
        const relativePath = path.relative(PROJECT_ROOT, file);
        hashes[relativePath] = await hashDependencies(file);
    }
    
    return hashes;
}

// ============================================================================
// Main Check Function
// ============================================================================

/**
 * Check dependencies and install if needed.
 * Silent if no changes, outputs only when installing.
 * @returns {Promise<boolean>} true if install was run, false if up to date
 */
async function checkDependencies() {
    const currentHashes = await getPackageJsonHashes();
    const storedHashes = await getState('packageJsonHashes') || {};
    
    // Check if any package.json has changed
    const changedFiles = [];
    
    // Check for changed or new files
    for (const [file, hash] of Object.entries(currentHashes)) {
        if (storedHashes[file] !== hash) {
            changedFiles.push(file);
        }
    }
    
    // Check for deleted files
    for (const file of Object.keys(storedHashes)) {
        if (!currentHashes[file]) {
            changedFiles.push(`${file} (deleted)`);
        }
    }
    
    // Silent return if no changes
    if (changedFiles.length === 0) {
        return false;
    }
    
    // Show what changed and install
    console.log(`Dependencies changed: ${changedFiles.slice(0, 3).join(', ')}${changedFiles.length > 3 ? ` (+${changedFiles.length - 3} more)` : ''}`);
    console.log('Installing dependencies...');
    
    await execCommand('pnpm', ['install'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
    
    // Update stored hashes after successful install
    await setState('packageJsonHashes', currentHashes);
    
    return true;
}

module.exports = { checkDependencies };
