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
// SETTINGS FIELDS — labelled controls the four sub-pages share
// =============================================================================
//
// Every field is a real `<label>` bound to its control, so the label text is
// the control's accessible name and clicking it focuses the control — the
// keyboard path and the pointer path are the same path. The `help` line is
// bound through `aria-describedby`, so it is read out too rather than being
// decoration.
//
// Titles and defaults come from `nodes/src/nodes/discord/services.json`; each
// field names the `discord.*` key it maps to in its help line, so a reader can
// tell what the form actually changes.
// =============================================================================

import React, { useId } from 'react';
import type { ReactNode } from 'react';
import { Chip } from 'shell';

// =============================================================================
// STYLES
// =============================================================================

/**
 * One field row: label and help on the left, the control on the right — the
 * design system's FormField.
 */
const FieldRow: React.FC<{ id: string; label: string; help: string; children: ReactNode }> = ({ id, label, help, children }) => (
	<div className="dd-field">
		<div>
			<label htmlFor={id} className="dd-field__label">
				{label}
			</label>
			<p id={`${id}-help`} className="dd-field__help">
				{help}
			</p>
		</div>
		<div className="dd-field__control">{children}</div>
	</div>
);

// =============================================================================
// TEXT
// =============================================================================

/** Props shared by every field. */
interface BaseFieldProps {
	/** The control's visible name — the services.json title where one exists. */
	label: string;
	/** What the value does, and which `discord.*` key it writes. */
	help: string;
	/** Read-only mode (sample data on, or a save in flight). */
	disabled?: boolean;
}

/**
 * A single-line text field.
 *
 * @param props.value - Current value.
 * @param props.onChange - Fired with the new value on every keystroke.
 * @param props.placeholder - Hint shown while empty.
 * @returns The labelled input.
 */
export const TextField: React.FC<BaseFieldProps & { value: string; onChange: (value: string) => void; placeholder?: string }> = ({ label, help, value, onChange, placeholder, disabled }) => {
	const id = useId();
	return (
		<FieldRow id={id} label={label} help={help}>
			<input id={id} className="dd-input" aria-describedby={`${id}-help`} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
		</FieldRow>
	);
};

// =============================================================================
// NUMBER
// =============================================================================

/**
 * A numeric field. An unparseable entry keeps the last good number rather than
 * writing NaN into the settings.
 *
 * The box holds its own text, so CLEARING it leaves the setting alone instead
 * of committing a value: `Number('')` is 0, which is finite, and 0 is a real
 * and harmful setting here — `maxAttachmentBytes: 0` skips every attachment.
 * An empty box means "still typing", and the last good number stands until a
 * new one is typed.
 *
 * @param props.value - Current value.
 * @param props.onChange - Fired with the new number.
 * @param props.min - Lowest accepted value.
 * @returns The labelled input.
 */
export const NumberField: React.FC<BaseFieldProps & { value: number; onChange: (value: number) => void; min?: number; max?: number }> = ({ label, help, value, onChange, min = 0, max, disabled }) => {
	const id = useId();
	const [draft, setDraft] = React.useState(String(value));

	// Re-seed the box when the saved value moves underneath it (a Reset, or
	// another sub-page's save landing in the workspace).
	const lastValue = React.useRef(value);
	if (lastValue.current !== value) {
		lastValue.current = value;
		if (draft.trim().length === 0 || Number(draft) !== value) setDraft(String(value));
	}

	return (
		<FieldRow id={id} label={label} help={help}>
			<input
				id={id}
				className="dd-input"
				aria-describedby={`${id}-help`}
				type="number"
				min={min}
				max={max}
				value={draft}
				disabled={disabled}
				onChange={(e) => {
					const raw = e.target.value;
					setDraft(raw);
					if (raw.trim().length === 0) return;
					const next = Number(raw);
					// The node clamps to the same bounds; clamping here keeps the saved
					// value equal to what the node will actually use.
					if (Number.isFinite(next)) onChange(Math.min(max ?? Infinity, Math.max(min, next)));
				}}
			/>
		</FieldRow>
	);
};

// =============================================================================
// BOOLEAN
// =============================================================================

/**
 * A checkbox field.
 *
 * @param props.value - Whether the box is ticked.
 * @param props.onChange - Fired with the new state.
 * @returns The labelled checkbox.
 */
export const BooleanField: React.FC<BaseFieldProps & { value: boolean; onChange: (value: boolean) => void }> = ({ label, help, value, onChange, disabled }) => {
	const id = useId();
	return (
		<FieldRow id={id} label={label} help={help}>
			<span className="dd-switchrow">
				<button id={id} type="button" role="switch" className="dd-switch" aria-checked={value} aria-describedby={`${id}-help`} disabled={disabled} onClick={() => onChange(!value)} />
				<span className="dd-caption">{value ? 'On' : 'Off'}</span>
			</span>
		</FieldRow>
	);
};

// =============================================================================
// SELECT
// =============================================================================

/**
 * A single-choice field over a fixed vocabulary (a services.json `enum`).
 *
 * @param props.value - Current value.
 * @param props.options - The choices, in the order they should read.
 * @param props.onChange - Fired with the chosen value.
 * @returns The labelled select.
 */
export function SelectField<T extends string>({
	label,
	help,
	value,
	options,
	onChange,
	disabled,
}: BaseFieldProps & {
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
}): React.ReactElement {
	const id = useId();
	return (
		<FieldRow id={id} label={label} help={help}>
			<select id={id} aria-describedby={`${id}-help`} value={value} disabled={disabled} className="dd-select" onChange={(e) => onChange(e.target.value as T)}>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</FieldRow>
	);
}

// =============================================================================
// ID LIST
// =============================================================================

/**
 * A list-of-ids field: comma-or-newline separated entry, rendered back as
 * removable chips.
 *
 * One text box rather than an add-one-at-a-time widget, because Discord ids are
 * pasted from the client in batches; the chips are there so a typo is visible
 * and removable without re-typing the whole list.
 *
 * @param props.value - Current ids.
 * @param props.onChange - Fired with the new id list.
 * @returns The labelled field.
 */
export const IdListField: React.FC<BaseFieldProps & { value: string[]; onChange: (value: string[]) => void; placeholder?: string }> = ({ label, help, value, onChange, placeholder, disabled }) => {
	const id = useId();
	const [draft, setDraft] = React.useState(value.join(', '));

	// Re-seed the text box when the saved value changes underneath it (a Reset,
	// or another tab's save landing in the workspace).
	const joined = value.join(', ');
	const lastJoined = React.useRef(joined);
	if (lastJoined.current !== joined) {
		lastJoined.current = joined;
		if (draft.trim() !== joined) setDraft(joined);
	}

	/** Split the text box into ids, dropping blanks. */
	const commit = (text: string) => {
		const ids = text
			.split(/[\s,]+/)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		onChange(ids);
	};

	return (
		<FieldRow id={id} label={label} help={help}>
			<input
				id={id}
				className="dd-input"
				aria-describedby={`${id}-help`}
				value={draft}
				placeholder={placeholder}
				disabled={disabled}
				onChange={(e) => {
					setDraft(e.target.value);
					commit(e.target.value);
				}}
			/>
			{value.length > 0 && (
				<div className="dd-row" style={{ gap: 6 }}>
					{value.map((entry) => (
						<Chip
							key={entry}
							label={entry}
							onRemove={
								disabled
									? undefined
									: () => {
											const next = value.filter((candidate) => candidate !== entry);
											setDraft(next.join(', '));
											onChange(next);
										}
							}
						/>
					))}
				</div>
			)}
		</FieldRow>
	);
};

// =============================================================================
// TEXT LIST
// =============================================================================

/**
 * A list-of-phrases field: one entry per LINE, rendered back as removable
 * chips.
 *
 * Separate from {@link IdListField} because that one splits on whitespace as
 * well as commas, which is right for ids and emoji and wrong for anything with
 * a space in it — "Escalated to the RocketRide team." would become five
 * entries.
 *
 * @param props.value - Current entries.
 * @param props.onChange - Fired with the new list.
 * @param props.rows - Height of the box in lines. Default 3.
 * @returns The labelled field.
 */
export const TextListField: React.FC<BaseFieldProps & { value: string[]; onChange: (value: string[]) => void; placeholder?: string; rows?: number }> = ({ label, help, value, onChange, placeholder, rows = 3, disabled }) => {
	const id = useId();
	const [draft, setDraft] = React.useState(value.join('\n'));

	// Re-seed the box when the saved value moves underneath it (a Reset, or
	// another session's save landing in the workspace).
	const joined = value.join('\n');
	const lastJoined = React.useRef(joined);
	if (lastJoined.current !== joined) {
		lastJoined.current = joined;
		if (draft !== joined) setDraft(joined);
	}

	/** Split the box into entries, one per non-blank line. */
	const commit = (text: string) => {
		onChange(
			text
				.split('\n')
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0)
		);
	};

	return (
		<FieldRow id={id} label={label} help={help}>
			<textarea
				id={id}
				className="dd-input"
				aria-describedby={`${id}-help`}
				value={draft}
				rows={rows}
				placeholder={placeholder}
				disabled={disabled}
				style={disabled === true ? { opacity: 0.55 } : undefined}
				onChange={(e) => {
					setDraft(e.target.value);
					commit(e.target.value);
				}}
			/>
			{value.length > 0 && (
				<div className="dd-row" style={{ gap: 6 }}>
					{value.map((entry, index) => (
						<Chip key={`${entry}-${index}`} label={entry} />
					))}
				</div>
			)}
		</FieldRow>
	);
};

// =============================================================================
// READ-ONLY
// =============================================================================

/**
 * A value the form shows but cannot change, with the reason why.
 *
 * @param props.label - The field name.
 * @param props.children - The value.
 * @param props.help - Why it cannot be changed here.
 * @returns The read-only row.
 */
export const ReadOnlyField: React.FC<{ label: string; help: string; children: ReactNode }> = ({ label, help, children }) => (
	<div className="dd-field">
		<div>
			<span className="dd-field__label">{label}</span>
			<p className="dd-field__help">{help}</p>
		</div>
		<div className="dd-field__control dd-muted dd-mono">{children}</div>
	</div>
);
