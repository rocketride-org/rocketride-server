import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from './types';

const DOCS_DIR = '.rocketride/docs';
const GITIGNORE_ENTRY = '.rocketride/';

/** Doc files shipped in the bundle. Order matches the source-of-truth list. */
export const DOC_FILES: ReadonlyArray<string> = [
  'ROCKETRIDE_README.md',
  'ROCKETRIDE_QUICKSTART.md',
  'ROCKETRIDE_PIPELINE_RULES.md',
  'ROCKETRIDE_COMPONENT_REFERENCE.md',
  'ROCKETRIDE_COMMON_MISTAKES.md',
  'ROCKETRIDE_python_API.md',
  'ROCKETRIDE_typescript_API.md',
  'ROCKETRIDE_OBSERVABILITY.md',
];

/**
 * Sync documentation files from a bundle directory into <workspaceRoot>/.rocketride/docs/.
 * Idempotent: only writes files whose content differs (line-ending normalized).
 * Removes files in the target that are not in DOC_FILES.
 */
export async function installDocs(bundleDocsDir: string, workspaceRoot: string, log: Logger): Promise<void> {
  const targetDir = path.join(workspaceRoot, DOCS_DIR);
  await fs.mkdir(targetDir, { recursive: true });
  const expected = new Set<string>(DOC_FILES);

  for (const file of DOC_FILES) {
    const source = path.join(bundleDocsDir, file);
    const target = path.join(targetDir, file);
    let sourceStr: string;
    try {
      sourceStr = await fs.readFile(source, 'utf8');
    } catch (err) {
      log(`Could not read bundled doc ${file}: ${err}`);
      continue;
    }
    let needsWrite = true;
    try {
      const targetStr = await fs.readFile(target, 'utf8');
      needsWrite = sourceStr.replace(/\r\n/g, '\n') !== targetStr.replace(/\r\n/g, '\n');
    } catch {
      // Target missing — needs write.
    }
    if (needsWrite) {
      await fs.writeFile(target, sourceStr, 'utf8');
      log(`Synced ${file}`);
    }
  }

  try {
    const entries = await fs.readdir(targetDir);
    for (const name of entries) {
      if (!expected.has(name)) {
        await fs.unlink(path.join(targetDir, name));
        log(`Removed obsolete doc: ${name}`);
      }
    }
  } catch {
    // Directory listing failed — first install, nothing to clean.
  }
}

/**
 * Ensure `.rocketride/` is present in <workspaceRoot>/.gitignore. Creates the
 * file if missing, appends the entry if missing, no-op if already present.
 */
export async function ensureGitignore(workspaceRoot: string): Promise<void> {
  const target = path.join(workspaceRoot, '.gitignore');
  let content = '';
  try {
    content = await fs.readFile(target, 'utf8');
  } catch {
    // Will create.
  }
  if (content.split('\n').some((line) => line.trim() === GITIGNORE_ENTRY)) {
    return;
  }
  const next = content.trimEnd() + (content ? '\n' : '') + GITIGNORE_ENTRY + '\n';
  await fs.writeFile(target, next, 'utf8');
}
