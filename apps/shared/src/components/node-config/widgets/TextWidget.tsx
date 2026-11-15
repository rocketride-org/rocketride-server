// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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

/**
 * TextWidget — string / number / integer leaves. One input: the default shows
 * as the placeholder while nothing is stored (the ghost), typing stores the
 * value, clearing the field deletes the key. `format: textarea` renders a
 * textarea; `secret` leaves mask a stored value until the user chooses to
 * replace it; string leaves get the `${ROCKETRIDE_*}` autocomplete.
 */

import { CSSProperties, ReactElement, useCallback, useRef, useState } from 'react';
import { Button, InputField, commonStyles } from 'shell';

import EnvVarSuggestions from './EnvVarSuggestions';
import { fieldStyles } from './PropertyField';
import { useEnvVarAutocomplete } from './useEnvVarAutocomplete';

// =============================================================================
// Constants
// =============================================================================

/** Trailing characters left visible when a stored secret is masked. */
const SECRET_VISIBLE_TAIL = 4;

// =============================================================================
// Styles
// =============================================================================

const styles = {
	textarea: {
		...commonStyles.inputField,
		minHeight: 90,
		resize: 'vertical',
	} as CSSProperties,

	// Masked stored-secret display.
	masked: {
		...commonStyles.inputField,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
		fontFamily: 'var(--rr-font-family-mono, monospace)',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Masks a secret, keeping its last few characters so the user can tell which
 * key is stored.
 *
 * @param value - The stored secret.
 * @returns The masked text.
 */
export function maskSecret(value: string): string {
	if (value.length <= SECRET_VISIBLE_TAIL) return '•'.repeat(value.length);
	return '•'.repeat(value.length - SECRET_VISIBLE_TAIL) + value.slice(-SECRET_VISIBLE_TAIL);
}

/**
 * Parses an input string into the leaf's numeric type.
 *
 * @param text - The raw input text.
 * @param integer - Whether the leaf is an integer.
 * @returns The number, or the raw text when it does not parse (so the
 *   validator reports the type error instead of silently dropping input).
 */
function parseNumber(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed === '') return undefined;
	const numeric = Number(trimmed);
	// Mid-edit text ("-", "1e") stays as typed so the validator flags it
	// instead of the input silently dropping it; a completed number wins
	return Number.isNaN(numeric) ? trimmed : numeric;
}

// =============================================================================
// Props
// =============================================================================

/** Props for {@link TextWidget}. */
export interface ITextWidgetProps {
	/** The control's element id. */
	id: string;
	/** `string`, `number` or `integer`. */
	type: 'string' | 'number' | 'integer';
	/** The stored value (undefined = ghost default). */
	stored: unknown;
	/** The node's default (shown as the ghost). */
	defaultValue: unknown;
	/** Stores a value; undefined deletes the key. */
	onChange: (value: unknown) => void;
	/** Multi-line input. */
	multiline?: boolean;
	/** Masks the stored value until replaced. */
	secret?: boolean;
	/** The value lives in the engine's encrypted section (no plaintext here). */
	storedSecurely?: boolean;
	/** Placeholder override (falls back to the default). */
	placeholder?: string;
	/** Env keys for the `${}` autocomplete. */
	envKeys?: string[];
	/** Minimum / maximum for numeric inputs. */
	minimum?: number;
	maximum?: number;
	/** Disabled (saving, locked canvas, `readonly` flag). */
	disabled?: boolean;
	/** Invalid state (error border). */
	invalid?: boolean;
	/** Focus on mount. */
	autoFocus?: boolean;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a text / number input for one leaf.
 *
 * @param props - {@link ITextWidgetProps}.
 * @returns The control.
 */
export default function TextWidget({ id, type, stored, defaultValue, onChange, multiline, secret, storedSecurely, placeholder, envKeys = [], minimum, maximum, disabled, invalid, autoFocus }: ITextWidgetProps): ReactElement {
	// The shell InputField forwards no ref, so the wrapper anchors the
	// suggestion list and the control is found inside it when needed.
	const wrapperRef = useRef<HTMLDivElement | null>(null);
	const controlOf = (): HTMLInputElement | HTMLTextAreaElement | null => wrapperRef.current?.querySelector('input, textarea') ?? null;
	const autocomplete = useEnvVarAutocomplete(type === 'string' ? envKeys : []);

	// A stored secret stays masked until the user chooses to replace it, so an
	// existing key is never edited by accident. Typing starts fresh.
	const hasStoredSecret = Boolean(secret) && (storedSecurely || (typeof stored === 'string' && stored.length > 0));
	const [replacing, setReplacing] = useState(false);
	const masked = hasStoredSecret && !replacing;

	const text = stored === undefined || stored === null ? '' : String(stored);
	const ghostText = defaultValue === undefined || defaultValue === null ? '' : String(defaultValue);

	const commit = useCallback(
		(raw: string) => {
			if (type === 'string') onChange(raw === '' ? undefined : raw);
			else onChange(parseNumber(raw));
		},
		[type, onChange]
	);

	const pick = useCallback(
		(key: string) => {
			commit(autocomplete.handleSelect(key, text, controlOf()));
		},
		[autocomplete, commit, text]
	);

	// --- Masked stored secret ------------------------------------------------
	if (masked) {
		return (
			<div style={styles.masked}>
				<span style={commonStyles.textEllipsis}>{storedSecurely ? 'Saved securely' : maskSecret(text)}</span>
				{!disabled && (
					<Button variant="ghost" small onClick={() => { setReplacing(true); onChange(undefined); }} title="Enter a new value">
						Replace
					</Button>
				)}
			</div>
		);
	}

	const style: CSSProperties = { ...fieldStyles.input, ...(invalid ? fieldStyles.inputError : {}) };
	const shared = {
		id,
		value: text,
		placeholder: placeholder ?? ghostText,
		disabled,
		autoFocus,
		'aria-invalid': invalid || undefined,
	};

	// --- Textarea ------------------------------------------------------------
	if (multiline) {
		return (
			<div ref={wrapperRef}>
				<textarea
					{...shared}
					style={{ ...styles.textarea, ...(invalid ? fieldStyles.inputError : {}) }}
					onChange={(event) => {
						commit(event.target.value);
						autocomplete.handleInputChange(event.target.value, event.target.selectionStart ?? event.target.value.length);
					}}
					onKeyDown={(event) => autocomplete.handleKeyDown(event, pick)}
				/>
				<EnvVarSuggestions open={autocomplete.isOpen} anchorRef={wrapperRef} suggestions={autocomplete.suggestions} highlightedIndex={autocomplete.highlightedIndex} onSelect={pick} onDismiss={autocomplete.handleDismiss} />
			</div>
		);
	}

	// --- Single line ---------------------------------------------------------
	return (
		<div ref={wrapperRef}>
			<InputField
				{...shared}
				type={type === 'string' ? (secret ? 'password' : 'text') : 'number'}
				step={type === 'integer' ? 1 : 'any'}
				min={minimum}
				max={maximum}
				style={style}
				autoComplete={secret ? 'new-password' : undefined}
				onChange={(event) => {
					commit(event.target.value);
					autocomplete.handleInputChange(event.target.value, event.target.selectionStart ?? event.target.value.length);
				}}
				onKeyDown={(event) => autocomplete.handleKeyDown(event, pick)}
			/>
			<EnvVarSuggestions open={autocomplete.isOpen} anchorRef={wrapperRef} suggestions={autocomplete.suggestions} highlightedIndex={autocomplete.highlightedIndex} onSelect={pick} onDismiss={autocomplete.handleDismiss} />
		</div>
	);
}
