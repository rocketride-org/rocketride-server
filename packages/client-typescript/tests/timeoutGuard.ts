export function makeTimeoutRejector(
	ms: number,
	context: string
): { promise: Promise<void>; clear: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<void>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${context} timeout ${ms}ms`)), ms);
	});
	return {
		promise,
		clear: () => {
			if (timer !== undefined) clearTimeout(timer);
		},
	};
}

export async function withTimeoutGuard<T>(
	operation: Promise<T>,
	ms: number,
	context: string
): Promise<T> {
	const guard = makeTimeoutRejector(ms, context);
	try {
		return await Promise.race([operation, guard.promise]);
	} finally {
		guard.clear();
	}
}
