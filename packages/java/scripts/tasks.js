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
 * Java Build Module
 * 
 * Handles downloading JDK, JRE, and Maven.
 */
const path = require('path');
const { 
    withLock, getState, setState,
    downloadFile, extractArchive,
    removeDir, getPlatform, PROJECT_ROOT,
    exists, readJson, mkdir,
    parallel
} = require('../../../scripts/lib');

// Paths
const BUILD_DIR = path.join(PROJECT_ROOT, 'build', 'java');
const JDK_DIR = path.join(BUILD_DIR, 'jdk');
const JRE_DIR = path.join(BUILD_DIR, 'jre');
const MAVEN_DIR = path.join(BUILD_DIR, 'maven');

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
        
        // Submodule actions (called by server:build-core / server:clean-all)
        { name: 'java:submodule-build', action: () => ({
            steps: [
                parallel([
                    'java:setup-jdk',
                    'java:setup-maven',
                    'java:setup-jre'
                ], 'Setup Java tools')
            ]
        })},
        { name: 'java:submodule-clean', action: () => ({
            run: async (ctx, task) => {
                await withLock('java-setup', async () => {
                    await removeDir(BUILD_DIR);
                    await setState('java.jdk', null);
                    await setState('java.maven', null);
                    await setState('java.jre', null);
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
