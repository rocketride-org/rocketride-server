// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Runs asynchronous jobs one at a time, in the order they were added.
 *
 * The sidebar's `.pipe` watcher puts created files through one (issue
 * #2466): each created-file handler judges its file against the parsed-file
 * cache and adds its file to the cache afterwards, so two handlers running
 * side by side both see a cache without the other's file, and a project_id
 * the two files share goes unreported. Queued, the second runs against the
 * cache the first left behind.
 *
 * Kept free of `vscode` so it can be asserted directly (see serialQueue.test.ts).
 */
export class SerialQueue {
	/** Settles once the most recently added job has finished, one way or the other. */
	private tail: Promise<void> = Promise.resolve();

	/**
	 * Adds `job` to the end of the queue. It starts once every job added
	 * before it has settled, and the returned promise settles the way the job
	 * did. A job that throws or rejects does not stop the queue: the next job
	 * runs regardless, and only the returned promise carries the failure.
	 *
	 * A job must never await a job it enqueues on the same queue: the new job
	 * waits for the running one to settle, which is waiting for it. Deadlock.
	 */
	enqueue<T>(job: () => Promise<T> | T): Promise<T> {
		const run = this.tail.then(job);
		// `run.then(noop, noop)` attaches a rejection handler to `run`, so a
		// caller that drops the returned promise loses the failure silently: no
		// unhandledRejection is raised. Handle it on the returned promise.
		this.tail = run.then(noop, noop);
		return run;
	}
}

function noop(): void {}
