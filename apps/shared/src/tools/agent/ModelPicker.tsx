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
// MODEL PICKER — the conversation's model, beside the composer
// =============================================================================

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { Check, ChevronDown, TriangleAlert } from 'lucide-react';
import { AnchoredPopup, Button, commonStyles, PopupRow, ToggleGroup, useLatest } from 'shell';
import type { AgentSession } from '../../modules/agent/agent';
import type { ProviderId, ProviderOffer } from '../../modules/agent/model';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	anchor: { flexShrink: 0 },
	label: { ...commonStyles.textEllipsis, maxWidth: 160 },
	warning: { flexShrink: 0, color: 'var(--rr-color-warning)' },
	popup: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		width: 320,
		padding: 8,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
	},
	check: { display: 'flex', flexShrink: 0, width: 14 },
	title: { ...commonStyles.textEllipsis, flex: 1, minWidth: 0 },
	status: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--rr-text-secondary)' },
};

// =============================================================================
// COMPONENT
// =============================================================================

export interface ModelPickerProps {
	session: AgentSession;
	/** A turn is running: its model is held, so the next one must be picked after it. */
	disabled: boolean;
	offers: () => Promise<ProviderOffer[]>;
	/** Offers are read on mount, on each open, and when this changes, so a fixed key clears the warning. */
	refreshKey: unknown;
	onOpenVariables: () => void;
}

/**
 * The conversation's model: a ghost button showing its title (its id until the offers are read), with a
 * warning mark when its key is missing. The popup's toggle only changes the list; choosing a row picks.
 */
export const ModelPicker: React.FC<ModelPickerProps> = ({ session, disabled, offers, refreshKey, onOpenVariables }) => {
	const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
	const model = useSyncExternalStore(subscribe, () => session.model);
	const [offered, setOffered] = useState<readonly ProviderOffer[] | null>(null);
	const [open, setOpen] = useState(false);
	const [viewed, setViewed] = useState<ProviderId>(model.provider);
	const anchorRef = useRef<HTMLDivElement>(null);

	// step: only the newest read lands, so a slow old one cannot bring back a warning the user fixed
	const readOffers = useLatest(offers);
	const newestRead = useRef(0);
	const read = useCallback(() => {
		const id = ++newestRead.current;
		readOffers.current().then(
			(next) => {
				if (newestRead.current === id) setOffered(next);
			},
			(err: unknown) => console.log('[ModelPicker] could not read the models', err)
		);
	}, [readOffers]);
	useEffect(read, [read, refreshKey]);

	// step: a turn that starts while the popup is open closes it, so it does not come back when the turn ends
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	const toggle = (): void => {
		if (!open) {
			setViewed(model.provider);
			read();
		}
		setOpen(!open);
	};

	const current = offered?.find((offer) => offer.provider === model.provider);
	const title = current?.models.find((offer) => offer.model === model.model)?.title ?? model.model;
	const keyMissing = current?.key === 'missing';
	const listed = offered?.find((offer) => offer.provider === viewed) ?? offered?.[0];

	return (
		<div ref={anchorRef} style={styles.anchor}>
			<Button variant="ghost" small disabled={disabled} ariaExpanded={open} title={keyMissing ? `Requires your ${current.title} key` : 'The model this chat uses'} onClick={toggle}>
				{keyMissing && <TriangleAlert size={12} style={styles.warning} />}
				<span style={styles.label}>{title}</span>
				<ChevronDown size={12} />
			</Button>
			<AnchoredPopup anchorRef={anchorRef} open={open && !disabled} onClose={() => setOpen(false)} placement="above" style={styles.popup}>
				{!listed && <div style={styles.status}>{offered ? 'The model list could not be read.' : 'Reading the models…'}</div>}
				{offered && listed && (
					<>
						<ToggleGroup options={offered.map((offer) => ({ id: offer.provider, label: offer.title }))} value={listed.provider} onChange={setViewed} />
						<div>
							{listed.models.map((offer) => {
								const chosen = listed.provider === model.provider && offer.model === model.model;
								return (
									<PopupRow
										key={offer.model}
										onClick={() => {
											session.setModel({ provider: listed.provider, model: offer.model });
											setOpen(false);
										}}
									>
										<span style={styles.check}>{chosen && <Check size={14} />}</span>
										<span style={styles.title}>{offer.title}</span>
									</PopupRow>
								);
							})}
						</div>
						{listed.key === 'set' && <div style={styles.status}>Uses your {listed.title} key</div>}
						{listed.key === 'missing' && (
							<div style={styles.status}>
								<TriangleAlert size={12} style={styles.warning} />
								Requires your {listed.title} key
								<Button
									variant="ghost"
									small
									onClick={() => {
										setOpen(false);
										onOpenVariables();
									}}
								>
									Open Variables
								</Button>
							</div>
						)}
					</>
				)}
			</AnchoredPopup>
		</div>
	);
};
