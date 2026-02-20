/**
 * Chat UI Build Module
 * 
 * React-based chat interface application.
 */
const path = require('path');
const { 
    execCommand, syncDir, formatSyncStats, removeDir, PROJECT_ROOT,
    hasSourceChanged, saveSourceHash, setState, exists
} = require('../../../scripts/lib');

// Paths
const APP_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(APP_ROOT, 'src');
const BUILD_DIR = path.join(PROJECT_ROOT, 'build', 'chat-ui');
const SERVER_STATIC_DIR = path.join(PROJECT_ROOT, 'dist', 'server', 'static', 'chat');

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
            const stats = await syncDir(BUILD_DIR, SERVER_STATIC_DIR);
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
            description: 'Build production bundle',
            steps: [
                'client-typescript:compile',
                'chat-ui:bundle',
                'chat-ui:copy'
            ]
        })},
        { name: 'chat-ui:dev', action: () => ({
            description: 'Start development server',
            run: async (ctx, task) => {
                task.output = 'Starting development server on http://localhost:3000';
                await execCommand('npx', ['rsbuild', 'dev'], { task, cwd: APP_ROOT });
            }
        })},
        { name: 'chat-ui:clean', action: () => ({
            description: 'Remove chat-ui build artifacts',
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
