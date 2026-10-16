/**
 * A server rejection keeps its machine-readable code through `client.call()`.
 *
 * The spend gate answers a refused `execute` with `code: OUT_OF_CREDITS`; the
 * SDK must hand that to the caller as an exception field, not bury it in prose.
 */

import { RocketRideClient } from '../src/client/client';
import { ExecutionException } from '../src/client/exceptions';

/** A client stub: enough surface for call(), no transport. */
function stubClient(response: Record<string, unknown>): RocketRideClient {
	return {
		buildRequest: (command: string, extra: Record<string, unknown>) => ({ command, ...extra }),
		request: async () => ({ type: 'response', seq: 1, command: 'execute', ...response }),
	} as unknown as RocketRideClient;
}

const call = RocketRideClient.prototype.call;

describe('client.call() on a server rejection', () => {
	it('keeps the server code on an ExecutionException that is still an Error', async () => {
		const client = stubClient({ success: false, message: 'Out of credits', code: 'OUT_OF_CREDITS' });
		const err = await call.call(client, 'execute', {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ExecutionException);
		expect(err).toBeInstanceOf(Error);
		expect((err as ExecutionException).code).toBe('OUT_OF_CREDITS');
		expect((err as Error).message).toBe('Out of credits');
	});

	it('names the command when the server sent no message', async () => {
		const client = stubClient({ success: false });
		const err = await call.call(client, 'execute').catch((e: unknown) => e);
		expect((err as Error).message).toBe('execute failed');
		expect((err as ExecutionException).code).toBeUndefined();
	});
});
