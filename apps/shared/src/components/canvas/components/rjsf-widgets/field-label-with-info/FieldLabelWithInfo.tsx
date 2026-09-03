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

import { KeyboardEvent, ReactNode, SyntheticEvent } from 'react';
import Box from '@mui/material/Box';
import InfoIcon from '@mui/icons-material/Info';
import Tooltip from '@mui/material/Tooltip';

import { sanitizeAndParseHtmlToReact } from '../../../util/helpers';

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
	// No description means the field renders its ordinary label with no icon, but
	// keep the same id-bearing inline wrapper so consumers relying on the id
	// (e.g., RJSF descriptionId) still find their target element.
	if (!description) {
		return (
			<Box component="span" id={id} sx={{ display: 'inline-flex', alignItems: 'center' }}>
				{label}
			</Box>
		);
	}

	const accessibleName = fieldTitle ? `More information about ${fieldTitle}` : 'More information';

	// Service descriptions may carry simple markup. Tooltip renders a string
	// verbatim, so parse it the way DescriptionField does rather than showing the
	// user a literal <b>.
	const richDescription = typeof description === 'string' ? sanitizeAndParseHtmlToReact(description) : description;

	// Keep the icon pointer-interactive even when nested inside a MUI InputLabel or
	// FormControlLabel: activating the icon must not toggle a checkbox or steal focus.
	// Suppressing mouse and keyboard activation cancels the label's default behavior
	// without affecting the tooltip.
	const suppressLabelActivation = (event: SyntheticEvent) => {
		if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Enter' && (event as KeyboardEvent).key !== ' ') return;
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<Box component="span" id={id} sx={{ display: 'inline-flex', alignItems: 'center' }}>
			{label}
			<Tooltip title={richDescription} placement="right" describeChild>
				<span role="button" tabIndex={0} aria-label={accessibleName} onMouseDown={suppressLabelActivation} onClick={suppressLabelActivation} onKeyDown={suppressLabelActivation} style={{ display: 'inline-flex', alignItems: 'center', cursor: 'default', pointerEvents: 'auto' }}>
					<InfoIcon sx={{ ml: 0.5, color: 'text.secondary', fontSize: 16 }} />
				</span>
			</Tooltip>
		</Box>
	);
}
