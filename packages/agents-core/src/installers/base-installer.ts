import * as fs from 'fs/promises';
import * as path from 'path';

const MARKER_BEGIN = '<!-- ROCKETRIDE:BEGIN -->';
const MARKER_END = '<!-- ROCKETRIDE:END -->';

export abstract class BaseAgentInstaller {
  abstract readonly name: string;
  abstract readonly stubSource: string;
  abstract readonly stubTarget: string;

  async readStub(stubsDir: string): Promise<string> {
    return fs.readFile(path.join(stubsDir, this.stubSource), 'utf8');
  }

  async install(stubsDir: string, workspaceRoot: string): Promise<boolean> {
    const stub = await this.readStub(stubsDir);
    const target = path.join(workspaceRoot, this.stubTarget);
    await fs.mkdir(path.dirname(target), { recursive: true });

    let existing = '';
    try {
      existing = await fs.readFile(target, 'utf8');
    } catch {
      // File doesn't exist — will create.
    }

    const next = this.mergeContent(existing, stub);
    if (next.replace(/\r\n/g, '\n') === existing.replace(/\r\n/g, '\n')) {
      return false;
    }
    await fs.writeFile(target, next, 'utf8');
    return true;
  }

  async isInstalled(workspaceRoot: string): Promise<boolean> {
    try {
      const content = await fs.readFile(path.join(workspaceRoot, this.stubTarget), 'utf8');
      return content.includes(MARKER_BEGIN) && content.includes(MARKER_END);
    } catch {
      return false;
    }
  }

  async uninstall(workspaceRoot: string): Promise<boolean> {
    const target = path.join(workspaceRoot, this.stubTarget);
    let existing: string;
    try {
      existing = await fs.readFile(target, 'utf8');
    } catch {
      return false;
    }
    const stripped = this.stripMarkedContent(existing);
    if (stripped.trim() === '') {
      await fs.unlink(target);
    } else {
      await fs.writeFile(target, stripped, 'utf8');
    }
    return true;
  }

  protected mergeContent(existing: string, stubContent: string): string {
    if (existing === '') return stubContent;
    const beginIdx = existing.indexOf(MARKER_BEGIN);
    const endIdx = existing.indexOf(MARKER_END);
    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      const before = existing.substring(0, beginIdx);
      const after = existing.substring(endIdx + MARKER_END.length);
      return before + this.extractMarkedContent(stubContent) + after;
    }
    return existing.trimEnd() + '\n\n' + stubContent;
  }

  private extractMarkedContent(stubContent: string): string {
    const beginIdx = stubContent.indexOf(MARKER_BEGIN);
    const endIdx = stubContent.indexOf(MARKER_END);
    if (beginIdx !== -1 && endIdx !== -1) {
      return stubContent.substring(beginIdx, endIdx + MARKER_END.length);
    }
    return `${MARKER_BEGIN}\n${stubContent}\n${MARKER_END}`;
  }

  private stripMarkedContent(content: string): string {
    const beginIdx = content.indexOf(MARKER_BEGIN);
    const endIdx = content.indexOf(MARKER_END);
    if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return content;
    const before = content.substring(0, beginIdx);
    const after = content.substring(endIdx + MARKER_END.length);
    return (before + after).replace(/\n{3,}/g, '\n\n').trim();
  }
}
