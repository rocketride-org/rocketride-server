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
// THEME & COMMON STYLES — GALLERY ENTRY (DOC-ONLY, UTILITIES)
// =============================================================================

/** Doc-only gallery entry for commonStyles and the theme token vocabulary. */

import type { IGalleryEntry } from '../galleryTypes';

/** The Theme & commonStyles gallery entry. */
export const themeStylesEntry: IGalleryEntry = {
	id: 'theme-styles',
	name: 'Theme & commonStyles',
	group: 'utils',
	blurb: 'The styling vocabulary: ~80 --rr-* theme tokens (ThemeTokens) and the commonStyles map of shared CSSProperties every stock component builds on.',
	doc: `Styling has exactly two layers, both on the surface:

**Tokens** — every colour, font, radius, and shadow is a \`--rr-*\` CSS variable declared on \`:root\` and re-declared per theme (\`ThemeTokens\` is the typed map). Components never hardcode colours; they reference \`var(--rr-...)\` so every theme — light, dark, custom — applies without component changes. Each component entry in this gallery lists the exact tokens it consumes (click a chip to copy).

**commonStyles** — the shared \`CSSProperties\` map from the shell theme layer. Reach for a member BEFORE writing a one-off style; single-use styles stay in the component. The members by family:

- **Cards & sections**: \`card\`, \`cardHeader\`, \`cardBody\`, \`cardFlat\`, \`section\`, \`sectionHeader\`, \`sectionHeaderLabel\`
- **Buttons**: \`buttonPrimary\`, \`buttonSecondary\`, \`buttonDanger\`, \`buttonDangerOutline\`, the \`*Small\` variants, \`buttonDisabled\`, \`cardHeaderButton\`, \`cardBodyButton\`, \`toggleButton(active)\`, \`toggleGroup\`
- **Layout**: \`splitHeader\`, \`tabContent\`, \`columnFill\`, \`headerBar\`, \`divider\`
- **Text**: \`textMuted\`, \`textEllipsis\`, \`fontMono\`, \`labelUppercase\`, \`empty\`
- **Overlays & menus**: \`overlay\`, \`modalOverlay\`, \`dialog\`, \`modalDialog\`, \`modalHeader\`, \`modalBody\`, \`modalFooter\`, \`popupMenu\`, \`menuRow\`
- **Controls & lists**: \`inputField\`, \`listRow(active)\`, \`emptyState\`, \`iconBox\`, \`badge\`
- **Tables**: \`tableHeader\`, \`tableCell\`
- **Status indicators**: \`indicatorSuccess\`, \`indicatorInfo\`, \`indicatorWarning\`, \`indicatorError\`, \`indicatorMuted\`

(\`toggleButton\` and \`listRow\` are functions of the active state; \`viewPadding\` is deprecated.)`,
	docNote: 'Never hardcode a colour - reference var(--rr-*) tokens, and check commonStyles for an existing member before writing a new style block.',
	code: `import { commonStyles } from 'shell';
import type { ThemeTokens } from 'shell';

const styles: Record<string, React.CSSProperties> = {
	// Compose from the shared vocabulary first...
	header: { ...commonStyles.labelUppercase, marginBottom: 8 },
	row: { ...commonStyles.textMuted, ...commonStyles.textEllipsis },
	// ...and theme every one-off through tokens:
	callout: { border: '1px solid var(--rr-border)', background: 'var(--rr-bg-surface-alt)' },
};`,
	propsLabel: 'Exports',
	props: [
		{ name: 'commonStyles', type: 'Record<string, CSSProperties | (active: boolean) => CSSProperties>', dir: 'in', note: 'The shared style map (54 members, families listed above).' },
		{ name: 'ThemeTokens', type: "{ '--rr-...': string, [key: string]: string }", dir: 'in', note: 'The typed theme token map (~80 tokens: palette, backgrounds, text, borders, buttons, fonts, chart hues).' },
	],
};
