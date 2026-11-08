import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConnectionManager } from 'shell';
import { getCheckoutScope, matchesCheckoutScope, sameCheckoutScope } from 'shell/src/connection/checkoutScope';
import type { CheckoutScope } from 'shell/src/connection/checkoutScope';
import type { StripeKeyState } from './useStripeKey';

interface CheckoutSession {
	id: number;
	scope: CheckoutScope;
}

export function useCheckoutSession(stripe: StripeKeyState) {
	const cm = ConnectionManager.getInstance();
	const [checkout, setCheckout] = useState<CheckoutSession | null>(null);
	const [liveReplaySupported, setLiveReplaySupported] = useState(false);
	const active = useRef<CheckoutSession | null>(null);
	const sequence = useRef(0);
	const lastKey = useRef<{ checkout: CheckoutSession; key: string } | null>(null);

	const closeCheckout = useCallback((expected?: CheckoutSession) => {
		if (expected && active.current !== expected) return;
		active.current = null;
		lastKey.current = null;
		setCheckout(null);
	}, []);
	const openCheckout = useCallback(() => {
		const scope = getCheckoutScope(cm.getClient());
		if (!cm.isConnected() || !scope) return;
		if (active.current && sameCheckoutScope(scope, active.current.scope)) return;
		const next = { id: ++sequence.current, scope };
		active.current = next;
		setLiveReplaySupported(scope.replaySupported);
		setCheckout(next);
	}, [cm]);
	const isCurrent = useCallback((expected: CheckoutSession) => active.current === expected && cm.isConnected() &&
		matchesCheckoutScope(getCheckoutScope(cm.getClient()), expected.scope), [cm]);

	useEffect(() => {
		const checkScope = () => {
			const scope = getCheckoutScope(cm.getClient());
			if (active.current && scope && !sameCheckoutScope(scope, active.current.scope)) closeCheckout();
			else if (scope) setLiveReplaySupported(scope.replaySupported);
		};
		const off = [
			cm.on('shell:accountUpdate', checkScope),
			cm.on('shell:statusChange', checkScope),
			cm.on('shell:workspaceWillChange', () => closeCheckout()),
		];
		return () => off.forEach((unsubscribe) => unsubscribe());
	}, [cm, closeCheckout]);

	const matchingKey = checkout && stripe.server === checkout.scope.server ? stripe.key : '';
	useLayoutEffect(() => {
		if (checkout && matchingKey && isCurrent(checkout)) lastKey.current = { checkout, key: matchingKey };
	}, [checkout, matchingKey, isCurrent]);

	// A transient disconnect clears useStripeKey. Keep the mounted attempt
	// and its original key until this checkout's verified scope changes.
	const checkoutStripeKey = lastKey.current?.checkout === checkout ? lastKey.current.key : matchingKey;
	const replaySupported = checkout?.scope.replaySupported === true && liveReplaySupported;
	return { checkout, checkoutStripeKey, openCheckout, closeCheckout, isCurrent, replaySupported };
}
