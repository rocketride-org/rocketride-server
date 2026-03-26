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
 * Build tasks for @rocketride/tika
 * 
 * Commands:
 *   build - Build Java modules and copy to dist
 *   clean - Remove build artifacts
 */
const path = require('path');
const {
    execCommand, syncDir, formatSyncStats,
    removeDirs, removeFile, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT,
    exists, readFile, writeFile, syncFile,
    parallel
} = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(DIST_ROOT, 'server', 'java');
const BUILD_DIR = path.join(BUILD_ROOT, 'tika');

// Read versions from package.json (loaded async in tasks)
let TIKA_VERSION = '3.2.3';
let packageJsonLoaded = false;

async function loadPackageJson() {
    if (!packageJsonLoaded) {
        const content = await readFile(path.join(PROJECT_ROOT, 'package.json'));
        const packageJson = JSON.parse(content);
        TIKA_VERSION = packageJson.tika?.version || '3.2.3';
        packageJsonLoaded = true;
    }
    return TIKA_VERSION;
}

// Java paths (will be set after java setup)
const JAVA_DIR = path.join(BUILD_ROOT, 'java');
const JDK_DIR = path.join(JAVA_DIR, 'jdk');
const JRE_DIR = path.join(JAVA_DIR, 'jre');
const MAVEN_DIR = path.join(JAVA_DIR, 'maven');
const MAVEN = path.join(MAVEN_DIR, 'bin', 'mvn');

// Glob patterns to ignore when syncing
const IGNORE = ['**/target/**', '**/node_modules/**', '**/.git/**', '**/scripts/**', '**/lib/tika/pom.xml'];

// ============================================================================
// Helpers
// ============================================================================

async function execMaven(args, options = {}) {
    return execCommand(MAVEN, args, {
        ...options,
        env: {
            ...process.env,
            JAVA_HOME: JDK_DIR,
            PATH: `${path.join(JDK_DIR, 'bin')}${path.delimiter}${process.env.PATH}`
        }
    });
}

// ============================================================================
// Action Factories
// ============================================================================

function makeSyncTikaSourceAction(options = {}) {
    return {
        locks: ['tika'],
        run: async (ctx, task) => {
            task.output = 'Scanning for changes...';
            const stats = await syncDir(PACKAGE_DIR, BUILD_DIR, { ignore: IGNORE });
            task.output = formatSyncStats(stats);
            ctx.tikaSourceChanged = stats.changed > 0;
        }
    };
}

function makeBuildDbgconnAction(options = {}) {
    const buildDbgconnDir = path.join(BUILD_DIR, 'lib', 'dbgconn');
    const distDbgconnJar = path.join(DIST_DIR, 'lib', 'dbgconn.jar');

    return {
        locks: ['tika'],
        run: async (ctx, task) => {
            // Skip if already built
            if (!options.force && !ctx.tikaSourceChanged && await exists(distDbgconnJar)) {
                task.output = 'Already built';
                return;
            }

            await execMaven(['clean', 'compile', 'package', '-q'], { task, cwd: buildDbgconnDir });
        }
    };
}

function makeBuildTikaJarAction(options = {}) {
    const buildTikaDir = path.join(BUILD_DIR, 'lib', 'tika');
    const distTikaJar = path.join(DIST_DIR, 'lib', 'tika.jar');

    return {
        locks: ['tika'],
        run: async (ctx, task) => {
            // Skip if already built
            if (!options.force && !ctx.tikaSourceChanged && await exists(distTikaJar)) {
                task.output = 'Already built';
                return;
            }

            const tikaVersion = await loadPackageJson();

            // Generate pom.xml from template
            const pomTemplate = await readFile(path.join(buildTikaDir, 'pom-template.xml'));
            let osClassifier;
            if (process.platform === 'win32') osClassifier = 'win-x86_64';
            else if (process.platform === 'darwin') osClassifier = 'osx-x86_64';
            else osClassifier = 'linux-x86_64';

            const pomContent = pomTemplate
                .replace(/@ROCKETRIDE_TIKA_VERSION@/g, tikaVersion)
                .replace(/@ROCKETRIDE_OPERATING_SYSTEM@/g, osClassifier);
            await writeFile(path.join(buildTikaDir, 'pom.xml'), pomContent);

            task.output = 'Generated pom.xml, building...';

            await execMaven(['clean', 'compile', 'package', 'dependency:copy-dependencies', '-q'], { task, cwd: buildTikaDir });
        }
    };
}

function makeTestDbgconnAction() {
    const buildDbgconnDir = path.join(BUILD_DIR, 'lib', 'dbgconn');

    return {
        run: async (_ctx, task) => {
            await execMaven(['test', '-q'], { task, cwd: buildDbgconnDir });
        }
    };
}

function makeTestTikaJarAction() {
    const buildTikaDir = path.join(BUILD_DIR, 'lib', 'tika');

    return {
        run: async (_ctx, task) => {
            await execMaven(['test', '-q'], { task, cwd: buildTikaDir });
        }
    };
}

function makeCopyTikaOutputsAction(options = {}) {
    const buildDbgconnDir = path.join(BUILD_DIR, 'lib', 'dbgconn');
    const buildTikaDir = path.join(BUILD_DIR, 'lib', 'tika');
    const distDbgconnJar = path.join(DIST_DIR, 'lib', 'dbgconn.jar');
    const distTikaJar = path.join(DIST_DIR, 'lib', 'tika.jar');

    return {
        locks: ['tika'],
        run: async (ctx, task) => {
            // Skip if already copied
            if (!options.force && !ctx.tikaSourceChanged &&
                await exists(distDbgconnJar) && await exists(distTikaJar)) {
                task.output = 'Already copied';
                return;
            }

            const tikaVersion = await loadPackageJson();
            const libDir = path.join(DIST_DIR, 'lib');

            // Copy JRE to dist
            const jreDist = path.join(DIST_DIR, 'jre');
            if (await exists(JRE_DIR)) {
                task.output = 'Syncing JRE...';
                const jreStats = await syncDir(JRE_DIR, jreDist, { package: true });
                task.output = `JRE: ${formatSyncStats(jreStats)}`;
            }

            // Copy tika-config.xml
            const tikaConfig = path.join(buildTikaDir, 'tika-config.xml');
            await syncFile(tikaConfig, path.join(DIST_DIR, 'tika-config.xml'), { package: true });

            // Copy dbgconn.jar
            const dbgconnJarWithDeps = path.join(buildDbgconnDir, 'target', 'dbgconn-2.0-jar-with-dependencies.jar');
            const dbgconnJar = path.join(buildDbgconnDir, 'target', 'dbgconn-2.0.jar');
            if (await exists(dbgconnJarWithDeps)) {
                await syncFile(dbgconnJarWithDeps, path.join(libDir, 'dbgconn.jar'), { package: true });
            } else if (await exists(dbgconnJar)) {
                await syncFile(dbgconnJar, path.join(libDir, 'dbgconn.jar'), { package: true });
            }

            // Copy tika.jar
            const tikaJar = path.join(buildTikaDir, 'target', `tika-${tikaVersion}.jar`);
            await syncFile(tikaJar, path.join(libDir, 'tika.jar'), { package: true });

            // Copy tika dependencies
            await syncDir(path.join(buildTikaDir, 'target', 'dependency'), libDir, { mirror: false, package: true });
        }
    };
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
    name: 'tika',
    description: 'Java/Tika Document Parser',

    actions: [
        // Internal actions
        { name: 'tika:sync-source', action: makeSyncTikaSourceAction },
        { name: 'tika:build-dbgconn', action: makeBuildDbgconnAction },
        { name: 'tika:build-jar', action: makeBuildTikaJarAction },
        { name: 'tika:sync', action: makeCopyTikaOutputsAction },
        { name: 'tika:test-dbgconn', action: makeTestDbgconnAction },
        { name: 'tika:test-jar', action: makeTestTikaJarAction },

        // Submodule actions (called by server:build-core / server:clean-all)
        { name: 'tika:submodule-build', action: () => ({
            steps: [
                'java:submodule-build',
                'tika:sync-source',
                parallel([
                    'tika:build-dbgconn',
                    'tika:build-jar'
                ], 'Build Java modules'),
                'tika:sync'
            ]
        })},
        { name: 'tika:submodule-test', action: () => ({
            steps: [
                'tika:submodule-build',
                parallel([
                    'tika:test-dbgconn',
                    'tika:test-jar'
                ], 'Test Java modules')
            ]                
        })},
        { name: 'tika:submodule-clean', action: () => ({
            run: async (ctx, task) => {
                await removeDirs([
                    BUILD_DIR,
                    DIST_DIR,
                    path.join(PACKAGE_DIR, 'lib', 'tika', 'target'),
                    path.join(PACKAGE_DIR, 'lib', 'dbgconn', 'target'),
                    path.join(PACKAGE_DIR, 'dist')
                ]);
                await removeFile(path.join(PACKAGE_DIR, 'lib', 'tika', 'pom.xml'));
                task.output = 'Cleaned tika';
            }
        })}
    ]
};
