import type { CSSProperties } from 'react';
import { AlertCircle, Check, Loader2, Mic, MicOff, X } from 'lucide-react';

export type VoiceBuilderPanelState = 'ready' | 'recording' | 'transcribing' | 'applying' | 'applied' | 'error';

export interface IVoiceBuilderPanelProps {
	state: VoiceBuilderPanelState;
	transcript?: string;
	summary?: string;
	error?: string | null;
	setupErrors?: string[];
	model?: string;
	isRecording: boolean;
	isStarting: boolean;
	onToggleRecording: () => void;
	onClose: () => void;
}

const styles = {
	panel: {
		position: 'absolute',
		top: 16,
		left: 16,
		width: 340,
		maxWidth: 'calc(100% - 32px)',
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		boxShadow: '0 12px 28px rgba(0,0,0,0.24)',
		color: 'var(--rr-text-primary)',
		zIndex: 1500,
		overflow: 'hidden',
	} satisfies CSSProperties,
	header: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		height: 42,
		padding: '0 10px',
		borderBottom: '1px solid var(--rr-border)',
	} satisfies CSSProperties,
	title: {
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 600,
		flex: 1,
	} satisfies CSSProperties,
	iconButton: {
		width: 28,
		height: 28,
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		border: 'none',
		borderRadius: 6,
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
	} satisfies CSSProperties,
	body: {
		padding: 12,
		display: 'flex',
		flexDirection: 'column',
		gap: 10,
	} satisfies CSSProperties,
	messageBox: {
		minHeight: 76,
		padding: 10,
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-default)',
		fontSize: 'var(--rr-font-size-widget)',
		lineHeight: 1.45,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'pre-wrap',
	} satisfies CSSProperties,
	errorBox: {
		padding: '8px 10px',
		borderRadius: 6,
		backgroundColor: 'color-mix(in srgb, var(--rr-color-error) 18%, transparent)',
		color: 'var(--rr-color-error)',
		fontSize: 'var(--rr-font-size-widget)',
		lineHeight: 1.35,
	} satisfies CSSProperties,
	meta: {
		color: 'var(--rr-text-secondary)',
		fontSize: 'var(--rr-font-size-widget)',
	} satisfies CSSProperties,
	action: {
		height: 34,
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		backgroundColor: 'var(--rr-bg-active)',
		color: 'var(--rr-text-primary)',
		cursor: 'pointer',
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		fontSize: 'var(--rr-font-size-widget)',
		fontWeight: 600,
	} satisfies CSSProperties,
} as const;

function getStatusCopy(state: VoiceBuilderPanelState, isStarting: boolean): string {
	if (isStarting) return 'Starting microphone...';
	switch (state) {
		case 'recording':
			return 'Recording';
		case 'transcribing':
			return 'Transcribing';
		case 'applying':
			return 'Applying';
		case 'applied':
			return 'Applied';
		case 'error':
			return 'Error';
		default:
			return 'Ready';
	}
}

function StatusIcon({ state, isStarting }: { state: VoiceBuilderPanelState; isStarting: boolean }) {
	if (isStarting || state === 'transcribing' || state === 'applying') return <Loader2 size={16} />;
	if (state === 'recording') return <MicOff size={16} />;
	if (state === 'applied') return <Check size={16} />;
	if (state === 'error') return <AlertCircle size={16} />;
	return <Mic size={16} />;
}

export function VoiceBuilderPanel({ state, transcript, summary, error, setupErrors = [], model, isRecording, isStarting, onToggleRecording, onClose }: IVoiceBuilderPanelProps) {
	const setupText = setupErrors.length > 0 ? setupErrors.join('\n') : null;
	const isBusy = isStarting || state === 'transcribing' || state === 'applying';
	const canRecord = !isBusy && setupErrors.length === 0;
	const actionLabel = isRecording ? 'Stop and apply' : 'Record command';

	return (
		<div style={styles.panel}>
			<div style={styles.header}>
				<StatusIcon state={state} isStarting={isStarting} />
				<div style={styles.title}>Voice</div>
				<div style={styles.meta}>{model}</div>
				<button type="button" title="Close" style={styles.iconButton} onClick={onClose}>
					<X size={16} />
				</button>
			</div>
			<div style={styles.body}>
				<div style={styles.messageBox}>{transcript || summary || getStatusCopy(state, isStarting)}</div>
				{setupText && <div style={styles.errorBox}>{setupText}</div>}
				{error && <div style={styles.errorBox}>{error}</div>}
				<button type="button" style={{ ...styles.action, opacity: canRecord || isRecording ? 1 : 0.5, cursor: canRecord || isRecording ? 'pointer' : 'default' }} disabled={!canRecord && !isRecording} onClick={onToggleRecording}>
					{isRecording ? <MicOff size={16} /> : <Mic size={16} />}
					{actionLabel}
				</button>
			</div>
		</div>
	);
}
