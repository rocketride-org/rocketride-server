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
// VECTOR-UI — ScopeBar (the directory's filter row)
// =============================================================================
//
// The directory's path box, first, then Add condition (folder, file type,
// ingest dates, chunk counts, tables, missing first chunk) and Saved. With no
// condition it is one row, exactly the old filter row. With conditions they
// show as chips under it (each one removes itself), with the Apply to toggles
// (Documents, Map, Search, Chat; all on), Save and Clear. The conditions
// scope the documents, the map, search and chat (ConsoleModel.scope); until
// the scope's documents are known (its listing pages, failed or stopped short
// of every document) and above `limits.scope_keys_max` documents the Map,
// Search and Chat toggles are off, disabled with the sentence, which is shown
// too.
//
// Every control is a native element with a label; the menus are lists of
// menu items under the row (nothing floats over the directory); Escape closes
// what is open. The logic lives in vector/filters.ts; this file draws it.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Availability, IDocumentsFilter, IScopeState, ISavedFilter, ScopeBarProps as ContractScopeBarProps } from '../contract/types';
import { ALL_TARGETS, CONDITION_KINDS, CONDITION_TITLES, FILTER_TEXT_MAX, conditionLabel, dateToIso, filterOf, removeCondition, scopeAvailability, scopeFromFilter, setCondition, toDocumentsFilter, validateFilter } from '../vector/filters';
import type { ConditionKind, ICondition, IFilter } from '../vector/filters';
import type { IPagerState } from '../vector/documents';
import { ALLOWED_EXTENSIONS } from '../vector/fileType';
import { ACCENT_TOKEN, CONSOLE_TEXT_TOKEN, selectedRowBackground } from '../vector/colors';
import { DEFAULT_LIMITS } from '../vector/results';
import { FOCUS_RING, styles } from '../styles';

/** What is open on the bar. */
export interface IScopeBarOpen {
	menu?: 'add' | 'saved' | null;
	/** The editor of one kind of condition. */
	editor?: ConditionKind | null;
	/** The name box of Save. */
	saving?: boolean;
}

/** The frozen props plus the bar's own (optional, so the frozen mount still renders). */
export interface ScopeBarProps extends ContractScopeBarProps {
	/** Whether each kind of condition can be offered on this store (absent: offered). */
	available?: Partial<Record<ConditionKind, Availability>>;
	/** The folders of the loaded documents, suggested for "Folder is under". */
	folders?: readonly string[];
	/** `limits.scope_keys_max`. */
	cap?: number;
	/** This connection's saved filters. */
	saved?: readonly ISavedFilter[];
	/** Save the scope's conditions under a name; resolves to an error sentence, or null when saved. */
	onSave?(name: string, filter: IDocumentsFilter): string | null;
	onDeleteSaved?(id: string): void;
	/** What is open on the first render (the directory opens nothing; tests open each part). */
	initial?: IScopeBarOpen;
	/** The path box's settled text (after its debounce), which a new scope carries; default `text`. */
	scopeText?: string;
	/** The directory's listing, so the Map, Search and Chat toggles say how far the scope's documents are. */
	listing?: IPagerState | null;
}

export type { ContractScopeBarProps };

/** The four surfaces a scope applies to, in the toggles' order. */
const TARGETS: ReadonlyArray<{ key: keyof IScopeState['applyTo']; label: string }> = [
	{ key: 'documents', label: 'Documents' },
	{ key: 'map', label: 'Map' },
	{ key: 'search', label: 'Search' },
	{ key: 'chat', label: 'Chat' },
];

/** A small native button in the shell's look; `pressed` tints it with the accent. */
function buttonStyle(pressed = false, disabled = false): CSSProperties {
	return {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 4,
		padding: '3px 8px',
		fontSize: 12,
		lineHeight: '18px',
		whiteSpace: 'nowrap',
		color: `var(${CONSOLE_TEXT_TOKEN})`,
		background: pressed ? selectedRowBackground() : 'var(--rr-bg-paper)',
		border: `1px solid ${pressed ? `var(${ACCENT_TOKEN})` : 'var(--rr-border-input)'}`,
		borderRadius: 4,
		cursor: disabled ? 'not-allowed' : 'pointer',
		opacity: disabled ? 0.55 : 1,
	};
}

/** Focus ring handlers for the bar's native controls. */
const ring = {
	onFocus: (event: React.FocusEvent<HTMLElement>) => (event.currentTarget.style.outline = FOCUS_RING),
	onBlur: (event: React.FocusEvent<HTMLElement>) => (event.currentTarget.style.outline = 'none'),
};

/**
 * Arrow keys, Home and End move between a menu's items (the WAI-ARIA menu pattern); disabled items are skipped.
 *
 * @param event - The key event on the menu.
 */
export function moveInMenu(event: React.KeyboardEvent<HTMLElement>): void {
	const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
	if (items.length === 0) return;
	const at = items.indexOf(document.activeElement as HTMLElement);
	let next: number | null = null;
	if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (at + 1) % items.length;
	else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (at - 1 + items.length) % items.length;
	else if (event.key === 'Home') next = 0;
	else if (event.key === 'End') next = items.length - 1;
	if (next === null) return;
	event.preventDefault();
	items[next]?.focus();
}

/** The draft values of the condition editors. */
interface IDraft {
	prefix: string;
	types: string[];
	date: string;
	min: string;
	max: string;
	tables: boolean;
}

const EMPTY_DRAFT: IDraft = { prefix: '', types: [], date: '', min: '', max: '', tables: true };

/**
 * The condition an editor's draft makes, or the sentence saying what is missing.
 *
 * @param kind - The editor.
 * @param draft - Its values.
 * @returns The condition, or `{ error }`.
 */
export function draftCondition(kind: ConditionKind, draft: IDraft): ICondition | { error: string } {
	switch (kind) {
		case 'folder': {
			const prefix = draft.prefix.trim();
			return prefix === '' ? { error: 'Type or choose a folder.' } : { kind, prefix };
		}
		case 'fileType':
			return draft.types.length === 0 ? { error: 'Choose at least one file type.' } : { kind, types: draft.types };
		case 'ingestedAfter':
		case 'ingestedBefore': {
			const at = dateToIso(draft.date);
			return at === null ? { error: 'Choose a date.' } : { kind, at };
		}
		case 'chunks': {
			const num = (text: string): number | null | 'bad' => {
				if (text.trim() === '') return null;
				const n = Number(text);
				return Number.isInteger(n) && n >= 0 ? n : 'bad';
			};
			const min = num(draft.min);
			const max = num(draft.max);
			if (min === 'bad' || max === 'bad') return { error: 'Chunk counts are whole numbers, 0 or more.' };
			if (min === null && max === null) return { error: 'Give a smallest or a largest chunk count.' };
			return { kind, min, max };
		}
		case 'hasTables':
			return { kind, value: draft.tables };
		case 'firstChunk':
			return { kind, present: false };
	}
}

/**
 * The directory's filter row: the path box, Add condition and Saved; the chips and the Apply to toggles while a scope is set.
 *
 * @param props - {@link ScopeBarProps}.
 * @returns The bar.
 */
export function ScopeBar({ text, onText, scope = null, onScope, available = {}, folders = [], cap = DEFAULT_LIMITS.scope_keys_max, saved = [], onSave, onDeleteSaved, initial = {}, scopeText = text, listing = null }: ScopeBarProps): React.ReactElement {
	const [menu, setMenu] = useState<IScopeBarOpen['menu']>(initial.menu ?? null);
	const [editor, setEditor] = useState<ConditionKind | null>(initial.editor ?? null);
	const [draft, setDraft] = useState<IDraft>(EMPTY_DRAFT);
	const [saving, setSaving] = useState(initial.saving ?? false);
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	// An opened menu takes the focus on its first item, as a menu button's menu does.
	const menuRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (menu !== null) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
	}, [menu]);

	const filter: IFilter = filterOf(scope, scopeText);
	const conditions = filter.conditions;
	const targets = scope ? scopeAvailability(scope, cap, listing) : null;
	const blocked = targets ? (TARGETS.map((t) => targets[t.key]).find((a) => !a.enabled)?.reason ?? null) : null;
	const availability = (kind: ConditionKind): Availability => available[kind] ?? { enabled: true, reason: null };
	// With a scope the box goes to the store, which refuses text this long: the scope keeps its last text (withText).
	const boxRefused = scope !== null && scopeText.trim().length > FILTER_TEXT_MAX ? `The path text is longer than ${FILTER_TEXT_MAX.toLocaleString('en-US')} characters, so it is not sent with the scope. Shorten it.` : null;
	const alert = error ?? boxRefused;

	/** Hand a new filter to the host (null scope with no condition). */
	const commit = (next: IFilter): void => {
		const wire = toDocumentsFilter(next);
		const invalid = validateFilter(wire);
		if (invalid !== null) {
			setError(invalid);
			return;
		}
		setError(null);
		onScope?.(scopeFromFilter(next, scope));
	};
	const closeAll = (): void => {
		setMenu(null);
		setEditor(null);
		setSaving(false);
		setError(null);
	};
	const choose = (kind: ConditionKind): void => {
		setMenu(null);
		setError(null);
		if (kind === 'firstChunk') {
			commit(setCondition(filter, { kind, present: false }));
			return;
		}
		setDraft(EMPTY_DRAFT);
		setEditor(kind);
	};
	const addDraft = (): void => {
		if (editor === null) return;
		const made = draftCondition(editor, draft);
		if ('error' in made) {
			setError(made.error);
			return;
		}
		const next = setCondition(filter, made);
		const invalid = validateFilter(toDocumentsFilter(next));
		if (invalid !== null) {
			setError(invalid);
			return;
		}
		setEditor(null);
		commit(next);
	};
	const save = (): void => {
		if (!scope || !onSave) return;
		const outcome = onSave(name, scope.filter);
		if (outcome !== null) {
			setError(outcome);
			return;
		}
		setSaving(false);
		setName('');
		setError(null);
	};
	const apply = (entry: ISavedFilter): void => {
		setMenu(null);
		let next: IFilter = { conditions: [], text: scopeText };
		for (const condition of filterOf({ filter: entry.filter }, scopeText).conditions) next = setCondition(next, condition);
		commit(next);
	};

	const row: CSSProperties = { display: 'flex', gap: 8, padding: '8px 12px', alignItems: 'center' };
	return (
		<div
			data-component="ScopeBar"
			onKeyDown={(event) => {
				if (event.key === 'Escape' && (menu !== null || editor !== null || saving)) closeAll();
			}}
		>
			<div style={row}>
				<input type="search" value={text} placeholder="Filter paths…" aria-label="Filter documents by path" style={styles.input} onChange={(event) => onText(event.target.value)} />
				<button type="button" aria-haspopup="menu" aria-expanded={menu === 'add'} style={buttonStyle(menu === 'add')} onClick={() => setMenu(menu === 'add' ? null : 'add')} {...ring}>
					Add condition
				</button>
				<button type="button" aria-haspopup="menu" aria-expanded={menu === 'saved'} style={buttonStyle(menu === 'saved')} onClick={() => setMenu(menu === 'saved' ? null : 'saved')} {...ring}>
					{saved.length > 0 ? `Saved (${saved.length})` : 'Saved'}
				</button>
			</div>
			{menu === 'add' && (
				<div ref={menuRef} role="menu" aria-label="Add condition" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 12px 8px' }} onKeyDown={moveInMenu}>
					{CONDITION_KINDS.map((kind) => {
						const av = availability(kind);
						return (
							<button key={kind} type="button" role="menuitem" aria-disabled={!av.enabled} disabled={!av.enabled} title={av.reason ?? undefined} style={buttonStyle(false, !av.enabled)} onClick={() => av.enabled && choose(kind)} {...ring}>
								{av.enabled ? CONDITION_TITLES[kind] : `${CONDITION_TITLES[kind]}: ${av.reason}`}
							</button>
						);
					})}
				</div>
			)}
			{menu === 'saved' && (
				<div ref={menuRef} role="menu" aria-label="Saved filters" style={{ padding: '0 12px 8px', ...styles.small }} onKeyDown={moveInMenu}>
					{saved.length === 0 ? (
						<p style={{ margin: 0 }}>No saved filters for this connection yet. Add a condition, then Save.</p>
					) : (
						<ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
							{saved.map((entry) => (
								<li key={entry.id} role="none" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
									<button type="button" role="menuitem" aria-label={`Apply saved filter ${entry.name}`} title={filterOf({ filter: entry.filter }, '').conditions.map(conditionLabel).join(' · ')} style={buttonStyle()} onClick={() => apply(entry)} {...ring}>
										{entry.name}
									</button>
									<span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filterOf({ filter: entry.filter }, '').conditions.map(conditionLabel).join(' · ')}</span>
									<button type="button" role="menuitem" aria-label={`Delete saved filter ${entry.name}`} style={buttonStyle()} onClick={() => onDeleteSaved?.(entry.id)} {...ring}>
										Delete
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
			{editor !== null && (
				<div role="group" aria-label={CONDITION_TITLES[editor]} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '0 12px 8px', ...styles.small }}>
					<span style={{ fontWeight: 600 }}>{CONDITION_TITLES[editor]}</span>
					{editor === 'folder' && (
						<>
							<input type="text" list="scope-bar-folders" value={draft.prefix} placeholder="C:/demo/handbooks/" aria-label="Folder the paths start with" style={{ ...styles.input, flex: '1 1 160px' }} onChange={(event) => setDraft({ ...draft, prefix: event.target.value })} />
							<datalist id="scope-bar-folders">
								{folders.map((folder) => (
									<option key={folder} value={folder} />
								))}
							</datalist>
						</>
					)}
					{editor === 'fileType' && (
						<fieldset style={{ display: 'flex', flexWrap: 'wrap', gap: 8, border: 'none', margin: 0, padding: 0 }}>
							<legend style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>File types</legend>
							{ALLOWED_EXTENSIONS.map((ext) => (
								<label key={ext} style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
									<input type="checkbox" checked={draft.types.includes(ext)} onChange={(event) => setDraft({ ...draft, types: event.target.checked ? [...draft.types, ext] : draft.types.filter((t) => t !== ext) })} />
									{ext}
								</label>
							))}
						</fieldset>
					)}
					{(editor === 'ingestedAfter' || editor === 'ingestedBefore') && <input type="date" value={draft.date} aria-label={editor === 'ingestedAfter' ? 'Ingested on or after (UTC)' : 'Ingested before (UTC)'} style={{ ...styles.input, flex: '0 0 auto' }} onChange={(event) => setDraft({ ...draft, date: event.target.value })} />}
					{editor === 'chunks' && (
						<>
							<input type="number" min={0} step={1} value={draft.min} aria-label="At least this many chunks" placeholder="from" style={{ ...styles.input, flex: '0 0 80px' }} onChange={(event) => setDraft({ ...draft, min: event.target.value })} />
							<span>and</span>
							<input type="number" min={0} step={1} value={draft.max} aria-label="At most this many chunks" placeholder="to" style={{ ...styles.input, flex: '0 0 80px' }} onChange={(event) => setDraft({ ...draft, max: event.target.value })} />
						</>
					)}
					{editor === 'hasTables' && (
						<>
							<label style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
								<input type="radio" name="scope-bar-tables" checked={draft.tables} onChange={() => setDraft({ ...draft, tables: true })} />
								with tables
							</label>
							<label style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
								<input type="radio" name="scope-bar-tables" checked={!draft.tables} onChange={() => setDraft({ ...draft, tables: false })} />
								without tables
							</label>
						</>
					)}
					<button type="button" style={buttonStyle()} onClick={addDraft} {...ring}>
						Add
					</button>
					<button type="button" style={buttonStyle()} onClick={() => setEditor(null)} {...ring}>
						Cancel
					</button>
				</div>
			)}
			{conditions.length > 0 && scope && targets && (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '0 12px 8px', ...styles.small }}>
					{conditions.map((condition) => {
						const words = conditionLabel(condition);
						return (
							<button key={condition.kind} type="button" aria-label={`Remove condition: ${words}`} title={`Remove condition: ${words}`} style={{ ...buttonStyle(true), borderRadius: 10 }} onClick={() => commit(removeCondition(filter, condition.kind))} {...ring}>
								{words}
								<span aria-hidden="true">×</span>
							</button>
						);
					})}
					<span role="group" aria-label="Apply the scope to" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 4 }}>
						<span>Apply to:</span>
						{TARGETS.map(({ key, label }) => {
							const av = targets[key];
							const on = scope.applyTo[key] && av.enabled;
							return (
								<button key={key} type="button" aria-pressed={on} disabled={!av.enabled} title={av.reason ?? undefined} style={buttonStyle(on, !av.enabled)} onClick={() => onScope?.({ ...scope, applyTo: { ...ALL_TARGETS, ...scope.applyTo, [key]: !scope.applyTo[key] } })} {...ring}>
									{label}
								</button>
							);
						})}
					</span>
					{onSave && (
						<button type="button" aria-expanded={saving} style={buttonStyle(saving)} onClick={() => setSaving(!saving)} {...ring}>
							Save…
						</button>
					)}
					<button type="button" style={buttonStyle()} onClick={() => commit({ conditions: [], text: scopeText })} {...ring}>
						Clear
					</button>
				</div>
			)}
			{saving && scope && onSave && (
				<div role="group" aria-label="Save these conditions" style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '0 12px 8px', ...styles.small }}>
					<input type="text" value={name} placeholder="Name, e.g. handbooks" aria-label="Name of the saved filter" maxLength={60} style={styles.input} onChange={(event) => setName(event.target.value)} />
					<button type="button" style={buttonStyle()} onClick={save} {...ring}>
						Save
					</button>
					<button type="button" style={buttonStyle()} onClick={() => setSaving(false)} {...ring}>
						Cancel
					</button>
				</div>
			)}
			{alert !== null && (
				<div role="alert" style={{ ...styles.small, padding: '0 12px 8px' }}>
					{alert}
				</div>
			)}
			{blocked !== null && (
				<div role="status" style={{ ...styles.small, padding: '0 12px 8px' }}>
					{blocked}
				</div>
			)}
		</div>
	);
}

export default ScopeBar;
