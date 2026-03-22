/**
 * Tests for ErrorBoundary component.
 *
 * Verifies that render crashes are caught gracefully
 * instead of killing the entire app (white screen).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';

// Component that throws during render
const CrashingComponent = () => {
	throw new Error('Test crash!');
};

// Component that renders normally
const WorkingComponent = () => <div>All good</div>;

describe('ErrorBoundary', () => {
	it('renders children when no error', () => {
		render(
			<ErrorBoundary>
				<WorkingComponent />
			</ErrorBoundary>
		);
		expect(screen.getByText('All good')).toBeDefined();
	});

	it('catches render errors and shows fallback', () => {
		// Suppress console.error from React's error boundary logging
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(
			<ErrorBoundary>
				<CrashingComponent />
			</ErrorBoundary>
		);

		expect(screen.getByText('Something went wrong')).toBeDefined();
		expect(screen.getByText('Test crash!')).toBeDefined();

		spy.mockRestore();
	});

	it('renders custom fallback when provided', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		render(
			<ErrorBoundary fallback={<div>Custom error message</div>}>
				<CrashingComponent />
			</ErrorBoundary>
		);

		expect(screen.getByText('Custom error message')).toBeDefined();

		spy.mockRestore();
	});
});
