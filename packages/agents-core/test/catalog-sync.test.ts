import * as fs from 'fs/promises';
import * as path from 'path';
import { mkTempWorkspace, exists } from './helpers';
import { syncServiceCatalog } from '../src/catalog-sync';

describe('syncServiceCatalog', () => {
  it('writes each service to .rocketride/schema/<name>.json', async () => {
    const ws = await mkTempWorkspace();
    await syncServiceCatalog(ws, {
      chat: { classType: ['source'], description: 'Chat source. Used for conversational pipelines.', lanes: {} },
      llm_openai: { classType: ['provider'], description: 'OpenAI LLM provider.', lanes: {} },
    }, () => undefined);
    expect(JSON.parse(await fs.readFile(path.join(ws, '.rocketride/schema/chat.json'), 'utf8'))).toMatchObject({ classType: ['source'] });
    expect(JSON.parse(await fs.readFile(path.join(ws, '.rocketride/schema/llm_openai.json'), 'utf8'))).toMatchObject({ classType: ['provider'] });
  });

  it('removes obsolete schema files', async () => {
    const ws = await mkTempWorkspace();
    const obsolete = path.join(ws, '.rocketride/schema/old_service.json');
    await fs.mkdir(path.dirname(obsolete), { recursive: true });
    await fs.writeFile(obsolete, '{}', 'utf8');
    await syncServiceCatalog(ws, { chat: { classType: [], description: 'x.', lanes: {} } }, () => undefined);
    expect(await exists(obsolete)).toBe(false);
  });

  it('writes services-catalog.json with first-sentence-only descriptions', async () => {
    const ws = await mkTempWorkspace();
    await syncServiceCatalog(ws, {
      chat: { classType: ['source'], description: 'First sentence. Second sentence.', lanes: { questions: {} } },
    }, () => undefined);
    const catalog = JSON.parse(await fs.readFile(path.join(ws, '.rocketride/services-catalog.json'), 'utf8'));
    expect(catalog).toHaveLength(1);
    expect(catalog[0].description).toBe('First sentence.');
  });

  it('sanitizes unsafe service names and refuses path escapes', async () => {
    const ws = await mkTempWorkspace();
    await syncServiceCatalog(ws, {
      '../escape': { classType: [], description: 'x.', lanes: {} },
      'ok_name': { classType: [], description: 'x.', lanes: {} },
    }, () => undefined);
    // Sanitized escape attempt must land inside .rocketride/schema/, never above.
    expect(await exists(path.join(ws, '.rocketride/schema/ok_name.json'))).toBe(true);
    const schemaDir = path.join(ws, '.rocketride/schema');
    const entries = await fs.readdir(schemaDir);
    for (const e of entries) {
      expect(e.includes('..')).toBe(false);
      expect(e.includes('/')).toBe(false);
    }
  });
});
