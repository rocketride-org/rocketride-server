import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export async function mkTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rr-core-'));
}

export async function mkBundle(stubs: Record<string, string>, docs: Record<string, string> = {}): Promise<{ docsDir: string; stubsDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-bundle-'));
  const docsDir = path.join(root, 'docs');
  const stubsDir = path.join(docsDir, 'stubs');
  await fs.mkdir(stubsDir, { recursive: true });
  for (const [name, content] of Object.entries(stubs)) {
    await fs.writeFile(path.join(stubsDir, name), content, 'utf8');
  }
  for (const [name, content] of Object.entries(docs)) {
    await fs.writeFile(path.join(docsDir, name), content, 'utf8');
  }
  return { docsDir, stubsDir };
}

export async function readFile(p: string): Promise<string> {
  return fs.readFile(p, 'utf8');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
