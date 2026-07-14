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

import { MouseEvent, ReactNode } from 'react';
import Box from '@mui/material/Box';
import InfoIcon from '@mui/icons-material/Info';
import Tooltip from '@mui/material/Tooltip';

// =============================================================================
// Types
// =============================================================================

interface FieldLabelWithInfoProps {
	/** The already-rendered field label content. */
	label: ReactNode;
	/** Optional field description; when empty, no info icon is rendered. */
	description?: ReactNode;
	/** Field title used to build the info icon's accessible name. */
	fieldTitle?: string;
	/** Optional id applied to the wrapper (e.g., RJSF descriptionId). */
	id?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a field label followed by an optional accessible info icon that
 * reveals the field description in a MUI Tooltip. Centralizes the icon size,
 * color, tooltip placement, and hover/focus/touch behavior so text, select,
 * API-key, and checkbox widgets stay consistent. It is presentation only and
 * never receives or exposes field values.
 */
export default function FieldLabelWithInfo({ label, description, fieldTitle, id }: FieldLabelWithInfoProps) {
	// No description means the field renders its ordinary label with no icon.
	if (!description) {
		return <>{label}</>;
	}

	const accessibleName = fieldTitle ? `More information about ${fieldTitle}` : 'More information';

	// Keep the icon pointer-interactive even when nested inside a MUI InputLabel or
	// FormControlLabel: clicking the icon must not toggle a checkbox or focus/steal
	// focus from the associated input. Suppressing both mousedown and click cancels
	// the label's default activation without affecting the tooltip.
	const suppressLabelActivation = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<Box component="span" id={id} sx={{ display: 'inline-flex', alignItems: 'center' }}>
			{label}
			<Tooltip title={description} placement="right">
				<Box component="span" role="img" tabIndex={0} aria-label={accessibleName} onMouseDown={suppressLabelActivation} onClick={suppressLabelActivation} sx={{ display: 'inline-flex', alignItems: 'center', cursor: 'default' }}>
					<InfoIcon sx={{ ml: 0.5, color: 'text.secondary', fontSize: 16 }} />
				</Box>
			</Tooltip>
		</Box>
	);
}
