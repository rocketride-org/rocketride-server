import * as fs from 'fs/promises';
import * as path from 'path';
import { mkTempWorkspace, mkBundle, readFile, exists } from './helpers';
import { installDocs, ensureGitignore, DOC_FILES } from '../src/docs-sync';

const docs: Record<string, string> = Object.fromEntries(
  DOC_FILES.map((f) => [f, `# ${f}\nbody for ${f}\n`])
);

describe('installDocs', () => {
  it('writes all 8 doc files into .rocketride/docs/', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({}, docs);
    await installDocs(bundle.docsDir, ws, () => undefined);
    for (const file of DOC_FILES) {
      expect(await exists(path.join(ws, '.rocketride/docs', file))).toBe(true);
    }
  });

  it('removes obsolete files from .rocketride/docs/', async () => {
    const ws = await mkTempWorkspace();
    const obsolete = path.join(ws, '.rocketride/docs/STALE.md');
    await fs.mkdir(path.dirname(obsolete), { recursive: true });
    await fs.writeFile(obsolete, 'stale', 'utf8');
    const bundle = await mkBundle({}, docs);
    await installDocs(bundle.docsDir, ws, () => undefined);
    expect(await exists(obsolete)).toBe(false);
  });

  it('is idempotent: re-running does not modify files whose content matches', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({}, docs);
    await installDocs(bundle.docsDir, ws, () => undefined);
    const file = path.join(ws, '.rocketride/docs/ROCKETRIDE_README.md');
    const mtimeBefore = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await installDocs(bundle.docsDir, ws, () => undefined);
    const mtimeAfter = (await fs.stat(file)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

describe('ensureGitignore', () => {
  it('creates .gitignore with the .rocketride/ entry when missing', async () => {
    const ws = await mkTempWorkspace();
    await ensureGitignore(ws);
    const content = await readFile(path.join(ws, '.gitignore'));
    expect(content.trim().split('\n')).toContain('.rocketride/');
  });

  it('appends the entry when .gitignore exists without it', async () => {
    const ws = await mkTempWorkspace();
    await fs.writeFile(path.join(ws, '.gitignore'), 'node_modules/\n', 'utf8');
    await ensureGitignore(ws);
    const content = await readFile(path.join(ws, '.gitignore'));
    expect(content).toContain('node_modules/');
    expect(content).toContain('.rocketride/');
  });

  it('is a no-op when entry already present', async () => {
    const ws = await mkTempWorkspace();
    const existing = 'node_modules/\n.rocketride/\n';
    await fs.writeFile(path.join(ws, '.gitignore'), existing, 'utf8');
    await ensureGitignore(ws);
    const content = await readFile(path.join(ws, '.gitignore'));
    expect(content).toBe(existing);
  });
});
