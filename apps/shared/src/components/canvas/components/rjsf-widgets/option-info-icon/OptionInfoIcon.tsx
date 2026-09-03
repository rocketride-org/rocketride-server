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

import { SyntheticEvent } from 'react';
import Box from '@mui/material/Box';
import InfoIcon from '@mui/icons-material/Info';
import Tooltip from '@mui/material/Tooltip';

import { sanitizeAndParseHtmlToReact } from '../../../util/helpers';

// =============================================================================
// Types
// =============================================================================

type OptionInfoIconProps = {
	/** Help text for this option; may contain simple HTML, which is sanitized. */
	description: string;
	/** Id of the hidden text node the option's `aria-describedby` points at. */
	descriptionId: string;
};

// =============================================================================
// Component
// =============================================================================

/**
 * Per-option help affordance for a select dropdown: a hover tooltip plus the
 * hidden text node that carries the same content to assistive technology.
 *
 * Deliberately not `FieldLabelWithInfo`. That component's trigger is tabbable,
 * which is correct beside a field label but wrong inside a `MenuItem`: MUI's
 * `Menu` closes on Tab so the trigger is unreachable anyway, and a focusable
 * descendant makes `MenuList` resolve the next option from the focused span
 * rather than the option row, which silently kills arrow-key navigation. The
 * icon is therefore pointer-only and hidden from the accessibility tree, and
 * the description reaches screen readers through the option's
 * `aria-describedby` instead.
 *
 * Populate it from `ui:enumDescriptions`, a parallel array index-aligned with
 * `ui:enumNames` that the engine builds from an option's optional third tuple
 * element in `services.json` (`[value, label, description]`).
 *
 * @param description - Help text for the option the icon sits on.
 * @param descriptionId - Id the owning option references via `aria-describedby`.
 * @return The icon and its visually hidden description node.
 * @example
 * <OptionInfoIcon description="Deals and their products." descriptionId="root_toolGroups__option_0__description" />
 */
export default function OptionInfoIcon({ description, descriptionId }: OptionInfoIconProps) {
	// A MenuItem commits its selection on click, so let neither the pointer press
	// nor the click reach it - reading the help must not toggle the option.
	const suppressOptionActivation = (event: SyntheticEvent) => {
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', ml: 'auto', pl: 1 }}>
			<Tooltip title={sanitizeAndParseHtmlToReact(description)} placement="right">
				<Box component="span" onMouseDown={suppressOptionActivation} onClick={suppressOptionActivation} sx={{ display: 'inline-flex', alignItems: 'center', cursor: 'default' }}>
					<InfoIcon aria-hidden="true" sx={{ color: 'text.secondary', fontSize: 16 }} />
				</Box>
			</Tooltip>
			{/* The tooltip is pointer-only, so the same text is mirrored here for the
			    option's aria-describedby. Clipped rather than display:none, which
			    would take it out of the accessibility tree along with the pixels. */}
			<Box component="span" id={descriptionId} sx={{ position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}>
				{description}
			</Box>
		</Box>
	);
}
