// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

import { useEffect, useRef, useState, FC } from 'react';
import { WidgetProps } from '@rjsf/utils';
import { InputAdornment, TextField, Tooltip } from '@mui/material';
import { Delete } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';

/** Number of trailing characters to display unmasked when an API key is present. */
const lastCharsToShow = 4;

/**
 * Returns a masked representation of an API key, showing only the last few characters.
 * This prevents accidental exposure of sensitive key values in the UI while still
 * letting the user confirm which key is stored.
 *
 * @param val - The raw API key string to mask.
 * @returns The masked string with bullet characters replacing hidden characters.
 */
const getMaskedValue = (val: string): string => {
	if (!val) return '';
	// If the value is shorter than the number of characters to show, mask the entire value.
	if (val.length <= lastCharsToShow) {
		return '•'.repeat(val.length);
	}
	const maskedPart = '•'.repeat(val.length - lastCharsToShow);
	return maskedPart + val.slice(-lastCharsToShow);
};

/**
 * RJSF widget for securely entering and displaying API keys.
 * When a key already exists, the field shows a masked value (e.g., "••••abcd")
 * in read-only mode with a delete button to clear it. Once cleared, the field
 * becomes editable for entering a new key. This prevents accidental modification
 * of existing keys while still allowing replacement.
 */
const ApiKeyWidget: FC<WidgetProps> = ({
	id,
	value,
	label,
	required,
	autofocus,
	disabled,
	readonly,
	rawErrors,
	onChange,
}) => {
	const { t } = useTranslation();

	// If a value already exists, start in masked (read-only) mode to prevent accidental edits
	const [maskApiKey, setMaskApiKey] = useState(!!value);
	// Initialize the displayed value as the masked representation of the stored key
	const [tempValue, setTempValue] = useState(() => getMaskedValue(value));

	const inputRef = useRef<HTMLInputElement>(null);

	// Sync when an external update provides a value while the widget is showing empty
	// (e.g., credential carry-over during a profile/model switch)
	useEffect(() => {
		if (value && !tempValue) {
			setTempValue(getMaskedValue(value));
			setMaskApiKey(true);
		}
	}, [value, tempValue]);

	// When in masked mode, scroll the input to the end so the visible trailing characters are shown
	useEffect(() => {
		if (inputRef.current && maskApiKey) {
			inputRef.current.scrollLeft = inputRef.current.scrollWidth;
		}
	}, [maskApiKey]);

	return (
		<TextField
			id={id}
			name={id}
			required={required}
			type={'text'}
			label={label}
			inputRef={inputRef}
			size="small"
			value={tempValue}
			onChange={(e) => {
				// Sync both the local display value and the form value on every keystroke
				setTempValue(e.target.value);
				onChange(e.target.value);
			}}
			autoFocus={autofocus}
			disabled={disabled}
			fullWidth
			variant="outlined"
			aria-readonly={maskApiKey ?? readonly}
			error={!!rawErrors}
			helperText={rawErrors}
			slotProps={{
				input: {
					readOnly: maskApiKey,
					endAdornment: maskApiKey && (
						<InputAdornment position="end">
							<Tooltip title={t('form.apiKeyRemoveTooltip')}>
								<Delete
									sx={(theme) => ({
										cursor: 'pointer',
										color: theme.palette.error.light,
										'&:hover': {
											color: theme.palette.error.main,
										},
									})}
									onClick={() => {
										// Clear the stored key and exit masked mode so user can type a new one
										setTempValue('');
										onChange('');
										setMaskApiKey(false);
									}}
								/>
							</Tooltip>
						</InputAdornment>
					),
				},
			}}
		/>
	);
};

export default ApiKeyWidget;
