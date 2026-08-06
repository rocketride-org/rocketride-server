// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SchedulePanel — the per-source schedule editor (deploy v4 mockup panel).
 *
 * A stock DetailPanel hosting the v4 design: a SCHEDULE section of radio
 * options — On demand / Repeating interval / Daily / Weekly / Advanced cron
 * — where the selected option expands in place, a RUN FOR section, a
 * human-worded summary line whose next-occurrence comes from the SERVER's
 * single cron evaluator (nothing here ever parses cron for display), and a
 * Cancel / Save footer.
 *
 * The pickers GENERATE the 5-field cron the wire stores; an existing cron
 * is reverse-mapped into the matching picker when it has one of the picker
 * shapes, and lands in Advanced otherwise. Choosing "On demand" clears the
 * schedule (confirmed — it stops future runs).
 */

import React, { useEffect, useMemo, useState, CSSProperties, ReactNode } from 'react';

import { commonStyles } from 'shell/src/themes/styles';
import { Button } from 'shell';
import { ConfirmDialog } from 'shell/src/components/modal/ConfirmDialog';
import { DetailPanel } from 'shell';
import { InputField } from 'shell';
import { formatTime } from '../../modules/server/util/formatters';
import type { SchedulePreviewResult } from './DeploymentView';

// =============================================================================
// PROPS
// =============================================================================

/** Props for {@link SchedulePanel}. */
export interface ISchedulePanelProps {
	/** Whether the panel is open (DetailPanel renders nothing when closed). */
	open: boolean;
	/** The source being scheduled (subtitle identity; title uses the name). */
	sourceId: string;
	/** Source display name from the artifact (falls back to the id). */
	sourceName?: string;
	/** Context line: team display name. */
	teamName: string;
	/** Context line: pipeline display name. */
	pipelineName: string;
	/** The source's current cron ('' = manual / on demand). */
	initialCron: string;
	/** The source's current run window in seconds (undefined = until finished). */
	initialTtl?: number;
	/** Persist the schedule: cron (null clears) + run window (null = until finished). */
	onSave: (cron: string | null, ttl: number | null) => Promise<void>;
	/** The schedule's paused state (renders the Pause/Resume footer verb). */
	paused?: boolean;
	/** Pause/resume THIS schedule, preserving cron/ttl (footer verb; only a
	    stored schedule can pause, so it renders only when one exists). */
	onSetPaused?: (paused: boolean) => Promise<void>;
	/** Dismiss without saving. */
	onClose: () => void;
	/** Cron preview via the server's single evaluator. */
	previewSchedule?: (cron: string, count: number) => Promise<SchedulePreviewResult>;
	/** True while this source has a live run (shows Stop instead of Run). */
	running?: boolean;
	/** Start this source now (the record panel owns the verbs — house rule). */
	onRunNow?: () => void;
	/** Stop this source's live run (confirmed by the owner view). */
	onStopRun?: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Trigger choices, in mockup order. */
type TriggerKind = 'demand' | 'interval' | 'daily' | 'weekly' | 'cron';

/** Interval units the picker offers. */
type IntervalUnit = 'minutes' | 'hours';

/** Day chips, Monday-first (labels) with their cron day-of-week numbers. */
const DAY_CHIPS: Array<{ label: string; cron: number }> = [
	{ label: 'M', cron: 1 },
	{ label: 'T', cron: 2 },
	{ label: 'W', cron: 3 },
	{ label: 'T', cron: 4 },
	{ label: 'F', cron: 5 },
	{ label: 'S', cron: 6 },
	{ label: 'S', cron: 0 },
];

/** Debounce for server preview requests while editing (ms). */
const PREVIEW_DEBOUNCE_MS = 400;

// =============================================================================
// STYLES (v4 mockup panel vocabulary over --rr-* tokens)
// =============================================================================

const S = {
	sectionLabel: {
		...commonStyles.labelUppercase,
		padding: '14px 0 4px',
	} as CSSProperties,
	option: (selected: boolean, enabled: boolean): CSSProperties => ({
		margin: '6px 0',
		border: selected ? '2px solid var(--rr-brand)' : '1px solid var(--rr-border)',
		borderRadius: 9,
		padding: selected ? '9px 13px' : '10px 14px',
		display: 'flex',
		gap: 11,
		background: selected ? 'color-mix(in srgb, var(--rr-brand) 3%, transparent)' : 'transparent',
		cursor: enabled ? 'pointer' : 'default',
		opacity: enabled ? 1 : 0.55,
	}),
	optionDashed: {
		borderStyle: 'dashed',
	} as CSSProperties,
	radio: (selected: boolean): CSSProperties => ({
		width: 16,
		height: 16,
		border: selected ? '2px solid var(--rr-brand)' : '2px solid var(--rr-border-hover)',
		borderRadius: '50%',
		flex: 'none',
		marginTop: 2,
		boxShadow: selected ? 'inset 0 0 0 3.5px var(--rr-bg-paper), inset 0 0 0 10px var(--rr-brand)' : undefined,
	}),
	optionTitle: {
		fontSize: 13.5,
		fontWeight: 600,
	} as CSSProperties,
	optionSub: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
	} as CSSProperties,
	optionForm: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginTop: 6,
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		flexWrap: 'wrap',
	} as CSSProperties,
	numBox: {
		...commonStyles.inputField,
		height: 26,
		width: 64,
		padding: '0 8px',
		fontSize: 12.5,
	} as CSSProperties,
	unitSelect: {
		...commonStyles.inputField,
		height: 26,
		padding: '0 6px',
		fontSize: 12.5,
	} as CSSProperties,
	dayChip: (on: boolean): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 28,
		height: 26,
		border: `1px solid ${on ? 'var(--rr-bg-list-active)' : 'var(--rr-border)'}`,
		borderRadius: 6,
		fontSize: 11.5,
		fontWeight: 700,
		background: on ? 'var(--rr-bg-list-active)' : 'var(--rr-bg-paper)',
		color: on ? 'var(--rr-fg-list-active)' : 'var(--rr-text-secondary)',
		cursor: 'pointer',
	}),
	summary: {
		marginTop: 12,
		padding: '9px 12px',
		border: '1px solid var(--rr-border)',
		borderRadius: 7,
		background: 'var(--rr-bg-surface-alt)',
		fontSize: 12.5,
	} as CSSProperties,
	summaryMuted: {
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,
	/** Left-anchored verb group in the panel footer (footer is flex-end). */
	footerLeftVerbs: {
		marginRight: 'auto',
		display: 'flex',
		gap: 8,
	} as CSSProperties,
	errorText: {
		color: 'var(--rr-color-error)',
		fontSize: 12.5,
		marginTop: 8,
	} as CSSProperties,
};

// =============================================================================
// CRON MAPPING (generation + reverse-mapping — display never parses cron)
// =============================================================================

/** Picker state, the panel's source of truth. */
interface PickerState {
	kind: TriggerKind;
	intervalN: number;
	intervalUnit: IntervalUnit;
	/** 'HH:MM' 24h for daily/weekly. */
	time: string;
	/** Selected cron day-of-week numbers (weekly). */
	days: number[];
	/** Raw expression (advanced). */
	cron: string;
}

/** Generate the wire cron from the picker state ('' = on demand). */
function toCron(state: PickerState): string {
	// Step 1: on demand stores no cron at all.
	if (state.kind === 'demand') return '';
	// Step 2: advanced passes the raw expression through untouched.
	if (state.kind === 'cron') return state.cron.trim();
	// Step 3: the pickers construct the canonical 5-field shapes.
	if (state.kind === 'interval') {
		return state.intervalUnit === 'minutes' ? `*/${state.intervalN} * * * *` : `0 */${state.intervalN} * * *`;
	}
	const [hour, minute] = state.time.split(':').map((part) => parseInt(part, 10));
	if (state.kind === 'daily') return `${minute} ${hour} * * *`;
	const days = [...state.days].sort((a, b) => a - b).join(',');
	return `${minute} ${hour} * * ${days || '*'}`;
}

/** Reverse-map an existing cron into the picker that expresses it. */
function fromCron(cron: string): PickerState {
	const base: PickerState = { kind: 'demand', intervalN: 1, intervalUnit: 'hours', time: '08:00', days: [1, 3, 5], cron: '' };
	const trimmed = cron.trim();
	if (!trimmed) return base;

	// The three picker shapes; anything else lands in Advanced verbatim.
	const minuteInterval = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(trimmed);
	if (minuteInterval) return { ...base, kind: 'interval', intervalN: parseInt(minuteInterval[1], 10), intervalUnit: 'minutes' };
	const hourInterval = /^0 \*\/(\d{1,2}) \* \* \*$/.exec(trimmed);
	if (hourInterval) return { ...base, kind: 'interval', intervalN: parseInt(hourInterval[1], 10), intervalUnit: 'hours' };
	const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(trimmed);
	if (daily) return { ...base, kind: 'daily', time: `${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}` };
	const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([\d,]+)$/.exec(trimmed);
	if (weekly) return { ...base, kind: 'weekly', time: `${weekly[2].padStart(2, '0')}:${weekly[1].padStart(2, '0')}`, days: weekly[3].split(',').map((d) => parseInt(d, 10)) };
	return { ...base, kind: 'cron', cron: trimmed };
}

/** Day names for weekly wording, cron day-of-week order. */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Render a wire 'HH:MM' (24h — the cron/time-input format) as a clock time
 * in the BROWSER's locale, the same ambient format every other time in the
 * product uses ('18:15' -> '6:15 PM' for en-US, '18:15' for de-DE).
 *
 * @param time - 24h 'HH:MM' from the picker/cron.
 * @returns The locale-formatted clock time (the input verbatim if malformed).
 */
function formatClock(time: string): string {
	const [hour, minute] = time.split(':').map((part) => parseInt(part, 10));
	if (Number.isNaN(hour) || Number.isNaN(minute)) return time;
	// A throwaway local date carries the pair through the locale formatter;
	// only the clock fields render, so the date chosen is irrelevant.
	const date = new Date();
	date.setHours(hour, minute, 0, 0);
	return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Human wording for the summary line (from picker state, never cron). */
function summaryWording(state: PickerState): string {
	switch (state.kind) {
		case 'demand':
			return 'On demand — runs only when you trigger it';
		case 'interval':
			return state.intervalN === 1 ? `Runs every ${state.intervalUnit.slice(0, -1)}` : `Runs every ${state.intervalN} ${state.intervalUnit}`;
		case 'daily':
			return `Runs daily at ${formatClock(state.time)}`;
		case 'weekly': {
			const days = [...state.days].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b)).map((d) => DAY_NAMES[d] ?? String(d));
			return `Runs ${days.join(', ')} at ${formatClock(state.time)}`;
		}
		default:
			return 'Runs on the cron schedule';
	}
}

/**
 * Human wording for a stored run window.
 *
 * @param ttl - Seconds, or undefined for finish-bounded runs.
 * @returns e.g. 'up to 30 minutes', '' when finish-bounded.
 */
export function describeTtl(ttl?: number): string {
	if (!ttl) return '';
	if (ttl % 3600 === 0) return `up to ${ttl / 3600} ${ttl === 3600 ? 'hour' : 'hours'}`;
	const minutes = Math.round(ttl / 60);
	return `up to ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Human wording for a stored cron — THE one mapper every surface uses
 * (schedule rows, tiles, where-live summaries). Reverse-maps the picker
 * shapes; anything else renders the raw expression (the Advanced case).
 *
 * @param cron - The stored 5-field expression ('' = manual).
 * @returns Short human wording, e.g. 'every 30 minutes', 'daily at 08:00'.
 */
export function describeCron(cron: string): string {
	const state = fromCron(cron);
	if (state.kind === 'demand') return 'manual';
	if (state.kind === 'cron') return cron.trim();
	// Reuse the editor's wording, without the leading 'Runs '.
	return summaryWording(state).replace(/^Runs /, '');
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The v4 schedule editor panel. See the module docstring.
 */
export const SchedulePanel: React.FC<ISchedulePanelProps> = ({ open, sourceId, sourceName, teamName, pipelineName, initialCron, initialTtl, onSave, onClose, paused = false, onSetPaused, previewSchedule, running, onRunNow, onStopRun }) => {
	const [picker, setPicker] = useState<PickerState>(() => fromCron(initialCron));
	// RUN FOR: finish-bounded, or a fixed window (seconds on the wire).
	const [runFor, setRunFor] = useState<'finish' | 'window'>(initialTtl ? 'window' : 'finish');
	const [windowN, setWindowN] = useState<number>(initialTtl ? (initialTtl % 3600 === 0 ? initialTtl / 3600 : Math.max(1, Math.round(initialTtl / 60))) : 30);
	const [windowUnit, setWindowUnit] = useState<'minutes' | 'hours'>(initialTtl && initialTtl % 3600 === 0 ? 'hours' : 'minutes');
	const [preview, setPreview] = useState<SchedulePreviewResult | null>(null);
	const [clearConfirm, setClearConfirm] = useState(false);
	const [discardConfirm, setDiscardConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	// Re-seed the picker whenever the panel opens on a (new) source.
	useEffect(() => {
		if (open) {
			setPicker(fromCron(initialCron));
			setRunFor(initialTtl ? 'window' : 'finish');
			setWindowN(initialTtl ? (initialTtl % 3600 === 0 ? initialTtl / 3600 : Math.max(1, Math.round(initialTtl / 60))) : 30);
			setWindowUnit(initialTtl && initialTtl % 3600 === 0 ? 'hours' : 'minutes');
			setPreview(null);
			setDiscardConfirm(false);
			setError('');
		}
	}, [open, sourceId, initialCron, initialTtl]);

	const cron = useMemo(() => toCron(picker), [picker]);

	// Debounced SERVER preview: validity + the next occurrence — the single
	// evaluator renders every "next:" in the product.
	useEffect(() => {
		if (!open || !cron || !previewSchedule) {
			setPreview(null);
			return;
		}
		const timer = setTimeout(() => {
			previewSchedule(cron, 1)
				.then(setPreview)
				.catch(() => setPreview(null));
		}, PREVIEW_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [open, cron, previewSchedule]);

	// The staged run window in seconds ('until finished' and 'on demand' both
	// store none), and the DIRTY flag against the stored schedule — Save's
	// presence IS the dirty indicator (style guide), and dirty arms the
	// panel's X / Escape discard guard.
	const stagedTtl = cron && runFor === 'window' ? windowN * (windowUnit === 'hours' ? 3600 : 60) : null;
	const dirty = cron !== initialCron.trim() || stagedTtl !== (initialTtl ?? null);

	/** Persist (confirming a clear — it stops future runs). */
	const save = async (): Promise<void> => {
		setBusy(true);
		setError('');
		try {
			await onSave(cron || null, stagedTtl);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	/** Pause/resume this schedule in place (the panel stays open). */
	const togglePause = async (): Promise<void> => {
		if (!onSetPaused) return;
		setBusy(true);
		setError('');
		try {
			await onSetPaused(!paused);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const invalidCron = Boolean(cron) && preview !== null && preview.valid === false;
	const clearing = picker.kind === 'demand' && Boolean(initialCron.trim());

	/** One selectable option row (mockup .opt/.radio grammar). Carries real
	    radio semantics — role/aria-checked/tab stop and Enter/Space — so the
	    form is keyboard-completable. The keydown ignores events bubbling out
	    of the row's embedded inputs (Space typed in the cron box must never
	    flip the trigger). */
	const option = (kind: TriggerKind, title: ReactNode, sub: ReactNode, dashed = false): ReactNode => (
		<div
			style={{ ...S.option(picker.kind === kind, !busy), ...(dashed ? S.optionDashed : {}) }}
			role="radio"
			aria-checked={picker.kind === kind}
			tabIndex={busy ? -1 : 0}
			onClick={() => !busy && setPicker((prev) => ({ ...prev, kind }))}
			onKeyDown={(e) => {
				if (busy || e.target !== e.currentTarget) return;
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					setPicker((prev) => ({ ...prev, kind }));
				}
			}}
		>
			<span style={S.radio(picker.kind === kind)} />
			<div style={{ flex: 1 }}>
				<div style={S.optionTitle}>{title}</div>
				{sub}
			</div>
		</div>
	);

	return (
		<>
			<DetailPanel
				open={open}
				onClose={onClose}
				title={`Schedule — ${pipelineName ? `${pipelineName}/` : ''}${sourceName || sourceId}`}
				subtitle={`When this source's deployed pipeline runs on ${teamName}, and how long each run stays up.`}
				busy={busy}
				dirty={dirty}
				editing
				onExitMode={onClose}
				footer={
					<>
						{/* Record-level verbs at the LEFT edge (footer convention):
						    Pause/Resume (only a stored schedule can pause) and the
						    run verbs. [Save schedule] + [Cancel] MATERIALIZE on the
						    first change — their presence IS the dirty indicator; a
						    dirty Cancel routes through the discard confirm. Pristine
						    panels close via X / Escape. */}
						<span style={S.footerLeftVerbs}>
							{onSetPaused && Boolean(initialCron.trim()) && (
								<Button variant="secondary" small disabled={busy} onClick={() => void togglePause()}>
									{paused ? 'Resume' : 'Pause'}
								</Button>
							)}
							{onRunNow && !running && (
								<Button variant="danger" small disabled={busy} onClick={onRunNow}>
									Run
								</Button>
							)}
							{onStopRun && running && (
								<Button variant="danger" small disabled={busy} onClick={onStopRun}>
									Stop
								</Button>
							)}
						</span>
						{dirty && (
							<>
								<Button variant="primary" small disabled={busy || invalidCron || (picker.kind === 'cron' && !picker.cron.trim()) || (picker.kind === 'weekly' && picker.days.length === 0)} onClick={() => (clearing ? setClearConfirm(true) : void save())}>
									{busy ? 'Saving…' : 'Save schedule'}
								</Button>
								<Button variant="ghost" small disabled={busy} onClick={() => setDiscardConfirm(true)}>
									Cancel
								</Button>
							</>
						)}
					</>
				}
			>
				<div>
					{/* ── SCHEDULE — the trigger ────────────────────────────── */}
					<div style={S.sectionLabel} id="schedule-trigger-label">
						Schedule
					</div>
					<div role="radiogroup" aria-labelledby="schedule-trigger-label">
						{option('demand', 'On demand', <div style={S.optionSub}>Stored on the server; runs only when you trigger it.</div>)}
						{option(
							'interval',
							'Repeating interval',
							picker.kind === 'interval' ? (
								<div style={S.optionForm}>
									Every
									<input style={S.numBox} type="number" min={1} max={59} value={picker.intervalN} disabled={busy} onClick={(e) => e.stopPropagation()} onChange={(e) => setPicker((prev) => ({ ...prev, intervalN: Math.max(1, parseInt(e.target.value, 10) || 1) }))} />
									<select style={S.unitSelect} value={picker.intervalUnit} disabled={busy} onClick={(e) => e.stopPropagation()} onChange={(e) => setPicker((prev) => ({ ...prev, intervalUnit: e.target.value as IntervalUnit }))}>
										<option value="minutes">minutes</option>
										<option value="hours">hours</option>
									</select>
								</div>
							) : (
								<div style={S.optionSub}>Every N minutes or hours.</div>
							)
						)}
						{option(
							'daily',
							'Daily',
							picker.kind === 'daily' ? (
								<div style={S.optionForm}>
									Run at
									<input style={{ ...S.numBox, width: 118 }} type="time" value={picker.time} disabled={busy} onClick={(e) => e.stopPropagation()} onChange={(e) => setPicker((prev) => ({ ...prev, time: e.target.value || prev.time }))} />
								</div>
							) : (
								<div style={S.optionSub}>Once a day at a set time.</div>
							)
						)}
						{option(
							'weekly',
							'Weekly',
							picker.kind === 'weekly' ? (
								<div style={S.optionForm}>
									{DAY_CHIPS.map((day, index) => (
										<span
											key={index}
											style={S.dayChip(picker.days.includes(day.cron))}
											role="checkbox"
											aria-checked={picker.days.includes(day.cron)}
											aria-label={day.label}
											tabIndex={busy ? -1 : 0}
											onClick={(e) => {
												e.stopPropagation();
												if (busy) return;
												setPicker((prev) => ({ ...prev, days: prev.days.includes(day.cron) ? prev.days.filter((d) => d !== day.cron) : [...prev.days, day.cron] }));
											}}
											onKeyDown={(e) => {
												// Chip toggles never reach the row radio (stop both paths).
												e.stopPropagation();
												if (busy) return;
												if (e.key === 'Enter' || e.key === ' ') {
													e.preventDefault();
													setPicker((prev) => ({ ...prev, days: prev.days.includes(day.cron) ? prev.days.filter((d) => d !== day.cron) : [...prev.days, day.cron] }));
												}
											}}
										>
											{day.label}
										</span>
									))}
									<span>at</span>
									<input style={{ ...S.numBox, width: 118 }} type="time" value={picker.time} disabled={busy} onClick={(e) => e.stopPropagation()} onChange={(e) => setPicker((prev) => ({ ...prev, time: e.target.value || prev.time }))} />
								</div>
							) : (
								<div style={S.optionSub}>On chosen weekdays at a set time.</div>
							)
						)}
						{option(
							'cron',
							<span style={{ color: 'var(--rr-text-secondary)' }}>Advanced: cron expression</span>,
							picker.kind === 'cron' ? (
								<div style={S.optionForm}>
									<InputField value={picker.cron} placeholder="*/30 * * * *" disabled={busy} style={{ width: '100%' }} onClick={(e) => e.stopPropagation()} onChange={(e) => setPicker((prev) => ({ ...prev, cron: e.target.value }))} />
								</div>
							) : (
								<div style={S.optionSub}>Last resort for shapes the pickers cannot express. Validated and previewed by the server before it can be saved.</div>
							),
							true
						)}
					</div>

					{/* ── RUN FOR — duration is part of the schedule ─────────── */}
					<div style={S.sectionLabel} id="schedule-runfor-label">
						Run for
					</div>
					<div role="radiogroup" aria-labelledby="schedule-runfor-label">
						<div
							style={S.option(runFor === 'finish', !busy)}
							role="radio"
							aria-checked={runFor === 'finish'}
							tabIndex={busy ? -1 : 0}
							onClick={() => !busy && setRunFor('finish')}
							onKeyDown={(e) => {
								if (busy || e.target !== e.currentTarget) return;
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									setRunFor('finish');
								}
							}}
						>
							<span style={S.radio(runFor === 'finish')} />
							<div style={{ flex: 1 }}>
								<div style={S.optionTitle}>Until the pipeline finishes</div>
								<div style={S.optionSub}>The task ends when the source completes — right for batch sources.</div>
							</div>
						</div>
						<div
							style={S.option(runFor === 'window', !busy)}
							role="radio"
							aria-checked={runFor === 'window'}
							tabIndex={busy ? -1 : 0}
							onClick={() => !busy && setRunFor('window')}
							onKeyDown={(e) => {
								if (busy || e.target !== e.currentTarget) return;
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									setRunFor('window');
								}
							}}
						>
							<span style={S.radio(runFor === 'window')} />
							<div style={{ flex: 1 }}>
								<div style={S.optionTitle}>Fixed window</div>
								{runFor === 'window' ? (
									<div style={S.optionForm}>
										Stay up for
										<input style={S.numBox} type="number" min={1} max={999} value={windowN} disabled={busy} onClick={(e) => e.stopPropagation()} onChange={(e) => setWindowN(Math.max(1, parseInt(e.target.value, 10) || 1))} />
										<select style={S.unitSelect} value={windowUnit} disabled={busy} onClick={(e) => e.stopPropagation()} onChange={(e) => setWindowUnit(e.target.value as 'minutes' | 'hours')}>
											<option value="minutes">minutes</option>
											<option value="hours">hours</option>
										</select>
										then shut down — essential for endpoint-style sources that never terminate on their own.
									</div>
								) : (
									<div style={S.optionSub}>Stay up for a set window, then shut down — endpoint-style sources that never terminate on their own.</div>
								)}
							</div>
						</div>
					</div>

					{/* ── Summary — server-previewed ─────────────────────────── */}
					<div style={S.summary}>
						{invalidCron ? (
							<span style={{ color: 'var(--rr-color-error)' }}>{preview?.error || 'Invalid cron expression'}</span>
						) : (
							<>
								{summaryWording(picker)}
								{picker.kind !== 'demand' ? (runFor === 'window' ? `, each run up to ${windowN} ${windowUnit}` : ', each run until the pipeline finishes') : ''}
								{cron && preview?.valid && preview.next?.length ? (
									<>
										{' '}
										&middot; next: <b>{formatTime(preview.next[0])}</b> <span style={S.summaryMuted}>(previewed by the server)</span>
									</>
								) : null}
							</>
						)}
					</div>
					{error && <div style={S.errorText}>{error}</div>}
				</div>
			</DetailPanel>

			{/* ── Discard guard for the footer Cancel (stock ConfirmDialog) ── */}
			{discardConfirm && (
				<ConfirmDialog
					title="Discard changes?"
					message="Your unsaved changes will be lost."
					confirmLabel="Discard"
					cancelLabel="Keep Editing"
					destructive
					onConfirm={() => {
						setDiscardConfirm(false);
						onClose();
					}}
					onCancel={() => setDiscardConfirm(false)}
				/>
			)}

			{/* ── Clearing confirmation (On demand removes the schedule) ──── */}
			{clearConfirm && (
				<ConfirmDialog
					title={`Stop scheduling ${sourceName || sourceId}?`}
					message="On demand removes the schedule — the source stops firing automatically and only runs when triggered."
					confirmLabel="Save"
					cancelLabel="Cancel"
					onConfirm={() => {
						setClearConfirm(false);
						void save();
					}}
					onCancel={() => setClearConfirm(false)}
				/>
			)}
		</>
	);
};
