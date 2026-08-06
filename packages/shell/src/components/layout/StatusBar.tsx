import React, { CSSProperties } from 'react';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	bar: {
		height: '32px',
		flexShrink: 0,
		backgroundColor: 'var(--rr-bg-paper)',
		color: 'var(--rr-text-secondary)',
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 500,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '0 12px',
		borderTop: '1px solid var(--rr-border)',
	} as CSSProperties,
	left: { display: 'flex', alignItems: 'center', gap: 8 } as CSSProperties,
	right: { display: 'flex', alignItems: 'center', gap: 8 } as CSSProperties,
	dot: (connected: boolean): CSSProperties => ({
		width: 8,
		height: 8,
		borderRadius: '50%',
		backgroundColor: connected ? 'var(--rr-color-success)' : 'var(--rr-color-error)',
		display: 'inline-block',
	}),
	readyLabel: (connected: boolean): CSSProperties => ({
		color: connected ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
		fontWeight: 600,
	}),
};

// =============================================================================
// Types
// =============================================================================

interface StatusBarProps {
	appName: string;
	isConnected: boolean;
	/** When true, show the connection indicator (dot + label). */
	isAuthenticated: boolean;
	statusMessage: string | null;
	onToggleBottomPanel: () => void;
}

// =============================================================================
// Component
// =============================================================================

const StatusBar: React.FC<StatusBarProps> = ({ appName, isConnected, isAuthenticated, statusMessage, onToggleBottomPanel }) => {
	return (
		<div style={styles.bar}>
			<div style={styles.left}>
				<span style={{ cursor: 'pointer' }} onClick={onToggleBottomPanel}>{appName}</span>
				{isAuthenticated && (
					<>
						<span style={styles.dot(isConnected)} />
						<span>{isConnected ? 'Connected' : 'Disconnected'}</span>
					</>
				)}
			</div>
			<div style={styles.right}>
				{isAuthenticated && (
					<>
						{statusMessage && <span>{statusMessage}</span>}
						<span style={styles.readyLabel(isConnected)}>
							{isConnected ? 'Ready' : 'Offline'}
						</span>
					</>
				)}
			</div>
		</div>
	);
};

export default StatusBar;
