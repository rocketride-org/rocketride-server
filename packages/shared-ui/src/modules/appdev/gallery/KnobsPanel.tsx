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

// =============================================================================
// KNOBS PANEL — knob controls for a gallery entry's live demo
// =============================================================================

/**
 * Renders an entry's knob spec as a row of controls and lifts every change
 * to the gallery pane, which feeds the values back into the live demo and
 * the snippet builder. Dogfooded from stock components: booleans and selects
 * render as ToggleGroups, text and numbers as InputFields.
 */

import React from 'react';
import { InputField } from 'shell';
import { ToggleGroup } from '../../../components/toggle-group/ToggleGroup';
import { commonStyles } from 'shell/src/themes/styles';
import type { IGalleryKnob, KnobValue, KnobValues } from './galleryTypes';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link KnobsPanel} component. */
export interface IKnobsPanelProps {
	/** The entry's knob spec, in render order. */
	knobs: IGalleryKnob[];
	/** Current values keyed by knob id. */
	values: KnobValues;
	/** Fired with the knob id and its new value on every edit. */
	onChange: (id: string, value: KnobValue) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '10px 22px',
		padding: '12px 14px',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		background: 'var(--rr-bg-surface-alt)',
	},
	knob: {
		display: 'flex',
		flexDirection: 'column',
		gap: 5,
	},
	label: {
		...commonStyles.labelUppercase,
		fontSize: 10,
	},
	textInput: {
		width: 170,
	},
	numberInput: {
		width: 80,
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the knob controls for one gallery entry.
 *
 * Steps: for each knob in spec order, render its label plus the control
 * matching the knob kind, seeded from `values`, lifting edits via `onChange`.
 *
 * @param props - See {@link IKnobsPanelProps}.
 */
export const KnobsPanel: React.FC<IKnobsPanelProps> = ({ knobs, values, onChange }) => {
	/** Renders the control for one knob by kind. */
	const renderControl = (knob: IGalleryKnob): React.ReactNode => {
		const value = values[knob.id];
		switch (knob.kind) {
			case 'boolean':
				// On/Off segmented control — matches the toolbar toggle idiom
				return (
					<ToggleGroup
						options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]}
						value={value ? 'on' : 'off'}
						onChange={(id) => onChange(knob.id, id === 'on')}
					/>
				);
			case 'select':
				// One segment per option — knob selects stay small (2-5 options)
				return (
					<ToggleGroup
						options={(knob.options ?? []).map((option) => ({ id: option, label: option }))}
						value={String(value)}
						onChange={(id) => onChange(knob.id, id)}
					/>
				);
			case 'number':
				return (
					<InputField
						type="number"
						style={styles.numberInput}
						value={Number(value)}
						onChange={(event) => onChange(knob.id, Number(event.target.value))}
					/>
				);
			case 'text':
			default:
				return (
					<InputField
						type="text"
						style={styles.textInput}
						value={String(value)}
						onChange={(event) => onChange(knob.id, event.target.value)}
					/>
				);
		}
	};

	return (
		<div style={styles.wrap}>
			{knobs.map((knob) => (
				<div key={knob.id} style={styles.knob}>
					<span style={styles.label}>{knob.label}</span>
					{renderControl(knob)}
				</div>
			))}
		</div>
	);
};
