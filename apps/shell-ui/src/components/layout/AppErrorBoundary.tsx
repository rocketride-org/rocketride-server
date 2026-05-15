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
// APP ERROR BOUNDARY — catches crashes in app components
// =============================================================================

import { Component } from 'react';
import type { CSSProperties, ErrorInfo, ReactNode } from 'react';
import { commonStyles } from 'shared/themes/styles';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	errorContainer: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		height: '100%',
		padding: 40,
		fontFamily: 'var(--rr-font-family)',
		color: 'var(--rr-text-primary)',
		backgroundColor: 'var(--rr-bg-default)',
		gap: 16,
	} as CSSProperties,
	errorTitle: {
		fontSize: 18,
		fontWeight: 700,
		color: 'var(--rr-color-error, #ef4444)',
	} as CSSProperties,
	errorMessage: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		maxWidth: 600,
		textAlign: 'center',
		lineHeight: 1.6,
	} as CSSProperties,
	errorDetails: {
		fontSize: 11,
		fontFamily: 'var(--rr-font-family-mono, monospace)',
		color: 'var(--rr-text-tertiary, #888)',
		maxWidth: 600,
		maxHeight: 200,
		overflow: 'auto',
		padding: '12px 16px',
		borderRadius: 8,
		backgroundColor: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	} as CSSProperties,
	errorButton: {
		...commonStyles.buttonPrimary,
		padding: '8px 20px',
		fontWeight: 600,
		marginTop: 8,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Props for the AppErrorBoundary component.
 */
export interface AppErrorBoundaryProps {
	/** The app name for the error message. */
	appName: string;
	/** Children to render (the app component). */
	children: ReactNode;
}

/** Internal state for the error boundary. */
interface AppErrorBoundaryState {
	/** Whether an error has been caught. */
	hasError: boolean;
	/** The caught error object. */
	error: Error | null;
	/** The React component stack trace at the time of the error. */
	errorInfo: string;
}

/**
 * Error boundary that catches crashes in app components and displays
 * a friendly error screen instead of breaking the entire shell.
 *
 * Includes a "Reload App" button that resets the error state and
 * re-mounts the app component.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
	constructor(props: AppErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null, errorInfo: '' };
	}

	/** Derive error state from a caught error. */
	static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
		return { hasError: true, error };
	}

	/** Log the error and component stack for debugging. */
	override componentDidCatch(error: Error, info: ErrorInfo): void {
		const stack = info.componentStack ?? '';
		this.setState({ errorInfo: stack });
		console.error(`[${this.props.appName}] App crashed:`, error, stack);
	}

	/** Resets the error state to re-render the app. */
	handleReload = (): void => {
		this.setState({ hasError: false, error: null, errorInfo: '' });
	};

	override render(): ReactNode {
		if (this.state.hasError) {
			return (
				<div style={styles.errorContainer}>
					<div style={styles.errorTitle}>
						{this.props.appName} encountered an error
					</div>
					<div style={styles.errorMessage}>
						{this.state.error?.message ?? 'An unexpected error occurred.'}
					</div>
					{this.state.errorInfo && (
						<div style={styles.errorDetails}>
							{this.state.error?.stack ?? this.state.errorInfo}
						</div>
					)}
					<button style={styles.errorButton} onClick={this.handleReload}>
						Reload App
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
