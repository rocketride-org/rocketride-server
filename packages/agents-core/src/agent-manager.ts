import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger, ResourceBundle } from './types';
import { BaseAgentInstaller } from './installers/base-installer';
import { ClaudeCodeInstaller } from './installers/claude-code-installer';
import { CursorInstaller } from './installers/cursor-installer';
import { WindsurfInstaller } from './installers/windsurf-installer';
import { CopilotInstaller } from './installers/copilot-installer';
import { ClaudeMdInstaller } from './installers/claude-md-installer';
import { AgentsMdInstaller } from './installers/agents-md-installer';
import { installDocs } from './docs-sync';
import { ensureGitignore } from './docs-sync';

export class AgentManager {
  private readonly installers: BaseAgentInstaller[] = [
    new CursorInstaller(),
    new ClaudeCodeInstaller(),
    new WindsurfInstaller(),
    new CopilotInstaller(),
    new ClaudeMdInstaller(),
    new AgentsMdInstaller(),
  ];

  get supportedAgents(): string[] {
    return this.installers.map((i) => i.name);
  }

  async installAll(bundle: ResourceBundle, workspaceRoot: string, log: Logger): Promise<void> {
    await installDocs(bundle.docsDir, workspaceRoot, log);
    await ensureGitignore(workspaceRoot);
    for (const inst of this.installers) {
      await this.run(inst, bundle.stubsDir, workspaceRoot, log);
    }
  }

  async installFromList(agentNames: string[], bundle: ResourceBundle, workspaceRoot: string, log: Logger): Promise<void> {
    const selected: BaseAgentInstaller[] = [];
    for (const name of agentNames) {
      const inst = this.installers.find((i) => i.name === name);
      if (!inst) {
        throw new Error(`Unknown agent name: ${name}. Supported: ${this.supportedAgents.join(', ')}`);
      }
      selected.push(inst);
    }
    await installDocs(bundle.docsDir, workspaceRoot, log);
    await ensureGitignore(workspaceRoot);
    for (const inst of selected) {
      await this.run(inst, bundle.stubsDir, workspaceRoot, log);
    }
  }

  async uninstallAll(workspaceRoot: string, log: Logger): Promise<void> {
    for (const inst of this.installers) {
      const removed = await inst.uninstall(workspaceRoot);
      if (removed) log(`Removed ${inst.name} agent stub`);
    }
    await this.rmIfExists(path.join(workspaceRoot, '.rocketride/docs'), true, log);
    await this.rmIfExists(path.join(workspaceRoot, '.rocketride/schema'), true, log);
    await this.rmIfExists(path.join(workspaceRoot, '.rocketride/services-catalog.json'), false, log);
  }

  private async run(inst: BaseAgentInstaller, stubsDir: string, workspaceRoot: string, log: Logger): Promise<void> {
    try {
      const installed = await inst.install(stubsDir, workspaceRoot);
      if (installed) log(`Installed ${inst.name} agent stub → ${inst.stubTarget}`);
    } catch (err) {
      log(`Failed to install ${inst.name} agent stub: ${err}`);
    }
  }

  private async rmIfExists(target: string, recursive: boolean, log: Logger): Promise<void> {
    try {
      await fs.rm(target, { recursive, force: true });
      log(`Removed ${path.relative(path.dirname(target), target) || target}`);
    } catch {
      // Already gone.
    }
  }
}
