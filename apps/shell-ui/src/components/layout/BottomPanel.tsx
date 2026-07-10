import React, { useState, CSSProperties } from 'react';
import { X } from 'lucide-react';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	panel: {
		height: '140px',
		flexShrink: 0,
		backgroundColor: 'var(--rr-bg-paper)',
		borderTop: '1px solid var(--rr-border)',
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
	tabs: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		padding: '0 8px',
		borderBottom: '1px solid var(--rr-border)',
		minHeight: 40,
	} as CSSProperties,
	tab: (active: boolean): CSSProperties => ({
		padding: '4px 8px',
		fontSize: 'var(--rr-font-size-subtitle)',
		fontWeight: 500,
		color: active ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
		backgroundColor: active ? 'var(--rr-accent-faded)' : 'transparent',
		borderRadius: '8px 8px 0 0',
		cursor: 'pointer',
	}),
	spacer: { flex: 1 } as CSSProperties,
	closeBtn: { color: 'var(--rr-text-secondary)', padding: 4, display: 'flex', alignItems: 'center' } as CSSProperties,
	content: {
		flex: 1,
		overflow: 'auto',
		padding: '6px 12px',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 'var(--rr-font-size-widget)',
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	} as CSSProperties,
};

// =============================================================================
// Types
// =============================================================================

interface BottomPanelProps {
	onClose: () => void;
}

// =============================================================================
// Component
// =============================================================================

const panelTabs = ['Output', 'Run', 'Logs'] as const;

const BottomPanel: React.FC<BottomPanelProps> = ({ onClose }) => {
	const [activeTab, setActiveTab] = useState<string>('Output');

	return (
		<div style={styles.panel}>
			<div style={styles.tabs}>
				{panelTabs.map((tab) => (
					<div key={tab} onClick={() => setActiveTab(tab)} style={styles.tab(activeTab === tab)}>
						{tab}
					</div>
				))}
				<div style={styles.spacer} />
				<button style={styles.closeBtn} onClick={onClose}>
					<X size={16} />
				</button>
			</div>
			<div style={styles.content}>
				Ready. Select a project to see output here.
			</div>
		</div>
	);
};

export default BottomPanel;
