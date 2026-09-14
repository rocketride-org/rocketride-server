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
// USE SESSION LIST — the caller's rocket-agent sessions, newest activity first
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { agentApi } from '../services/agentApi';
import type { AgentSessionRecord } from '../services/agentTypes';

/** Return shape of {@link useSessionList}. */
export interface UseSessionListResult {
	sessions: AgentSessionRecord[];
	loading: boolean;
	error: string | null;
	/** Force an immediate re-fetch (owner-scoped list). */
	refresh: () => void;
}

/**
 * Fetch the caller's rocket-agent sessions, sorted by most recent activity.
 *
 * @returns Sessions, loading/error state, and a manual refresh.
 */
export function useSessionList(): UseSessionListResult {
	const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(() => {
		agentApi
			.list()
			.then((s) => {
				setSessions([...s].sort((a, b) => b.lastActivity - a.lastActivity));
				setError(null);
			})
			.catch((e: Error) => setError(e.message))
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	return { sessions, loading, error, refresh };
}
