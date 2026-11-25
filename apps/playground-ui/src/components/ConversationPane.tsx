// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConversationPane — one connection on the right: the agent's header, then
 * either its conversation (the shell's MessageList with the Playground's
 * bubble bodies, and the bottom bar for what its source takes) or, for an
 * agent that takes no requests here, the page of what you can do with it.
 * The browser app and the dev tool frame both mount it.
 */

import React, { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Button, EmptyState, MessageList, useShellConnection } from 'shell';
import { AgentHeader } from './AgentHeader';
import { AgentTile } from './AgentTile';
import { BottomBar } from './BottomBar';
import { playgroundBodies } from './Bodies';
import { OnItsOwnPage } from './OnItsOwnPage';
import { loadAgent } from '../core/agentInfo';
import type { AgentSessionMeta } from '../core/history';
import type { AgentInfo, AgentSource } from '../core/model';
import { failureOf } from '../core/send';
import { useConversation } from '../core/useConversation';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	pane: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
		backgroundColor: 'var(--rr-bg-default)',
	} as CSSProperties,
	center: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
	} as CSSProperties,
	empty: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: 8,
		textAlign: 'center',
	} as CSSProperties,
	emptyName: {
		fontSize: 18,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		margin: '6px 0 0',
	} as CSSProperties,
	emptyTagline: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		margin: 0,
		maxWidth: 420,
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link ConversationPane}. */
export interface IConversationPaneProps {
	/** The connection's id: the address the agent was opened with. */
	connectionId: string;
	/** The conversation to show, or null for a new one. */
	sessionId: string | null;
	/** Simple view. */
	simple: boolean;
	/** Flips Simple / Advanced. */
	onToggleView: () => void;
	/** A conversation's file was saved; commit its row. */
	onSaved: (meta: AgentSessionMeta) => void;
	/** Starts a new conversation with this agent. */
	onNewConversation: () => void;
	/** Back to the picker. */
	onChooseAnother: () => void;
	/** Opens another of the agent's sources as its own connection. */
	onUseSource: (address: string, name: string) => void;
	/** The agent was read (its name, icon and whether it takes requests here). */
	onAgentRead?: (agent: AgentInfo) => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders one connection.
 *
 * @param props - {@link IConversationPaneProps}.
 * @returns The pane.
 */
export const ConversationPane: React.FC<IConversationPaneProps> = ({ connectionId, sessionId, simple, onToggleView, onSaved, onNewConversation, onChooseAnother, onUseSource, onAgentRead }) => {
	const { client, isConnected } = useShellConnection();
	const [agent, setAgent] = useState<AgentInfo | null>(null);
	const [agentError, setAgentError] = useState<string | null>(null);
	const [aboutOpen, setAboutOpen] = useState(false);

	// step: read the agent once per connection, when connected
	useEffect(() => {
		if (!client || !isConnected) return undefined;
		let cancelled = false;
		setAgent(null);
		setAgentError(null);
		loadAgent(client, connectionId)
			.then((info) => {
				if (cancelled) return;
				setAgent(info);
				onAgentRead?.(info);
			})
			.catch((err: unknown) => {
				if (!cancelled) setAgentError(failureOf(err).message);
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- read once per connection; the callback is the host's
	}, [client, isConnected, connectionId]);

	const conversation = useConversation({ client, agent, connectionId, sessionId, onSaved });
	const renderBody = useMemo(() => playgroundBodies(simple, agent?.listing.name ?? 'The agent'), [simple, agent]);

	// ── Not yet read ──────────────────────────────────────────────────────
	if (agentError) {
		return (
			<div style={styles.pane}>
				<div style={styles.center}>
					<EmptyState
						title="This agent isn't available to you"
						description={simple ? "It may have been removed, or it isn't shared with you." : agentError}
						action={
							<Button variant="primary" small onClick={onChooseAnother}>
								Choose an agent
							</Button>
						}
					/>
				</div>
			</div>
		);
	}
	if (!agent) {
		return (
			<div style={styles.pane}>
				<div style={styles.center}>
					<EmptyState title={isConnected ? 'Opening the agent…' : 'Connecting…'} />
				</div>
			</div>
		);
	}

	const source = agent.source;
	const takesRequests = source !== null && source.kind === 'request' && source.entry === 'data';
	const header = <AgentHeader agent={agent} simple={simple} onToggleView={onToggleView} onNewConversation={takesRequests ? onNewConversation : undefined} canStartNew={conversation.messages.length > 0 || sessionId !== null} aboutOpen={aboutOpen} onAboutChange={setAboutOpen} />;

	// ── An agent that takes no requests here ──────────────────────────────
	if (!takesRequests) {
		return (
			<div style={styles.pane}>
				{header}
				{source ? (
					<OnItsOwnPage agent={agent} source={source} simple={simple} onAbout={() => setAboutOpen(true)} onUseSource={(s: AgentSource) => onUseSource(s.address, agent.listing.name)} onChooseAnother={onChooseAnother} />
				) : (
					<div style={styles.center}>
						<EmptyState title={`${agent.listing.name} has no source`} description="There is nothing here to send to." />
					</div>
				)}
			</div>
		);
	}

	// ── The conversation ──────────────────────────────────────────────────
	const empty = (
		<div style={styles.empty}>
			<AgentTile name={agent.listing.name} icon={agent.listing.icon} size="xl" />
			<h2 style={styles.emptyName}>{agent.listing.name}</h2>
			{agent.listing.tagline && <p style={styles.emptyTagline}>{agent.listing.tagline}</p>}
		</div>
	);
	return (
		<div style={styles.pane}>
			{header}
			{conversation.loadError ? (
				<div style={styles.center}>
					<EmptyState title="This conversation couldn't be opened" description={conversation.loadError} />
				</div>
			) : (
				<MessageList messages={conversation.messages} isTyping={false} emptySlot={conversation.loading ? <EmptyState title="Opening the conversation…" /> : empty} renderBody={renderBody} />
			)}
			<BottomBar source={source!} agentName={agent.listing.name} connected={isConnected} onText={conversation.sendText} onFiles={conversation.sendFiles} />
		</div>
	);
};
