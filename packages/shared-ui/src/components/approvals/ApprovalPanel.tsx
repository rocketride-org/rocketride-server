// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ApprovalPanel — Reviewer UI for human-in-the-loop approval requests.
 *
 * Polls GET /approvals?status=pending every 2 seconds while mounted.
 * Each pending request is shown as a card with:
 *   - the payload (text or JSON)
 *   - an editable textarea so reviewers can modify the text before approving
 *   - Approve / Reject buttons
 *   - a countdown to the deadline
 *
 * Communicates directly with the REST API built in packages/ai (issue #635).
 * No WebSocket needed — the approval gate lives in the pipeline thread.
 */

import React, { CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// Types
// =============================================================================

interface ApprovalRequest {
	approval_id: string;
	status: 'pending' | 'approved' | 'rejected' | 'timed_out';
	payload: Record<string, unknown>;
	modified_payload?: Record<string, unknown> | null;
	created_at: number;
	deadline_at?: number | null;
	decided_by?: string | null;
	decision_reason?: string | null;
	require_reason_on_reject?: boolean;
	profile?: string;
	metadata?: Record<string, unknown>;
}

interface ApiListResponse {
	status: string;
	data: { count: number; approvals: ApprovalRequest[] };
}

// =============================================================================
// Styles
// =============================================================================

const S: Record<string, CSSProperties> = {
	empty: {
		color: 'var(--rr-text-disabled)',
		textAlign: 'center',
		padding: 40,
		fontSize: 13,
	},
	card: {
		...commonStyles.card,
		marginBottom: 20,
		borderRadius: 8,
	},
	cardHeader: {
		...commonStyles.cardHeader,
		borderRadius: '8px 8px 0 0',
		gap: 10,
	},
	cardBody: {
		...commonStyles.cardBody,
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 12,
	},
	badge: {
		fontSize: 10,
		fontWeight: 700,
		padding: '2px 8px',
		borderRadius: 10,
		backgroundColor: 'var(--rr-color-warning)',
		color: '#000',
	},
	badgeTimeout: {
		fontSize: 10,
		fontWeight: 700,
		padding: '2px 8px',
		borderRadius: 10,
		backgroundColor: 'var(--rr-color-error)',
		color: '#fff',
	},
	label: {
		...commonStyles.labelUppercase,
		marginBottom: 4,
	},
	payloadBlock: {
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		padding: '8px 10px',
		fontSize: 12,
		...commonStyles.fontMono,
		whiteSpace: 'pre-wrap' as const,
		wordBreak: 'break-word' as const,
		maxHeight: 200,
		overflowY: 'auto' as const,
		color: 'var(--rr-text-primary)',
	},
	textarea: {
		width: '100%',
		minHeight: 120,
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		padding: '8px 10px',
		fontSize: 12,
		...commonStyles.fontMono,
		color: 'var(--rr-text-primary)',
		resize: 'vertical' as const,
		boxSizing: 'border-box' as const,
	},
	actionRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'center',
	},
	metaRow: {
		display: 'flex',
		gap: 16,
		alignItems: 'center',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	},
	rejectModal: {
		backgroundColor: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		width: 420,
		maxWidth: '90vw',
		padding: 24,
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 16,
		boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
	},
	rejectTitle: {
		fontSize: 14,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	},
	rejectInput: {
		width: '100%',
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		padding: '8px 10px',
		fontSize: 12,
		color: 'var(--rr-text-primary)',
		boxSizing: 'border-box' as const,
	},
	errorText: {
		fontSize: 11,
		color: 'var(--rr-color-error)',
	},
	spinnerWrap: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '8px 0',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	},
};

// =============================================================================
// Helpers
// =============================================================================

function extractDisplayText(payload: Record<string, unknown>): { mode: 'text' | 'json'; value: string } {
	if ('text' in payload && typeof payload.text === 'string') {
		return { mode: 'text', value: payload.text };
	}
	if ('json' in payload) {
		return { mode: 'json', value: JSON.stringify(payload.json, null, 2) };
	}
	return { mode: 'json', value: JSON.stringify(payload, null, 2) };
}

function useCountdown(deadlineAt: number | null | undefined): string {
	const [remaining, setRemaining] = useState('');

	useEffect(() => {
		if (!deadlineAt) {
			setRemaining('');
			return;
		}
		const tick = () => {
			const now = Date.now() / 1000;
			const secs = Math.max(0, Math.round(deadlineAt - now));
			if (secs <= 0) {
				setRemaining('expired');
				return;
			}
			const m = Math.floor(secs / 60);
			const s = secs % 60;
			setRemaining(m > 0 ? `${m}m ${s}s` : `${s}s`);
		};
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	}, [deadlineAt]);

	return remaining;
}

// =============================================================================
// RejectModal
// =============================================================================

interface RejectModalProps {
	approvalId: string;
	requireReason: boolean;
	onConfirm: (approvalId: string, reason: string) => Promise<void>;
	onCancel: () => void;
}

const RejectModal: React.FC<RejectModalProps> = ({ approvalId, requireReason, onConfirm, onCancel }) => {
	const [reason, setReason] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState('');

	const handleConfirm = async () => {
		if (requireReason && !reason.trim()) {
			setError('A reason is required for this rejection.');
			return;
		}
		setSubmitting(true);
		setError('');
		try {
			await onConfirm(approvalId, reason);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : 'Rejection failed.');
			setSubmitting(false);
		}
	};

	const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
		if (e.target === e.currentTarget) onCancel();
	};

	return createPortal(
		<div style={commonStyles.overlay} onClick={handleBackdrop}>
			<div style={S.rejectModal} onClick={(e) => e.stopPropagation()}>
				<div style={S.rejectTitle}>Reject approval</div>
				<div>
					<div style={S.label}>Reason {requireReason ? '(required)' : '(optional)'}</div>
					<input
						style={S.rejectInput}
						placeholder={requireReason ? 'Enter a reason for rejection…' : 'Reason (optional)'}
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						autoFocus
						onKeyDown={(e) => {
							if (e.key === 'Enter') handleConfirm();
							if (e.key === 'Escape') onCancel();
						}}
					/>
				</div>
				{error && <div style={S.errorText}>{error}</div>}
				<div style={S.actionRow}>
					<button style={submitting ? commonStyles.buttonDisabled : commonStyles.buttonDanger} disabled={submitting} onClick={handleConfirm}>
						{submitting ? 'Rejecting…' : 'Confirm Reject'}
					</button>
					<button style={commonStyles.buttonSecondary} onClick={onCancel} disabled={submitting}>
						Cancel
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
};

// =============================================================================
// ApprovalCard
// =============================================================================

interface ApprovalCardProps {
	req: ApprovalRequest;
	onApprove: (id: string, modifiedText: string | null, mode: 'text' | 'json') => Promise<void>;
	onReject: (id: string, reason: string) => Promise<void>;
}

const ApprovalCard: React.FC<ApprovalCardProps> = ({ req, onApprove, onReject }) => {
	const { mode, value } = extractDisplayText(req.payload);
	const [editedValue, setEditedValue] = useState(value);
	const [approving, setApproving] = useState(false);
	const [showReject, setShowReject] = useState(false);
	const [approveError, setApproveError] = useState('');
	const countdown = useCountdown(req.deadline_at);
	const isExpiringSoon = countdown !== '' && countdown !== 'expired' && req.deadline_at ? req.deadline_at - Date.now() / 1000 < 30 : false;

	const wasModified = editedValue.trim() !== value.trim();

	const handleApprove = async () => {
		setApproving(true);
		setApproveError('');
		try {
			await onApprove(req.approval_id, wasModified ? editedValue : null, mode);
		} catch (e: unknown) {
			setApproveError(e instanceof Error ? e.message : 'Approval failed.');
			setApproving(false);
		}
	};

	const handleRejectConfirm = async (id: string, reason: string) => {
		await onReject(id, reason);
		setShowReject(false);
	};

	const profile = req.profile ?? 'auto';
	const short_id = req.approval_id.slice(0, 8);

	return (
		<div style={S.card}>
			{/* Card header */}
			<div style={S.cardHeader}>
				<span style={{ fontWeight: 600, fontSize: 13, color: 'var(--rr-text-primary)', flex: 1 }}>
					Request <span style={{ ...commonStyles.fontMono, fontSize: 11 }}>{short_id}…</span>
				</span>
				{profile !== 'auto' && <span style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>profile: {profile}</span>}
				{countdown === 'expired' ? <span style={S.badgeTimeout}>Expired</span> : countdown ? <span style={isExpiringSoon ? S.badgeTimeout : S.badge}>⏱ {countdown}</span> : null}
				<span style={S.badge}>PENDING</span>
			</div>

			{/* Card body */}
			<div style={S.cardBody}>
				{/* Original payload (read-only preview) */}
				<div>
					<div style={S.label}>Payload {mode === 'json' ? '(JSON)' : '(text)'}</div>
					<div style={S.payloadBlock}>{value}</div>
				</div>

				{/* Editable version for modification */}
				<div>
					<div style={S.label}>
						Edit before approving
						{wasModified && <span style={{ marginLeft: 8, color: 'var(--rr-color-warning)', fontWeight: 700, textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>● modified</span>}
					</div>
					<textarea style={S.textarea} value={editedValue} onChange={(e) => setEditedValue(e.target.value)} spellCheck={false} />
				</div>

				{/* Action row */}
				<div style={{ ...S.actionRow, justifyContent: 'space-between' }}>
					<div style={S.actionRow}>
						<button style={approving ? commonStyles.buttonDisabled : commonStyles.buttonPrimary} disabled={approving} onClick={handleApprove}>
							{approving ? 'Approving…' : wasModified ? 'Approve (modified)' : 'Approve'}
						</button>
						<button style={commonStyles.buttonDanger} disabled={approving} onClick={() => setShowReject(true)}>
							Reject
						</button>
					</div>
					<div style={S.metaRow}>{req.require_reason_on_reject && <span style={{ color: 'var(--rr-color-warning)' }}>reason required on reject</span>}</div>
				</div>

				{approveError && <div style={S.errorText}>{approveError}</div>}
			</div>

			{showReject && <RejectModal approvalId={req.approval_id} requireReason={req.require_reason_on_reject ?? false} onConfirm={handleRejectConfirm} onCancel={() => setShowReject(false)} />}
		</div>
	);
};

// =============================================================================
// ApprovalPanel (main export)
// =============================================================================

export interface ApprovalPanelProps {
	/** Base URL of the RocketRide server, e.g. "http://localhost:3000". */
	serverHost: string;
	/** Called whenever the pending count changes (used to drive the tab badge). */
	onPendingCountChange?: (count: number) => void;
}

const POLL_INTERVAL_MS = 2000;

export const ApprovalPanel: React.FC<ApprovalPanelProps> = ({ serverHost, onPendingCountChange }) => {
	const [requests, setRequests] = useState<ApprovalRequest[]>([]);
	const [loading, setLoading] = useState(true);
	const [fetchError, setFetchError] = useState('');
	const onCountRef = useRef(onPendingCountChange);
	onCountRef.current = onPendingCountChange;

	const baseUrl = serverHost.replace(/\/$/, '');

	const fetchPending = useCallback(async () => {
		if (!baseUrl) return;
		try {
			const res = await fetch(`${baseUrl}/approvals?status=pending`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body: ApiListResponse = await res.json();
			const items = body.data?.approvals ?? [];
			setRequests(items);
			setFetchError('');
			onCountRef.current?.(items.length);
		} catch (e: unknown) {
			setFetchError(e instanceof Error ? e.message : 'Failed to fetch approvals.');
		} finally {
			setLoading(false);
		}
	}, [baseUrl]);

	// Poll while mounted
	useEffect(() => {
		fetchPending();
		const id = setInterval(fetchPending, POLL_INTERVAL_MS);
		return () => clearInterval(id);
	}, [fetchPending]);

	const handleApprove = useCallback(
		async (approvalId: string, modifiedText: string | null, mode: 'text' | 'json') => {
			let modifiedPayload: Record<string, unknown> | undefined;
			if (modifiedText !== null) {
				if (mode === 'json') {
					try {
						modifiedPayload = { json: JSON.parse(modifiedText) };
					} catch {
						modifiedPayload = { text: modifiedText };
					}
				} else {
					modifiedPayload = { text: modifiedText };
				}
			}

			const body: Record<string, unknown> = {};
			if (modifiedPayload !== undefined) body.modified_payload = modifiedPayload;

			const res = await fetch(`${baseUrl}/approvals/${approvalId}/approve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const detail = await res
					.json()
					.then((d) => d.detail ?? `HTTP ${res.status}`)
					.catch(() => `HTTP ${res.status}`);
				throw new Error(detail);
			}
			// Remove from local list immediately; next poll will confirm
			setRequests((prev) => prev.filter((r) => r.approval_id !== approvalId));
			onCountRef.current?.(requests.length - 1);
		},
		[baseUrl, requests.length]
	);

	const handleReject = useCallback(
		async (approvalId: string, reason: string) => {
			const res = await fetch(`${baseUrl}/approvals/${approvalId}/reject`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(reason ? { reason } : {}),
			});

			if (!res.ok) {
				const detail = await res
					.json()
					.then((d) => d.detail ?? `HTTP ${res.status}`)
					.catch(() => `HTTP ${res.status}`);
				throw new Error(detail);
			}
			setRequests((prev) => prev.filter((r) => r.approval_id !== approvalId));
			onCountRef.current?.(requests.length - 1);
		},
		[baseUrl, requests.length]
	);

	// No server host — guard
	if (!baseUrl) {
		return <div style={S.empty}>Approval panel requires a server connection.</div>;
	}

	if (loading) {
		return <div style={S.spinnerWrap}>Loading approvals…</div>;
	}

	if (fetchError) {
		return (
			<div style={S.empty}>
				<div style={{ color: 'var(--rr-color-error)', marginBottom: 8 }}>{fetchError}</div>
				<div>Make sure the RocketRide server is running and the approval module is registered.</div>
			</div>
		);
	}

	if (requests.length === 0) {
		return (
			<div style={S.empty}>
				<div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
				<div style={{ fontWeight: 600, marginBottom: 4 }}>No pending approvals</div>
				<div style={{ fontSize: 12 }}>When an approval node blocks the pipeline, requests appear here.</div>
			</div>
		);
	}

	return (
		<div>
			<div style={{ marginBottom: 16, fontSize: 12, color: 'var(--rr-text-secondary)' }}>
				{requests.length} pending {requests.length === 1 ? 'request' : 'requests'} — approving unblocks the pipeline
			</div>
			{requests.map((req) => (
				<ApprovalCard key={req.approval_id} req={req} onApprove={handleApprove} onReject={handleReject} />
			))}
		</div>
	);
};

export default ApprovalPanel;
