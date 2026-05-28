import * as path from 'path';
import { ResourceBundle } from './types';

export { AgentManager } from './agent-manager';
export { BaseAgentInstaller } from './installers/base-installer';
export { ClaudeCodeInstaller } from './installers/claude-code-installer';
export { CursorInstaller } from './installers/cursor-installer';
export { WindsurfInstaller } from './installers/windsurf-installer';
export { CopilotInstaller } from './installers/copilot-installer';
export { ClaudeMdInstaller } from './installers/claude-md-installer';
export { AgentsMdInstaller } from './installers/agents-md-installer';
export { installDocs, ensureGitignore, DOC_FILES } from './docs-sync';
export { syncServiceCatalog } from './catalog-sync';
export type { Logger, ResourceBundle } from './types';

/**
 * Resolve the bundle that ships inside this package. Both extension (P3) and
 * CLI (P2) get a sensible default when no override is supplied.
 */
export function defaultBundle(): ResourceBundle {
  const docsDir = path.resolve(__dirname, '..', 'docs');
  return {
    docsDir,
    stubsDir: path.join(docsDir, 'stubs'),
  };
}
