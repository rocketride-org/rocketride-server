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
 * Chat UI Build Module
 * 
 * React-based chat interface application.
 */
const path = require('path');
const {
    execCommand, syncDir, formatSyncStats, removeDir, BUILD_ROOT, DIST_ROOT,
    hasSourceChanged, saveSourceHash, setState, exists
} = require('../../../scripts/lib');

// Paths
const APP_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(APP_ROOT, 'src');
const BUILD_DIR = path.join(BUILD_ROOT, 'chat-ui');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'chat');

// State key for source fingerprint
const SRC_HASH_KEY = 'chat-ui.srcHash';

// =============================================================================
// Action Factories
// =============================================================================

function makeBuildChatUiAction() {
    return {
        run: async (ctx, task) => {
            // Check if source changed
            const { changed, hash } = await hasSourceChanged(SRC_DIR, SRC_HASH_KEY);
            const outputExists = await exists(BUILD_DIR);

            if (!changed && outputExists) {
                task.output = 'No changes detected';
                return;
            }

            await execCommand('npx', ['rsbuild', 'build'], { task, cwd: APP_ROOT });

            // Save hash after successful build
            await saveSourceHash(SRC_HASH_KEY, hash);
        }
    };
}

function makeCopyChatUiAction() {
    return {
        run: async (ctx, task) => {
            const stats = await syncDir(BUILD_DIR, SERVER_STATIC_DIR, { package: true });
            task.output = formatSyncStats(stats);
        }
    };
}

// =============================================================================
// Module Definition
// =============================================================================

module.exports = {
    name: 'chat-ui',
    description: 'Chat Interface Application',

    actions: [
        // Internal actions
        { name: 'chat-ui:bundle', action: makeBuildChatUiAction },
        { name: 'chat-ui:copy', action: makeCopyChatUiAction },

        // Public actions (have descriptions)
        { name: 'chat-ui:build', action: () => ({
            description: 'Build chat UI',
            steps: [
                'client-typescript:build',
                'chat-ui:bundle',
                'chat-ui:copy'
            ]
        })},
        { name: 'chat-ui:dev', action: () => ({
            description: 'Dev chat UI',
            run: async (ctx, task) => {
                task.output = 'Starting development server on http://localhost:3000';
                await execCommand('npx', ['rsbuild', 'dev'], { task, cwd: APP_ROOT });
            }
        })},
        { name: 'chat-ui:clean', action: () => ({
            description: 'Clean chat UI',
            run: async (ctx, task) => {
                await removeDir(BUILD_DIR);
                await removeDir(SERVER_STATIC_DIR);
                await removeDir(path.join(APP_ROOT, 'dist'));
                await setState(SRC_HASH_KEY, null);
                task.output = 'Cleaned chat-ui';
            }
        })}
    ]
};
