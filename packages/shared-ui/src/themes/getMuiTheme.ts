// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import { createTheme, type Theme } from '@mui/material/styles';
import '@fontsource/roboto';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import '@fontsource/roboto-condensed';
import '@fontsource/ubuntu-mono';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Reads a CSS custom property from :root and returns its resolved value.
 * Falls back to `fallback` when the property is empty or the DOM is
 * unavailable (SSR).
 */
const rr = (name: string, fallback: string = ''): string => {
	if (typeof document === 'undefined') return fallback;
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value || fallback;
};

/**
 * Returns true when the resolved hex colour is perceptually dark (luminance < 0.5).
 * Used to pick between MUI's 'light' and 'dark' palette modes.
 */
const isColorDark = (color: string): boolean => {
	const hex = color.replace('#', '');
	if (hex.length < 6) return false;
	const r = parseInt(hex.substring(0, 2), 16);
	const g = parseInt(hex.substring(2, 4), 16);
	const b = parseInt(hex.substring(4, 6), 16);
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance < 0.5;
};

// =============================================================================
// getMuiTheme
// =============================================================================

/**
 * Builds an MUI theme by reading --rr-* CSS custom properties at call time.
 *
 * The CSS files (rocketride-default.css / rocketride-vscode.css) and JSON themes are the single
 * source of truth for every colour, font, and size decision. This function
 * simply translates those tokens into the shape MUI expects.
 *
 * Call this inside a `useMemo` keyed on a theme-version counter so it
 * re-reads the tokens whenever the host switches themes.
 */
export function getMuiTheme(): Theme {
	// --- Read tokens --------------------------------------------------------

	const brand = rr('--rr-brand', '#F7901F');
	const bgDefault = rr('--rr-bg-default', '#ffffff');
	const bgPaper = rr('--rr-bg-paper', '#f5f5f5');
	const secondary = rr('--rr-color-secondary', '#666666');
	const error = rr('--rr-color-error', '#fa3c3c');
	const warning = rr('--rr-color-warning', '#E8B931');
	const info = rr('--rr-color-info', '#3182CE');
	const success = rr('--rr-color-success', '#22e02c');

	const textPrimary = rr('--rr-text-primary', '#1a1a1a');
	const textSecondary = rr('--rr-text-secondary', '#666666');
	const textDisabled = rr('--rr-text-disabled', '#838383');
	const textCaption = rr('--rr-text-caption', '#7D7D7D');
	const divider = rr('--rr-border', '#DCDCDC');

	const hoverBg = rr('--rr-bg-list-hover', 'rgba(0, 0, 0, 0.04)');
	const inputBg = rr('--rr-bg-input', '#ffffff');
	const inputBorder = rr('--rr-border-input', '#a8a8a8');
	const borderFocus = rr('--rr-border-focus', '#0078d4');

	const grey200 = rr('--rr-grey-200', '#D9D9D9');
	const grey400 = rr('--rr-grey-400', '#A8A8A8');
	const grey500 = rr('--rr-grey-500', '#8E8E8E');

	const fontFamily = rr('--rr-font-family', 'Roboto, sans-serif');
	const fontSizeH1 = rr('--rr-font-size-h1', '2rem');
	const fontSizeH2 = rr('--rr-font-size-h2', '1.475rem');
	const fontSizeH3 = rr('--rr-font-size-h3', '1.2rem');
	const fontSizeH4 = rr('--rr-font-size-h4', '1.25rem');
	const fontSizeH5 = rr('--rr-font-size-h5', '1.25rem');
	const fontSizeBody = rr('--rr-font-size-body', 'inherit');
	const fontSizeButton = rr('--rr-font-size-button', '0.85rem');
	const fontSizeCaption = rr('--rr-font-size-caption', 'inherit');
	const fontSizeSubtitle = rr('--rr-font-size-subtitle', '0.875rem');
	const fontWeightH5 = parseInt(rr('--rr-font-weight-h5', '400'), 10) || 400;
	const fontWeightButton = parseInt(rr('--rr-font-weight-button', '600'), 10) || 600;

	const paperBorder = rr('--rr-border-paper', '2px solid #eee');

	const scrollbarThumb = rr('--rr-bg-scrollbar-thumb', 'rgba(121,121,121,0.4)');

	const listActiveBg = rr('--rr-bg-list-active', '#0e639c');
	const listActiveFg = rr('--rr-fg-list-active', '#ffffff');

	// --- Derived values -----------------------------------------------------

	// Determine palette mode.
	// Priority: VS Code body attribute > explicit CSS token > luminance detection.
	const vscodeThemeKind = typeof document !== 'undefined' ? document.body.getAttribute('data-vscode-theme-kind') || '' : '';
	const isVsCodeDark = vscodeThemeKind === 'vscode-dark' || vscodeThemeKind === 'vscode-high-contrast';
	const declaredMode = rr('--rr-palette-mode', '');
	const vscodeEditorBg = typeof document !== 'undefined' ? getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() : '';
	const effectiveBg = vscodeEditorBg || bgDefault;
	const isDark = isVsCodeDark || declaredMode === 'dark' || (declaredMode !== 'light' && isColorDark(effectiveBg));

	// Body-level font size in px (used for htmlFontSize and component sizing)
	const bodyFontSizePx = fontSizeBody !== 'inherit' ? parseFloat(fontSizeBody) || 16 : 16;

	// --- Build theme --------------------------------------------------------

	return createTheme({
		palette: {
			mode: isDark ? 'dark' : 'light',
			primary: { main: brand },
			secondary: { main: secondary },
			error: { main: error },
			warning: { main: warning },
			info: { main: info },
			success: { main: success },
			background: { default: bgDefault, paper: bgPaper },
			text: { primary: textPrimary, secondary: textSecondary, disabled: textDisabled },
			divider,
			action: { hover: hoverBg },
			grey: { 200: grey200, 400: grey400, 500: grey500 },
		},

		typography: {
			fontFamily,
			...(fontSizeBody !== 'inherit' ? { fontSize: bodyFontSizePx, htmlFontSize: bodyFontSizePx } : {}),
			h1: { fontFamily, fontWeight: 500, letterSpacing: '0.5px', fontSize: fontSizeH1, color: textPrimary },
			h2: { fontFamily, fontSize: fontSizeH2, fontWeight: 500, letterSpacing: 0 },
			h3: { fontFamily, fontSize: fontSizeH3, fontWeight: 500, letterSpacing: 0 },
			h4: { fontFamily, fontSize: fontSizeH4, fontWeight: 500, letterSpacing: 0 },
			h5: { fontFamily, fontSize: fontSizeH5, fontWeight: fontWeightH5, letterSpacing: 0 },
			button: { fontFamily, fontSize: fontSizeButton, fontWeight: fontWeightButton },
			body1: { fontFamily, ...(fontSizeBody !== 'inherit' ? { fontSize: fontSizeBody } : {}) },
			body2: { fontFamily, ...(fontSizeBody !== 'inherit' ? { fontSize: fontSizeBody } : {}) },
			caption: { fontFamily, color: textCaption, letterSpacing: 0, ...(fontSizeCaption !== 'inherit' ? { fontSize: fontSizeCaption } : {}) },
			subtitle1: { fontFamily, fontSize: fontSizeSubtitle, fontWeight: 400, letterSpacing: 0 },
			subtitle2: { fontFamily, fontSize: fontSizeSubtitle, fontWeight: 400, letterSpacing: 0, fontStyle: 'italic' },
		},

		components: {
			MuiCssBaseline: {
				styleOverrides: {
					'@global': {
						'.add-node-list-scroll': {
							scrollbarWidth: 'thin' as const,
							scrollbarColor: `${scrollbarThumb} transparent`,
						},
						'.add-node-list-scroll::-webkit-scrollbar': {
							width: '10px',
						},
						'.add-node-list-scroll::-webkit-scrollbar-thumb': {
							backgroundColor: scrollbarThumb,
							borderRadius: '4px',
						},
					},
				},
			},
			MuiPaper: {
				styleOverrides: {
					root: {
						border: paperBorder,
					},
				},
				defaultProps: {
					elevation: 0,
				},
			},
			MuiListItem: {
				styleOverrides: {
					root: {
						fontSize: `${bodyFontSizePx}px`,
						fontFamily,
						padding: '0',
						minHeight: '22px',
						lineHeight: '22px',
						'&:hover': {
							backgroundColor: hoverBg,
						},
						'&.Mui-selected': {
							backgroundColor: listActiveBg,
							color: listActiveFg,
							'&:hover': {
								backgroundColor: listActiveBg,
							},
						},
					},
				},
			},
			MuiListItemText: {
				styleOverrides: {
					root: { margin: 0 },
					primary: {
						fontSize: `${bodyFontSizePx}px`,
						fontFamily,
						fontWeight: 400,
						lineHeight: '22px',
					},
				},
			},
			MuiInputBase: {
				styleOverrides: {
					root: {
						fontSize: `${bodyFontSizePx}px`,
						fontFamily,
						lineHeight: 1.4,
						'& .MuiInputBase-input': {
							fontSize: `${bodyFontSizePx}px`,
							minHeight: '22px',
						},
					},
				},
			},
			MuiOutlinedInput: {
				styleOverrides: {
					root: {
						backgroundColor: inputBg,
						'& fieldset': {
							borderColor: inputBorder,
						},
						'&:hover fieldset': {
							borderColor: borderFocus,
						},
					},
				},
			},
			MuiSnackbar: {
				styleOverrides: {
					root: {
						background: 'transparent',
					},
					anchorOriginBottomRight: {
						bottom: '62px !important',
						padding: 8,
					},
				},
			},
			MuiIconButton: {
				styleOverrides: {
					root: {
						pointerEvents: 'auto',
						padding: '4px',
						'& .MuiSvgIcon-root': {
							fontSize: '16px',
						},
					},
				},
			},
			MuiFormHelperText: {
				styleOverrides: {
					root: {
						fontSize: '0.7rem',
						marginLeft: '9px',
						marginTop: '5px',
					},
				},
			},
			MuiCheckbox: {
				styleOverrides: {
					root: {
						padding: '2px 2px 2px 9px',
					},
				},
			},
			MuiFormControlLabel: {
				styleOverrides: {
					root: {
						marginBottom: 0,
						marginTop: 0,
					},
				},
			},
		},
	});
}
