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
// GRAPH-UI - STYLE EDITOR (colour, size, caption and badge of a label; colour of a type)
// =============================================================================
//
// Inline in the legend, never a dialog. A label can take one of the six measured
// chart colours (or "Automatic", the colour it was given when first seen), a
// size, a caption property and a badge (initials, a dot or nothing). A
// relationship type can take only the colours that are at least 3:1 against the
// canvas in every shipped theme (colors.ts TYPE_COLOR_SLOTS). There is no free
// colour picker: every colour offered has been measured.
//
// Each choice is applied as soon as it is made (the owner writes it to the
// connection's style); "Reset to default" removes the person's choices for this
// label or type, and "Done" closes the editor.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Button } from 'shell';
import type { ICaptionChoice } from '../graph/captions';
import { CHART_COLOR_NAMES, CHART_COLOR_VARS } from '../graph/colors';
import type { BadgeMode, ILabelStyle, LabelSize } from '../graph/userData';

/** Props. */
export interface IStyleEditorProps {
	kind: 'label' | 'type';
	/** The label or type being styled ('(no label)' text is the caller's). */
	name: string;
	/** The person's own choices (empty members follow the defaults). */
	style: ILabelStyle;
	/** The colour slots offered. */
	slots: readonly number[];
	/** The slot the label has now, whether chosen or automatic (marked when no own choice is made). */
	currentSlot: number | null;
	/** Which other label already uses a slot, by slot. */
	usedBy: ReadonlyMap<number, readonly string[]>;
	/** Label only: the caption choices and the one chosen ('' for automatic). */
	captionChoices?: readonly ICaptionChoice[];
	caption?: string;
	onCaption?(choice: string): void;
	onChange(style: ILabelStyle): void;
	onReset(): void;
	onDone(): void;
	/** Why the last edit could not be kept, or null. */
	error: string | null;
}

const SIZES: readonly LabelSize[] = ['S', 'M', 'L'];
const BADGES: ReadonlyArray<{ mode: BadgeMode; text: string; name: string }> = [
	{ mode: 'initials', text: 'Aa', name: 'Initials' },
	{ mode: 'dot', text: '●', name: 'Dot' },
	{ mode: 'none', text: 'none', name: 'None' },
];

const styles = {
	root: { borderTop: '1px solid var(--rr-border)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 } as CSSProperties,
	row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as CSSProperties,
	name: { minWidth: 56, color: 'var(--rr-text-secondary)' } as CSSProperties,
	title: { margin: 0, fontSize: 13, outline: 'none' } as CSSProperties,
	swatch: (fill: string, chosen: boolean): CSSProperties => ({ width: 22, height: 22, borderRadius: '50%', background: fill, border: '1px solid var(--rr-text-primary)', boxShadow: chosen ? '0 0 0 2px var(--rr-bg-paper), 0 0 0 4px var(--rr-border-focus)' : 'none', cursor: 'pointer', padding: 0 }),
	select: { fontSize: 12, padding: '2px 4px', background: 'var(--rr-bg-input)', color: 'var(--rr-text-primary)', border: '1px solid var(--rr-border-input)', borderRadius: 4 } as CSSProperties,
	note: { color: 'var(--rr-text-secondary)' } as CSSProperties,
};

/**
 * The editor.
 *
 * @param props - See {@link IStyleEditorProps}.
 * @returns The editor.
 */
export const StyleEditor: React.FC<IStyleEditorProps> = ({ kind, name, style, slots, currentSlot, usedBy, captionChoices, caption, onCaption, onChange, onReset, onDone, error }) => {
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus({ preventScroll: true });
	}, [kind, name]);
	const own = style.slot;
	const chosenSlot = own ?? currentSlot;
	const sameAs = chosenSlot !== null ? (usedBy.get(chosenSlot) ?? []).filter((other) => other !== name && other !== (name === '(no label)' ? '' : name)) : [];
	return (
		<section
			aria-label={`Style ${name}`}
			style={styles.root}
			onKeyDown={(event) => {
				if (event.key === 'Escape' && !event.defaultPrevented) {
					event.preventDefault();
					onDone();
				}
			}}
		>
			<h4 ref={heading} tabIndex={-1} style={styles.title}>{`Style: ${name}`}</h4>
			<div style={styles.row} role="group" aria-label="Colour">
				<span style={styles.name}>Colour</span>
				<Button variant={own === undefined ? 'primary' : 'ghost'} small pressed={own === undefined} onClick={() => onChange({ ...style, slot: undefined })}>Automatic</Button>
				{slots.map((slot) => (
					<button key={slot} type="button" aria-label={CHART_COLOR_NAMES[slot]} title={CHART_COLOR_NAMES[slot]} aria-pressed={own === slot} style={styles.swatch(`var(${CHART_COLOR_VARS[slot]})`, own === slot)} onClick={() => onChange({ ...style, slot })} />
				))}
			</div>
			{sameAs.length > 0 && <div role="status" style={{ ...styles.note, color: 'var(--rr-text-primary)' }}>{`Same colour as ${sameAs.join(', ')}: they will be hard to tell apart.`}</div>}
			{kind === 'label' && (
				<>
					<div style={styles.row} role="group" aria-label="Size">
						<span style={styles.name}>Size</span>
						{SIZES.map((size) => (
							<Button key={size} variant={(style.size ?? 'M') === size ? 'primary' : 'ghost'} small pressed={(style.size ?? 'M') === size} onClick={() => onChange({ ...style, size })}>{size}</Button>
						))}
					</div>
					{captionChoices && onCaption && (
						<label style={styles.row}>
							<span style={styles.name}>Caption</span>
							<select style={styles.select} aria-label={`Caption for ${name}`} value={caption ?? ''} onChange={(event) => onCaption(event.target.value)}>
								<option value="">automatic</option>
								{captionChoices.map((choice) => (
									<option key={choice.value} value={choice.value}>{choice.label}</option>
								))}
							</select>
						</label>
					)}
					<div style={styles.row} role="group" aria-label="Badge">
						<span style={styles.name}>Badge</span>
						{BADGES.map((badge) => (
							<Button key={badge.mode} variant={(style.badge ?? 'initials') === badge.mode ? 'primary' : 'ghost'} small title={badge.name} pressed={(style.badge ?? 'initials') === badge.mode} onClick={() => onChange({ ...style, badge: badge.mode })}>{badge.text}</Button>
						))}
					</div>
				</>
			)}
			{error !== null && <div role="alert" style={{ color: 'var(--rr-text-primary)', fontWeight: 600 }}>{`Could not keep this change: ${error}`}</div>}
			<div style={styles.row}>
				<Button variant="ghost" small onClick={onReset}>Reset to default</Button>
				<Button variant="primary" small onClick={onDone}>Done</Button>
			</div>
		</section>
	);
};

export default StyleEditor;
