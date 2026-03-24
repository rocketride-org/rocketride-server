// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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
const { glob } = require('glob');
const {
    getState, setState, updateState,
    removeDirs, syncDir, syncFile, removeFiles,
    formatSyncStats,
    execCommand, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT, isWindows, isMac, isLinux,
    exists, readFile, readJson, writeJson, mkdir, copyFile, removeFile,
    loadPackageJson, downloadGitHubFile, createArchive, extractArchive,
    parallel, whenNot, fingerprint, contentHash,
    taskDebug,
    STATE_FILE
} = require('../../../scripts/lib');
const { runCompilerSetup } = require('../../../scripts/compiler');

// Paths
const PACKAGES_DIR = path.join(PROJECT_ROOT, 'packages');
const SERVER_DIR = path.join(PACKAGES_DIR, 'server');
const DIST_DIR = path.join(DIST_ROOT, 'server');
const VCPKG_DIR = path.join(BUILD_ROOT, 'vcpkg');
const DIST_ARTIFACTS_DIR = path.join(DIST_ROOT, 'artifacts');

// =============================================================================
// Platform Detection
// =============================================================================

function getPlatformInfo(options = {}) {
    const platform = os.platform();
    const arch = options.arch || os.arch();

    if (isWindows()) {
        return { name: 'win64', os: 'windows', ext: 'zip' };
    } else if (isMac()) {
        const darwinArch = arch === 'arm64' ? 'arm64' : 'x64';
        return {
            name: `darwin-${darwinArch}`,
            os: 'darwin',
            arch: darwinArch,
            ext: 'tar.gz'
        };
    } else if (isLinux()) {
        return { name: 'linux-x64', os: 'linux', ext: 'tar.gz' };
    }
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

async function getPackageInfo(options = {}) {
    const { version } = await loadPackageJson();
    const platform = getPlatformInfo(options);
    const releaseTag = `server-v${version}`;
    const prereleaseTag = `${releaseTag}-prerelease`;
    const baseName = `rocketride-${releaseTag}-${platform.name}`;
    const manifestFilename = `${baseName}.manifest.json`;
    const distFilename = `${baseName}.${platform.ext}`;
    const symDistFilename = isWindows() ? `${baseName}.symbols.${platform.ext}` : null;
    const distFile = path.join(DIST_ARTIFACTS_DIR, distFilename);
    const symDistFile = symDistFilename ? path.join(DIST_ARTIFACTS_DIR, symDistFilename) : null;

    return {
        releaseTag,
        prereleaseTag,
        baseName,
        manifestFilename,
        distFilename,
        symDistFilename,
        distFile,
        symDistFile
    };
}

// =============================================================================
// State Management
// =============================================================================

async function isConfigured() {
    const configured = await getState('server.configured');
    if (configured !== true) return false;

    // Check CMakeCache.txt exists
    const cmakeCache = path.join(BUILD_ROOT, 'CMakeCache.txt');
    if (!await exists(cmakeCache)) return false;

    // Check vcpkg packages are installed (manifest or classic path)
    const vcpkgInstalled = await getVcpkgInstalledDir();
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
        throw new Error('Visual Studio build path not set. Run server:setup-tools first (e.g. run builder server:setup-tools --autoinstall).');
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
        throw new Error('Visual Studio environment not in state. Run server:setup-tools first (e.g. run builder server:setup-tools --autoinstall).');
    }
    vsEnvCache = { ...process.env, ...buildEnv };
    return vsEnvCache;
}

// =============================================================================
// Helpers
// =============================================================================

async function getPythonLibDest(options = {}) {
    if (isWindows()) {
        return path.join(DIST_DIR, 'lib');
    } else {
        const pythonVersion = await getPythonVersion(options);
        return path.join(DIST_DIR, 'lib', `python${pythonVersion}`);
    }
}

async function getPythonVersion(options = {}) {
    let pythonVersion = await getState('vcpkg.pythonVersion');
    if (pythonVersion !== undefined) return pythonVersion;

    const vcpkgJsonPath = path.join(BUILD_ROOT, 'vcpkg', 'ports', 'python3', 'vcpkg.json');
    if (!await exists(vcpkgJsonPath))
        throw new Error('Python port not found');

    const vcpkgJson = await readJson(vcpkgJsonPath);
    if (!vcpkgJson || !vcpkgJson.version)
        throw new Error(`Python version not found in ${vcpkgJsonPath}`);

    // Get major.minor from manifest version (e.g., "3.12.9" -> "3.12")
    const match = /^(\d+\.\d+)/.exec(vcpkgJson.version);
    if (!match) throw new Error(`Unexpected Python version format: ${vcpkgJson.version}`);

    pythonVersion = match[1];
    await setState('vcpkg.pythonVersion', pythonVersion);
    return pythonVersion;
}

function getVcpkgTriplet(options = {}) {
    const arch = options.arch || os.arch();
    if (isWindows()) return 'x64-windows-vc-rocketride';
    if (isLinux()) return 'x64-linux-clang-rocketride';
    if (isMac()) return arch === 'arm64' ? 'arm64-osx-appleclang-rocketride' : 'x64-osx-appleclang-rocketride';
    throw new Error('Unsupported platform');
}

async function getVcpkgInstalledDir(options = {}) {
    return path.join(BUILD_ROOT, 'vcpkg_installed', getVcpkgTriplet(options));
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

    const vcpkgInstalled = await getVcpkgInstalledDir(options);
    const sambaSrc = path.join(vcpkgInstalled, 'samba');

    if (!await exists(sambaSrc)) {
        return { copied: false, reason: 'Samba not found in vcpkg' };
    }

    const sambaDest = path.join(DIST_DIR, 'samba');
    await mkdir(sambaDest);
    const stats = await syncDir(sambaSrc, sambaDest, { mirror: false, package: true });
    return { copied: true, stats };
}

async function copyJavaJre(options = {}) {
    const jreSrc = path.join(BUILD_ROOT, 'java', 'jre');
    const jreDest = path.join(DIST_DIR, 'java', 'jre');

    if (!await exists(jreSrc)) {
        return { copied: false, reason: 'JRE not found (run java setup first)' };
    }

    await mkdir(path.dirname(jreDest));
    const stats = await syncDir(jreSrc, jreDest, { mirror: false, package: true });

    return { copied: true, stats };
}

async function copyPythonEnv(options = {}) {
    const vcpkgInstalled = await getVcpkgInstalledDir(options);

    if (!await exists(vcpkgInstalled)) {
        return { copied: false, reason: 'vcpkg not installed' };
    }

    const pythonLibDest = await getPythonLibDest(options);

    let pythonLibSrc;
    if (isWindows()) {
        pythonLibSrc = path.join(vcpkgInstalled, 'tools', 'python3', 'lib');
    } else {
        const pythonVersion = await getPythonVersion(options);
        pythonLibSrc = path.join(vcpkgInstalled, 'lib', `python${pythonVersion}`);
    }

    let stats = {};

    await syncDir(pythonLibSrc, pythonLibDest, { mirror: false, package: true }, stats);

    const includeDir = path.join(vcpkgInstalled, 'include');
    if (await exists(includeDir)) {
        const pythonIncludeDirs = await glob('python*', { cwd: includeDir, absolute: true });
        for (const pyIncludeDir of pythonIncludeDirs) {
            await syncDir(
                pyIncludeDir,
                path.join(DIST_DIR, 'include', path.basename(pyIncludeDir)),
                { package: true }, stats);
        }
    }

    const rocketridePython = path.join(SERVER_DIR, 'engine-lib', 'rocketlib-python');
    if (isWindows()) {
        const pipBat = path.join(rocketridePython, 'pip', 'pip.bat');
        await syncFile(pipBat, path.join(DIST_DIR, 'pip.bat'), { package: true }, stats);
    } else {
        const pipSh = path.join(rocketridePython, 'pip', 'pip.sh');
        await syncFile(pipSh, path.join(DIST_DIR, 'pip'), { package: true }, stats);
    }

    if (isWindows()) {
        const libDir = path.join(vcpkgInstalled, 'lib');
        const libsDest = path.join(DIST_DIR, 'libs');
        await syncDir(libDir, libsDest, { pattern: 'python*.lib', package: true }, stats);

        const binDir = path.join(vcpkgInstalled, 'bin');
        await syncDir(binDir, DIST_DIR, { pattern: 'python*.dll', mirror: false, package: true }, stats);

        const dllsDir = path.join(vcpkgInstalled, 'tools', 'python3', 'DLLs');
        await syncDir(dllsDir, path.join(DIST_DIR, 'DLLs'), { package: true }, stats);
    }

    return { copied: true, stats };
}

async function syncRocketlibPythonLib(options = {}) {
    const rocketrideLib = path.join(SERVER_DIR, 'engine-lib', 'rocketlib-python', 'lib');
    const pythonLibDest = await getPythonLibDest(options);

    if (!await exists(rocketrideLib)) {
        return { synced: false, reason: 'Source not found' };
    }

    await mkdir(pythonLibDest);
    const stats = await syncDir(rocketrideLib, pythonLibDest, { mirror: false, package: true });
    return { synced: true, stats };
}

async function copyClangRuntimeLibs(options = {}) {
    if (!isLinux()) return { copied: false, reason: 'Not Linux' };

    const destLib = path.join(DIST_DIR, 'lib');
    await mkdir(destLib);

    const clangVersions = ['18', '16', '15', '10'];
    for (const ver of clangVersions) {
        const llvmLib = `/usr/lib/llvm-${ver}/lib`;
        const libcpp = path.join(llvmLib, 'libc++.so.1');

        if (await exists(libcpp)) {
            await copyFile(libcpp, path.join(DIST_DIR, 'lib', 'libc++.so.1'));

            const libcppabi = path.join(llvmLib, 'libc++abi.so.1');
            if (await exists(libcppabi)) {
                await copyFile(libcppabi, path.join(DIST_DIR, 'lib', 'libc++abi.so.1'));
            }

            const unwindPaths = [
                path.join(llvmLib, 'libunwind.so.1'),
                '/usr/lib/x86_64-linux-gnu/libunwind.so.1',
                '/usr/lib/x86_64-linux-gnu/libunwind.so.8'
            ];

            for (const unwindPath of unwindPaths) {
                if (await exists(unwindPath)) {
                    await copyFile(unwindPath, path.join(DIST_DIR, 'lib', 'libunwind.so.1'));
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

function makeDownloadAction(options = {}) {
    return {
        run: async (ctx, task) => {
            // Compute content hash of local source (always, ~110ms)
            task.output = 'Computing source hash...';
            const localHash = await contentHash(SERVER_DIR, { log: (msg) => { task.output = msg; } });
            ctx.contentHash = localHash;
            ctx.serverAlreadyBuilt = false;

            if (options.force) {
                task.output = 'Force rebuild requested';
                await setState('server.contentHash', null);
                await setState('server.downloaded', false);
                ctx.downloaded = false;
                return;
            }

            if (options.nodownload) {
                task.output = 'Download skipped (--nodownload)';
                await setState('server.downloaded', false);
                ctx.downloaded = false;
                return;
            }

            // Get local vcpkg version
            const { getVcpkgVersion } = require('../../vcpkg/scripts/tasks');
            const localVcpkgVersion = await getVcpkgVersion();

            if (!await getState('server.downloaded')
                && await getState('server.contentHash') === localHash
                && await getState('vcpkg.version') === localVcpkgVersion) {
                ctx.serverAlreadyBuilt = true;
                task.output = 'Server already built';
                return;
            }

            const {
                releaseTag, prereleaseTag, manifestFilename, distFilename, symDistFilename
            } = await getPackageInfo(options);

            // Try stable release first, then prerelease
            const tagsToTry = [releaseTag, prereleaseTag];
            let releaseAvailable = false;
            let matchedTag = null;

            for (const tag of tagsToTry) {
                task.output = `Checking release ${tag}...`;

                let manifest = null;
                const manifestPath = await downloadGitHubFile(tag, manifestFilename, task);
                if (manifestPath) {
                    manifest = await readJson(manifestPath);
                }

                if (manifest) {
                    task.output = `Release ${tag} available`;
                    releaseAvailable = true;
                } else {
                    task.output = `Release ${tag} not available`;
                    continue;
                }

                const serverHash = manifest?.server?.contentHash;
                const serverVcpkgVersion = manifest?.vcpkg?.version;
                if (localHash === serverHash && localVcpkgVersion === serverVcpkgVersion) {
                    matchedTag = tag;
                    break;
                }
            }

            if (!releaseAvailable) {
                task.output = 'No releases available - will compile';
                await setState('server.contentHash', null);
                await setState('server.downloaded', false);
                ctx.downloaded = false;
                return;
            }

            if (!matchedTag) {
                task.output = 'Source differs from all releases — will compile';
                await setState('server.contentHash', null);
                await setState('server.downloaded', false);
                ctx.downloaded = false;
                return;
            }

            if (await getState('server.downloaded')) {
                ctx.downloaded = true;
                task.output = 'Server already downloaded';
                return;
            }

            try {
                task.output = `Downloading ${distFilename} from ${matchedTag}...`;
                const distPath = await downloadGitHubFile(matchedTag, distFilename, task);
                if (!distPath)
                    throw new Error(`Dist file ${distFilename} cannot be downloaded`);
                task.output = `Downloaded ${distFilename}`;

                let symDistPath = null;
                if (symDistFilename) {
                    task.output = `Downloading ${symDistFilename}...`;
                    symDistPath = await downloadGitHubFile(matchedTag, symDistFilename, task);
                    if (symDistPath)
                        task.output = `Downloaded ${symDistFilename}`;
                    else
                        task.output = `Symbol dist file ${symDistFilename} not available, skipping`;
                }

                task.output = `Extracting ${distFilename}...`;
                await extractArchive(distPath, DIST_DIR);
                task.output = `Extracted ${distFilename}`;

                if (symDistPath) {
                    task.output = `Extracting ${symDistFilename}...`;
                    await extractArchive(symDistPath, DIST_DIR);
                    task.output = `Extracted ${symDistFilename}`;
                }

                await setState('server.downloaded', true);
                ctx.downloaded = true;
                ctx.serverAlreadyBuilt = false;
                task.output = `Downloaded server from ${matchedTag}`;

            } catch {
                await setState('server.downloaded', false);
                ctx.downloaded = false;
                ctx.serverAlreadyBuilt = false;
                task.output = `Release ${matchedTag} download failed: Will compile from source`;
            }
        }
    };
}

function makeSetupToolsAction(options = {}) {
    return {
        run: async (ctx, task) => {
            await runCompilerSetup({
                autoinstall: options.autoinstall,
                verbose: options.verbose,
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

            await mkdir(BUILD_ROOT);

            const cached = await getCachedGeneratorArgs(BUILD_ROOT);
            const generator = cached ?? (await detectGenerator());
            taskDebug('configure generator source:', cached ? 'cached (CMakeCache.txt)' : 'state (compiler-windows)');
            taskDebug('configure generator args:', generator);
            if (!cached) {
                await removeFiles(BUILD_ROOT, ['CMakeCache.txt', 'cmake_install.cmake']);
                await removeDirs([path.join(BUILD_ROOT, 'CMakeFiles')]);
                taskDebug('cleared CMake state for fresh configure');
            }
            const triplet = getVcpkgTriplet(options);
            const vcpkgToolchain = path.join(VCPKG_DIR, 'scripts', 'buildsystems', 'vcpkg.cmake');
            const overlayPorts = path.join(SERVER_DIR, 'cmake', 'ports');
            const overlayTriplets = path.join(SERVER_DIR, 'cmake', 'triplets');

            const cmakeArgs = [
                'cmake',
                '-B', BUILD_ROOT,
                '-S', SERVER_DIR,
                ...generator,
                '-DCMAKE_BUILD_TYPE=Release',
                `-DCMAKE_TOOLCHAIN_FILE=${vcpkgToolchain}`,
                `-DVCPKG_TARGET_TRIPLET=${triplet}`,
                `-DVCPKG_HOST_TRIPLET=${triplet}`,
                `-DVCPKG_OVERLAY_PORTS=${overlayPorts}`,
                `-DVCPKG_OVERLAY_TRIPLETS=${overlayTriplets}`
            ];

            if (options.batchSize) {
                cmakeArgs.push(`-DROCKETRIDE_UNITY_BATCH_SIZE:STRING=${options.batchSize}`);
            }

            if (options.buildVersion) {
                cmakeArgs.push(`-DCMAKE_PROJECT_VERSION:STRING=${options.buildVersion}`);
            }

            if (options.buildHash) {
                cmakeArgs.push(`-DROCKETRIDE_BUILD_HASH_SHORT:STRING=${options.buildHash}`);
            }

            if (options.buildStamp) {
                cmakeArgs.push(`-DROCKETRIDE_BUILD_STAMP:STRING=${options.buildStamp}`);
            }

            const baseEnv = isWindows() ? await getVsEnvironment() : process.env;
            const env = {
                ...baseEnv,
                VCPKG_ROOT: path.join(BUILD_ROOT, 'vcpkg')  // Help vcpkg find itself faster
            };
            await execCommand(cmakeArgs[0], cmakeArgs.slice(1), { task, env, verbose: options.verbose });

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
                VCPKG_ROOT: path.join(BUILD_ROOT, 'vcpkg')
            };

            if (options.force) {
                task.output = 'Cleaning build directory...';
                await execCommand('cmake', ['--build', BUILD_ROOT, '--target', 'clean'], { task, env, verbose: options.verbose});
            }

            const jobs = getParallelJobs();
            const cmakeArgs = [
                'cmake', '--build', BUILD_ROOT,
                '--config', 'Release',
                '--target', 'engine',
                '--parallel', String(jobs)
            ];
            await execCommand(cmakeArgs[0], cmakeArgs.slice(1), { task, env, verbose: options.verbose });

            // Copy engine to dist
            await mkdir(DIST_DIR);
            const exeExt = isWindows() ? '.exe' : '';
            await syncFile(
                path.join(BUILD_ROOT, 'apps', 'engine', 'engine' + exeExt),
                path.join(DIST_DIR, 'engine' + exeExt),
                { package: true });

            if (isWindows()) {
                await syncFile(
                    path.join(BUILD_ROOT, 'apps', 'engine', 'engine.pdb'),
                    path.join(DIST_DIR, 'engine.pdb'));
            }

            // Save content hash after successful compilation
            await setState('server.contentHash', ctx.contentHash);

            task.output = `Compiled v${version}`;
        }
    };
}

function makeCompileTestsAction(options = {}) {
    return {
        locks: ['cmake'],
        run: async (ctx, task) => {
            // Check source hash to skip if nothing changed since last test build
            if (options.force) {
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
                VCPKG_ROOT: path.join(BUILD_ROOT, 'vcpkg')
            };
            const jobs = getParallelJobs();

            // Build aptest
            task.output = 'Building aptest...';
            const aptestArgs = ['--build', BUILD_ROOT, '--config', 'Release', '--target', 'aptest', '--parallel', String(jobs)];
            await execCommand('cmake', aptestArgs, { task, env, verbose: options.verbose });

            // Build engtest
            task.output = 'Building engtest...';
            const engtestArgs = ['--build', BUILD_ROOT, '--config', 'Release', '--target', 'engtest', '--parallel', String(jobs)];
            await execCommand('cmake', engtestArgs, { task, env, verbose: options.verbose });

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
            let stats = {};
            const subdirs = ['images', 'documents', 'audio', 'video', 'text', 'misc'];
            for (const subdir of subdirs) {
                const src = path.join(testdataDir, subdir);
                if (await exists(src)) {
                    await syncDir(src, destDatasets, { mirror: false }, stats);
                }
            }
            task.output = formatSyncStats(stats);

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
                        path.join(BUILD_ROOT, 'engine-core', 'test', 'Release', 'aptest' + exeExt),
                        path.join(BUILD_ROOT, 'engine-core', 'test', 'aptest' + exeExt)
                    ]
                },
                {
                    name: 'engtest',
                    paths: [
                        path.join(BUILD_ROOT, 'engine-lib', 'test', 'Release', 'engtest' + exeExt),
                        path.join(BUILD_ROOT, 'engine-lib', 'test', 'engtest' + exeExt)
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
                condition: (ctx) => ctx.downloaded || ctx.serverAlreadyBuilt,
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
            await setState('package', null);

            await removeFiles(BUILD_ROOT, [
                'CMakeCache.txt', 'cmake_install.cmake',
                'build.ninja', '.ninja_deps', '.ninja_log', 'compile_commands.json',
                'CPackConfig.cmake', 'CPackSourceConfig.cmake', 'CTestTestfile.cmake',
                'Makefile', 'CMakePresets.json'
            ]);

            // Clean only the server build artifacts; vcpkg state is managed by vcpkg:clean
            await removeDirs([
                path.join(BUILD_ROOT, 'CMakeFiles'),
                path.join(BUILD_ROOT, 'Testing'),
                path.join(BUILD_ROOT, 'apps'),
                path.join(BUILD_ROOT, 'engine-core'),
                path.join(BUILD_ROOT, 'engine-lib'),
                path.join(BUILD_ROOT, 'packages'),
                path.join(BUILD_ROOT, '_download_temp'),
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
                        'tika:submodule-test',
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
            const {
                manifestFilename, distFilename, symDistFilename, distFile, symDistFile
            } = await getPackageInfo(options);
            const symFilename = isWindows() ? 'engine.pdb' : null;

            const sourceHash = await getState('server.contentHash');
            const packageHash = await getState('server.pkgHash');
            if (!sourceHash) {
                throw new Error('Content hash not found — build server first');
            } else if (!options.force && sourceHash === packageHash && await exists(distFile)) {
                _task.output = `Server package ${distFilename} is up to date`;
                return;
            }

            try {
                _task.output = `Packaging ${distFilename}...`;
                await mkdir(DIST_ARTIFACTS_DIR);
                await removeFile(distFile);
                const packageEntries = [];
                const packageState = await getState('package');
                if (!packageState) {
                    throw new Error('Package state not found — build server first');
                }
                for (const [_, values] of Object.entries(packageState)) {
                    packageEntries.push(...values);
                }
                await createArchive(distFile, DIST_DIR, packageEntries);
                _task.output = `Packaged ${distFilename}`;

                if (symDistFile) {
                    _task.output = `Packaging ${symDistFilename}...`;
                    await removeFile(symDistFile);
                    await createArchive(symDistFile, DIST_DIR, [symFilename]);
                    _task.output = `Packaged ${symDistFilename}`;
                }

                await setState('server.pkgHash', sourceHash);

                // Copy state.json without releases as build manifest for download validation
                const state = await readJson(STATE_FILE);
                delete state.server.releases;
                await writeJson(path.join(DIST_ARTIFACTS_DIR, manifestFilename), state);

            } catch (err) {
                await removeFile(distFile);
                if (symDistFile) {
                    await removeFile(symDistFile);
                }
                throw err;
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
        { name: 'server:download', action: makeDownloadAction },
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
