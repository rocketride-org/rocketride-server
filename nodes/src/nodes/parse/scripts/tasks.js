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
 * Build tasks for the parse node's java library
 *
 * Commands:
 *   build - Build the tika jar and copy to dist
 *   clean - Remove build artifacts
 */
const path = require('path');
const {
    syncDir,
    removeDirs, BUILD_ROOT, DIST_ROOT,
    exists, syncFile, setState,
    hasSourceChanged, saveSourceHash, fingerprint
} = require('../../../../../scripts/lib');
const { execMaven } = require('../../../../../packages/java/scripts/tasks');

const PACKAGE_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(DIST_ROOT, 'server', 'java');
const BUILD_DIR = path.join(BUILD_ROOT, 'parse');

// The jar is built from here, maven only writes to BUILD_DIR
const SRC_DIR = path.join(PACKAGE_DIR, 'lib', 'parse');

// A target/ is where the IDE builds the pom, never a build input
const EXCLUDE = ['target'];

// ============================================================================
// Action Factories
// ============================================================================

function makeCheckSourceAction(options = {}) {
    return {
        locks: ['parse'],
        run: async (ctx, task) => {
            task.output = 'Scanning for changes...';
            const { changed } = await hasSourceChanged(SRC_DIR, 'parse.srcHash',
                                                       { exclude: EXCLUDE });
            ctx.parseSourceChanged = changed;
            task.output = changed ? 'Source changed' : 'No changes';
        }
    };
}

function makeBuildJarAction(options = {}) {
    const distParseJar = path.join(DIST_DIR, 'lib', 'rocketride-parse.jar');

    return {
        locks: ['parse', 'maven'],
        run: async (ctx, task) => {
            // Skip if already built
            if (!options.force && !ctx.parseSourceChanged && await exists(distParseJar)) {
                task.output = 'Already built';
                return;
            }


            // includeScope=runtime skips the log4j jars rocketride-core ships
            await execMaven(['clean', 'compile', 'package', 'dependency:copy-dependencies',
                             '-DincludeScope=runtime', '-q',
                             `-Drocketride.build.dir=${BUILD_DIR}`],
                            { task, cwd: SRC_DIR });
        }
    };
}

function makeTestJarAction() {
    return {
        locks: ['maven'],
        run: async (_ctx, task) => {
            await execMaven(['test', '-q', `-Drocketride.build.dir=${BUILD_DIR}`],
                            { task, cwd: SRC_DIR });
        }
    };
}

function makeCopyOutputsAction(options = {}) {
    const distParseJar = path.join(DIST_DIR, 'lib', 'rocketride-parse.jar');

    return {
        locks: ['parse'],
        run: async (ctx, task) => {
            // Skip if already copied
            if (!options.force && !ctx.parseSourceChanged && await exists(distParseJar)) {
                task.output = 'Already copied';
                return;
            }


            const libDir = path.join(DIST_DIR, 'lib');

            // Copy tika-config.xml
            const tikaConfig = path.join(SRC_DIR, 'tika-config.xml');
            await syncFile(tikaConfig, path.join(DIST_DIR, 'tika-config.xml'), { package: true });

            // Copy the parse jar, named by the pom's finalName
            const tikaJar = path.join(BUILD_DIR, 'rocketride-parse.jar');
            await syncFile(tikaJar, distParseJar, { package: true });

            // Copy tika dependencies
            await syncDir(path.join(BUILD_DIR, 'dependency'), libDir, { mirror: false, package: true });

            // Stored once the jar is in the dist, so a failed build is retried
            await saveSourceHash('parse.srcHash',
                                 await fingerprint(SRC_DIR, { exclude: EXCLUDE }));
        }
    };
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
    name: 'parse',
    description: 'Parse Node Java Library',

    actions: [
        // Internal actions
        { name: 'parse:check-source', action: makeCheckSourceAction },
        { name: 'parse:build-jar', action: makeBuildJarAction },
        { name: 'parse:sync', action: makeCopyOutputsAction },
        { name: 'parse:test-jar', action: makeTestJarAction },

        // Submodule actions (called by nodes:build / nodes:clean)
        { name: 'parse:submodule-build', action: () => ({
            steps: [
                // Installs rocketride-core, which this module depends on
                'java:submodule-build',
                'parse:check-source',
                'parse:build-jar',
                'parse:sync'
            ]
        })},
        { name: 'parse:submodule-test', action: () => ({
            steps: [
                'parse:submodule-build',
                'parse:test-jar'
            ]
        })},
        { name: 'parse:submodule-clean', action: () => ({
            run: async (ctx, task) => {
                await removeDirs([BUILD_DIR]);
                await setState('parse.srcHash', null);
                task.output = 'Cleaned parse';
            }
        })}
    ]
};
