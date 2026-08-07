import { BaseAgentInstaller } from './base-installer';
export class CursorInstaller extends BaseAgentInstaller {
  readonly name = 'Cursor';
  readonly stubSource = 'cursor.mdc';
  readonly stubTarget = '.cursor/rules/rocketride.mdc';
}
