// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Server Build Module
 * 
 * Handles downloading pre-built server binaries or compiling from source.
 */
const path = require('path');
const os = require('os');
const {
    getState, setState, updateState,
    removeDirs, resetDir, syncDir, removeFiles,
    overlayDir, formatSyncStats,
    execCommand, PROJECT_ROOT, BUILD_DIR, isWindows, isMac, isLinux,
    exists, readFile, readJson, readDir, mkdir, copyFile, removeFile, chmod,
    downloadFile, createArchive, extractArchive,
    parallel, whenNot, fingerprint, contentHash,
    taskDebug,
    DOWNLOADS_DIR,
    STATE_FILE
} = require('../../../scripts/lib');
const { runCompilerSetup } = require('../../../scripts/compiler');

// Paths
const PACKAGES_DIR = path.join(PROJECT_ROOT, 'packages');
const SERVER_DIR = path.join(PACKAGES_DIR, 'server');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist', 'server');
const VCPKG_DIR = path.join(BUILD_DIR, 'vcpkg');
const BUILD_ARTIFACTS_DIR = path.join(BUILD_DIR, 'artifacts');
const DIST_ARTIFACTS_DIR = path.join(PROJECT_ROOT, 'dist', 'artifacts');

// Get package info (loaded async)
let VERSION = '0.0.0';
let REPO = 'rocketride/rocketride-engine';
let packageJsonLoaded = false;

async function loadPackageJson() {
    if (!packageJsonLoaded) {
        const packageJson = await readJson(path.join(PROJECT_ROOT, 'package.json'));
        VERSION = packageJson.version;
        REPO = packageJson.repository?.url?.match(/github\.com[/:](.+?)(?:\.git)?$/)?.[1] || 'rocketride/rocketride-engine';
        packageJsonLoaded = true;
    }
    return { version: VERSION, repo: REPO };
}

// =============================================================================
// Platform Detection
// =============================================================================

function getPlatformInfo(options = {}) {
    const platform = os.platform();
    const arch = options.arch || os.arch();

    if (platform === 'win32') {
        return { name: 'win64', os: 'windows', ext: 'zip' };
    } else if (platform === 'darwin') {
        const darwinArch = arch === 'arm64' ? 'arm64' : 'x64';
        return {
            name: `darwin-${darwinArch}`,
            os: 'darwin',
            arch: darwinArch,
            ext: 'tar.gz'
        };
    } else if (platform === 'linux') {
        return { name: 'linux-x64', os: 'linux', ext: 'tar.gz' };
    }
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

async function getDistInfo(options = {}) {
    const { version, repo } = await loadPackageJson();
    const platform = getPlatformInfo(options);
    const releaseTag = `server-v${version}`;
    const baseName = `rocketride-${releaseTag}-${platform.name}`;
    const distFilename = `${baseName}.${platform.ext}`;
    const symDistFilename = isWindows() ? `${baseName}.symbols.${platform.ext}` : null;
    const releaseUrl = `https://github.com/${repo}/releases/download/${releaseTag}`;

    return {
        baseName: baseName,
        repo: repo,
        releaseTag: releaseTag,
        distFilename: distFilename,
        symDistFilename: symDistFilename,
        releaseUrl: releaseUrl,
        distUrl: `${releaseUrl}/${distFilename}`,
        symDistUrl: symDistFilename ? `${releaseUrl}/${symDistFilename}` : null
    };
}

// =============================================================================
// State Management
// =============================================================================

async function isConfigured() {
    const configured = await getState('server.configured');
    if (configured !== true) return false;
    
    // Check CMakeCache.txt exists
    const cmakeCache = path.join(BUILD_DIR, 'CMakeCache.txt');
    if (!await exists(cmakeCache)) return false;
    
    // Check vcpkg packages are installed
    const triplet = getVcpkgTriplet();
    const vcpkgInstalled = path.join(VCPKG_DIR, 'installed', triplet);
    if (!await exists(vcpkgInstalled)) return false;
    
    return true;
}

// Static copy helpers removed - now using existence checks instead of state

async function updateServerState(updates) {
    const stateUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
        stateUpdates[`server.${key}`] = value;
    }
    await updateState(stateUpdates);
}

// =============================================================================
// VS Environment (Windows) – from state (populated by scripts/compiler-windows.js)
// =============================================================================

let windowsToolchainCache = null;
let vsEnvCache = null;

async function getWindowsToolchain() {
    if (windowsToolchainCache) return windowsToolchainCache;
    const vsRoot = await getState('build.vsPath');
    if (!vsRoot || !(await exists(vsRoot))) {
        throw new Error('Visual Studio build path not set. Run server:setup-tools first (e.g. pnpm run builder server:setup-tools --autoinstall).');
    }
    const ninjaPath = path.join(vsRoot, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'Ninja', 'ninja.exe');
    const ninjaExists = await exists(ninjaPath);
    const generatorName = (await getState('build.generatorName')) || 'Visual Studio 17 2022';
    windowsToolchainCache = { vsRoot, ninjaPath: ninjaExists ? ninjaPath : null, generatorName };
    return windowsToolchainCache;
}

async function getVsEnvironment() {
    if (vsEnvCache) return vsEnvCache;
    if (!isWindows()) return process.env;
    const buildEnv = await getState('build.env');
    if (!buildEnv || typeof buildEnv !== 'object' || Object.keys(buildEnv).length === 0) {
        throw new Error('Visual Studio environment not in state. Run server:setup-tools first (e.g. pnpm run builder server:setup-tools --autoinstall).');
    }
    vsEnvCache = { ...process.env, ...buildEnv };
    return vsEnvCache;
}

// =============================================================================
// Helpers
// =============================================================================

function getPythonLibDest(options = {}) {
    const destDir = options.destDir || DIST_DIR;
    const platform = os.platform();
    if (platform === 'win32') {
        return path.join(destDir, 'lib');
    } else {
        return path.join(destDir, 'lib', 'python3.10');
    }
}

function getVcpkgTriplet(options = {}) {
    const platform = os.platform();
    const arch = options.arch || os.arch();

    if (platform === 'win32') return 'x64-windows-vc-rocketride';
    if (platform === 'darwin') return arch === 'arm64' ? 'arm64-osx-appleclang-rocketride' : 'x64-osx-appleclang-rocketride';
    return 'x64-linux-clang-rocketride';
}

function getParallelJobs() {
    return os.cpus().length || 4;
}

async function detectGenerator() {
    if (isWindows()) {
        try {
            await getWindowsToolchain();
            return ['-G', 'Ninja'];
        } catch {
            return [];
        }
    }
    const pathEnv = process.env.PATH || '';
    const name = 'ninja';
    for (const dir of pathEnv.split(':')) {
        if (await exists(path.join(dir.trim(), name))) return ['-G', 'Ninja'];
    }
    return ['-G', 'Unix Makefiles'];
}

/** If CMakeCache.txt exists, return generator args that match the existing config (avoids generator mismatch). Never use cache for Ninja. */
async function getCachedGeneratorArgs(buildDir) {
    const cachePath = path.join(buildDir, 'CMakeCache.txt');
    if (!await exists(cachePath)) return null;
    try {
        const content = await readFile(cachePath, 'utf8');
        let generator = null;
        let generatorPlatform = null;
        for (const line of content.split('\n')) {
            const genMatch = /^CMAKE_GENERATOR:INTERNAL=(.+)$/.exec(line.trim());
            if (genMatch) generator = genMatch[1].trim();
            const platformMatch = /^CMAKE_GENERATOR_PLATFORM:INTERNAL=(.+)$/.exec(line.trim());
            if (platformMatch) generatorPlatform = platformMatch[1].trim();
        }
        if (!generator) return null;
        if (/^Ninja$/i.test(generator)) return null;
        if (/^Visual Studio\s+\d+\s+\d{4}$/.test(generator) && (!generatorPlatform || generatorPlatform === '')) {
            return null;
        }
        const args = ['-G', generator];
        if (/^Visual Studio\s+\d+\s+\d{4}$/.test(generator)) {
            args.push('-A', generatorPlatform || 'x64');
        }
        return args;
    } catch {
        return null;
    }
}

// =============================================================================
// Static Copy Helpers
// =============================================================================

async function copySambaLibs(options = {}) {
    if (!isMac()) return { copied: false, reason: 'Not macOS' };

    const destDir = options.destDir || DIST_DIR;
    const triplet = getVcpkgTriplet(options);
    const sambaSrc = path.join(VCPKG_DIR, 'installed', triplet, 'samba');

    if (!await exists(sambaSrc)) {
        return { copied: false, reason: 'Samba not found in vcpkg' };
    }

    const sambaDest = path.join(destDir, 'samba');
    await mkdir(sambaDest);
    const stats = await overlayDir(sambaSrc, sambaDest);
    return { copied: true, stats };
}

async function copyJavaJre(options = {}) {
    const destDir = options.destDir || DIST_DIR;
    const jreSrc = path.join(BUILD_DIR, 'java', 'jre');
    const jreDest = path.join(destDir, 'java', 'jre');

    if (!await exists(jreSrc)) {
        return { copied: false, reason: 'JRE not found (run java setup first)' };
    }

    await mkdir(path.dirname(jreDest));
    const stats = await overlayDir(jreSrc, jreDest);

    return { copied: true, stats };
}

async function copyPythonEnv(options = {}) {
    const destDir = options.destDir || DIST_DIR;
    const triplet = getVcpkgTriplet(options);
    const vcpkgInstalled = path.join(VCPKG_DIR, 'installed', triplet);

    if (!await exists(vcpkgInstalled)) {
        return { copied: false, reason: 'vcpkg not installed' };
    }

    const platform = os.platform();
    const pythonLibDest = getPythonLibDest(options);

    let pythonLibSrc;
    if (platform === 'win32') {
        pythonLibSrc = path.join(vcpkgInstalled, 'tools', 'python3', 'lib');
    } else {
        pythonLibSrc = path.join(vcpkgInstalled, 'lib', 'python3.10');
    }

    let totalStats = { added: 0, updated: 0, unchanged: 0, removed: 0 };

    if (await exists(pythonLibSrc)) {
        await mkdir(pythonLibDest);
        const stats = await overlayDir(pythonLibSrc, pythonLibDest);
        totalStats.added += stats.added || 0;
        totalStats.updated += stats.updated || 0;
        totalStats.unchanged += stats.unchanged || 0;
    }

    const includeDir = path.join(vcpkgInstalled, 'include');
    if (await exists(includeDir)) {
        const pythonIncludes = (await readDir(includeDir)).filter(d => d.startsWith('python'));
        for (const pyInclude of pythonIncludes) {
            const src = path.join(includeDir, pyInclude);
            let dest;
            if (platform === 'darwin') {
                dest = path.join(destDir, 'include', pyInclude);
            } else {
                dest = path.join(destDir, 'include');
            }
            await mkdir(dest);
            const stats = await overlayDir(src, dest);
            totalStats.added += stats.added || 0;
            totalStats.updated += stats.updated || 0;
            totalStats.unchanged += stats.unchanged || 0;
        }
    }

    const rocketridePython = path.join(SERVER_DIR, 'engine-lib', 'rocketlib-python');
    const pipBat = path.join(rocketridePython, 'pip', 'pip.bat');
    if (await exists(pipBat)) {
        await copyFile(pipBat, path.join(destDir, 'pip.bat'));
    }
    const pipSh = path.join(rocketridePython, 'pip', 'pip.sh');
    if (await exists(pipSh)) {
        await copyFile(pipSh, path.join(destDir, 'pip'));
        if (platform !== 'win32') {
            await chmod(path.join(destDir, 'pip'), 0o755);
        }
    }

    if (platform === 'win32') {
        const libDir = path.join(vcpkgInstalled, 'lib');
        if (await exists(libDir)) {
            const libFiles = (await readDir(libDir)).filter(f => f.startsWith('python') && f.endsWith('.lib'));
            if (libFiles.length > 0) {
                const libsDest = path.join(destDir, 'libs');
                await mkdir(libsDest);
                for (const lib of libFiles) {
                    const dest = path.join(libsDest, lib);
                    if (!(await exists(dest))) {
                        await copyFile(path.join(libDir, lib), dest);
                    }
                }
            }
        }

        const binDir = path.join(vcpkgInstalled, 'bin');
        if (await exists(binDir)) {
            const dllFiles = (await readDir(binDir)).filter(f => f.startsWith('python') && f.endsWith('.dll'));
            for (const dll of dllFiles) {
                const dest = path.join(destDir, dll);
                if (!(await exists(dest))) {
                    await copyFile(path.join(binDir, dll), dest);
                }
            }
        }

        const dllsDir = path.join(vcpkgInstalled, 'tools', 'python3', 'DLLs');
        if (await exists(dllsDir)) {
            const stats = await overlayDir(dllsDir, path.join(destDir, 'DLLs'));
            totalStats.added += stats.added || 0;
            totalStats.updated += stats.updated || 0;
            totalStats.unchanged += stats.unchanged || 0;
        }
    }

    return { copied: true, stats: totalStats };
}

async function syncRocketlibPythonLib(options = {}) {
    const rocketrideLib = path.join(SERVER_DIR, 'engine-lib', 'rocketlib-python', 'lib');
    const pythonLibDest = getPythonLibDest(options);

    if (!await exists(rocketrideLib)) {
        return { synced: false, reason: 'Source not found' };
    }

    await mkdir(pythonLibDest);
    const stats = await overlayDir(rocketrideLib, pythonLibDest);
    return { synced: true, stats };
}

async function copyClangRuntimeLibs(options = {}) {
    if (!isLinux()) return { copied: false, reason: 'Not Linux' };

    const destDir = options.destDir || DIST_DIR;
    const destLib = path.join(destDir, 'lib');
    await mkdir(destLib);

    const clangVersions = ['18', '16', '15', '10'];
    for (const ver of clangVersions) {
        const llvmLib = `/usr/lib/llvm-${ver}/lib`;
        const libcpp = path.join(llvmLib, 'libc++.so.1');

        if (await exists(libcpp)) {
            await copyFile(libcpp, path.join(destLib, 'libc++.so.1'));

            const libcppabi = path.join(llvmLib, 'libc++abi.so.1');
            if (await exists(libcppabi)) {
                await copyFile(libcppabi, path.join(destLib, 'libc++abi.so.1'));
            }

            const unwindPaths = [
                path.join(llvmLib, 'libunwind.so.1'),
                '/usr/lib/x86_64-linux-gnu/libunwind.so.1',
                '/usr/lib/x86_64-linux-gnu/libunwind.so.8'
            ];

            for (const unwindPath of unwindPaths) {
                if (await exists(unwindPath)) {
                    await copyFile(unwindPath, path.join(destLib, 'libunwind.so.1'));
                    break;
                }
            }

            return { copied: true, version: ver };
        }
    }

    const systemLib = '/usr/lib/x86_64-linux-gnu';
    const systemLibcpp = path.join(systemLib, 'libc++.so.1');

    if (await exists(systemLibcpp)) {
        await copyFile(systemLibcpp, path.join(destLib, 'libc++.so.1'));

        const systemLibcppabi = path.join(systemLib, 'libc++abi.so.1');
        if (await exists(systemLibcppabi)) {
            await copyFile(systemLibcppabi, path.join(destLib, 'libc++abi.so.1'));
        }

        const systemUnwind = path.join(systemLib, 'libunwind.so.1');
        if (await exists(systemUnwind)) {
            await copyFile(systemUnwind, path.join(destLib, 'libunwind.so.1'));
        }

        return { copied: true, version: 'system' };
    }

    return { copied: false, reason: 'No clang runtime libs found' };
}

// =============================================================================
// Action Factories
// =============================================================================

function makeCheckPrebuiltAction(options = {}) {
    return {
        run: async (ctx, task) => {
            // Compute content hash of local source (always, ~110ms)
            task.output = 'Computing source hash...';
            const localHash = await contentHash(SERVER_DIR);
            ctx.contentHash = localHash;

            if (options.force) {
                task.output = 'Force rebuild requested';
                await setState('server.contentHash', null);
                ctx.downloaded = false;
                return;
            }

            if (ctx.options?.nodownload) {
                task.output = 'Download skipped (--nodownload)';
                ctx.downloaded = false;
                return;
            }

            // Already attempted download — nothing more to do
            const downloadAttempted = await getState('server.downloadAttempted');
            if (downloadAttempted) {
                task.output = 'Download already attempted';
                return;
            }

            const {
                repo, releaseTag, distFilename, symDistFilename, distUrl, symDistUrl,
            } = await getDistInfo(options);

            // Fetch release manifest and compare content hash
            const manifestName = `builder-${releaseTag}.json`;
            const manifestPath = path.join(DOWNLOADS_DIR, manifestName);
            let hashMatches = false;

            try {
                task.output = 'Checking source compatibility...';
                await removeFile(manifestPath);
                const manifestUrl = `https://github.com/${repo}/releases/download/${releaseTag}/${manifestName}`;
                await downloadFile(manifestUrl, manifestName, task);

                if (await exists(manifestPath)) {
                    const manifest = await readJson(manifestPath);
                    await setState('server.releaseManifest', manifest);
                    hashMatches = manifest?.server?.contentHash === localHash;
                }
            } catch {
                // Manifest not available — cannot verify, must compile
            }

            if (!hashMatches) {
                task.output = 'Source differs from release — will compile';
                await setState('server.contentHash', null);
                await setState('server.downloadAttempted', true);
                ctx.downloaded = false;
                return;
            }

            // Hash matches (or no manifest) — download the binary
            try {
                task.output = `Downloading ${distFilename}...`;
                const distPath = await downloadFile(distUrl, distFilename, task);
                task.output = `Downloaded ${distFilename}`;

                let symDistPath = null;
                if (symDistFilename) {
                    task.output = `Downloading ${symDistFilename}...`;
                    symDistPath = await downloadFile(symDistUrl, symDistFilename, task);
                    task.output = `Downloaded ${symDistFilename}`;
                }

                task.output = `Extracting ${distFilename}...`;
                await extractArchive(distPath, DIST_DIR);
                task.output = `Extracted ${distFilename}`;

                if (isWindows() && symDistPath) {
                    task.output = `Extracting ${symDistFilename}...`;
                    await extractArchive(symDistPath, DIST_DIR);
                    task.output = `Extracted ${symDistFilename}`;
                }

                await setState('server.contentHash', localHash);
                await setState('server.downloadAttempted', true);
                task.output = `Downloaded server ${releaseTag}`;
                ctx.downloaded = true;

            } catch (e) {
                await setState('server.contentHash', null);
                await setState('server.downloadAttempted', true);
                ctx.downloaded = false;
                task.output = `Release ${releaseTag} download failed:\n${e.message.trim()}\nWill compile from source`;
            }
        }
    };
}

function makeSetupToolsAction(_options = {}) {
    return {
        run: async (ctx, task) => {
            await runCompilerSetup({
                autoinstall: !!(ctx.options && ctx.options.autoinstall),
                verbose: !!(ctx.options && ctx.options.verbose),
                onOutput: (line) => { task.output = line; },
                task
            });
        }
    };
}

function makeConfigureServerAction(options = {}) {
    return {
        locks: ['cmake'],
        run: async (ctx, task) => {
            if (!options.force && await isConfigured()) {
                task.output = 'Already configured';
                return;
            }

            await mkdir(BUILD_DIR);

            const cached = await getCachedGeneratorArgs(BUILD_DIR);
            const generator = cached ?? (await detectGenerator());
            taskDebug('configure generator source:', cached ? 'cached (CMakeCache.txt)' : 'state (compiler-windows)');
            taskDebug('configure generator args:', generator);
            if (!cached) {
                await removeFiles(BUILD_DIR, ['CMakeCache.txt', 'cmake_install.cmake']);
                await removeDirs([path.join(BUILD_DIR, 'CMakeFiles')]);
                taskDebug('cleared CMake state for fresh configure');
            }
            const triplet = getVcpkgTriplet(options);
            const toolchainFile = path.join(SERVER_DIR, 'engine-core', 'cmake', 'triplets', triplet + '.cmake');

            const cmakeArgs = [
                'cmake',
                '-B', BUILD_DIR,
                '-S', SERVER_DIR,
                ...generator,
                '-DCMAKE_BUILD_TYPE=Release',
                `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`
            ];

            if (options.batchSize) {
                cmakeArgs.push(`-DROCKETRIDE_UNITY_BATCH_SIZE:STRING=${options.batchSize}`);
            }

            const baseEnv = isWindows() ? await getVsEnvironment() : process.env;
            const env = {
                ...baseEnv,
                VCPKG_ROOT: path.join(BUILD_DIR, 'vcpkg')  // Help vcpkg find itself faster
            };
            await execCommand(cmakeArgs[0], cmakeArgs.slice(1), { task, env, verbose: !!(ctx.options && ctx.options.verbose) });

            await updateServerState({
                configured: true,
                configuredAt: new Date().toISOString(),
                buildType: 'Release'
            });
        }
    };
}

function makeSetupPythonAction(options = {}) {
    return {
        run: async (ctx, task) => {
            task.output = 'Copying Python environment from vcpkg...';
            const copyResult = await copyPythonEnv(options);
            
            if (!copyResult.copied) {
                throw new Error(`Failed to copy Python environment: ${copyResult.reason}`);
            }
            
            task.output = 'Syncing rocketlib-python lib...';
            const syncResult = await syncRocketlibPythonLib();

            // Combine stats from both operations
            const stats = {
                added: (copyResult.stats?.added || 0) + (syncResult.stats?.added || 0),
                updated: (copyResult.stats?.updated || 0) + (syncResult.stats?.updated || 0),
                unchanged: (copyResult.stats?.unchanged || 0) + (syncResult.stats?.unchanged || 0)
            };

            task.output = formatSyncStats(stats);
        }
    };
}

function makeSetupJreAction() {
    return {
        run: async (ctx, task) => {
            const result = await copyJavaJre();
            if (!result.copied) {
                task.output = result.reason;
            } else {
                task.output = result.stats ? formatSyncStats(result.stats) : 'Synced JRE';
            }
        }
    };
}

function makeSetupRuntimeLibsAction(options = {}) {
    return {
        run: async (ctx, task) => {
            if (!isLinux()) {
                task.output = 'Not Linux';
                return;
            }
            const result = await copyClangRuntimeLibs(options);
            task.output = result.copied
                ? `Synced clang-${result.version} runtime libs`
                : result.reason;
        }
    };
}

function makeSetupSambaAction(options = {}) {
    return {
        run: async (ctx, task) => {
            if (!isMac()) {
                task.output = 'Not macOS';
                return;
            }
            const result = await copySambaLibs(options);
            if (!result.copied) {
                task.output = result.reason;
            } else {
                task.output = result.stats ? formatSyncStats(result.stats) : 'Synced Samba libs';
            }
        }
    };
}

function makeCompileEngineAction(options = {}) {
    return {
        locks: ['cmake'],
        run: async (ctx, task) => {
            const { version } = await loadPackageJson();

            // Check content hash — skip if source matches last successful build
            if (!options.force) {
                const savedHash = await getState('server.contentHash');
                const exeExt = isWindows() ? '.exe' : '';
                const engineExists = await exists(path.join(DIST_DIR, 'engine' + exeExt));

                if (savedHash && savedHash === ctx.contentHash && engineExists) {
                    task.output = 'No source changes detected';
                    return;
                }
            }

            task.output = `Compiling v${version}...`;

            const baseEnv = isWindows() ? await getVsEnvironment() : process.env;
            const env = {
                ...baseEnv,
                VCPKG_ROOT: path.join(BUILD_DIR, 'vcpkg')
            };

            if (options.force) {
                task.output = 'Cleaning build directory...';
                await execCommand('cmake', ['--build', BUILD_DIR, '--target', 'clean'], { task, env, verbose: !!(ctx.options && ctx.options.verbose) });
            }

            const jobs = getParallelJobs();
            const cmakeArgs = [
                'cmake', '--build', BUILD_DIR,
                '--config', 'Release',
                '--target', 'engine',
                '--parallel', String(jobs)
            ];
            await execCommand(cmakeArgs[0], cmakeArgs.slice(1), { task, env, verbose: !!(ctx.options && ctx.options.verbose) });

            // Copy engine to dist
            await mkdir(DIST_DIR);
            const exeExt = isWindows() ? '.exe' : '';
            const enginePaths = [
                path.join(BUILD_DIR, 'apps', 'engine', 'Release', 'engine' + exeExt),
                path.join(BUILD_DIR, 'apps', 'engine', 'engine' + exeExt)
            ];

            for (const src of enginePaths) {
                if (await exists(src)) {
                    await copyFile(src, path.join(DIST_DIR, 'engine' + exeExt));
                    break;
                }
            }

            if (isWindows()) {
                const pdbPaths = [
                    path.join(BUILD_DIR, 'apps', 'engine', 'Release', 'engine.pdb'),
                    path.join(BUILD_DIR, 'apps', 'engine', 'engine.pdb')
                ];
                for (const src of pdbPaths) {
                    if (await exists(src)) {
                        await copyFile(src, path.join(DIST_DIR, 'engine.pdb'));
                        break;
                    }
                }
            }

            // Save content hash after successful compilation
            await setState('server.contentHash', ctx.contentHash);

            task.output = `Compiled v${version}`;
        }
    };
}

function makeCompileTestsAction() {
    return {
        locks: ['cmake'],
        run: async (ctx, task) => {
            // Check source hash to skip if nothing changed since last test build
            if (!(ctx.options && ctx.options.force)) {
                task.output = 'Checking for source changes...';
                const [coreHash, libHash, cmakeHash] = await Promise.all([
                    fingerprint(path.join(SERVER_DIR, 'engine-core')),
                    fingerprint(path.join(SERVER_DIR, 'engine-lib')),
                    fingerprint(path.join(SERVER_DIR, 'cmake'))
                ]);
                const combinedHash = require('crypto')
                    .createHash('md5')
                    .update(`${coreHash}:${libHash}:${cmakeHash}`)
                    .digest('hex');

                const savedHash = await getState('server.testSrcHash');
                if (combinedHash === savedHash) {
                    task.output = 'No source changes detected';
                    return;
                }

                ctx._testSrcHash = combinedHash;
            }

            const baseEnv = isWindows() ? await getVsEnvironment() : process.env;
            const env = {
                ...baseEnv,
                VCPKG_ROOT: path.join(BUILD_DIR, 'vcpkg')
            };
            const jobs = getParallelJobs();

            // Build aptest
            task.output = 'Building aptest...';
            const aptestArgs = ['--build', BUILD_DIR, '--config', 'Release', '--target', 'aptest', '--parallel', String(jobs)];
            await execCommand('cmake', aptestArgs, { task, env, verbose: !!(ctx.options && ctx.options.verbose) });

            // Build engtest
            task.output = 'Building engtest...';
            const engtestArgs = ['--build', BUILD_DIR, '--config', 'Release', '--target', 'engtest', '--parallel', String(jobs)];
            await execCommand('cmake', engtestArgs, { task, env, verbose: !!(ctx.options && ctx.options.verbose) });

            // Save test source hash after successful build
            if (ctx._testSrcHash) {
                await setState('server.testSrcHash', ctx._testSrcHash);
            }

            task.output = 'Test executables compiled';
        }
    };
}

function makeInstallPipAction() {
    return {
        run: async (ctx, task) => {
            // Bootstrap pip and install setuptools, wheel, build, pytest, pytest-asyncio (once; tracked in state)
            const pipInstalled = await getState('server.pipInstalled');
            if (!pipInstalled) {
                const enginePath = path.join(DIST_DIR, 'engine');
                task.output = 'Bootstrapping pip...';
                await execCommand(enginePath, ['-m', 'ensurepip', '--default-pip'], { task, cwd: DIST_DIR });
                task.output = 'Upgrading pip...';
                await execCommand(enginePath, ['-m', 'pip', 'install', '--upgrade', 'pip'], { task, cwd: DIST_DIR });
                task.output = 'Installing setuptools, wheel, build, pytest, pytest-asyncio...';
                await execCommand(enginePath, ['-m', 'pip', 'install', 'setuptools>=75', 'wheel', 'build', 'pytest', 'pytest-asyncio'], { task, cwd: DIST_DIR });
                await setState('server.pipInstalled', true);
            } else {
                task.output = 'Pip and build deps already installed (skipped)';
            }
        }
    };
}

function makeCopyTestDataAction() {
    return {
        run: async (ctx, task) => {
            await mkdir(DIST_DIR);

            // Test data is now in PROJECT_ROOT/testdata, organized by type
            const testdataDir = path.join(PROJECT_ROOT, 'testdata');
            const destDatasets = path.join(DIST_DIR, 'datasets');
            await mkdir(destDatasets);

            // Sync from each subdirectory (images, documents, audio, video, text, misc)
            // to flatten into a single datasets folder for C++ tests
            let totalStats = { added: 0, updated: 0, unchanged: 0 };
            const subdirs = ['images', 'documents', 'audio', 'video', 'text', 'misc'];
            for (const subdir of subdirs) {
                const src = path.join(testdataDir, subdir);
                if (await exists(src)) {
                    const stats = await overlayDir(src, destDatasets);
                    totalStats.added += stats.added || 0;
                    totalStats.updated += stats.updated || 0;
                    totalStats.unchanged += stats.unchanged || 0;
                }
            }
            task.output = formatSyncStats(totalStats);

            // Copy cacert.pem on Linux
            if (isLinux()) {
                const cacert = path.join(SERVER_DIR, 'engine-core', '3rdparty', 'cacert.pem');
                if (await exists(cacert)) {
                    await copyFile(cacert, path.join(DIST_DIR, 'cacert.pem'));
                }
            }

            const exeExt = isWindows() ? '.exe' : '';
            const testExes = [
                {
                    name: 'aptest',
                    paths: [
                        path.join(BUILD_DIR, 'engine-core', 'test', 'Release', 'aptest' + exeExt),
                        path.join(BUILD_DIR, 'engine-core', 'test', 'aptest' + exeExt)
                    ]
                },
                {
                    name: 'engtest',
                    paths: [
                        path.join(BUILD_DIR, 'engine-lib', 'test', 'Release', 'engtest' + exeExt),
                        path.join(BUILD_DIR, 'engine-lib', 'test', 'engtest' + exeExt)
                    ]
                }
            ];

            for (const test of testExes) {
                for (const src of test.paths) {
                    if (await exists(src)) {
                        await copyFile(src, path.join(DIST_DIR, test.name + exeExt));
                        break;
                    }
                }
            }
        }
    };
}

function makeRunAptestAction(options = {}) {
    return {
        run: async (ctx, task) => {
            const exeExt = isWindows() ? '.exe' : '';
            const exe = path.join(DIST_DIR, 'aptest' + exeExt);
            const args = [...(options.catch || [])];
            if (options.trace?.length) {
                args.push(`--trace=${options.trace.join(',')}`);
            }
            await execCommand(exe, args, { task, cwd: DIST_DIR });
        }
    };
}

function makeRunEngtestAction(options = {}) {
    return {
        run: async (ctx, task) => {
            const exeExt = isWindows() ? '.exe' : '';
            const exe = path.join(DIST_DIR, 'engtest' + exeExt);
            const args = [...(options.catch || [])];
            if (options.trace?.length) {
                args.push(`--trace=${options.trace.join(',')}`);
            }
            await execCommand(exe, args, { task, cwd: DIST_DIR });
        }
    };
}

function makeBuildCoreAction() {
    return {
        steps: [
            'server:download',
            whenNot({
                name: 'downloaded',
                condition: (ctx) => ctx.downloaded,
                then: [
                    parallel([
                        'server:setup-tools',
                        'vcpkg:submodule-build',
                        'java:setup-jdk'
                    ], 'Setup build tools'),
                    'server:configure',
                    'server:compile-engine',
                    parallel([
                        'server:setup-python',
                        'server:setup-jre'
                    ], 'Setup dependencies'),
                    parallel([
                        'server:setup-runtime-libs',
                        'server:setup-samba'
                    ], 'Setup runtime'),
                    'tika:submodule-build'
                ]
            }),
        ]
    };
}

function makeBuildAction() {
    return {
        description: 'Build server',
        steps: [
            'server:build-core',
            'server:setup-pip',
            // Sync nodes, ai, and clients into dist/server regardless of whether
            // the engine was downloaded or compiled — the prebuilt binary doesn't
            // include these modules, and they must match the current repo checkout.
            parallel([
                'nodes:sync',
                'ai:sync',
                'client-python:sync-source'
            ], 'Sync modules')
        ]
    };
}

function makeCleanServerAction() {
    return {
        description: 'Clean server',
        run: async (ctx, task) => {
            await setState('server', {});

            await removeFiles(BUILD_DIR, [
                'CMakeCache.txt', 'cmake_install.cmake',
                'build.ninja', '.ninja_deps', '.ninja_log', 'compile_commands.json',
                'CPackConfig.cmake', 'CPackSourceConfig.cmake', 'CTestTestfile.cmake',
                'Makefile', 'CMakePresets.json'
            ]);

            // Clean only the server build artifacts; vcpkg state is managed by vcpkg:clean
            await removeDirs([
                path.join(BUILD_DIR, 'CMakeFiles'),
                path.join(BUILD_DIR, 'Testing'),
                path.join(BUILD_DIR, 'apps'),
                path.join(BUILD_DIR, 'engine-core'),
                path.join(BUILD_DIR, 'engine-lib'),
                path.join(BUILD_DIR, 'packages'),
                path.join(BUILD_DIR, '_download_temp'),
                BUILD_ARTIFACTS_DIR,
                DIST_ARTIFACTS_DIR,
                DIST_DIR
            ]);

            task.output = 'Cleaned server build';
        }
    };
}

// =============================================================================
// Module Definition
// =============================================================================

// =============================================================================
// Public Actions (have descriptions, shown in `builder --help`)
// =============================================================================

function makeBuildAllAction() {
    return {
        description: 'Build server and modules',
        steps: [
            'server:build',
            // Build external modules
            parallel([
                'nodes:build',
                'ai:build',
                'client-python:build'
            ], 'Build modules')
        ]
    };
}

function makeCompileAction() {
    return {
        description: 'Compile server',
        steps: [
            'server:configure',
            'server:setup-python',
            'server:compile-engine'
        ]
    };
}

function makeConfigureAction() {
    return {
        description: 'Configure server',
        steps: [
            'server:setup-tools',
            'server:configure'
        ]
    };
}

function makeTestAction() {
    return {
        description: 'Test server',
        steps: [
            'server:build',
            whenNot({
                name: 'downloaded',
                condition: (ctx) => ctx.downloaded,
                then: [
                    // Build modules needed for tests
                    parallel([
                        'nodes:build',
                        'ai:build',
                        'client-python:build'
                    ], 'Build dependencies'),
                    'server:compile-tests',
                    'server:copy-test-data',
                    parallel([
                        'server:run-aptest',
                        'server:run-engtest'
                    ], 'Run tests')
                ]
            })
        ]
    };
}

function makePackageAction(options = {}) {
    return {
        description: 'Package server distribution',
        run: async (_ctx, _task) => {
            const { baseName, releaseTag, distFilename, symDistFilename } = await getDistInfo(options);
            const distPath = path.join(DIST_ARTIFACTS_DIR, distFilename);
            const symDistPath = symDistFilename ? path.join(DIST_ARTIFACTS_DIR, symDistFilename) : null;
            const symFilename = isWindows() ? 'engine.pdb' : null;

            // temp dir for packaging
            options.destDir = path.join(BUILD_ARTIFACTS_DIR, baseName);

            const sourceHash = await getState('server.contentHash');
            const packageHash = await getState('server.pkgHash');
            if (!sourceHash) {
                throw new Error('Content hash not found — build server first');
            } else if (!_ctx.force && sourceHash === packageHash && await exists(distPath)) {
                _task.output = `Server package ${distFilename} is up to date`;
                return;
            }

            try {
                _task.output = `Preparing files for packaging ${distFilename}...`;
                await resetDir(options.destDir);
                // TODO: refactor this
                await Promise.all([
                    copyClangRuntimeLibs(options),
                    copySambaLibs(options),
                    copyPythonEnv(options),
                    syncRocketlibPythonLib(options),
                    // copyJavaJre(options),
                    syncDir(path.join(DIST_DIR, 'java'), path.join(options.destDir, 'java')),
                    syncDir(path.join(PROJECT_ROOT, 'nodes', 'src', 'nodes'), path.join(options.destDir, 'nodes')),
                    syncDir(path.join(PACKAGES_DIR, 'ai', 'src', 'ai'), path.join(options.destDir, 'ai')),
                    syncDir(path.join(PACKAGES_DIR, 'client-python', 'src', 'rocketride'), path.join(options.destDir, 'rocketride')),
                    (async(options) => {
                        const exeExt = isWindows() ? '.exe' : '';
                        const enginePaths = [
                            path.join(BUILD_DIR, 'apps', 'engine', 'Release', 'engine' + exeExt),
                            path.join(BUILD_DIR, 'apps', 'engine', 'engine' + exeExt)
                        ];
                        for (const src of enginePaths) {
                            if (await exists(src)) {
                                await copyFile(src, path.join(options.destDir, 'engine' + exeExt));
                                break;
                            }
                        }
                    })(options),
                ]);
                _task.output = `Prepared files for packaging ${distFilename}`;

                _task.output = `Packaging ${distFilename}...`;
                await mkdir(DIST_ARTIFACTS_DIR);
                await removeFile(distPath);
                await createArchive(distPath, options.destDir, ".");
                _task.output = `Packaged ${distFilename}`;

                if (symDistPath) {
                    _task.output = `Packaging ${path.basename(symDistPath)}...`;
                    await removeFile(symDistPath);
                    await createArchive(symDistPath, DIST_DIR, [ symFilename ]);
                    _task.output = `Packaged ${path.basename(symDistPath)}`;
                }


                await setState('server.pkgHash', sourceHash);

                // Copy state.json as build manifest for download validation
                const manifestName = `builder-${releaseTag}.json`;
                await copyFile(STATE_FILE, path.join(DIST_ARTIFACTS_DIR, manifestName));
                _task.output = `Packaged ${distFilename} + ${manifestName}`;

            } catch (err) {
                await removeFile(distPath);
                if (symDistPath) {
                    await removeFile(symDistPath);
                }
                throw err;

            } finally {
                // Leave it in place for testing
                // await removeDir(options.destDir);
            }
        }
    };
}

function makeCleanAction() {
    return {
        description: 'Clean all',
        steps: [
            'server:clean',
            'vcpkg:submodule-clean',
            'java:submodule-clean',
            'tika:submodule-clean'
        ]
    };
}

// =============================================================================
// Module Definition (Unified Action Model)
// =============================================================================

module.exports = {
    name: 'server',
    description: 'C++ Engine Server',

    actions: [
        // Internal actions (no description in help)
        { name: 'server:download', action: makeCheckPrebuiltAction },
        { name: 'server:build-core', action: makeBuildCoreAction },
        { name: 'server:setup-tools', action: makeSetupToolsAction },
        { name: 'server:configure', action: makeConfigureServerAction },
        { name: 'server:setup-python', action: makeSetupPythonAction },
        { name: 'server:setup-jre', action: makeSetupJreAction },
        { name: 'server:setup-runtime-libs', action: makeSetupRuntimeLibsAction },
        { name: 'server:setup-samba', action: makeSetupSambaAction },
        { name: 'server:compile-engine', action: makeCompileEngineAction },
        { name: 'server:compile-tests', action: makeCompileTestsAction },
        { name: 'server:setup-pip', action: makeInstallPipAction },
        { name: 'server:copy-test-data', action: makeCopyTestDataAction },
        { name: 'server:run-aptest', action: makeRunAptestAction },
        { name: 'server:run-engtest', action: makeRunEngtestAction },
        { name: 'server:clean', action: makeCleanServerAction },

        // Public actions (have descriptions, shown in help)
        { name: 'server:build', action: makeBuildAction },
        { name: 'server:build-all', action: makeBuildAllAction },
        { name: 'server:compile', action: makeCompileAction },
        { name: 'server:configure-cmake', action: makeConfigureAction },
        { name: 'server:test', action: makeTestAction },
        { name: 'server:package', action: makePackageAction },
        { name: 'server:clean-all', action: makeCleanAction }
    ]
};
