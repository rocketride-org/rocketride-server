import { BaseAgentInstaller } from './base-installer';
export class WindsurfInstaller extends BaseAgentInstaller {
  readonly name = 'Windsurf';
  readonly stubSource = 'windsurf.md';
  readonly stubTarget = '.windsurf/rules/rocketride.md';
}
