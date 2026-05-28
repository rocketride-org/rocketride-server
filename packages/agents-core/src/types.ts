/**
 * Logger interface used across agents-core. The extension injects a wrapper
 * around vscode's output channel; the CLI injects a wrapper around console.log.
 * No `vscode` import escapes this package.
 */
export type Logger = (message: string) => void;

/**
 * Resource bundle paths.
 * - docsDir: absolute path to a directory containing the 8 ROCKETRIDE_*.md files.
 * - stubsDir: absolute path to a directory containing the per-agent stub files
 *   (claude-code.md, cursor.mdc, etc).
 *
 * Both default to this package's bundled `docs/` and `docs/stubs/` when callers
 * use the helpers in `src/index.ts`.
 */
export interface ResourceBundle {
  docsDir: string;
  stubsDir: string;
}
