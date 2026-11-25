// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * OnItsOwnPage — an agent whose source takes no requests here (a listener,
 * a scan, or a source entered by tool calls). The thread and the bottom bar
 * give way to one page: what it is, and what the caller can do with it.
 * Nothing is ever sent to it.
 */

import React, { type CSSProperties } from 'react';
import { Button, LabelValue, Section, commonStyles } from 'shell';
import { AgentTile } from './AgentTile';
import type { AgentInfo, AgentSource } from '../core/model';
import { otherWaysIn } from '../core/sources';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	page: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		padding: '32px 20px',
		gap: 10,
	} as CSSProperties,
	name: {
		fontSize: 18,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		margin: 0,
	} as CSSProperties,
	say: {
		maxWidth: 560,
		textAlign: 'center',
		fontSize: 13.5,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	card: {
		...commonStyles.card,
		width: '100%',
		maxWidth: 620,
		marginTop: 8,
	} as CSSProperties,
	cardLabel: {
		...commonStyles.labelUppercase,
		padding: '10px 14px 4px',
	} as CSSProperties,
	row: {
		display: 'grid',
		gridTemplateColumns: '150px 1fr auto',
		gap: 12,
		alignItems: 'center',
		padding: '10px 14px',
		borderTop: '1px solid var(--rr-border)',
		fontSize: 13,
	} as CSSProperties,
	rowTitle: {
		fontWeight: 600,
	} as CSSProperties,
	rowText: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	sources: {
		width: '100%',
		maxWidth: 620,
		marginTop: 8,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link OnItsOwnPage}. */
export interface IOnItsOwnPageProps {
	/** The agent. */
	agent: AgentInfo;
	/** Its source here. */
	source: AgentSource;
	/** Simple view. */
	simple: boolean;
	/** Opens the README. */
	onAbout: () => void;
	/** Opens another of its sources in a connection of its own. */
	onUseSource: (source: AgentSource) => void;
	/** Back to the picker. */
	onChooseAnother: () => void;
}

/**
 * Renders the page.
 *
 * @param props - {@link IOnItsOwnPageProps}.
 * @returns The page.
 */
export const OnItsOwnPage: React.FC<IOnItsOwnPageProps> = ({ agent, source, simple, onAbout, onUseSource, onChooseAnother }) => {
	const name = agent.listing.name;
	const others = otherWaysIn(agent.sources, source);
	const sentence = source.entry === 'tool' ? `${name} takes tool calls from other agents. The Playground can't call tools yet.` : `${name} works on its own, from ${source.title}. It doesn't take messages or files here.`;

	return (
		<div style={styles.page}>
			<AgentTile name={name} icon={agent.listing.icon} size="xl" />
			<h2 style={styles.name}>{name}</h2>
			<div style={styles.say}>{sentence}</div>

			<div style={styles.card}>
				<div style={styles.cardLabel}>What you can do</div>
				<div style={styles.row}>
					<span style={styles.rowTitle}>Read about it</span>
					<span style={styles.rowText}>What it does and how to reach it, from its publisher.</span>
					<Button variant="secondary" small onClick={onAbout}>
						About
					</Button>
				</div>
				{others.map((other) => (
					<div key={other.address} style={styles.row}>
						<span style={styles.rowTitle}>Use it another way</span>
						<span style={styles.rowText}>{other.typed && other.fileLanes.length === 0 ? `It also takes questions through ${other.name}.` : `It also takes files through ${other.name}.`}</span>
						<Button variant="primary" small onClick={() => onUseSource(other)}>
							Open
						</Button>
					</div>
				))}
				<div style={styles.row}>
					<span style={styles.rowTitle}>Choose another agent</span>
					<span style={styles.rowText}>Pick an agent you can talk to.</span>
					<Button variant="secondary" small onClick={onChooseAnother}>
						Choose
					</Button>
				</div>
			</div>

			{!simple && (
				<div style={styles.sources}>
					<Section label="Sources">
						{agent.sources.map((s) => (
							<LabelValue key={s.address} label={s.title}>
								{`${s.address} · ${s.kind === 'request' ? `request · ${s.entry}` : 'on its own'}${s.lanes.length ? ` · ${s.lanes.join(', ')}` : ''}`}
							</LabelValue>
						))}
					</Section>
				</div>
			)}
		</div>
	);
};
