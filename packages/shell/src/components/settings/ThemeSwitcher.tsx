// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ThemeSwitcher — pick the shell theme from a settings page.
 *
 * Inside the shell it needs no props: it reads the theme list and the
 * current theme from the workspace and switches with `setTheme`, the same
 * path the sidebar footer's picker uses. Outside the shell (a webview, a
 * test, a standalone host) pass `options`, `value` and `onChange` to drive
 * it yourself; with neither, it renders nothing.
 *
 * Renders a Select by default, or a RadioGroup (`variant="radio"`) when
 * there are only a few themes and the page has room.
 */

import React from 'react';
import { useOptionalWorkspace } from '../workspace/WorkspaceContext';
import { Select } from '../form/Select';
import { RadioGroup } from '../form/RadioGroup';

// =============================================================================
// TYPES
// =============================================================================

/** A theme choice. */
export interface IThemeChoice {
	/** Theme id (e.g. `'rocketride-light'`). */
	id: string;
	/** Display name. */
	name: string;
}

/** Props for the {@link ThemeSwitcher} component. */
export interface IThemeSwitcherProps {
	/** Select (default) or radio buttons. */
	variant?: 'select' | 'radio';
	/** Themes to offer (defaults to the shell's list). */
	options?: IThemeChoice[];
	/** Current theme id (defaults to the shell's). */
	value?: string;
	/** Fired with the chosen theme id (defaults to the shell's setTheme). */
	onChange?: (themeId: string) => void;
	/** Accessible name when not inside a Field. Defaults to `'Theme'`. */
	ariaLabel?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the theme picker.
 *
 * @param props - {@link IThemeSwitcherProps}.
 * @returns The picker, or nothing when there is no theme source.
 */
export function ThemeSwitcher({ variant = 'select', options, value, onChange, ariaLabel = 'Theme' }: IThemeSwitcherProps): React.ReactElement | null {
	const workspace = useOptionalWorkspace();

	const choices = options ?? workspace?.themeOptions ?? [];
	const current = value ?? workspace?.prefs.theme ?? null;
	const change = onChange ?? workspace?.setTheme;

	if (choices.length === 0 || !change) return null;

	if (variant === 'radio') {
		return <RadioGroup ariaLabel={ariaLabel} options={choices.map((choice) => ({ value: choice.id, label: choice.name }))} value={current} onChange={change} />;
	}

	return <Select ariaLabel={ariaLabel} options={choices.map((choice) => ({ value: choice.id, label: choice.name }))} value={current} onChange={change} />;
}
