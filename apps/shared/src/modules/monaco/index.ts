// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// MONACO MODULE — deep-path entry point ('shared/modules/monaco')
// =============================================================================

/**
 * The platform's ONE Monaco surface: bundled editor + self-hosted workers
 * (never a CDN), the rr token theme, language detection, the shared editor
 * component, and the App Builder's TS language-service setup. Every Monaco
 * consumer (App Builder Code pane, explorer-ui viewer, sql-ui editor)
 * imports from here — `monaco-editor` is never imported directly by app
 * code, and Monaco's bytes stay behind this module's lazy boundary.
 */

export { ensureMonacoEnvironment } from './environment';
export { loadMonaco } from './loader';
export type { Monaco } from './loader';
export { detectLanguage } from './languages';
export { THEME_NAME, defineRrTheme, useThemeVersion } from './theme';
export { MonacoEditor } from './MonacoEditor';
export type { IMonacoEditorProps } from './MonacoEditor';
export { setupAppTypescript, emitModel } from './typescriptSetup';
export type { EmitOutput, TypescriptSetupHandle } from './typescriptSetup';
