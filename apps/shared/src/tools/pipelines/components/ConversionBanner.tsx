// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * The convert-on-open banner (plan §5.6.8, B20).
 *
 * A pipeline file written before the config format switch is converted by
 * the server the moment the editor sees a node with unknown keys; this
 * banner sits above the editor's page strip, beside the developer-id
 * onboarding, and lists what the converter changed, dropped or filled in,
 * and which components it refused (those stay red with the same message on
 * their gear). The next save writes the converted shape. It renders nothing
 * while there is no conversion to report.
 */

import React from 'react';
import type { CSSProperties } from 'react';
import { Banner } from 'shell';

import type { IConversionBanner } from '../convertOnOpen';

// =============================================================================
// Styles
// =============================================================================

const styles: Record<string, CSSProperties> = {
	wrap: {
		padding: '8px 12px 0',
	},
	list: {
		margin: '6px 0 0',
		paddingLeft: 18,
		fontSize: 12,
	},
};

// =============================================================================
// Props
// =============================================================================

/** Props for {@link ConversionBanner}. */
export interface IConversionBannerProps {
	/** The banner model from the last converter reply; null = nothing to show. */
	conversion: IConversionBanner | null;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the converter's report for the open pipeline.
 *
 * @param props - See {@link IConversionBannerProps}.
 * @returns The banner, or null when there was no conversion.
 */
export const ConversionBanner: React.FC<IConversionBannerProps> = ({ conversion }) => {
	if (!conversion) return null;
	return (
		<div style={styles.wrap}>
			<Banner variant={conversion.variant}>
				<strong>{conversion.title}</strong>
				{conversion.items.length > 0 ? (
					<ul style={styles.list}>
						{conversion.items.map((item, index) => (
							<li key={`${index}:${item}`}>{item}</li>
						))}
					</ul>
				) : null}
			</Banner>
		</div>
	);
};

export default ConversionBanner;
