import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from './types';

async function writeIfChanged(target: string, content: string): Promise<boolean> {
  try {
    const existing = await fs.readFile(target, 'utf8');
    if (existing.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) {
      return false;
    }
  } catch {
    // Will create.
  }
  await fs.writeFile(target, content, 'utf8');
  return true;
}

function firstSentence(description: string | undefined): string {
  if (!description) return '';
  let stripped = description;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/<[^>]*>/g, '');
  } while (stripped !== prev);
  const text = stripped.trim();
  const match = text.match(/^[^.!?]*[.!?]/);
  return match ? match[0].trim() : text;
}

function sanitizeServiceName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, (match) => '_'.repeat(match.length));
}

function isUnderDirectory(parent: string, child: string): boolean {
  const parentResolved = path.resolve(parent) + path.sep;
  const childResolved = path.resolve(child);
  return childResolved.startsWith(parentResolved);
}

export async function syncServiceCatalog(
  workspaceRoot: string,
  services: Record<string, unknown>,
  log: Logger,
): Promise<void> {
  const schemaDir = path.join(workspaceRoot, '.rocketride', 'schema');
  await fs.mkdir(schemaDir, { recursive: true });

  const serviceNames = Object.keys(services);
  const expected = new Set<string>();
  for (const name of serviceNames) {
    const safe = sanitizeServiceName(name);
    const target = path.join(schemaDir, `${safe}.json`);
    if (!isUnderDirectory(schemaDir, target)) {
      log(`Skipped schema write for unsafe service name: ${name}`);
      continue;
    }
    expected.add(`${safe}.json`);
    await writeIfChanged(target, JSON.stringify(services[name], null, 2));
  }

  try {
    const entries = await fs.readdir(schemaDir);
    for (const fileName of entries) {
      if (!expected.has(fileName)) {
        await fs.unlink(path.join(schemaDir, fileName));
        log(`Removed obsolete schema: ${fileName}`);
      }
    }
  } catch {
    // First run, nothing to clean.
  }

  const catalog = serviceNames.map((name) => {
    const svc = (services[name] ?? {}) as Record<string, unknown>;
    const entry: Record<string, unknown> = {
      name,
      classType: svc.classType ?? [],
      description: firstSentence(svc.description as string | undefined),
      lanes: svc.lanes ?? {},
    };
    if (svc.invoke !== undefined) {
      entry.invoke = svc.invoke;
    }
    return entry;
  });

  await writeIfChanged(
    path.join(workspaceRoot, '.rocketride', 'services-catalog.json'),
    JSON.stringify(catalog, null, 2),
  );
}
