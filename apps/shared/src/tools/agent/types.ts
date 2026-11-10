// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Sidebar types — shared between VS Code webview and rocket-ui hosts.
 *
 * The host builds a flat array of ProjectEntry (one per .pipe file) and
 * passes it into <SidebarMain>.  The component derives the directory
 * hierarchy on the fly via path parsing (S3-style).
 */



// =============================================================================
// TOOLS/AGENT — sidebar data types
// =============================================================================
//
// The Agent tool's session-list shapes (moved from modules/sidebar).


/**
 * One agent-session row of the MY SESSIONS list (mirrors the shared
 * AgentSessionMeta shape without importing the agent module — the sidebar
 * renders whatever rows the host supplies).
 */
export interface AgentSessionListItem {
	/** The session's GUID. */
	sessionId: string;
	/** Epoch-ms creation stamp (list is rendered newest-first). */
	date: number;
	/** Display title — the first user request, truncated. */
	title: string;
}

/**
 * Agent sidebar content. PRESENCE of this prop adds the `Agent` mode tab
 * (cloud hosts); hosts that omit it (VS Code) render exactly as before.
 */
export interface AgentSidebar {
	/** MY SESSIONS list, newest first. */
	sessions: AgentSessionListItem[];
	/** The session whose conversation tab is open/focused, if any. */
	activeSessionId?: string;
	/** Start a brand-new session (opens an empty conversation tab). */
	onNewSession: () => void;
	/** Open a session's conversation tab. */
	onOpenSession: (sessionId: string) => void;
	/** Delete a session (host confirms first). */
	onDeleteSession: (sessionId: string) => void;
}

