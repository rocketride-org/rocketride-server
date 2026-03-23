/**
 * Tests for Message component.
 *
 * Based on Reddit March 2026 patterns:
 * - Use React Testing Library with getByRole/getByText (user-facing locators)
 * - Mock dependencies at module boundary
 * - Test rendering, not implementation details
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Message } from '../Message';
import type { Message as MessageType } from '../../types/chat.types';

describe('Message', () => {
	const userMessage: MessageType = {
		id: 1,
		text: 'Hello, how are you?',
		sender: 'user',
		timestamp: new Date().toISOString(),
	};

	const botMessage: MessageType = {
		id: 2,
		text: 'I am doing well, thank you!',
		sender: 'bot',
		timestamp: new Date().toISOString(),
	};

	const systemMessage: MessageType = {
		id: 3,
		text: 'Connection established',
		sender: 'system',
		timestamp: new Date().toISOString(),
	};

	it('renders user message text', () => {
		render(<Message message={userMessage} />);
		expect(screen.getByText('Hello, how are you?')).toBeInTheDocument();
	});

	it('renders bot message text', () => {
		render(<Message message={botMessage} />);
		expect(screen.getByText('I am doing well, thank you!')).toBeInTheDocument();
	});

	it('renders system message text', () => {
		render(<Message message={systemMessage} />);
		expect(screen.getByText('Connection established')).toBeInTheDocument();
	});

	it('renders without crashing for empty text', () => {
		const emptyMsg: MessageType = {
			id: 4,
			text: '',
			sender: 'bot',
			timestamp: new Date().toISOString(),
		};
		expect(() => render(<Message message={emptyMsg} />)).not.toThrow();
	});

	it('renders markdown in bot messages', () => {
		const markdownMsg: MessageType = {
			id: 5,
			text: '**bold text** and `code`',
			sender: 'bot',
			timestamp: new Date().toISOString(),
		};
		render(<Message message={markdownMsg} />);
		expect(screen.getByText('bold text')).toBeInTheDocument();
	});
});
