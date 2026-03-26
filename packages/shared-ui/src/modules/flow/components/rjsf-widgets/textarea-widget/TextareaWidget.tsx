/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import { ChangeEvent, FocusEvent, useState, useEffect, FC } from 'react';
import TextField from '@mui/material/TextField';
import { WidgetProps } from '@rjsf/utils';

const TextareaWidget: FC<WidgetProps> = ({ id, value, label, required, autofocus, disabled, readonly, rawErrors, onChange, onBlur, onFocus, options }) => {
	const [controlledValue, setControlledValue] = useState(value ?? '');

	useEffect(() => {
		if (value !== undefined && value !== null) {
			setControlledValue(value);
		}
	}, [value]);

	const minRows = (options?.rows as number) ?? 1;
	const maxRows = (options?.maxRows as number) ?? 5;

	return (
		<TextField
			id={id}
			name={id}
			required={required}
			label={label}
			size="small"
			fullWidth
			multiline
			minRows={minRows}
			maxRows={maxRows}
			value={controlledValue}
			onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
				setControlledValue(e.target.value);
				onChange(e.target.value === '' ? options.emptyValue : e.target.value);
			}}
			onBlur={(e: FocusEvent<HTMLTextAreaElement>) => onBlur && onBlur(id, e.target.value)}
			onFocus={(e: FocusEvent<HTMLTextAreaElement>) => onFocus && onFocus(id, e.target.value)}
			autoFocus={autofocus}
			disabled={disabled || readonly}
			error={!!rawErrors?.length}
			variant="outlined"
		/>
	);
};

export default TextareaWidget;
