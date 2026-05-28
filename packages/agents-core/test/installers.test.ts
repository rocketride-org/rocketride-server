import { ClaudeCodeInstaller } from '../src/installers/claude-code-installer';
import { CursorInstaller } from '../src/installers/cursor-installer';
import { WindsurfInstaller } from '../src/installers/windsurf-installer';
import { CopilotInstaller } from '../src/installers/copilot-installer';
import { ClaudeMdInstaller } from '../src/installers/claude-md-installer';
import { AgentsMdInstaller } from '../src/installers/agents-md-installer';

describe('concrete installers', () => {
  it.each([
    [new ClaudeCodeInstaller(), 'Claude Code', 'claude-code.md', '.claude/rules/rocketride.md'],
    [new CursorInstaller(), 'Cursor', 'cursor.mdc', '.cursor/rules/rocketride.mdc'],
    [new WindsurfInstaller(), 'Windsurf', 'windsurf.md', '.windsurf/rules/rocketride.md'],
    [new CopilotInstaller(), 'Copilot', 'copilot-instructions.md', '.github/copilot-instructions.md'],
    [new ClaudeMdInstaller(), 'CLAUDE.md', 'CLAUDE.md', 'CLAUDE.md'],
    [new AgentsMdInstaller(), 'AGENTS.md', 'AGENTS.md', 'AGENTS.md'],
  ])('%s exposes the right name/source/target', (inst, name, source, target) => {
    expect((inst as { name: string }).name).toBe(name);
    expect((inst as { stubSource: string }).stubSource).toBe(source);
    expect((inst as { stubTarget: string }).stubTarget).toBe(target);
  });
});
