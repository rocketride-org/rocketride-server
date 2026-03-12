/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

/**
 * Dropper UI Build Module
 * 
 * React-based file dropper/uploader interface application.
 */
const path = require('path');
const {
    execCommand, syncDir, formatSyncStats, removeDir, BUILD_ROOT, DIST_ROOT,
    hasSourceChanged, saveSourceHash, setState, exists
} = require('../../../scripts/lib');

// Paths
const APP_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(APP_ROOT, 'src');
const BUILD_DIR = path.join(BUILD_ROOT, 'dropper-ui');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'dropper');

// State key for source fingerprint
const SRC_HASH_KEY = 'dropper-ui.srcHash';

// =============================================================================
// Action Factories
// =============================================================================

function makeBuildDropperUiAction() {
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

function makeCopyDropperUiAction() {
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
    name: 'dropper-ui',
    description: 'File Dropper Application',

    actions: [
        // Internal actions
        { name: 'dropper-ui:bundle', action: makeBuildDropperUiAction },
        { name: 'dropper-ui:copy', action: makeCopyDropperUiAction },

        // Public actions (have descriptions)
        { name: 'dropper-ui:build', action: () => ({
            description: 'Build dropper UI',
            steps: [
                'client-typescript:build',
                'dropper-ui:bundle',
                'dropper-ui:copy'
            ]
        })},
        { name: 'dropper-ui:dev', action: () => ({
            description: 'Dev dropper UI',
            run: async (ctx, task) => {
                task.output = 'Starting development server on http://localhost:3000';
                await execCommand('npx', ['rsbuild', 'dev'], { task, cwd: APP_ROOT });
            }
        })},
        { name: 'dropper-ui:clean', action: () => ({
            description: 'Clean dropper UI',
            run: async (ctx, task) => {
                await removeDir(BUILD_DIR);
                await removeDir(SERVER_STATIC_DIR);
                await removeDir(path.join(APP_ROOT, 'dist'));
                await setState(SRC_HASH_KEY, null);
                task.output = 'Cleaned dropper-ui';
            }
        })}
    ]
};
