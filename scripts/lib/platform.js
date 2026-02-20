/**
 * Shared Platform Utilities
 * 
 * Helper functions for platform detection.
 */
const os = require('os');

/**
 * Get platform information for downloads and builds
 * 
 * @returns {{os: string, arch: string, ext: string}}
 */
function getPlatform() {
    const platform = os.platform();
    const arch = os.arch();
    
    if (platform === 'win32') {
        return { os: 'windows', arch: 'x64', ext: 'zip' };
    }
    if (platform === 'darwin') {
        return { os: 'mac', arch: arch === 'arm64' ? 'aarch64' : 'x64', ext: 'tar.gz' };
    }
    if (platform === 'linux') {
        return { os: 'linux', arch: 'x64', ext: 'tar.gz' };
    }
    
    throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Check if running on Windows
 * @returns {boolean}
 */
function isWindows() {
    return os.platform() === 'win32';
}

/**
 * Check if running on macOS
 * @returns {boolean}
 */
function isMac() {
    return os.platform() === 'darwin';
}

/**
 * Check if running on Linux
 * @returns {boolean}
 */
function isLinux() {
    return os.platform() === 'linux';
}

module.exports = {
    getPlatform,
    isWindows,
    isMac,
    isLinux
};

