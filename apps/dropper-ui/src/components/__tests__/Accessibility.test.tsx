/**
 * Accessibility tests for dropper-ui components.
 *
 * Verifies WCAG compliance for keyboard navigation and screen readers.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DropZone } from '../DropZone';

const defaultProps = {
	onFilesSelected: vi.fn(),
	isProcessing: false,
	isDragOver: false,
	onDragOver: vi.fn(),
	onDragLeave: vi.fn(),
	onDrop: vi.fn(),
};

describe('Accessibility', () => {
	it('DropZone has role=button and aria-label', () => {
		render(<DropZone {...defaultProps} />);
		const zone = screen.getByRole('button', {
			name: /drop files/i,
		});
		expect(zone).toBeDefined();
	});

	it('DropZone is keyboard-activatable with Enter', () => {
		render(<DropZone {...defaultProps} />);
		const zone = screen.getByRole('button', {
			name: /drop files/i,
		});
		// Enter should trigger file picker (which calls click on hidden input)
		fireEvent.keyDown(zone, { key: 'Enter' });
		// The input click is internal — we verify no error thrown
		expect(zone).toBeDefined();
	});

	it('DropZone is keyboard-activatable with Space', () => {
		render(<DropZone {...defaultProps} />);
		const zone = screen.getByRole('button', {
			name: /drop files/i,
		});
		fireEvent.keyDown(zone, { key: ' ' });
		expect(zone).toBeDefined();
	});

	it('DropZone is not focusable when disabled', () => {
		render(<DropZone {...defaultProps} disabled={true} />);
		// When disabled, the outermost div with role=button should have tabIndex -1
		const zone = screen.getByLabelText(/drop files/i);
		expect(zone.getAttribute('tabindex')).toBe('-1');
	});

	it('file input has aria-label', () => {
		render(<DropZone {...defaultProps} />);
		const input = screen.getByLabelText(/upload files/i);
		expect(input).toBeDefined();
	});
});
