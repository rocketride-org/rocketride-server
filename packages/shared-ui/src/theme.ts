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

import '@mui/material/styles/createPalette';
import { createTheme } from '@mui/material/styles';
import pxToRem from './utils/pxToRem';
import { isInVSCode, getVSCodeColor } from './utils/vscode';

import '@fontsource/roboto';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import '@fontsource/roboto-condensed';
import '@fontsource/ubuntu-mono';

/**
 * System fallback font stack used when primary web fonts are unavailable.
 * Provides cross-platform coverage for macOS, Windows, and Linux.
 */
export const fallbackFonts = [
	'-apple-system',
	'"Segoe UI"',
	'"Helvetica Neue"',
	'Arial',
	'sans-serif',
	'"Apple Color Emoji"',
	'"Segoe UI Emoji"',
	'"Segoe UI Symbol"',
];

/** CSS `font-family` string for the Roboto typeface with system fallbacks. */
export const roboto = ['Roboto', ...fallbackFonts].join(',');
/** CSS `font-family` string for Roboto Condensed with system fallbacks. */
export const robotoCondensed = ['Roboto Condensed', 'Roboto', ...fallbackFonts].join(',');
/** CSS `font-family` string for the Ubuntu Mono monospace typeface with system fallbacks. */
export const mono = ['Ubuntu Mono', ...fallbackFonts].join(',');

/** Primary brand color (RocketRide orange). */
export const brandOrange = '#F7901F';
/** Light grey used for subtle backgrounds and borders. */
export const lightGrey = '#E6E6E6';
/** Dark grey used for muted text and secondary icons. */
export const darkGrey = '#838383';
/** Off-black used as the secondary palette main color. */
export const offBlack = '#666666';

/**
 * Determines whether a hex color is perceptually dark by computing its
 * relative luminance. Used to decide between light and dark MUI palette modes
 * when adapting to VSCode's editor background color.
 *
 * @param color - A hex color string (e.g., '#1e1e1e').
 * @returns `true` if the color's luminance is below 0.5 (i.e., dark).
 */
const isColorDark = (color: string): boolean => {
	// Convert hex to RGB
	const hex = color.replace('#', '');
	const r = parseInt(hex.substr(0, 2), 16);
	const g = parseInt(hex.substr(2, 2), 16);
	const b = parseInt(hex.substr(4, 2), 16);
	// Calculate relative luminance
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance < 0.5;
};

/**
 * Creates a Material-UI theme that integrates with VSCode's active color theme.
 *
 * This function is exported for programmatic use by consumers of this library
 * who want to manually create a VSCode-aware theme. The theme automatically
 * adapts to VSCode's colors, fonts, and sizing when running in a VSCode webview.
 *
 * When not running in VSCode, it returns a standard theme with sensible defaults.
 *
 * @returns {Theme} A Material-UI theme configured to match VSCode's styling
 *
 * @example
 * ```tsx
 * import { createVSCodeTheme } from 'rocketride-canvas';
 *
 * const MyComponent = () => {
 *   const theme = createVSCodeTheme();
 *   return <ThemeProvider theme={theme}>...</ThemeProvider>;
 * };
 * ```
 */
export const createVSCodeTheme = () => {
	const editorBg = getVSCodeColor('--vscode-editor-background', '#ffffff');
	const isDark = isColorDark(editorBg);
	const inVSCode = isInVSCode();

	// Get VSCode's font size (e.g., "12px", "14px") - only if in VSCode
	const vscodeFontSize = inVSCode ? getVSCodeColor('--vscode-font-size', '') : '';
	const baseFontSize = vscodeFontSize ? parseFloat(vscodeFontSize) || 16 : 16;
	const vscodeFontFamily = inVSCode ? getVSCodeColor('--vscode-font-family', '') : '';

	return createTheme({
		palette: {
			mode: isDark ? 'dark' : 'light',
			primary: {
				main: brandOrange,
			},
			secondary: {
				main: '#007ACC', // VSCode blue
			},
			error: {
				main: getVSCodeColor('--vscode-errorForeground', '#F44336'),
			},
			warning: {
				main: getVSCodeColor('--vscode-editorWarning-foreground', '#E8B931'),
			},
			info: {
				main: getVSCodeColor('--vscode-editorInfo-foreground', '#3182CE'),
			},
			success: {
				main: getVSCodeColor('--vscode-editorGutter-addedBackground', '#229954'),
			},
			background: {
				default: getVSCodeColor('--vscode-editor-background', '#ffffff'),
				paper: getVSCodeColor('--vscode-sideBar-background', '#f5f5f5'),
			},
			text: {
				primary: getVSCodeColor('--vscode-editor-foreground', '#000000'),
				secondary: getVSCodeColor('--vscode-editorLineNumber-foreground', '#808080'),
				disabled: getVSCodeColor('--vscode-descriptionForeground', '#838383'),
			},
			divider: getVSCodeColor('--vscode-editorGroup-border', '#DCDCDC'),
			action: {
				hover: getVSCodeColor('--vscode-list-hoverBackground', 'rgba(0, 0, 0, 0.04)'),
			},
			grey: {
				200: getVSCodeColor('--vscode-input-background', isDark ? '#3c3c3c' : '#f3f3f3'),
				400: getVSCodeColor('--vscode-input-border', isDark ? '#858585' : '#a8a8a8'),
				500: getVSCodeColor('--vscode-descriptionForeground', '#8E8E8E'),
			},
		},
		typography: {
			// Only use VSCode font settings when running in VSCode
			...(inVSCode && vscodeFontSize ? { htmlFontSize: baseFontSize } : {}),
			...(inVSCode && vscodeFontFamily
				? { fontFamily: vscodeFontFamily }
				: { fontFamily: roboto }),
			...(inVSCode ? { fontSize: baseFontSize } : {}), // Use VSCode's base font size
			h1: {
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				fontWeight: 500,
				letterSpacing: '0.5px',
				fontSize: inVSCode ? '1.15rem' : '2rem',
				color: getVSCodeColor('--vscode-editor-foreground', '#000'),
			},
			h2: {
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				fontSize: inVSCode ? '1.1rem' : '1.475rem',
				fontWeight: 500,
				letterSpacing: 0,
			},
			h3: {
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				fontSize: inVSCode ? '1.05rem' : '1.2rem',
				fontWeight: 500,
				letterSpacing: 0,
			},
			h4: {
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				fontSize: inVSCode ? '1rem' : '1.25rem',
				fontWeight: 500,
				letterSpacing: 0,
			},
			h5: {
				// Match VSCode pane header style (.monaco-pane-view .pane>.pane-header h3.title)
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				fontSize: inVSCode ? '0.79rem' : '1.25rem', // VSCode uses 11px (0.79rem at 14px base)
				fontWeight: inVSCode ? 700 : 400, // Bold in VSCode
				letterSpacing: 0,
				textTransform: inVSCode ? 'uppercase' : 'none',
				color: inVSCode
					? getVSCodeColor(
							'--vscode-sideBarTitle-foreground',
							getVSCodeColor('--vscode-editor-foreground', '#000')
						)
					: undefined,
			},
			button: {
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				fontSize: inVSCode ? `${baseFontSize}px` : '0.85rem',
				fontWeight: inVSCode ? 400 : 600,
			},
			body1: {
				// Match VSCode tree item style
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				fontSize: inVSCode ? `${baseFontSize}px` : undefined,
				fontWeight: inVSCode ? 400 : undefined,
			},
			body2: {
				// Match VSCode tree item style
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				fontSize: inVSCode ? `${baseFontSize}px` : undefined,
				fontWeight: inVSCode ? 400 : undefined,
			},
			caption: {
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				color: getVSCodeColor('--vscode-descriptionForeground', '#7D7D7D'),
				letterSpacing: 0,
				fontSize: inVSCode ? `${baseFontSize - 1}px` : undefined,
			},
			subtitle1: {
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				fontSize: inVSCode ? `${baseFontSize}px` : '0.875rem',
				fontWeight: 400,
				letterSpacing: inVSCode ? 0 : '0.5px',
			},
			subtitle2: {
				...(inVSCode && vscodeFontFamily
					? { fontFamily: vscodeFontFamily }
					: { fontFamily: roboto }),
				fontSize: inVSCode ? `${baseFontSize}px` : '0.875rem',
				fontWeight: 400,
				letterSpacing: inVSCode ? 0 : '0.5px',
				fontStyle: 'italic',
			},
		},
		components: {
			MuiPaper: {
				styleOverrides: {
					root: {
						border: inVSCode ? 'none' : '2px solid #eee',
					},
				},
				defaultProps: {
					elevation: 0,
				},
			},
			MuiListItem: {
				styleOverrides: {
					root: inVSCode
						? {
								// Match VSCode tree item style
								fontSize: `${baseFontSize}px`,
								fontFamily: vscodeFontFamily || undefined,
								padding: '0',
								minHeight: '22px',
								lineHeight: '22px',
								'&:hover': {
									backgroundColor: getVSCodeColor(
										'--vscode-list-hoverBackground',
										'rgba(0, 0, 0, 0.04)'
									),
								},
								'&.Mui-selected': {
									backgroundColor: getVSCodeColor(
										'--vscode-list-activeSelectionBackground',
										'#0e639c'
									),
									color: getVSCodeColor(
										'--vscode-list-activeSelectionForeground',
										'#ffffff'
									),
									'&:hover': {
										backgroundColor: getVSCodeColor(
											'--vscode-list-activeSelectionBackground',
											'#0e639c'
										),
									},
								},
							}
						: {},
				},
			},
			MuiListItemText: {
				styleOverrides: {
					root: inVSCode
						? {
								margin: 0,
							}
						: {},
					primary: inVSCode
						? {
								fontSize: `${baseFontSize}px`,
								fontFamily: vscodeFontFamily || undefined,
								fontWeight: 400,
								lineHeight: '22px',
							}
						: {},
				},
			},
			MuiInputBase: {
				styleOverrides: {
					root: inVSCode
						? {
								fontSize: `${baseFontSize}px`,
								fontFamily: vscodeFontFamily || undefined,
								lineHeight: 1.4,
								'& .MuiInputBase-input': {
									fontSize: `${baseFontSize}px`,
									minHeight: '22px',
								},
							}
						: {},
				},
			},
			MuiOutlinedInput: {
				styleOverrides: {
					root: inVSCode
						? {
								backgroundColor: getVSCodeColor('--vscode-input-background', ''),
								'& fieldset': {
									borderColor: getVSCodeColor('--vscode-input-border', ''),
								},
								'&:hover fieldset': {
									borderColor: getVSCodeColor('--vscode-focusBorder', ''),
								},
							}
						: {},
				},
			},
			MuiCssBaseline: {
				styleOverrides: {
					':root': {
						'--icon-filter': isDark ? 'brightness(0) invert(1)' : 'none',
					},
					'@global': inVSCode
						? {
								'.add-node-list-scroll': {
									scrollbarWidth: 'thin',
									scrollbarColor: `${getVSCodeColor('--vscode-scrollbarSlider-background', 'rgba(121,121,121,0.4)')} transparent`,
								},
								'.add-node-list-scroll::-webkit-scrollbar': {
									width: getVSCodeColor('--vscode-scrollbarSlider-width', '10px') || '10px',
								},
								'.add-node-list-scroll::-webkit-scrollbar-thumb': {
									backgroundColor: getVSCodeColor(
										'--vscode-scrollbarSlider-background',
										'rgba(121,121,121,0.4)'
									),
									borderRadius: '4px',
								},
							}
						: {},
				},
			},
			MuiSnackbar: {
				styleOverrides: {
					root: {
						background: 'transparent',
					},
					anchorOriginBottomRight: {
						bottom: `${pxToRem(62)}rem !important`,
						padding: 8,
					},
				},
			},
			MuiCard: {
				styleOverrides: {
					root: {
						borderRadius: '12px',
					},
				},
			},
			MuiToolbar: {
				styleOverrides: {
					root: ({ theme }) => ({
						width: '100%',
						[theme.breakpoints.up('sm')]: {
							minHeight: `${pxToRem(64)}rem`,
						},
					}),
				},
			},
			MuiIconButton: {
				styleOverrides: {
					root: inVSCode
						? {
								pointerEvents: 'auto',
								padding: '4px',
								'& .MuiSvgIcon-root': {
									fontSize: '16px',
								},
							}
						: {
								pointerEvents: 'auto',
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
};

/**
 * The standard Material UI theme for the web application (DTC / standalone).
 * Contains the full brand palette, typography, and component overrides.
 * This is used when the app is NOT running inside a VSCode webview.
 */
export const theme = createTheme({
	palette: {
		// https://m2.material.io/inline-tools/color/
		primary: {
			main: brandOrange,
			dark: '#f17f1c',
			light: '#fb9a21',
			contrastText: '#fff',
		},
		secondary: {
			main: offBlack,
			dark: '#000',
			light: darkGrey,
			contrastText: '#000',
		},
		error: {
			main: '#fa3c3c',
			dark: '##eb323b',
			light: '#f44f55',
			contrastText: '#ffffff',
		},
		success: {
			main: '#22e02c',
		},
		warning: {
			main: '#E8B931',
		},
		// DTC Original Colors - Exact matches for 100% compatibility
		background: {
			default: '#ffffff',
			paper: '#fff',
		},
		text: {
			primary: '#000000',
			secondary: '#56565A', // Icon color in headers
			disabled: '#838383', // Muted text (lane body, tile labels)
		},
		divider: '#DCDCDC',
		action: {
			hover: '#f5f5f5',
			disabled: 'rgba(0, 0, 0, 0.26)',
			disabledBackground: 'rgba(0, 0, 0, 0.12)',
		},
		grey: {
			200: '#D9D9D9', // Annotation background
			400: '#A8A8A8', // Annotation borders
			500: '#8E8E8E', // Menu text color
		},
	},
	typography: {
		h1: {
			fontFamily: roboto,
			fontWeight: 500,
			letterSpacing: '0.5px',
			fontSize: '2rem',
			color: '#000',
		},
		h2: {
			fontFamily: roboto,
			fontSize: '1.475rem',
			fontWeight: 500,
			letterSpacing: 0,
		},
		h3: {
			fontFamily: roboto,
			fontSize: '1.2rem',
			fontWeight: 500,
			letterSpacing: 0,
		},
		h4: {
			fontFamily: roboto,
			fontSize: '1.25rem',
			fontWeight: 500,
			letterSpacing: 0,
		},
		h5: {
			fontFamily: roboto,
			fontSize: '1.25rem',
			fontWeight: 400,
			letterSpacing: 0,
		},
		button: {
			fontSize: '0.85rem',
			fontWeight: 600,
		},
		body1: {
			fontFamily: roboto,
		},
		caption: {
			color: '#7D7D7D',
			letterSpacing: 0,
		},
		subtitle1: {
			fontFamily: roboto,
			fontSize: '0.875rem',
			fontWeight: 400,
			letterSpacing: '0.5px',
		},
		subtitle2: {
			fontFamily: roboto,
			fontSize: '0.875rem',
			fontWeight: 400,
			letterSpacing: '0.5px',
			fontStyle: 'italic',
		},
	},
	components: {
		MuiCssBaseline: {
			styleOverrides: {
				':root': {
					'--icon-filter': 'none',
				},
			},
		},
		MuiPaper: {
			styleOverrides: {
				root: {
					border: '2px solid #eee',
				},
			},
			defaultProps: {
				elevation: 0,
			},
		},
		MuiSnackbar: {
			styleOverrides: {
				root: {
					background: 'transparent',
				},
				anchorOriginBottomRight: {
					bottom: `${pxToRem(62)}rem !important`,
					padding: 8,
				},
			},
		},
		MuiCard: {
			styleOverrides: {
				root: {
					borderRadius: '12px',
				},
			},
		},
		MuiToolbar: {
			styleOverrides: {
				root: ({ theme }) => ({
					width: '100%',
					[theme.breakpoints.up('sm')]: {
						minHeight: `${pxToRem(64)}rem`,
					},
				}),
			},
		},
		MuiIconButton: {
			styleOverrides: {
				root: {
					pointerEvents: 'auto',
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

// Export the appropriate theme based on the environment
// When running in VSCode: use the VSCode-aware theme
// When running in DTC or standalone: use the original static theme for 100% compatibility
export default isInVSCode() ? createVSCodeTheme() : theme;
