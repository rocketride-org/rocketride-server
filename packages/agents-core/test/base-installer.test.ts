import * as path from 'path';
import { mkTempWorkspace, mkBundle, readFile, exists } from './helpers';
import { BaseAgentInstaller } from '../src/installers/base-installer';

class TestInstaller extends BaseAgentInstaller {
  readonly name = 'Test';
  readonly stubSource = 'test.md';
  readonly stubTarget = 'subdir/test.md';
}

const STUB = '<!-- ROCKETRIDE:BEGIN -->\nrocketride stub\n<!-- ROCKETRIDE:END -->\n';

describe('BaseAgentInstaller', () => {
  it('creates target file with marker block when file does not exist', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': STUB });
    const inst = new TestInstaller();
    const wrote = await inst.install(bundle.stubsDir, ws);
    expect(wrote).toBe(true);
    const content = await readFile(path.join(ws, 'subdir/test.md'));
    expect(content).toBe(STUB);
  });

  it('appends marker block when file exists without markers', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': STUB });
    const target = path.join(ws, 'subdir/test.md');
    await (await import('fs/promises')).mkdir(path.dirname(target), { recursive: true });
    await (await import('fs/promises')).writeFile(target, 'user content\n', 'utf8');

    const inst = new TestInstaller();
    await inst.install(bundle.stubsDir, ws);
    const content = await readFile(target);
    expect(content.startsWith('user content')).toBe(true);
    expect(content).toContain('<!-- ROCKETRIDE:BEGIN -->');
    expect(content).toContain('rocketride stub');
    expect(content).toContain('<!-- ROCKETRIDE:END -->');
  });

  it('replaces marker block in place when file already has one', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': '<!-- ROCKETRIDE:BEGIN -->\nNEW\n<!-- ROCKETRIDE:END -->\n' });
    const target = path.join(ws, 'subdir/test.md');
    await (await import('fs/promises')).mkdir(path.dirname(target), { recursive: true });
    await (await import('fs/promises')).writeFile(target, 'pre\n<!-- ROCKETRIDE:BEGIN -->\nOLD\n<!-- ROCKETRIDE:END -->\npost\n', 'utf8');

    const inst = new TestInstaller();
    await inst.install(bundle.stubsDir, ws);
    const content = await readFile(target);
    expect(content).toContain('pre');
    expect(content).toContain('post');
    expect(content).toContain('NEW');
    expect(content).not.toContain('OLD');
  });

  it('is idempotent: second install with identical content returns false and does not rewrite', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': STUB });
    const inst = new TestInstaller();
    await inst.install(bundle.stubsDir, ws);
    const wroteAgain = await inst.install(bundle.stubsDir, ws);
    expect(wroteAgain).toBe(false);
  });

  it('uninstall removes marker block and deletes the file if it becomes empty', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': STUB });
    const inst = new TestInstaller();
    await inst.install(bundle.stubsDir, ws);
    const removed = await inst.uninstall(ws);
    expect(removed).toBe(true);
    expect(await exists(path.join(ws, 'subdir/test.md'))).toBe(false);
  });

  it('uninstall preserves non-stub content', async () => {
    const ws = await mkTempWorkspace();
    await mkBundle({ 'test.md': STUB });
    const target = path.join(ws, 'subdir/test.md');
    await (await import('fs/promises')).mkdir(path.dirname(target), { recursive: true });
    await (await import('fs/promises')).writeFile(target, 'keep me\n<!-- ROCKETRIDE:BEGIN -->\nstub\n<!-- ROCKETRIDE:END -->\nand me\n', 'utf8');
    const inst = new TestInstaller();
    await inst.uninstall(ws);
    const content = await readFile(target);
    expect(content).toContain('keep me');
    expect(content).toContain('and me');
    expect(content).not.toContain('ROCKETRIDE:BEGIN');
  });
});
