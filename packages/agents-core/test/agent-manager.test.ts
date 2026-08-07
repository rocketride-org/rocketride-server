import * as path from 'path';
import { mkTempWorkspace, mkBundle, exists } from './helpers';
import { AgentManager } from '../src/agent-manager';
import { DOC_FILES } from '../src/docs-sync';

const STUB = '<!-- ROCKETRIDE:BEGIN -->\nstub\n<!-- ROCKETRIDE:END -->\n';
const docs: Record<string, string> = Object.fromEntries(DOC_FILES.map((f) => [f, `# ${f}\n`]));
const stubs: Record<string, string> = {
  'claude-code.md': STUB,
  'cursor.mdc': STUB,
  'windsurf.md': STUB,
  'copilot-instructions.md': STUB,
  'CLAUDE.md': STUB,
  'AGENTS.md': STUB,
};

describe('AgentManager', () => {
  it('installAll writes docs, gitignore, and every agent stub', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle(stubs, docs);
    const mgr = new AgentManager();
    await mgr.installAll({ docsDir: bundle.docsDir, stubsDir: bundle.stubsDir }, ws, () => undefined);

    expect(await exists(path.join(ws, '.rocketride/docs/ROCKETRIDE_README.md'))).toBe(true);
    expect(await exists(path.join(ws, '.gitignore'))).toBe(true);
    expect(await exists(path.join(ws, '.claude/rules/rocketride.md'))).toBe(true);
    expect(await exists(path.join(ws, '.cursor/rules/rocketride.mdc'))).toBe(true);
    expect(await exists(path.join(ws, '.windsurf/rules/rocketride.md'))).toBe(true);
    expect(await exists(path.join(ws, '.github/copilot-instructions.md'))).toBe(true);
    expect(await exists(path.join(ws, 'CLAUDE.md'))).toBe(true);
    expect(await exists(path.join(ws, 'AGENTS.md'))).toBe(true);
  });

  it('installFromList installs only the named agents', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle(stubs, docs);
    const mgr = new AgentManager();
    await mgr.installFromList(['Claude Code'], { docsDir: bundle.docsDir, stubsDir: bundle.stubsDir }, ws, () => undefined);

    expect(await exists(path.join(ws, '.claude/rules/rocketride.md'))).toBe(true);
    expect(await exists(path.join(ws, '.cursor/rules/rocketride.mdc'))).toBe(false);
  });

  it('installFromList throws on unknown agent names', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle(stubs, docs);
    const mgr = new AgentManager();
    await expect(
      mgr.installFromList(['Bogus'], { docsDir: bundle.docsDir, stubsDir: bundle.stubsDir }, ws, () => undefined),
    ).rejects.toThrow(/Bogus/);
  });

  it('uninstallAll removes stubs and .rocketride/docs/ + schema + catalog', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle(stubs, docs);
    const mgr = new AgentManager();
    await mgr.installAll({ docsDir: bundle.docsDir, stubsDir: bundle.stubsDir }, ws, () => undefined);
    await mgr.uninstallAll(ws, () => undefined);

    expect(await exists(path.join(ws, '.claude/rules/rocketride.md'))).toBe(false);
    expect(await exists(path.join(ws, '.rocketride/docs'))).toBe(false);
  });

  it('supportedAgents returns the six well-known names', () => {
    const mgr = new AgentManager();
    expect(mgr.supportedAgents.sort()).toEqual(
      ['AGENTS.md', 'CLAUDE.md', 'Claude Code', 'Copilot', 'Cursor', 'Windsurf'].sort(),
    );
  });
});
