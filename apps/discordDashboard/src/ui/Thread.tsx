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
// <Thread> — the conversation drawer's thread, for reading
// =============================================================================
//
// The design system's ThreadView: an avatar column, a name line, then the
// bubble — the asker's on `surface-sunken`, Ralph's on `surface` with a line
// border and his answer rendered as markdown by the shell's MarkdownRenderer.
// Reactions sit as pills under the message they were put on; the things that
// are not messages (an escalation, the Slack page, a no-reply, a reaction on
// a message the log has no bubble for) are one centred event line each.
// Built only from the row's own data (`threadItems`). Tokens only.
// =============================================================================

import React from 'react';
import { MarkdownRenderer } from 'shell';
import type { ConversationRow } from '../state/types';
import { reasonText, shortId } from './parts';
import { shortWhen } from './dd';
import { Icon } from './Icon';
import { threadItems, type ThreadItem } from './threadItems';

type Bubble = Extract<ThreadItem, { kind: 'bubble' }>;
type Note = Extract<ThreadItem, { kind: 'note' }>;

/** The name above a bubble. */
function nameOf(item: Bubble): string {
	if (item.side === 'ralph') return 'Ralph';
	return shortId('user', item.authorId);
}

/** The avatar's letters. */
function initialsOf(item: Bubble): string {
	if (item.side === 'ralph') return 'R';
	if (item.side === 'team') return 'T';
	return 'U';
}

/** One centred event line. */
const EventLine: React.FC<{ icon: 'alert' | 'bell' | 'x' | 'check'; children: React.ReactNode }> = ({ icon, children }) => (
	<div className="dd-event">
		<Icon name={icon} />
		<span>{children}</span>
	</div>
);

/** A reaction pill, under the message it was put on. */
const Reaction: React.FC<{ note: Note }> = ({ note }) => (
	<span className="dd-react" title={`${note.removed ? 'Removed' : 'Added'} by ${shortId('user', note.actorId)} · ${shortWhen(note.ts)}`}>
		{note.emoji ?? '?'}
		{note.removed ? ' removed' : ''}
		<span className="dd-sr">
			{note.removed ? 'removed' : 'added'} by {shortId('user', note.actorId)}
		</span>
	</span>
);

/**
 * The thread for one conversation row.
 *
 * @param props.row - The row the drawer is showing.
 * @returns The thread, oldest first.
 */
export const Thread: React.FC<{ row: ConversationRow }> = ({ row }) => {
	const items = threadItems(row);
	if (items.length === 0) {
		return <p className="dd-help">Nothing was captured for this question.</p>;
	}

	// A reaction sits under the bubble it was put on, when the thread has it.
	const bubbles = items.filter((item): item is Bubble => item.kind === 'bubble');
	const ownerOf = (note: Note): Bubble | undefined => (note.targetId ? bubbles.find((bubble) => bubble.messageId === note.targetId || (bubble.replyIds ?? []).includes(note.targetId ?? '')) : undefined);
	const reactionsFor = new Map<string, Note[]>();
	for (const item of items) {
		if (item.kind !== 'note' || item.note !== 'reaction') continue;
		const owner = ownerOf(item);
		if (owner) reactionsFor.set(owner.key, [...(reactionsFor.get(owner.key) ?? []), item]);
	}

	return (
		<ol className="dd-thread" aria-label="Thread" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
			{items.map((item) => {
				if (item.kind === 'note') {
					if (item.note === 'reaction') {
						if (ownerOf(item)) return null;
						return (
							<li key={item.key}>
								<EventLine icon="check">
									{item.emoji ?? '?'} {item.removed ? 'removed' : 'added'} by {shortId('user', item.actorId)} · {shortWhen(item.ts)}
								</EventLine>
							</li>
						);
					}
					if (item.note === 'slack') {
						return (
							<li key={item.key}>
								<EventLine icon="bell">Paged Slack · {shortWhen(item.ts)} · a page was triggered</EventLine>
							</li>
						);
					}
					return (
						<li key={item.key}>
							<EventLine icon="x">
								No reply · {shortWhen(item.ts)}
								{reasonText(item.reason) !== null ? ` · ${reasonText(item.reason)}` : ''}
							</EventLine>
						</li>
					);
				}
				const reactions = reactionsFor.get(item.key) ?? [];
				const escalated = item.notes.includes('escalated');
				const meta = item.notes.filter((note) => note !== 'escalated');
				return (
					<li key={item.key} className="dd-stack" style={{ gap: 16 }}>
						<div className="dd-msg">
							<span className={`dd-avatar${item.side === 'ralph' ? ' dd-avatar--ralph' : item.side === 'team' ? ' dd-avatar--team' : ''}`} aria-hidden="true">
								{initialsOf(item)}
							</span>
							<div style={{ minWidth: 0 }}>
								<div className="dd-msg__meta">
									<span className="dd-msg__name" title={item.authorId ?? undefined}>
										{nameOf(item)}
									</span>
									{item.side === 'ralph' && (
										<span className="dd-chip dd-chip--brand" style={{ height: 20, padding: '0 8px' }}>
											Bot
										</span>
									)}
									{item.side === 'team' && (
										<span className="dd-chip dd-chip--info" style={{ height: 20, padding: '0 8px' }}>
											Team
										</span>
									)}
									<span className="dd-num">{shortWhen(item.ts)}</span>
									{meta.map((note) => (
										<span key={note}>· {note}</span>
									))}
								</div>
								<div className={`dd-bubble${item.side === 'ralph' ? ' dd-bubble--ralph' : ''}`}>
									{item.side === 'ralph' ? (
										<div className="dd-md">
											<MarkdownRenderer content={item.text} />
										</div>
									) : (
										<p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{item.text || '(no text captured)'}</p>
									)}
								</div>
								{reactions.length > 0 && (
									<div className="dd-reacts">
										{reactions.map((note) => (
											<Reaction key={note.key} note={note} />
										))}
									</div>
								)}
							</div>
						</div>
						{escalated && <EventLine icon="alert">Escalated to the RocketRide team · {shortWhen(item.ts)}</EventLine>}
					</li>
				);
			})}
		</ol>
	);
};
