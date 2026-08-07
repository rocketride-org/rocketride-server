import { BaseAgentInstaller } from './base-installer';
export class ClaudeCodeInstaller extends BaseAgentInstaller {
  readonly name = 'Claude Code';
  readonly stubSource = 'claude-code.md';
  readonly stubTarget = '.claude/rules/rocketride.md';
}
