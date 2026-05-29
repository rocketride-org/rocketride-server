#!/usr/bin/env ts-node
/**
 * Refresh packages/agents-core/docs/ from the canonical sources in
 * <repo>/docs/agents/ and <repo>/docs/stubs/.
 * Run from repo root: `pnpm -F @rocketride/agents-core run sync-bundle`.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (entry.isFile()) {
      await fs.copyFile(path.join(src, entry.name), path.join(dst, entry.name));
    }
  }
}

(async () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const pkgRoot = path.resolve(__dirname, '..');
  await copyDir(path.join(repoRoot, 'docs/agents'), path.join(pkgRoot, 'docs'));
  await copyDir(path.join(repoRoot, 'docs/stubs'), path.join(pkgRoot, 'docs/stubs'));
  console.log('Bundle synced.');
})();
