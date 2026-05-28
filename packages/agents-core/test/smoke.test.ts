import * as path from 'path';
import { mkTempWorkspace, exists } from './helpers';
import { AgentManager, defaultBundle, DOC_FILES } from '../src';

describe('smoke: installAll using bundled docs', () => {
  it('produces the canonical .rocketride/ + agent stub layout', async () => {
    const ws = await mkTempWorkspace();
    const mgr = new AgentManager();
    await mgr.installAll(defaultBundle(), ws, () => undefined);

    for (const f of DOC_FILES) {
      expect(await exists(path.join(ws, '.rocketride/docs', f))).toBe(true);
    }
    expect(await exists(path.join(ws, '.gitignore'))).toBe(true);
    for (const stubTarget of [
      '.claude/rules/rocketride.md',
      '.cursor/rules/rocketride.mdc',
      '.windsurf/rules/rocketride.md',
      '.github/copilot-instructions.md',
      'CLAUDE.md',
      'AGENTS.md',
    ]) {
      expect(await exists(path.join(ws, stubTarget))).toBe(true);
    }
  });

  it('re-run is a no-op (idempotent)', async () => {
    const ws = await mkTempWorkspace();
    const mgr = new AgentManager();
    await mgr.installAll(defaultBundle(), ws, () => undefined);

    const { stat } = await import('fs/promises');
    const target = path.join(ws, '.claude/rules/rocketride.md');
    const mtimeBefore = (await stat(target)).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await mgr.installAll(defaultBundle(), ws, () => undefined);
    const mtimeAfter = (await stat(target)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
