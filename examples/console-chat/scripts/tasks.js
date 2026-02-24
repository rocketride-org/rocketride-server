/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Build tasks for @rocketride/example-console-chat
 *
 * Commands:
 *   build - Compile TypeScript example
 *   clean - Remove build artifacts
 */
const path = require('path');
const { 
    execCommand, removeDirs, removeDirAndParents, PROJECT_ROOT,
    hasSourceChanged, saveSourceHash, setState, exists, mkdir, copyFile
} = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist', 'examples', 'console-chat');

// State key for source fingerprint
const SRC_HASH_KEY = 'console-chat.srcHash';

// ============================================================================
// Action Factories
// ============================================================================

function makeCompileConsoleChatAction() {
    return {
        run: async (ctx, task) => {
            // Check if source changed
            const { changed, hash } = await hasSourceChanged(SRC_DIR, SRC_HASH_KEY);
            const outputExists = await exists(DIST_DIR);
            
            if (!changed && outputExists) {
                task.output = 'No changes detected';
                return;
            }
            
            await execCommand('npx', ['tsc'], { task, cwd: PACKAGE_DIR });
            
            // Save hash after successful compile
            await saveSourceHash(SRC_HASH_KEY, hash);
        }
    };
}

function makeCopyPipelineConfigAction() {
    return {
        run: async (ctx, task) => {
            const srcFile = path.join(PACKAGE_DIR, 'chat.pipe.json');
            const destFile = path.join(DIST_DIR, 'chat.pipe.json');
            
            if (await exists(srcFile)) {
                await mkdir(DIST_DIR);
                await copyFile(srcFile, destFile);
                task.output = 'Copied chat.pipe.json to dist/';
            } else {
                task.output = 'No pipeline config found';
            }
        }
    };
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
    name: 'console-chat',
    description: 'Console Chat Example',
    
    actions: [
        // Internal actions
        { name: 'console-chat:compile', action: makeCompileConsoleChatAction },
        { name: 'console-chat:copy-config', action: makeCopyPipelineConfigAction },
        
        // Public actions (have descriptions)
        { name: 'console-chat:build', action: () => ({
            description: 'Build console chat example',
            steps: [
                'client-typescript:build',
                'console-chat:compile',
                'console-chat:copy-config'
            ]
        })},
        { name: 'console-chat:clean', action: () => ({
            description: 'Clean console chat example',
            run: async (ctx, task) => {
                await removeDirs([path.join(PACKAGE_DIR, 'dist')]);
                await removeDirAndParents(PROJECT_ROOT, DIST_DIR);
                await setState(SRC_HASH_KEY, null);
                task.output = 'Cleaned console-chat';
            }
        })}
    ]
};
