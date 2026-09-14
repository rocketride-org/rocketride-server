import { PROVIDERS, providerById, providerByKeyVar } from '../src/providers';
describe('provider registry', () => {
  it('includes openai/anthropic/deepseek with unique ids + keyVars', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['openai', 'anthropic', 'deepseek']));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(PROVIDERS.map((p) => p.keyVar)).size).toBe(PROVIDERS.length);
  });
  it('openai-compatible providers carry a baseURL; native ones do not require one', () => {
    for (const p of PROVIDERS) if (p.mode === 'openai-compatible') expect(p.baseURL).toMatch(/^https:\/\//);
  });
  it('openai-compatible providers carry a curated model list; native providers defer to opencode', () => {
    for (const p of PROVIDERS) {
      if (p.mode === 'openai-compatible') {
        // opencode can't enumerate these — the registry must supply the models itself.
        expect(Array.isArray(p.models)).toBe(true);
        expect(p.models!.length).toBeGreaterThan(0);
        for (const m of p.models!) {
          expect(typeof m.id).toBe('string');
          expect(m.id.length).toBeGreaterThan(0);
          expect(typeof m.title).toBe('string');
        }
      } else {
        // native models come from opencode's built-in catalog at runtime, not the registry.
        expect(p.models).toBeUndefined();
      }
    }
  });
  it('covers the native + openai-compatible providers the picker offers', () => {
    const ids = PROVIDERS.map((p) => p.id);
    // Native (models from opencode) + openai-compatible (curated).
    expect(ids).toEqual(expect.arrayContaining(['openai', 'anthropic', 'google', 'deepseek', 'mistral', 'xai', 'perplexity']));
    expect(ids).toEqual(expect.arrayContaining(['kimi', 'minimax', 'qwen', 'gmi', 'qianfan']));
  });
  it('maps by id and by keyVar', () => {
    expect(providerById('openai')?.keyVar).toBe('ROCKETRIDE_OPENAI_KEY');
    expect(providerByKeyVar('ROCKETRIDE_ANTHROPIC_KEY')?.id).toBe('anthropic');
  });
});
