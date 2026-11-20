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

// =============================================================================
// VECTOR-UI — CONNECTION DRAWER DETAILS (what the store node says about itself)
// =============================================================================
//
// Renders vector/connections.ts drawerView: roles, backend and version,
// collection, metric, model, dimension, index, the embedding and LLM node
// names, the write switch and support, then the notes. Nothing here reads a
// component's configuration or holds a credential.
// =============================================================================

import React from 'react';
import { LabelValue, Section } from 'shell';
import type { IDrawerView } from '../vector/connections';
import { styles } from '../styles';

/** Props for the {@link ConnectionDrawerDetails} component. */
export interface IConnectionDrawerDetailsProps {
	drawer: IDrawerView;
}

/**
 * The drawer's details.
 *
 * @param props - {@link IConnectionDrawerDetailsProps}.
 * @returns The sections.
 */
export function ConnectionDrawerDetails({ drawer }: IConnectionDrawerDetailsProps): React.ReactElement {
	return (
		<>
			<Section label="Connection">
				{drawer.rows.map((row) => (
					<LabelValue key={row.label} label={row.label}>
						{row.value}
					</LabelValue>
				))}
			</Section>
			{drawer.notes.length > 0 && (
				<Section label="What to know">
					{drawer.notes.map((note) => (
						<div key={note} style={{ ...styles.small, marginBottom: 8 }}>
							{note}
						</div>
					))}
				</Section>
			)}
		</>
	);
}

export default ConnectionDrawerDetails;
