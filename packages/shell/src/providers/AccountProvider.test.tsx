// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RocketRideClient, type BillingDetail, type ConnectResult, type CreditBalance } from 'rocketride';
import { ConnectionManager } from '../connection/connection';
import { ShellIdentityContext } from '../hooks/useAuthUser';
import type { IAccountViewProps } from '../modules/account/AccountView';

function identity(orgId: string): ConnectResult {
	return {
		userToken: 'rr_test-token',
		userId: 'test-user',
		displayName: 'Test User',
		givenName: 'Test',
		familyName: 'User',
		preferredUsername: 'test-user',
		email: 'test@example.invalid',
		emailVerified: true,
		phoneNumber: '',
		phoneNumberVerified: false,
		locale: 'en-US',
		devTeam: '',
		organization: { id: orgId, name: orgId, permissions: [], teams: [] },
		apps: [],
		capabilities: [],
	};
}

function subscription(orgId: string): BillingDetail {
	return {
		appId: 'test-app',
		stripeSubscriptionId: `sub_${orgId}`,
		stripePriceId: `price_${orgId}`,
		status: 'active',
		planNickname: null,
		unitAmount: null,
		billingInterval: null,
		currentPeriodStart: null,
		currentPeriodEnd: null,
		cancelAtPeriodEnd: false,
		credits: null,
		labels: null,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

test('billing details and dashboard remain workspace-scoped during an A to B to A switch', async (t) => {
	const dom = new JSDOM('<div id="app"></div>', { url: 'https://shell.example.invalid' });
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		localStorage: dom.window.localStorage,
		sessionStorage: dom.window.sessionStorage,
		IS_REACT_ACT_ENVIRONMENT: true,
	});

	// Observe what the provider renders without loading the billing screen and its grids.
	let view: IAccountViewProps | undefined;
	const readView = () => {
		assert.ok(view);
		return view;
	};
	const viewPath = require.resolve('../modules/account/AccountView');
	const originalView = require.cache[viewPath];
	const viewModule = new Module(viewPath);
	viewModule.loaded = true;
	viewModule.exports = (props: IAccountViewProps) => { view = props; return null; };
	require.cache[viewPath] = viewModule;
	let AccountProvider: typeof import('./AccountProvider').default;
	try {
		AccountProvider = require('./AccountProvider').default;
	} finally {
		if (originalView) require.cache[viewPath] = originalView;
		else delete require.cache[viewPath];
	}

	t.mock.method(RocketRideClient.prototype, 'attach', async () => {});
	const manager = ConnectionManager.getInstance();
	manager.initialize({ uri: 'https://server.example.invalid' });
	const client = manager.getClient();
	assert.ok(client);

	let sequence = 0;
	const sendIdentity = (orgId: string) => client.onEvent({
		type: 'event', seq: ++sequence, event: 'apaext_account', body: { ...identity(orgId) },
	});
	t.mock.method(client, 'login', async () => {
		await sendIdentity('a');
		return identity('a');
	});
	t.mock.method(client, 'isConnected', () => true);
	t.mock.method(client, 'disconnect', async () => {});
	t.mock.method(client, 'getServices', async () => ({ services: {} }));
	t.mock.method(client, 'addMonitor', async () => {});
	t.mock.method(client, 'removeMonitor', async () => {});
	t.mock.method(client.account, 'getProfile', async () => client.getAccountInfo());

	const aBalance: CreditBalance = { balances: { runs: 20 }, granted: {}, consumed: {}, labels: {} };
	const bBalance: CreditBalance = { balances: { runs: 30 }, granted: {}, consumed: {}, labels: {} };
	const aTransactions = { transactions: [], total: 0, page: 1, pageSize: 20 };
	const aUsage = [{ id: 'a-only', credits: { runs: 7 } }];
	const heldBBalance = deferred<CreditBalance>();
	const heldADetails = deferred<BillingDetail[]>();
	const aRow = subscription('a');
	const bRow = subscription('b');
	const getDetails = t.mock.method(client.billing, 'getDetails', async () => [aRow]);
	t.mock.method(client.billing, 'getCreditBalance', (orgId: string) => (
		orgId === 'a' ? Promise.resolve(aBalance) : heldBBalance.promise
	));
	t.mock.method(client.billing, 'getProductPrices', async () => []);
	t.mock.method(client.billing, 'getTransactions', async (orgId: string) => (
		orgId === 'a' ? aTransactions : { transactions: [], total: 0, page: 1, pageSize: 20 }
	));
	t.mock.method(client.billing, 'getUsageByUser', async (orgId: string) => orgId === 'a' ? aUsage : []);
	t.mock.method(client.billing, 'getUsageByTeam', async (orgId: string) => orgId === 'a' ? aUsage : []);

	await manager.connect('rr_test-token');
	const container = document.getElementById('app');
	assert.ok(container);
	const root = createRoot(container);
	try {
		await act(async () => root.render(
			<ShellIdentityContext.Provider value={identity('a')}>
				<AccountProvider embeddedSection="billing" />
			</ShellIdentityContext.Provider>,
		));
		assert.deepEqual(readView().subscriptions, [aRow]);
		assert.equal(readView().creditBalance, aBalance);

		getDetails.mock.mockImplementation((orgId: string) => (
			orgId === 'a' ? heldADetails.promise : Promise.resolve([bRow])
		));

		// Keep the provider mounted as Shell changes the current identity on inbound account events.
		const switchTo = (orgId: string) => act(async () => {
			await sendIdentity(orgId);
			root.render(
				<ShellIdentityContext.Provider value={manager.getAccountInfo() ?? null}>
					<AccountProvider embeddedSection="billing" />
				</ShellIdentityContext.Provider>,
			);
		});
		await switchTo('b');
		const waitingForBBalance = readView();
		assert.equal(waitingForBBalance.authUser?.organization?.id, 'b');

		await switchTo('a');
		const waitingForADetails = readView();
		assert.equal(waitingForADetails.authUser?.organization?.id, 'a');
		assert.deepEqual(waitingForADetails.subscriptions, []);
		assert.equal(waitingForADetails.onPreviewSubscriptionChange, undefined);

		assert.deepEqual(waitingForBBalance.subscriptions, [bRow]);
		assert.equal(waitingForBBalance.billingLoading, false);
		assert.equal(waitingForBBalance.creditBalance, null);
		assert.equal(waitingForBBalance.transactions, null);
		assert.deepEqual(waitingForBBalance.usageByUser, []);
		assert.deepEqual(waitingForBBalance.usageByTeam, []);

		await act(async () => heldADetails.resolve([aRow]));
		assert.deepEqual(readView().subscriptions, [aRow]);
		await act(async () => heldBBalance.resolve(bBalance));
		assert.deepEqual(readView().subscriptions, [aRow]);
		assert.equal(readView().creditBalance, aBalance);
	} finally {
		await act(async () => {
			heldADetails.resolve([aRow]);
			heldBBalance.resolve(bBalance);
			root.unmount();
		});
		await manager.disconnect();
		dom.window.close();
	}
});
