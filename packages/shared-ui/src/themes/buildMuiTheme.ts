// =============================================================================
// MUI Theme Bridge
// =============================================================================

import { createTheme, type Theme } from '@mui/material/styles';
import type { ThemeTokens } from './tokens';

/**
 * Build a MUI theme from a ThemeTokens object.
 * Only needed by components that still use MUI (RJSF widgets, Menu).
 */
export function buildMuiTheme(tokens: ThemeTokens): Theme {
	const isDark = tokens['--rr-palette-mode'] === 'dark';

	return createTheme({
		palette: {
			mode: isDark ? 'dark' : 'light',
			primary: {
				main: tokens['--rr-brand'],
			},
			secondary: {
				main: tokens['--rr-color-secondary'],
			},
			error: {
				main: tokens['--rr-color-error'],
			},
			warning: {
				main: tokens['--rr-color-warning'],
			},
			info: {
				main: tokens['--rr-color-info'],
			},
			success: {
				main: tokens['--rr-color-success'],
			},
			background: {
				default: tokens['--rr-bg-default'],
				paper: tokens['--rr-bg-paper'],
			},
			text: {
				primary: tokens['--rr-text-primary'],
				secondary: tokens['--rr-text-secondary'],
				disabled: tokens['--rr-text-disabled'],
			},
			divider: tokens['--rr-border'],
			action: {
				hover: tokens['--rr-bg-list-hover'],
			},
			grey: {
				200: tokens['--rr-grey-200'],
				400: tokens['--rr-grey-400'],
				500: tokens['--rr-grey-500'],
			},
		},
		typography: {
			fontFamily: tokens['--rr-font-family'],
		},
		components: {
			MuiCssBaseline: {
				styleOverrides: {
					':root': {
						'--icon-filter': tokens['--rr-icon-filter'],
					},
				},
			},
			MuiPaper: {
				styleOverrides: {
					root: {
						border: tokens['--rr-border-paper'],
					},
				},
				defaultProps: {
					elevation: 0,
				},
			},
			MuiIconButton: {
				styleOverrides: {
					root: {
						pointerEvents: 'auto',
					},
				},
			},
		},
	});
}

/**
 * Build a MUI theme by reading current --rr-* values from the DOM.
 * Use this when tokens have already been applied via applyTheme().
 */
export function buildMuiThemeFromDOM(): Theme {
	const tokens: Record<string, string> = {};
	const root = document.documentElement;
	for (const prop of Array.from(root.style)) {
		if (prop.startsWith('--rr-')) {
			tokens[prop] = root.style.getPropertyValue(prop);
		}
	}

	return buildMuiTheme(tokens as ThemeTokens);
}
