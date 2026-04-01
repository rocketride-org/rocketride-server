// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Formatting utilities for the Server Monitor module.
 */

/** Format seconds into a human-readable duration string (e.g. "4d 7h 23m"). */
export function formatUptime(seconds: number): string {
	if (seconds < 0) return '0s';

	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);

	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
	if (minutes > 0) return `${minutes}m ${secs}s`;
	return `${secs}s`;
}

/** Format a Unix timestamp into a short time string (HH:MM:SS). */
export function formatTime(timestamp: number): string {
	const date = new Date(timestamp * 1000);
	return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Format a Unix timestamp as a relative "X ago" string. */
export function formatTimeAgo(timestamp: number): string {
	const now = Date.now() / 1000;
	const diff = now - timestamp;

	if (diff < 5) return 'just now';
	if (diff < 60) return `${Math.floor(diff)}s ago`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

/** Format a number with locale-appropriate thousands separators. */
export function formatNumber(n: number): string {
	return n.toLocaleString();
}
