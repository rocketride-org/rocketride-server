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
 * ArrayWidget — an array property is ONE leaf (plan P25): the stored value is
 * the whole list and every edit stores the whole list. Three item shapes:
 *   - an enum item → a checkbox list (pick a subset, in declaration order);
 *   - a scalar item (string / number / integer / boolean) → one row per item
 *     with add / remove;
 *   - an object item (its own `properties`) → one small sub-form per item,
 *     each child addressed by its short `name` inside the item object.
 * While nothing is stored the default list shows as the ghost; the first edit
 * copies it into the file.
 */

import { CSSProperties, ReactElement } from 'react';
import type { ServiceProperty } from 'rocketride';
import { Button, commonStyles } from 'shell';

import { arrayItem, enumOptions, isFlagged, isGroup } from '../model';
import BooleanWidget from './BooleanWidget';
import EnumWidget from './EnumWidget';
import { fieldStyles } from './PropertyField';
import TextWidget from './TextWidget';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	list: {
		display: 'flex',
		flexDirection: 'column',
		gap: 6,
	} as CSSProperties,

	row: {
		display: 'flex',
		gap: 6,
		alignItems: 'flex-start',
	} as CSSProperties,

	rowControl: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	// One object item: a bordered card holding its sub-form.
	itemCard: {
		...commonStyles.cardFlat,
		padding: 10,
		flex: 1,
	} as CSSProperties,

	itemTitle: {
		...commonStyles.labelUppercase,
		marginBottom: 6,
	} as CSSProperties,

	subField: {
		marginBottom: 8,
	} as CSSProperties,

	subLabel: {
		...commonStyles.textMuted,
		display: 'block',
		marginBottom: 3,
	} as CSSProperties,

	checkRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		fontSize: 13,
		cursor: 'pointer',
	} as CSSProperties,

	ghostNote: {
		...commonStyles.textMuted,
		fontStyle: 'italic',
	} as CSSProperties,

	// Screen-reader-only text (the "Required" note on a required group).
	srOnly: {
		position: 'absolute',
		width: 1,
		height: 1,
		padding: 0,
		margin: -1,
		overflow: 'hidden',
		clip: 'rect(0 0 0 0)',
		whiteSpace: 'nowrap',
		border: 0,
	} as CSSProperties,
};

// =============================================================================
// Props
// =============================================================================

/** Props for {@link ArrayWidget}. */
export interface IArrayWidgetProps {
	/** The control's element id. */
	id: string;
	/** The array property (its `item` / `items` describes one element). */
	property: ServiceProperty;
	/** The stored list (undefined = ghost default). */
	stored: unknown;
	/** The effective list (stored ?? default). */
	value: unknown[];
	/** Whether the shown list is the ghost default. */
	ghost?: boolean;
	/** Stores the whole list. */
	onChange: (value: unknown[]) => void;
	/** Env keys for the `${}` autocomplete inside string items. */
	envKeys?: string[];
	/** Disabled state. */
	disabled?: boolean;
	/** Ids of the message / help elements the control is described by. */
	describedBy?: string;
	/** Required state, announced on the group. */
	required?: boolean;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the array control.
 *
 * @param props - {@link IArrayWidgetProps}.
 * @returns The control.
 */
export default function ArrayWidget({ id, property, value, ghost, onChange, envKeys, disabled, describedBy, required }: IArrayWidgetProps): ReactElement {
	const item = arrayItem(property);
	const title = String(property.title ?? property.name ?? 'Item');
	// The frame's label names the group; items are named by title and position.
	// A group carries no required state, so a required array says so in its
	// description through a screen-reader-only note.
	const requiredNoteId = `${id}-required`;
	const group = { id, role: 'group' as const, 'aria-labelledby': `${id}-label`, 'aria-describedby': [describedBy, required ? requiredNoteId : ''].filter(Boolean).join(' ') || undefined };
	const requiredNote = required ? (
		<span id={requiredNoteId} style={styles.srOnly}>
			Required
		</span>
	) : null;
	const itemType = typeof item?.type === 'string' ? item.type : 'string';
	const list = Array.isArray(value) ? value : [];

	// --- Enum item: pick a subset ---------------------------------------------
	if (item && Array.isArray(item.enum)) {
		const options = enumOptions(item);
		return (
			<div style={styles.list} {...group}>
				{requiredNote}
				{options.map(([optionValue, label]) => {
					const checked = list.includes(optionValue);
					return (
						<label key={String(optionValue)} style={{ ...styles.checkRow, ...(ghost ? fieldStyles.ghostControl : {}) }}>
							<input
								type="checkbox"
								checked={checked}
								disabled={disabled}
								onChange={(event) => {
									// Keep declaration order so the stored list is stable
									const next = options.map(([candidate]) => candidate).filter((candidate) => (candidate === optionValue ? event.target.checked : list.includes(candidate)));
									onChange(next);
								}}
							/>
							<span>{label}</span>
						</label>
					);
				})}
			</div>
		);
	}

	// --- Object item: one sub-form per element --------------------------------
	const objectChildren = item && (itemType === 'object' || isGroup(item)) ? ((item.properties as ServiceProperty[] | undefined) ?? []) : null;

	const update = (index: number, next: unknown): void => {
		const copy = [...list];
		copy[index] = next;
		onChange(copy);
	};
	const remove = (index: number): void => onChange(list.filter((_, position) => position !== index));
	const add = (): void => onChange([...list, objectChildren ? {} : itemType === 'boolean' ? false : itemType === 'number' || itemType === 'integer' ? 0 : '']);

	return (
		<div style={styles.list} {...group}>
			{requiredNote}
			{list.length === 0 && <span style={styles.ghostNote}>No entries</span>}
			{list.map((element, index) => (
				<div key={index} style={styles.row}>
					{objectChildren ? (
						<div style={styles.itemCard}>
							<div style={styles.itemTitle}>{`${title} ${index + 1}`}</div>
							{objectChildren.map((child) => {
								const name = typeof child.name === 'string' ? child.name : (typeof child.path === 'string' ? child.path.split('.').pop() ?? '' : '');
								if (!name || isFlagged(child, 'hidden') || child.type === 'constant') return null;
								const record = element !== null && typeof element === 'object' ? (element as Record<string, unknown>) : {};
								const childId = `${id}-${index}-${name}`;
								const set = (next: unknown): void => {
									const copy = { ...record };
									if (next === undefined) delete copy[name];
									else copy[name] = next;
									update(index, copy);
								};
								return (
									<div key={name} style={styles.subField}>
										<label style={styles.subLabel} htmlFor={childId}>
											{String(child.title ?? name)}
											{isFlagged(child, 'required') && <span style={fieldStyles.required}> *</span>}
										</label>
										{renderScalar(childId, child, record[name], set, envKeys, disabled || isFlagged(child, 'readonly'))}
									</div>
								);
							})}
						</div>
					) : (
						<div style={styles.rowControl}>{renderScalar(`${id}-${index}`, item ?? { name: 'item', type: 'string' }, element, (next) => update(index, next ?? ''), envKeys, disabled || (item ? isFlagged(item, 'readonly') : false), `${title} ${index + 1}`)}</div>
					)}
					{!disabled && (
						<Button variant="ghost" small onClick={() => remove(index)} title="Remove">
							×
						</Button>
					)}
				</div>
			))}
			{!disabled && (
				<div>
					<Button variant="secondary" small onClick={add}>
						+ Add
					</Button>
				</div>
			)}
		</div>
	);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Renders one scalar control inside an array (item or object-item child).
 * Items carry no `path`, so they are addressed by position / short name. An
 * absent child key still MEANS the child's default, so a choice control shows
 * that default without writing it into the item.
 */
function renderScalar(id: string, descriptor: ServiceProperty, value: unknown, onChange: (next: unknown) => void, envKeys: string[] | undefined, disabled: boolean | undefined, label?: string): ReactElement {
	const type = typeof descriptor.type === 'string' ? descriptor.type : 'string';
	const absent = value === undefined || value === null;
	const shown = absent ? descriptor.default : value;
	const required = isFlagged(descriptor, 'required');
	if (Array.isArray(descriptor.enum)) {
		return <EnumWidget id={id} options={enumOptions(descriptor)} value={shown} ghost={absent && shown !== undefined} onChange={onChange} disabled={disabled} required={required} label={label} />;
	}
	if (type === 'boolean') {
		return <BooleanWidget id={id} value={shown === true} ghost={absent} onChange={onChange} disabled={disabled} required={required} label={label} />;
	}
	const numeric = type === 'number' || type === 'integer';
	return <TextWidget id={id} type={numeric ? type : 'string'} stored={value} defaultValue={descriptor.default} onChange={onChange} multiline={descriptor.format === 'textarea'} secret={isFlagged(descriptor, 'secret')} envKeys={envKeys} disabled={disabled} required={required} label={label} placeholder={typeof descriptor.placeholder === 'string' ? descriptor.placeholder : undefined} />;
}
