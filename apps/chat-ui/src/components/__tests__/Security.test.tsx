/**
 * Security tests — verifies XSS prevention in markdown rendering.
 *
 * Based on Reddit March 2026 patterns for testing rehype-sanitize.
 * These tests verify that malicious content from pipeline responses
 * cannot execute scripts in the chat UI.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Message } from '../Message';
import type { Message as MessageType } from '../../types/chat.types';

function botMsg(text: string): MessageType {
	return { id: Date.now(), text, sender: 'bot', timestamp: '12:00' };
}

describe('XSS Prevention', () => {
	it('strips onerror event handlers from img tags', () => {
		render(<Message message={botMsg('<img src=x onerror="alert(1)">')} />);
		const imgs = document.querySelectorAll('img');
		imgs.forEach((img) => {
			expect(img.getAttribute('onerror')).toBeNull();
		});
	});

	it('strips script tags from markdown', () => {
		render(<Message message={botMsg('<script>alert("xss")</script>Hello safe text')} />);
		expect(screen.getByText('Hello safe text')).toBeDefined();
		const scripts = document.querySelectorAll('script');
		expect(scripts.length).toBe(0);
	});

	it('strips onclick handlers from elements', () => {
		render(<Message message={botMsg('<div onclick="alert(1)">Click me</div>')} />);
		const div = screen.getByText('Click me');
		expect(div.getAttribute('onclick')).toBeNull();
	});

	it('renders safe markdown correctly', () => {
		render(<Message message={botMsg('**Bold** and *italic* and [link](https://example.com)')} />);
		expect(screen.getByText('Bold')).toBeDefined();
		expect(screen.getByText('italic')).toBeDefined();
		expect(screen.getByRole('link', { name: 'link' })).toBeDefined();
	});
});
