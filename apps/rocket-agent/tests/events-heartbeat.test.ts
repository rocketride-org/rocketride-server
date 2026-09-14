import { startHeartbeat } from '../src/sse';

// Heartbeat interval must be well under the 350s NLB idle timeout AND under
// common intermediary timeouts (60s). 25s gives ~14 frames per NLB window.
describe('SSE heartbeat', () => {
	it('writes a comment frame every 25s while the stream is open', () => {
		jest.useFakeTimers();
		const written: string[] = [];
		const res = {
			writeHead: () => {},
			write: (s: string) => { written.push(s); return true; },
			on: () => {},
		} as unknown as import('express').Response;

		const stop = startHeartbeat(res);

		jest.advanceTimersByTime(25_000);
		expect(written.filter((w) => w === ': ping\n\n')).toHaveLength(1);

		jest.advanceTimersByTime(50_000);
		expect(written.filter((w) => w === ': ping\n\n')).toHaveLength(3);

		stop();
		jest.advanceTimersByTime(100_000);
		expect(written.filter((w) => w === ': ping\n\n')).toHaveLength(3);

		jest.useRealTimers();
	});
});
