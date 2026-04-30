// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * BillingWebview — VS Code webview bridge for billing management.
 *
 * Receives messages from the extension host via useMessaging, manages local
 * state, and renders <BillingView> with props. User actions flow back as
 * messages to the extension host.
 *
 * Architecture:
 *   PageBillingProvider (Node.js) <-> postMessage <-> BillingWebview (browser) -> BillingView (pure UI)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

import { applyTheme } from 'shared/themes';
import { BillingView } from 'shared';
import type { BillingDetail, CreditBalance, CreditPack } from 'shared';
import { useMessaging } from '../hooks/useMessaging';

// =============================================================================
// MESSAGE TYPES
// =============================================================================

/** Messages the extension host sends to the billing webview. */
type BillingHostToWebview =
	| { type: 'shell:init'; theme: Record<string, string>; isConnected: boolean }
	| { type: 'shell:themeChange'; tokens: Record<string, string> }
	| { type: 'shell:connectionChange'; isConnected: boolean }
	| {
			type: 'billing:data';
			subscriptions: BillingDetail[];
			creditBalance: CreditBalance | null;
			creditPacks: CreditPack[];
			loading: boolean;
			error: string | null;
	  };

/** Messages the billing webview sends to the extension host. */
type BillingWebviewToHost = { type: 'view:ready' } | { type: 'view:initialized' } | { type: 'billing:cancel'; appId: string } | { type: 'billing:portal' } | { type: 'billing:buyCredits'; packId: string } | { type: 'billing:refresh' };

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Bridge component that converts postMessage-based communication into
 * React props for the host-agnostic BillingView.
 */
const BillingWebview: React.FC = () => {
	// --- State (populated from host messages) ---------------------------------

	const [subscriptions, setSubscriptions] = useState<BillingDetail[]>([]);
	const [creditBalance, setCreditBalance] = useState<CreditBalance | null>(null);
	const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [isConnected, setIsConnected] = useState(false);

	const sendMessageRef = useRef<(msg: BillingWebviewToHost) => void>(() => {});

	// --- Messaging ------------------------------------------------------------

	/** Handles incoming messages from the extension host. */
	const handleMessage = useCallback((message: BillingHostToWebview) => {
		switch (message.type) {
			case 'shell:init':
				// Apply initial theme and connection state
				if (message.theme) applyTheme(message.theme);
				setIsConnected(message.isConnected);
				sendMessageRef.current({ type: 'view:initialized' });
				break;

			case 'shell:themeChange':
				applyTheme(message.tokens);
				break;

			case 'shell:connectionChange':
				// Update connection state when the host connection changes
				setIsConnected(message.isConnected);
				break;

			case 'billing:data':
				// Update all billing state from the host's fetched data
				setSubscriptions(message.subscriptions);
				setCreditBalance(message.creditBalance);
				setCreditPacks(message.creditPacks);
				setLoading(message.loading);
				setError(message.error);
				break;
		}
	}, []);

	const { sendMessage } = useMessaging<BillingWebviewToHost, BillingHostToWebview>({
		onMessage: handleMessage,
	});

	useEffect(() => {
		sendMessageRef.current = sendMessage;
	}, [sendMessage]);

	// --- Callbacks -> outgoing messages ---------------------------------------

	/**
	 * Sends a cancel subscription request to the extension host.
	 *
	 * @param appId - The app whose subscription to cancel.
	 */
	const handleCancelSubscription = useCallback(
		async (appId: string) => {
			sendMessage({ type: 'billing:cancel', appId });
		},
		[sendMessage]
	);

	/**
	 * Sends an open-portal request to the extension host, which opens
	 * the Stripe customer portal in the user's browser.
	 */
	const handleOpenPortal = useCallback(async () => {
		sendMessage({ type: 'billing:portal' });
	}, [sendMessage]);

	/**
	 * Sends a buy-credits request to the extension host, which opens
	 * the Stripe checkout URL in the user's browser.
	 *
	 * @param pack - The credit pack to purchase.
	 */
	const handleBuyCredits = useCallback(
		async (pack: CreditPack) => {
			sendMessage({ type: 'billing:buyCredits', packId: pack.packId });
		},
		[sendMessage]
	);

	// --- Render --------------------------------------------------------------

	return <BillingView isConnected={isConnected} subscriptions={subscriptions} loading={loading} error={error} creditBalance={creditBalance} creditPacks={creditPacks} onCancelSubscription={handleCancelSubscription} onOpenPortal={handleOpenPortal} onBuyCredits={handleBuyCredits} />;
};

export default BillingWebview;
