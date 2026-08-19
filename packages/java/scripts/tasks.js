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
 * Java Build Module
 *
 * Handles downloading JDK, JRE, and Maven, and builds the engine's java
 * libraries: rocketride-core and rocketride-dbgconn.
 */
const path = require('path');
const {
    withLock, getState, setState,
    downloadFile, extractArchive,
    removeDir, removeDirs, removeFile, getPlatform, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT,
    exists, readJson, mkdir, hasSourceChanged, saveSourceHash, fingerprint,
    execCommand, syncDir, syncFile, formatSyncStats,
    parallel
} = require('../../../scripts/lib');

// Paths
const PACKAGE_DIR = path.join(__dirname, '..');
const BUILD_DIR = path.join(BUILD_ROOT, 'java');
const JDK_DIR = path.join(BUILD_DIR, 'jdk');
const JRE_DIR = path.join(BUILD_DIR, 'jre');
const MAVEN_DIR = path.join(BUILD_DIR, 'maven');
const MAVEN = path.join(MAVEN_DIR, 'bin', 'mvn');

// Maven repository shared by every java build in the tree
const LIB_DIR = path.join(PACKAGE_DIR, 'lib');
const M2_DIR = path.join(BUILD_ROOT, 'm2');
const DIST_DIR = path.join(DIST_ROOT, 'server', 'java');

// A target/ is where the IDE builds the poms, never a build input
const EXCLUDE = ['target'];

// Read versions from package.json (loaded async in tasks)
let MAVEN_VERSION = '3.9.6';
let JDK_VERSION = '17';
let packageJsonLoaded = false;

async function loadPackageJson() {
    if (!packageJsonLoaded) {
        const packageJson = await readJson(path.join(PROJECT_ROOT, 'package.json'));
        MAVEN_VERSION = packageJson.java?.mavenVersion || '3.9.6';
        JDK_VERSION = packageJson.java?.jdkVersion || '17';
        packageJsonLoaded = true;
    }
    return { mavenVersion: MAVEN_VERSION, jdkVersion: JDK_VERSION };
}

// =============================================================================
// Helpers
// =============================================================================

function getMavenUrl() {
    return `https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz`;
}

function getJdkUrl() {
    const { os: osName, arch } = getPlatform();
    return `https://api.adoptium.net/v3/binary/latest/${JDK_VERSION}/ga/${osName}/${arch}/jdk/hotspot/normal/eclipse`;
}

function getJreUrl() {
    const { os: osName, arch } = getPlatform();
    return `https://api.adoptium.net/v3/binary/latest/${JDK_VERSION}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse`;
}

async function execMaven(args, options = {}) {
    return execCommand(MAVEN, ['-B', `-Dmaven.repo.local=${M2_DIR}`, ...args], {
        ...options,
        env: {
            ...process.env,
            JAVA_HOME: JDK_DIR,
            PATH: `${path.join(JDK_DIR, 'bin')}${path.delimiter}${process.env.PATH}`,
            MAVEN_OPTS: `${process.env.MAVEN_OPTS || ''} -Xmx1024m`.trim()
        }
    });
}

// =============================================================================
// Action Factories
// =============================================================================

function makeSetupJdkAction(options = {}) {
    return {
        locks: ['java-jdk'],
        outputLines: 1,
        run: async (ctx, task) => {
            const { jdkVersion } = await loadPackageJson();

            // Skip if already installed
            if (!options.force && await getState('java.jdk') === 'installed' && await exists(JDK_DIR)) {
                task.output = `JDK ${jdkVersion} already installed`;
                return;
            }

            const { ext, os } = getPlatform();
            task.output = `Downloading JDK ${jdkVersion}...`;
            await mkdir(BUILD_DIR);

            await withLock('java-jdk', async () => {
                const archivePath = await downloadFile(getJdkUrl(), `jdk-${jdkVersion}.${ext}`, task);
                const stripLevels = os === "mac" ? 3 : 1;
                task.output = 'Extracting...';
                await extractArchive(archivePath, JDK_DIR, { stripLevels: stripLevels });
                await setState('java.jdk', 'installed');
            });

            task.output = `JDK ${jdkVersion} installed`;
        }
    };
}

function makeSetupMavenAction(options = {}) {
    return {
        locks: ['java-maven'],
        outputLines: 1,
        run: async (ctx, task) => {
            const { mavenVersion } = await loadPackageJson();

            // Skip if already installed
            if (!options.force && await getState('java.maven') === 'installed' && await exists(MAVEN_DIR)) {
                task.output = `Maven ${mavenVersion} already installed`;
                return;
            }

            task.output = `Downloading Maven ${mavenVersion}...`;

            await withLock('java-maven', async () => {
                const archivePath = await downloadFile(getMavenUrl(), `maven-${mavenVersion}.tar.gz`, task);
                task.output = 'Extracting...';
                await extractArchive(archivePath, MAVEN_DIR, { stripLevels: 1 });
                await setState('java.maven', 'installed');
            });

            task.output = `Maven ${mavenVersion} installed`;
        }
    };
}

function makeSetupJreAction(options = {}) {
    return {
        locks: ['java-jre'],
        outputLines: 1,
        run: async (ctx, task) => {
            const { jdkVersion } = await loadPackageJson();

            // Skip if already installed
            if (!options.force && await getState('java.jre') === 'installed' && await exists(JRE_DIR)) {
                task.output = `JRE ${jdkVersion} already installed`;
                return;
            }

            const { ext, os } = getPlatform();
            task.output = `Downloading JRE ${jdkVersion}...`;

            await withLock('java-jre', async () => {
                const archivePath = await downloadFile(getJreUrl(), `jre-${jdkVersion}.${ext}`, task);
                const stripLevels = os === "mac" ? 3 : 1;
                task.output = 'Extracting...';
                await extractArchive(archivePath, JRE_DIR, { stripLevels: stripLevels });
                await setState('java.jre', 'installed');
            });

            task.output = `JRE ${jdkVersion} installed`;
        }
    };
}

function makeCheckSourceAction(options = {}) {
    return {
        locks: ['java-src'],
        run: async (ctx, task) => {
            task.output = 'Scanning for changes...';
            const { changed } = await hasSourceChanged(LIB_DIR, 'java.srcHash',
                                                       { exclude: EXCLUDE });
            ctx.javaSourceChanged = changed;
            task.output = changed ? 'Source changed' : 'No changes';
        }
    };
}

function makeBuildCoreAction(options = {}) {
    const srcCoreDir = path.join(LIB_DIR, 'core');
    const buildCoreDir = path.join(BUILD_DIR, 'core');
    const distCoreJar = path.join(DIST_DIR, 'lib', 'rocketride-core.jar');

    return {
        locks: ['maven'],
        run: async (ctx, task) => {
            // Skip if already built
            if (!options.force && !ctx.javaSourceChanged && await exists(distCoreJar)) {
                task.output = 'Already built';
                return;
            }

            // Installed so the tika module can resolve it
            await execMaven(['clean', 'compile', 'package', 'install',
                             'dependency:copy-dependencies', '-q',
                             `-Drocketride.build.dir=${buildCoreDir}`],
                            { task, cwd: srcCoreDir });
        }
    };
}

function makeBuildDbgconnAction(options = {}) {
    const srcDbgconnDir = path.join(LIB_DIR, 'dbgconn');
    const buildDbgconnDir = path.join(BUILD_DIR, 'dbgconn');
    const distDbgconnJar = path.join(DIST_DIR, 'lib', 'rocketride-dbgconn.jar');

    return {
        locks: ['maven'],
        run: async (ctx, task) => {
            // Skip if already built
            if (!options.force && !ctx.javaSourceChanged && await exists(distDbgconnJar)) {
                task.output = 'Already built';
                return;
            }

            await execMaven(['clean', 'compile', 'package', '-q',
                             `-Drocketride.build.dir=${buildDbgconnDir}`],
                            { task, cwd: srcDbgconnDir });
        }
    };
}

function makeTestDbgconnAction() {
    const srcDbgconnDir = path.join(LIB_DIR, 'dbgconn');
    const buildDbgconnDir = path.join(BUILD_DIR, 'dbgconn');

    return {
        locks: ['maven'],
        run: async (_ctx, task) => {
            await execMaven(['test', '-q', `-Drocketride.build.dir=${buildDbgconnDir}`],
                            { task, cwd: srcDbgconnDir });
        }
    };
}

function makeSyncOutputsAction(options = {}) {
    const buildCoreDir = path.join(BUILD_DIR, 'core');
    const buildDbgconnDir = path.join(BUILD_DIR, 'dbgconn');
    const distCoreJar = path.join(DIST_DIR, 'lib', 'rocketride-core.jar');
    const distDbgconnJar = path.join(DIST_DIR, 'lib', 'rocketride-dbgconn.jar');

    return {
        locks: ['java-src'],
        run: async (ctx, task) => {
            // Skip if already copied
            if (!options.force && !ctx.javaSourceChanged &&
                await exists(distCoreJar) && await exists(distDbgconnJar)) {
                task.output = 'Already copied';
                return;
            }

            const libDir = path.join(DIST_DIR, 'lib');

            // Drop the pre-rename jars, getJars() takes every jar it finds
            for (const legacy of ['dbgconn.jar', 'tika.jar'])
                await removeFile(path.join(libDir, legacy));

            // Copy JRE to dist
            const jreDist = path.join(DIST_DIR, 'jre');
            if (await exists(JRE_DIR)) {
                task.output = 'Syncing JRE...';
                const jreStats = await syncDir(JRE_DIR, jreDist, { package: true });
                task.output = `JRE: ${formatSyncStats(jreStats)}`;
            }

            // Copy rocketride-core.jar and its log4j dependencies
            await syncFile(path.join(buildCoreDir, 'rocketride-core-1.0.jar'),
                           distCoreJar, { package: true });
            await syncDir(path.join(buildCoreDir, 'dependency'), libDir,
                          { mirror: false, package: true });

            // Copy rocketride-dbgconn.jar
            const dbgconnJarWithDeps = path.join(buildDbgconnDir, 'rocketride-dbgconn-2.0-jar-with-dependencies.jar');
            const dbgconnJar = path.join(buildDbgconnDir, 'rocketride-dbgconn-2.0.jar');
            if (await exists(dbgconnJarWithDeps)) {
                await syncFile(dbgconnJarWithDeps, distDbgconnJar, { package: true });
            } else if (await exists(dbgconnJar)) {
                await syncFile(dbgconnJar, distDbgconnJar, { package: true });
            }

            // Store hash if build/copy passed
            await saveSourceHash('java.srcHash',
                                 await fingerprint(LIB_DIR, { exclude: EXCLUDE }));
        }
    };
}

// =============================================================================
// Module Definition
// =============================================================================

module.exports = {
    name: 'java',
    description: 'Java Development Kit & Maven',

    actions: [
        // Internal actions
        { name: 'java:setup-jdk', action: makeSetupJdkAction },
        { name: 'java:setup-maven', action: makeSetupMavenAction },
        { name: 'java:setup-jre', action: makeSetupJreAction },
        { name: 'java:check-source', action: makeCheckSourceAction },
        { name: 'java:build-core', action: makeBuildCoreAction },
        { name: 'java:build-dbgconn', action: makeBuildDbgconnAction },
        { name: 'java:sync', action: makeSyncOutputsAction },
        { name: 'java:test-dbgconn', action: makeTestDbgconnAction },

        // Submodule actions (called by server:build-core / server:clean-all)
        { name: 'java:submodule-build', action: () => ({
            steps: [
                parallel([
                    'java:setup-jdk',
                    'java:setup-maven',
                    'java:setup-jre'
                ], 'Setup Java tools'),
                'java:check-source',
                // Sequential: they share one maven repository
                'java:build-core',
                'java:build-dbgconn',
                'java:sync'
            ]
        })},
        { name: 'java:submodule-test', action: () => ({
            steps: [
                'java:submodule-build',
                'java:test-dbgconn'
            ]
        })},
        { name: 'java:submodule-clean', action: () => ({
            run: async (ctx, task) => {
                await withLock('java-setup', async () => {
                    await removeDirs([BUILD_DIR, M2_DIR, DIST_DIR]);
                    await setState('java.jdk', null);
                    await setState('java.maven', null);
                    await setState('java.jre', null);
                    await setState('java.srcHash', null);
                });
                task.output = 'Cleaned Java';
            }
        })}
    ]
};

// Export for direct use
module.exports.JDK_DIR = JDK_DIR;
module.exports.JRE_DIR = JRE_DIR;
module.exports.MAVEN_DIR = MAVEN_DIR;
module.exports.M2_DIR = M2_DIR;
module.exports.DIST_DIR = DIST_DIR;
module.exports.execMaven = execMaven;
