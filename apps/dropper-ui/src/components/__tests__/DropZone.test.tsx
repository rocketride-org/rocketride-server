/**
 * Tests for DropZone component.
 *
 * Based on Reddit March 2026 patterns:
 * - userEvent for file upload simulation (not fireEvent)
 * - Mock DataTransfer for drag-over UI states
 * - Test visual states: default, drag-over, processing, disabled
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

describe('DropZone', () => {
	it('renders default state with upload instructions', () => {
		render(<DropZone {...defaultProps} />);
		expect(screen.getByText(/Drop files or click/i)).toBeDefined();
	});

	it('renders processing state', () => {
		render(<DropZone {...defaultProps} isProcessing={true} />);
		expect(screen.getByText(/processing/i)).toBeDefined();
	});

	it('renders disabled state when connecting', () => {
		render(<DropZone {...defaultProps} disabled={true} />);
		expect(screen.getByText(/connecting/i)).toBeDefined();
	});

	it('renders drag-over state', () => {
		render(<DropZone {...defaultProps} isDragOver={true} />);
		expect(screen.getByText(/drop/i)).toBeDefined();
	});

	it('calls onDragOver when dragging over', () => {
		render(<DropZone {...defaultProps} />);
		const zone = screen.getByRole('button', { name: /drop files/i });
		fireEvent.dragOver(zone);
		expect(defaultProps.onDragOver).toHaveBeenCalled();
	});

	it('calls onDrop when files are dropped', () => {
		render(<DropZone {...defaultProps} />);
		const zone = screen.getByRole('button', { name: /drop files/i });
		fireEvent.drop(zone);
		expect(defaultProps.onDrop).toHaveBeenCalled();
	});

	it('has a file input element', () => {
		render(<DropZone {...defaultProps} />);
		const input = screen.queryByLabelText(/upload files/i);
		expect(input).not.toBeNull();
	});
});
