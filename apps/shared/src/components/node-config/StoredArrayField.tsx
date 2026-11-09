// Copyright (c) 2026 Aparavi Software AG Inc. MIT License.

import type { FieldProps } from '@rjsf/utils';
import { Button, commonStyles } from 'shell';

/** Opaque saved entries are kept until the user explicitly chooses to replace them. */
export default function StoredArrayField({ schema, uiSchema, formContext, disabled, readonly }: FieldProps) {
	return (
		<div>
			<div style={commonStyles.labelUppercase}>{schema.title}</div>
			<p>Saved securely. Existing entries will be kept when you save other changes.</p>
			<Button variant="ghost" small disabled={disabled || readonly} onClick={() => formContext.replaceStoredArray(uiSchema?.['ui:storedArrayPath'])}>
				Replace saved entries
			</Button>
			<p style={commonStyles.textMuted}>Replacing starts an empty list. Saving it replaces all saved entries.</p>
		</div>
	);
}
