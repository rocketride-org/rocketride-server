/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Stand-in for the builder's run button, node status and node menu (see
 * resolve.ts). A read-only canvas has nothing to run, no task status and
 * no node actions, so each of them renders nothing.
 */
export default function RenderNothing(): null {
	return null;
}
