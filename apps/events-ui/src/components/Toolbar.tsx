// =============================================================================
// Toolbar — Monitor controls, filter, clear, download
// =============================================================================

import React from 'react';
import type { CapturedEvent, MonitorConfig } from '../types';
import { EVENT_TYPE_NAMES } from '../types';
import { styles, toggleChip } from '../styles';
import { commonStyles } from 'shared/themes/styles';

interface Props {
	config: MonitorConfig;
	onConfigChange: (config: MonitorConfig) => void;
	onToggle: () => void;
	onClear: () => void;
	events: CapturedEvent[];
	filterType: string;
	onFilterChange: (filter: string) => void;
}

function downloadEvents(events: CapturedEvent[], filterType: string) {
	const filtered = filterType === 'ALL' ? events : events.filter((e) => e.eventName === filterType);
	const json = JSON.stringify(filtered, null, 2);
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `rocketride-events-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

const Toolbar: React.FC<Props> = ({
	config,
	onConfigChange,
	onToggle,
	onClear,
	events,
	filterType,
	onFilterChange,
}) => {
	// Collect unique event names from captured events for the filter dropdown
	const seenTypes = new Set(events.map((e) => e.eventName));
	const filterOptions = ['ALL', ...Array.from(seenTypes).sort()];

	const toggleType = (type: string) => {
		const current = new Set(config.types);
		if (current.has(type)) {
			current.delete(type);
		} else {
			current.add(type);
		}
		onConfigChange({ ...config, types: Array.from(current) });
	};

	const selectAll = () => {
		onConfigChange({ ...config, types: [...EVENT_TYPE_NAMES] });
	};

	const selectNone = () => {
		onConfigChange({ ...config, types: [] });
	};

	const startStopStyle = config.active
		? styles.buttonDanger
		: { ...styles.buttonActive, ...(config.types.length === 0 ? commonStyles.buttonDisabled : {}) };

	return (
		<div>
			{/* Row 1: Token + start/stop */}
			<div style={styles.toolbar}>
				<div style={styles.toolbarGroup}>
					<span style={styles.toolbarLabel}>Token</span>
					<input
						type="text"
						style={{ ...styles.input, ...styles.tokenInput }}
						value={config.token}
						onChange={(e) => onConfigChange({ ...config, token: e.target.value })}
						placeholder="* (all tasks)"
						disabled={config.active}
					/>
				</div>

				<button
					style={startStopStyle}
					onClick={onToggle}
					disabled={!config.active && config.types.length === 0}
				>
					{config.active ? 'Stop' : 'Start'}
				</button>

				<div style={styles.toolbarSpacer} />

				{/* Filter dropdown */}
				<div style={styles.toolbarGroup}>
					<span style={styles.toolbarLabel}>Filter</span>
					<select
						style={styles.select}
						value={filterType}
						onChange={(e) => onFilterChange(e.target.value)}
					>
						{filterOptions.map((opt) => (
							<option key={opt} value={opt}>{opt}</option>
						))}
					</select>
				</div>

				<button style={styles.button} onClick={onClear}>
					Clear
				</button>

				<button
					style={{ ...styles.button, ...(events.length === 0 ? commonStyles.buttonDisabled : {}) }}
					onClick={() => downloadEvents(events, filterType)}
					disabled={events.length === 0}
				>
					Download
				</button>
			</div>

			{/* Row 2: Event type toggle chips */}
			<div style={{ ...styles.toolbar, gap: 6 }}>
				<span style={styles.toolbarLabel}>Types</span>
				<div style={styles.typeChipsRow}>
					{EVENT_TYPE_NAMES.map((type) => (
						<button
							key={type}
							style={{
								...toggleChip(config.types.includes(type)),
								...(config.active ? commonStyles.buttonDisabled : {}),
							}}
							onClick={() => toggleType(type)}
							disabled={config.active}
						>
							{type}
						</button>
					))}
				</div>
				<button
					style={{ ...toggleChip(false), marginLeft: 4, ...(config.active ? commonStyles.buttonDisabled : {}) }}
					onClick={selectAll}
					disabled={config.active}
				>
					All
				</button>
				<button
					style={{ ...toggleChip(false), ...(config.active ? commonStyles.buttonDisabled : {}) }}
					onClick={selectNone}
					disabled={config.active}
				>
					None
				</button>
			</div>
		</div>
	);
};

export default Toolbar;
