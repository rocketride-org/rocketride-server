/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
}

/**
 * Error boundary to prevent render crashes from taking down the entire app.
 *
 * Wraps components that render untrusted data (markdown, charts, JSON)
 * to gracefully handle failures instead of showing a white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
		console.error('[ErrorBoundary] Component crash:', error, errorInfo);
	}

	override render(): ReactNode {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}
			return (
				<div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
					<p className="font-medium">Something went wrong</p>
					<p className="mt-1 text-xs opacity-70">{this.state.error?.message || 'Unknown error'}</p>
				</div>
			);
		}
		return this.props.children;
	}
}
