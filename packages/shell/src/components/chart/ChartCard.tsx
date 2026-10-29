// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ChartCard — the dashboard panel around a chart: a title, an optional
 * subtitle and headline (the period total, say), header actions (a range
 * picker), the chart, and a footer.
 *
 * It owns the states every chart needs, so call sites stay small:
 *   - `isLoading` shows a skeleton the size of the chart.
 *   - `error` replaces the chart with the message and an optional Retry.
 *   - `isEmpty` shows `emptyText` instead of an empty plot.
 *
 * Pass the chart's `data` and the card adds a Chart / Table switch: the
 * table view lists every value, which is the accessible (and copyable) form
 * of the chart and the relief for series colors with low surface contrast.
 *
 * ChartTable renders that table on its own as well.
 *
 * Built on `.rr-paper` and `.rr-chart-card` from components.css.
 */

import React, { ReactNode, useId, useState } from 'react';
import { Button } from '../button/Button';
import { Skeleton } from '../skeleton/Skeleton';
import { ITableColumn, Table } from '../table/Table';
import { ToggleGroup } from '../toggle-group/ToggleGroup';
import { formatCompact } from './chartFormat';
import { IChartData } from './chartMath';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ChartTable} component. */
export interface IChartTableProps {
	/** The chart data. */
	data: IChartData;
	/** Table caption (visually hidden); usually the chart's label. */
	caption: string;
	/** Header of the category column. Defaults to `'Period'`. */
	categoryHeader?: string;
	/** Formats values. Defaults to {@link formatCompact}. */
	formatValue?: (value: number) => string;
}

/** Which view a ChartCard shows. */
export type ChartCardView = 'chart' | 'table';

/** Props for the {@link ChartCard} component. */
export interface IChartCardProps {
	/** Card title. */
	title: ReactNode;
	/** Line under the title ("Last 30 days"). */
	subtitle?: ReactNode;
	/** Headline beside the title: the period total or current value. */
	headline?: ReactNode;
	/** Header actions (a range ToggleGroup, a Menu). */
	actions?: ReactNode;
	/** The chart. */
	children: ReactNode;
	/** Chart data; enables the Chart / Table switch. */
	data?: IChartData;
	/** Formats table values. Defaults to {@link formatCompact}. */
	formatValue?: (value: number) => string;
	/** Header of the table's category column. */
	categoryHeader?: string;
	/** Show a skeleton instead of the chart. */
	isLoading?: boolean;
	/** Show this error instead of the chart. */
	error?: ReactNode;
	/** Retry handler shown with the error. */
	onRetry?: () => void;
	/** Show `emptyText` instead of the chart. */
	isEmpty?: boolean;
	/** Empty-state text. Defaults to `'No data for this period'`. */
	emptyText?: ReactNode;
	/** Height of the chart area, for the loading, error and empty states. Defaults to 220. */
	height?: number;
	/** Footer under the chart (a link to the full report). */
	footer?: ReactNode;
	/** Heading level of the title. Defaults to 2 (a widget directly under the page's h1). */
	headingLevel?: 2 | 3 | 4;
}

/** One table row: a category index. */
interface IChartRow {
	index: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Options of the view switch. */
const VIEW_OPTIONS: { id: ChartCardView; label: string }[] = [
	{ id: 'chart', label: 'Chart' },
	{ id: 'table', label: 'Table' },
];

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders chart data as a table: one row per category, one column per series.
 *
 * @param props - {@link IChartTableProps}.
 * @returns The table.
 */
export function ChartTable({ data, caption, categoryHeader = 'Period', formatValue = formatCompact }: IChartTableProps): React.ReactElement {
	const rows: IChartRow[] = data.categories.map((_, index) => ({ index }));
	const columns: ITableColumn<IChartRow>[] = [
		{ id: '__category__', header: categoryHeader, value: (row) => data.categories[row.index] },
		...data.series.map(
			(series): ITableColumn<IChartRow> => ({
				id: series.id,
				header: series.label,
				align: 'right',
				mono: true,
				value: (row) => series.values[row.index],
				render: (row) => {
					const value = series.values[row.index];
					if (value === null || value === undefined) return '–';
					return formatValue(value);
				},
			})
		),
	];
	return <Table columns={columns} rows={rows} getRowId={(row) => String(row.index)} caption={caption} dense />;
}

/**
 * Renders a dashboard chart panel with loading, error, empty and table states.
 *
 * @param props - {@link IChartCardProps}.
 * @returns The card.
 */
export function ChartCard({ title, subtitle, headline, actions, children, data, formatValue = formatCompact, categoryHeader, isLoading = false, error, onRetry, isEmpty = false, emptyText = 'No data for this period', height = 220, footer, headingLevel = 2 }: IChartCardProps): React.ReactElement {
	const titleId = useId();
	const [view, setView] = useState<ChartCardView>('chart');
	const Heading = `h${headingLevel}` as 'h2';

	const hasData = Boolean(data) && !isLoading && !error && !isEmpty;
	let caption = 'Chart data';
	if (typeof title === 'string') caption = title;

	/** The chart, or the state that replaces it (loading wins, then error, then empty). */
	function renderBody(): ReactNode {
		if (isLoading) {
			return (
				<div className="rr-chart-card__state" aria-busy="true" aria-label="Loading chart">
					<Skeleton height={height} />
				</div>
			);
		}
		if (error) {
			return (
				<div className="rr-chart-card__state" role="alert" style={{ minHeight: height }}>
					<span>{error}</span>
					{onRetry && (
						<Button variant="secondary" small onClick={onRetry}>
							Retry
						</Button>
					)}
				</div>
			);
		}
		if (isEmpty) {
			return (
				<div className="rr-chart-card__state" style={{ minHeight: height }}>
					{emptyText}
				</div>
			);
		}
		if (view === 'table' && data) {
			return (
				<div className="rr-chart-card__table" tabIndex={0} role="region" aria-label={`${caption} table`}>
					<ChartTable data={data} caption={caption} categoryHeader={categoryHeader} formatValue={formatValue} />
				</div>
			);
		}
		return children;
	}

	return (
		<section className="rr-paper rr-chart-card" aria-labelledby={titleId}>
			<header className="rr-chart-card__header">
				<div className="rr-chart-card__titles">
					<Heading id={titleId} className="rr-chart-card__title">
						{title}
					</Heading>
					{subtitle && <p className="rr-chart-card__subtitle">{subtitle}</p>}
				</div>
				{(actions || hasData) && (
					<div className="rr-chart-card__actions">
						{actions}
						{hasData && <ToggleGroup options={VIEW_OPTIONS} value={view} onChange={setView} />}
					</div>
				)}
			</header>
			{headline && <div className="rr-chart-card__headline">{headline}</div>}
			<div className="rr-chart-card__body">{renderBody()}</div>
			{footer && <footer className="rr-chart-card__footer">{footer}</footer>}
		</section>
	);
}
