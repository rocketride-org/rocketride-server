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
// DESIGN SYSTEM PIECES — the shell's components, dressed; and the small
// pieces the shell does not have
// =============================================================================
//
// The shell's ContentHeader, Card, Banner and EmptyState are used as they are
// and restyled from a wrapper class (src/ui/theme/components.css). What the
// shell has no component for is built here from the design system's
// components/bundle.css: status chip, filter chip, stat tile, meter, bar list,
// id text, checklist, tabs and the button. Colours are tokens only.
// =============================================================================

import React, { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Banner, Card, ContentHeader, EmptyState } from 'shell';
import { Icon, iconHtml, type IconName } from './Icon';
import { useThemeMode } from './theme/useThemeMode';

// =============================================================================
// ROOT
// =============================================================================

/**
 * The app's root element: the scope every token lives under.
 *
 * @param props.children - The content area.
 * @returns The themed root.
 */
export const DdRoot: React.FC<{ children: ReactNode }> = ({ children }) => {
	const mode = useThemeMode();
	// The shell's own frame (left bar, tab frame, status bar) takes the design
	// tokens while this app is mounted: tokens.css keys that on these classes,
	// and they come off again on unmount, so no other app is restyled.
	useEffect(() => {
		const root = document.documentElement;
		root.classList.add('dd-app-active');
		return () => root.classList.remove('dd-app-active', 'dd-theme-dark');
	}, []);
	useEffect(() => {
		document.documentElement.classList.toggle('dd-theme-dark', mode === 'dark');
	}, [mode]);
	return (
		<div className="dd-root" data-theme={mode} style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
			{children}
		</div>
	);
};

// =============================================================================
// STATUS
// =============================================================================

/** The status language: one meaning per tone, app-wide. */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'brand';

/** The glyph each tone carries, so a status reads without colour. */
export const TONE_ICON: Record<Tone, IconName> = {
	ok: 'check',
	warn: 'alert',
	bad: 'x',
	info: 'clock',
	neutral: 'minus',
	brand: 'bell',
};

/** The class a tone puts on a chip. */
function chipClass(tone: Tone): string {
	return tone === 'neutral' ? 'dd-chip' : `dd-chip dd-chip--${tone}`;
}

/**
 * A status chip: glyph and word, on the tone's soft ground.
 *
 * @param props.tone - What it means.
 * @param props.icon - Another glyph than the tone's own (e.g. `cpu` for a pipeline).
 * @param props.live - A live dot instead of a glyph (Connected).
 * @param props.title - Tooltip.
 * @param props.children - The word.
 * @returns The chip.
 */
export const Chip: React.FC<{ tone: Tone; icon?: IconName | null; live?: boolean; title?: string; children: ReactNode }> = ({ tone, icon, live, title, children }) => (
	<span className={chipClass(tone)} title={title}>
		{live ? <span className="dd-dot dd-live" aria-hidden="true" /> : icon === null ? null : <Icon name={icon ?? TONE_ICON[tone]} small />}
		{children}
	</span>
);

/**
 * The same chip as a DOM node, for the grid's cell formatters.
 *
 * @param tone - What it means.
 * @param label - The word.
 * @returns The chip element.
 */
export function chipEl(tone: Tone, label: string): HTMLElement {
	const el = document.createElement('span');
	el.className = chipClass(tone);
	el.innerHTML = iconHtml(TONE_ICON[tone]);
	el.append(document.createTextNode(label));
	return el;
}

// =============================================================================
// ACTIONS
// =============================================================================

/**
 * The design system's button. Same contract as the shell's (`onClick`,
 * `disabled`, `title`), plus a leading icon.
 *
 * @param props.variant - `primary` (one per view), `secondary`, `ghost`, `danger`.
 * @returns The button.
 */
export const Btn: React.FC<{
	variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
	small?: boolean;
	icon?: IconName;
	onClick?: () => void;
	disabled?: boolean;
	title?: string;
	pressed?: boolean;
	children: ReactNode;
}> = ({ variant = 'secondary', small, icon, onClick, disabled, title, pressed, children }) => {
	const cls = ['dd-btn', variant !== 'secondary' ? `dd-btn--${variant}` : '', small ? 'dd-btn--sm' : ''].filter(Boolean).join(' ');
	return (
		<button type="button" className={cls} onClick={onClick} disabled={disabled} title={title} aria-pressed={pressed}>
			{icon && <Icon name={icon} />}
			{children}
		</button>
	);
};

/**
 * A link that leaves the app: brand-ink, ends with the external glyph.
 *
 * @param props.href - Where it goes.
 * @returns The link.
 */
export const ExtLink: React.FC<{ href: string; children: ReactNode }> = ({ href, children }) => (
	<a className="dd-link" href={href} target="_blank" rel="noopener noreferrer">
		{children}
		<Icon name="external" />
	</a>
);

/**
 * A toggle chip, for filters.
 *
 * @param props.pressed - Whether it is on.
 * @param props.count - An optional count on the chip.
 * @returns The chip button.
 */
export const FilterChip: React.FC<{ pressed: boolean; onClick: () => void; count?: number; children: ReactNode }> = ({ pressed, onClick, count, children }) => (
	<button type="button" className="dd-chipbtn" aria-pressed={pressed} onClick={onClick}>
		{children}
		{count !== undefined && <span className="dd-count">{count}</span>}
	</button>
);

/** One tab in a {@link Tabs} strip. */
export interface TabItem {
	id: string;
	label: string;
	count?: number;
}

/**
 * The underline tab strip: brand underline on the selected tab.
 *
 * @param props.items - The tabs.
 * @param props.active - The selected id.
 * @param props.onSelect - Switch tab.
 * @returns The strip.
 */
export const Tabs: React.FC<{ items: TabItem[]; active: string; onSelect: (id: string) => void; label: string }> = ({ items, active, onSelect, label }) => (
	<div className="dd-tabs" role="tablist" aria-label={label}>
		{items.map((item) => (
			<button key={item.id} type="button" role="tab" className="dd-tab" aria-selected={item.id === active} onClick={() => onSelect(item.id)}>
				{item.label}
				{item.count !== undefined && <span className="dd-count">{item.count}</span>}
			</button>
		))}
	</div>
);

// =============================================================================
// LAYOUT — the shell's components, dressed
// =============================================================================

/**
 * The page header: the shell's ContentHeader in the display face.
 *
 * @param props.title - Once per page.
 * @param props.subtitle - One sentence of purpose.
 * @param props.actions - Page actions, on the right.
 * @returns The header.
 */
export const PageHeader: React.FC<{ title: string; subtitle?: string; actions?: ReactNode }> = ({ title, subtitle, actions }) => (
	<div className="dd-ph-shell">
		<ContentHeader title={title} subtitle={subtitle} actions={actions} />
	</div>
);

/**
 * A surface card: the shell's Card with the design system's shape.
 *
 * @param props.title - Card title (section-title). Optional.
 * @param props.actions - Right side of the title row.
 * @param props.toolbar - A row under the title, divided from the body.
 * @param props.flush - No body padding (tables).
 * @param props.fill - Fill the parent's height.
 * @returns The card.
 */
export const DdCard: React.FC<{
	title?: ReactNode;
	actions?: ReactNode;
	toolbar?: ReactNode;
	flush?: boolean;
	fill?: boolean;
	children: ReactNode;
}> = ({ title, actions, toolbar, flush, fill, children }) => {
	const cls = ['dd-card-shell', title !== undefined ? 'dd-card-shell--head' : '', toolbar !== undefined ? 'dd-card-shell--toolbar' : '', flush ? 'dd-card-shell--flush' : '', fill ? 'dd-card-shell--fill' : ''].filter(Boolean).join(' ');
	return (
		<div className={cls}>
			<Card header={title} headerActions={actions} toolbar={toolbar} noBodyPadding={flush} fill={fill}>
				{children}
			</Card>
		</div>
	);
};

/** The glyph a banner leads with, per shell variant. */
const BANNER_ICON = { error: 'x', warning: 'alert', info: 'clock' } as const;

/**
 * A banner: the shell's Banner on its status's soft ground, with a glyph.
 *
 * @param props.variant - The shell's variant.
 * @param props.title - An optional bold first line.
 * @returns The banner.
 */
export const DdBanner: React.FC<{ variant: 'info' | 'warning' | 'error'; title?: string; children: ReactNode }> = ({ variant, title, children }) => (
	<div className={`dd-banner-shell dd-banner-shell--${variant}`}>
		<Banner variant={variant}>
			<Icon name={BANNER_ICON[variant]} />
			<span className="dd-banner__body">
				{title && <span className="dd-banner__title">{title} </span>}
				{children}
			</span>
		</Banner>
	</div>
);

/**
 * An empty state: the shell's EmptyState, quiet, with a brand-soft icon disc.
 *
 * @param props.icon - The glyph. Default `inbox`.
 * @returns The empty state.
 */
export const DdEmpty: React.FC<{ icon?: IconName; title: string; description?: string; action?: ReactNode }> = ({ icon = 'inbox', title, description, action }) => (
	<div className="dd-empty-shell">
		<EmptyState icon={<Icon name={icon} />} title={title} description={description} action={action} />
	</div>
);

// =============================================================================
// NUMBERS
// =============================================================================

/**
 * A meter: a pill track, a fill, and an optional target tick.
 *
 * @param props.value - 0..1.
 * @param props.target - 0..1, drawn as a tick.
 * @param props.tone - The fill's status.
 * @returns The meter.
 */
export const Meter: React.FC<{ value: number; target?: number; tone: 'ok' | 'warn' | 'bad' | 'info'; label: string }> = ({ value, target, tone, label }) => (
	<div className="dd-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
		<div className={`dd-meter__fill dd-fill-${tone}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
		{target !== undefined && <div className="dd-meter__target" style={{ left: `calc(${target * 100}% - 1px)` }} />}
	</div>
);

/**
 * A stat tile: eyebrow label, a display-face number, an optional note.
 *
 * @param props.tone - Colours the number; omit for ink.
 * @param props.meter - A meter under the number.
 * @returns The tile.
 */
export const StatTile: React.FC<{ label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'info'; note?: ReactNode; meter?: ReactNode }> = ({ label, value, tone, note, meter }) => (
	<div className={tone ? `dd-stat dd-stat--${tone}` : 'dd-stat'}>
		<span className="dd-eyebrow">{label}</span>
		<span className="dd-stat__value">{value}</span>
		{meter}
		{note !== undefined && note !== null && <span className="dd-stat__note">{note}</span>}
	</div>
);

/** One row of a {@link BarList}. */
export interface BarItem {
	key: string;
	label: ReactNode;
	n: number;
	/** The right-hand figure, when it is not just `n`. */
	figure?: ReactNode;
	/** A status fill, or a category rank (1..5) shown with a dot. */
	fill: 'ok' | 'warn' | 'bad' | 'info' | 'muted' | 1 | 2 | 3 | 4 | 5;
}

/**
 * A labelled bar list: label and count on a line, the bar under it.
 *
 * @param props.items - The rows, already in order.
 * @returns The list.
 */
export const BarList: React.FC<{ items: BarItem[] }> = ({ items }) => {
	const max = Math.max(1, ...items.map((item) => item.n));
	return (
		<div className="dd-bars">
			{items.map((item) => {
				const cat = typeof item.fill === 'number';
				return (
					<div key={item.key} className="dd-bar">
						<span className="dd-bar__label">
							{cat && <span className={`dd-dot dd-fill-${item.fill}`} aria-hidden="true" />}
							<span>{item.label}</span>
						</span>
						<span className="dd-bar__n">{item.figure ?? item.n}</span>
						<span className="dd-bar__track" aria-hidden="true">
							<span className={`dd-bar__fill dd-fill-${item.fill}`} style={{ display: 'block', width: `${(item.n / max) * 100}%` }} />
						</span>
					</div>
				);
			})}
		</div>
	);
};

// =============================================================================
// TEXT
// =============================================================================

/**
 * An id, shortened to its last four digits, the full id on hover.
 *
 * @param props.kind - `user`, `channel`, `thread`, or '' for none.
 * @param props.id - The snowflake.
 * @returns The id text.
 */
export const IdText: React.FC<{ kind?: string; id: string | null | undefined }> = ({ kind = '', id }) => {
	if (!id) return <span className="dd-id">—</span>;
	const tail = id.length > 4 ? `…${id.slice(-4)}` : id;
	return (
		<span className="dd-id" title={id}>
			{kind ? `${kind} ${tail}` : tail}
		</span>
	);
};

/**
 * A question with its test tag (`[eval R10] …`) split off into a mono tag,
 * so the real question reads first.
 *
 * @param text - The question.
 * @returns The tag (or null) and the rest.
 */
export function splitTag(text: string): { tag: string | null; rest: string } {
	const match = /^\s*\[([^\]\n]{1,40})\]\s*([\s\S]*)$/.exec(text);
	return match ? { tag: match[1], rest: match[2] } : { tag: null, rest: text };
}

/**
 * A one-line question with its test tag as a mono tag.
 *
 * @param props.text - The question's first line.
 * @returns The line.
 */
export const QuestionLine: React.FC<{ text: string; prefix?: string }> = ({ text, prefix }) => {
	const { tag, rest } = splitTag(text);
	return (
		<span className="dd-qline" title={text}>
			{tag !== null && <span className="dd-tag">{tag}</span>}
			<span className="dd-qline__text">
				{prefix}
				{rest || '(no text captured)'}
			</span>
		</span>
	);
};

/**
 * The same as a DOM node, for the grid.
 *
 * @param text - The question's first line.
 * @returns The cell content.
 */
export function questionEl(text: string): HTMLElement {
	const { tag, rest } = splitTag(text);
	const el = document.createElement('span');
	el.className = 'dd-cellq';
	el.title = text;
	if (tag !== null) {
		const t = document.createElement('span');
		t.className = 'dd-tag';
		t.textContent = tag;
		el.append(t);
	}
	const q = document.createElement('span');
	q.className = 'dd-cellq__t';
	q.textContent = rest || '(no text captured)';
	el.append(q);
	return el;
}

/**
 * A short time for lists: `1 Oct, 12:55`.
 *
 * @param ms - Unix ms.
 * @returns The time, or a dash.
 */
export function shortWhen(ms: number | undefined): string {
	if (!ms) return '—';
	const d = new Date(ms);
	return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// =============================================================================
// CHECKLIST
// =============================================================================

/** One row of a {@link CheckList}. */
export interface CheckItem {
	key: string;
	state: 'done' | 'todo' | 'bad';
	title: ReactNode;
	body?: ReactNode;
	action?: ReactNode;
}

/**
 * A checklist: a round mark, the step, an optional action on the right.
 *
 * @param props.items - The steps.
 * @returns The list.
 */
export const CheckList: React.FC<{ items: CheckItem[] }> = ({ items }) => (
	<ul className="dd-checks">
		{items.map((item) => (
			<li key={item.key} className="dd-check">
				<span className={item.state === 'done' ? 'dd-check__mark' : `dd-check__mark dd-check__mark--${item.state}`}>
					<Icon name={item.state === 'done' ? 'check' : item.state === 'bad' ? 'x' : 'minus'} small />
					<span className="dd-sr">{item.state === 'done' ? 'Done' : item.state === 'bad' ? 'Failed' : 'Not done yet'}</span>
				</span>
				<span>
					<span className="dd-check__title">{item.title}</span>
					{item.body !== undefined && item.body !== null && (
						<span className="dd-check__body" style={{ display: 'block' }}>
							{item.body}
						</span>
					)}
				</span>
				<span>{item.action}</span>
			</li>
		))}
	</ul>
);
