// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AgentHeader — the agent's icon, name and tagline (Advanced: publisher,
 * version and where it answered), with About, New conversation and the
 * Advanced / Simple view button. About shows the agent's README.
 */

import React, { useEffect, useState, type CSSProperties } from 'react';
import { Button, MarkdownRenderer, Modal, commonStyles } from 'shell';
import { AgentTile } from './AgentTile';
import type { AgentInfo } from '../core/model';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	header: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '10px 16px',
		borderBottom: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-paper)',
		flexShrink: 0,
	} as CSSProperties,
	text: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	name: {
		...commonStyles.textEllipsis,
		fontSize: 14.5,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	tagline: {
		...commonStyles.textEllipsis,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	actions: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		flexShrink: 0,
	} as CSSProperties,
	readme: {
		maxHeight: '60vh',
		overflowY: 'auto',
	} as CSSProperties,
	readmeEmpty: {
		...commonStyles.textMuted,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link AgentHeader}. */
export interface IAgentHeaderProps {
	/** The agent. */
	agent: AgentInfo;
	/** Simple view. */
	simple: boolean;
	/** Flips Simple / Advanced. */
	onToggleView: () => void;
	/** Starts a new conversation; omitted when the agent takes no requests. */
	onNewConversation?: () => void;
	/** Whether New conversation has anything to start fresh from. */
	canStartNew: boolean;
	/** Whether About (the README) is open. */
	aboutOpen: boolean;
	/** Opens or closes About. */
	onAboutChange: (open: boolean) => void;
}

/**
 * The developer line: publisher, version, rung and team.
 *
 * @param agent - The agent.
 * @returns The line.
 */
function factsLine(agent: AgentInfo): string {
	const parts = [agent.listing.publisher ?? agent.pipe.split('.')[0]];
	parts.push(agent.version === null ? 'your Play run' : `v${agent.version}`);
	if (agent.rung !== 'spec') parts.push(agent.rung === 'team' && agent.teamId ? `team ${agent.teamId}` : agent.rung);
	return parts.join(' · ');
}

/**
 * Renders the header.
 *
 * @param props - {@link IAgentHeaderProps}.
 * @returns The header.
 */
export const AgentHeader: React.FC<IAgentHeaderProps> = ({ agent, simple, onToggleView, onNewConversation, canStartNew, aboutOpen, onAboutChange }) => {
	const setAboutOpen = onAboutChange;
	const [readme, setReadme] = useState<string | null>(null);
	const { listing } = agent;

	// step: the README is fetched once, when About first opens
	useEffect(() => {
		if (!aboutOpen || readme !== null || !listing.readme) return;
		fetch(listing.readme)
			.then((r) => (r.ok ? r.text() : ''))
			.then((text) => setReadme(text))
			.catch(() => setReadme(''));
	}, [aboutOpen, readme, listing.readme]);

	return (
		<div style={styles.header}>
			<AgentTile name={listing.name} icon={listing.icon} size="m" />
			<div style={styles.text}>
				<div style={styles.name}>{listing.name}</div>
				<div style={styles.tagline}>{simple ? (listing.tagline ?? '') : factsLine(agent)}</div>
			</div>
			<div style={styles.actions}>
				<Button variant="ghost" small onClick={() => setAboutOpen(true)}>
					About
				</Button>
				{onNewConversation && (
					<Button variant="ghost" small disabled={!canStartNew} onClick={onNewConversation}>
						New conversation
					</Button>
				)}
				<Button variant="secondary" small pressed={!simple} onClick={onToggleView}>
					{simple ? 'Advanced' : 'Simple view'}
				</Button>
			</div>
			{aboutOpen && (
				<Modal title={listing.name} onClose={() => setAboutOpen(false)} width={640}>
					<div style={styles.readme}>{listing.readme === undefined ? <div style={styles.readmeEmpty}>{listing.tagline ?? `${listing.name} has no README.`}</div> : readme === null ? <div style={styles.readmeEmpty}>Loading…</div> : <MarkdownRenderer content={readme || `${listing.name} has no README.`} />}</div>
				</Modal>
			)}
		</div>
	);
};
