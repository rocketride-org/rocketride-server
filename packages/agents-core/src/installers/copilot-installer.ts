import { BaseAgentInstaller } from './base-installer';
export class CopilotInstaller extends BaseAgentInstaller {
  readonly name = 'Copilot';
  readonly stubSource = 'copilot-instructions.md';
  readonly stubTarget = '.github/copilot-instructions.md';
}
