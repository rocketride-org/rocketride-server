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
 * Build tasks for @rocketride/tika
 * 
 * Commands:
 *   build - Build Java modules and copy to dist
 *   clean - Remove build artifacts
 */
const path = require('path');
const { 
    execCommand, syncDir, formatSyncStats, 
    removeDirs, removeFile, PROJECT_ROOT,
    exists, readDir, readFile, writeFile, mkdir, copyFile,
    parallel
} = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist', 'server', 'java');
const BUILD_DIR = path.join(PROJECT_ROOT, 'build', 'tika');

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
const JAVA_DIR = path.join(PROJECT_ROOT, 'build', 'java');
const JDK_DIR = path.join(JAVA_DIR, 'jdk');
const JRE_DIR = path.join(JAVA_DIR, 'jre');
const MAVEN_DIR = path.join(JAVA_DIR, 'maven');

// Directories to skip when syncing
const SKIP_DIRS = ['target', 'node_modules', '.git', 'scripts'];

// ============================================================================
// Helpers
// ============================================================================

async function getJavaEnv() {
    let jdkPath = JDK_DIR;
    if (await exists(JDK_DIR)) {
        const subdirs = (await readDir(JDK_DIR)).filter(d => d.startsWith('jdk-'));
        if (subdirs.length > 0) {
            jdkPath = path.join(JDK_DIR, subdirs[0]);
        }
    }
    
    let mavenPath = MAVEN_DIR;
    if (await exists(MAVEN_DIR)) {
        const subdirs = (await readDir(MAVEN_DIR)).filter(d => d.startsWith('apache-maven-'));
        if (subdirs.length > 0) {
            mavenPath = path.join(MAVEN_DIR, subdirs[0]);
        }
    }
    
    return {
        jdkPath,
        mavenPath,
        env: {
            ...process.env,
            JAVA_HOME: jdkPath,
            PATH: `${path.join(jdkPath, 'bin')}${path.delimiter}${process.env.PATH}`
        }
    };
}

async function getJrePath() {
    if (await exists(JRE_DIR)) {
        const subdirs = (await readDir(JRE_DIR)).filter(d => d.startsWith('jdk-') || d.startsWith('jre-'));
        if (subdirs.length > 0) {
            return path.join(JRE_DIR, subdirs[0]);
        }
    }
    return JRE_DIR;
}

// ============================================================================
// Action Factories
// ============================================================================

function makeSyncTikaSourceAction(options = {}) {
    return {
        locks: ['tika'],
        run: async (ctx, task) => {
            task.output = 'Scanning for changes...';
            const stats = await syncDir(PACKAGE_DIR, BUILD_DIR, { skipDirs: SKIP_DIRS });
            task.output = formatSyncStats(stats);
            ctx.tikaSourceChanged = stats.copied > 0 || stats.updated > 0;
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
            
            const { env, mavenPath } = await getJavaEnv();
            
            await execCommand(path.join(mavenPath, 'bin', 'mvn'), ['clean', 'compile', 'package', '-q'], {
                task,
                cwd: buildDbgconnDir,
                env
            });
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
            const { env, mavenPath } = await getJavaEnv();
            
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
            
            await execCommand(path.join(mavenPath, 'bin', 'mvn'), ['clean', 'compile', 'package', 'dependency:copy-dependencies', '-q'], {
                task,
                cwd: buildTikaDir,
                env
            });
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
            await mkdir(libDir);
            
            // Copy JRE to dist
            const jreDist = path.join(DIST_DIR, 'jre');
            const jreSrc = await getJrePath();
            if (await exists(jreSrc)) {
                task.output = 'Syncing JRE...';
                const jreStats = await syncDir(jreSrc, jreDist);
                task.output = `JRE: ${formatSyncStats(jreStats)}`;
            }
            
            // Copy tika-config.xml
            const tikaConfig = path.join(buildTikaDir, 'tika-config.xml');
            if (await exists(tikaConfig)) {
                await copyFile(tikaConfig, path.join(DIST_DIR, 'tika-config.xml'));
            }
            
            // Copy dbgconn.jar
            const dbgconnJarWithDeps = path.join(buildDbgconnDir, 'target', 'dbgconn-2.0-jar-with-dependencies.jar');
            const dbgconnJar = path.join(buildDbgconnDir, 'target', 'dbgconn-2.0.jar');
            if (await exists(dbgconnJarWithDeps)) {
                await copyFile(dbgconnJarWithDeps, path.join(libDir, 'dbgconn.jar'));
            } else if (await exists(dbgconnJar)) {
                await copyFile(dbgconnJar, path.join(libDir, 'dbgconn.jar'));
            }
            
            // Copy tika.jar
            const tikaJar = path.join(buildTikaDir, 'target', `tika-${tikaVersion}.jar`);
            if (await exists(tikaJar)) {
                await copyFile(tikaJar, path.join(libDir, 'tika.jar'));
            }
            
            // Copy tika dependencies
            const tikaDepsDir = path.join(buildTikaDir, 'target', 'dependency');
            if (await exists(tikaDepsDir)) {
                const depFiles = (await readDir(tikaDepsDir)).filter(f => f.endsWith('.jar'));
                for (const file of depFiles) {
                    await copyFile(path.join(tikaDepsDir, file), path.join(libDir, file));
                }
                task.output = `Copied ${depFiles.length} dependency jars`;
            }
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
        { name: 'tika:copy-outputs', action: makeCopyTikaOutputsAction },
        
        // Public actions (have descriptions)
        { name: 'tika:build', action: () => ({
            description: 'Build Java modules and copy to dist',
            steps: [
                'java:build',
                'tika:sync-source',
                parallel([
                    'tika:build-dbgconn',
                    'tika:build-jar'
                ], 'Build Java modules'),
                'tika:copy-outputs'
            ]
        })},
        { name: 'tika:clean', action: () => ({
            description: 'Remove tika build artifacts',
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
