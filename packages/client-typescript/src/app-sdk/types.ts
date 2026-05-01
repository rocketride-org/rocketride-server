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
// APP SDK TYPES
// Type definitions for the RocketRide app plugin system.
//
// These are copied from cloud-ui/src/workspace/types.ts so that third-party
// apps can import them from `rocketride/app-sdk` without depending on the
// cloud-ui package.  At runtime Module Federation replaces stub implementations
// with the real singletons from the shell host — no duplication occurs.
// =============================================================================

import type * as React from 'react';

// =============================================================================
// VIEW + DOCUMENT TYPES
// =============================================================================

/** State of a single open document tab. */
export interface DocumentState {
	id: string;
	filename: string;
	viewType: string;
	isDirty?: boolean;
	[key: string]: unknown;
}

/** Item shown in the sidebar item list. */
export interface ViewItem {
	id: string;
	label: string;
	icon?: React.ReactNode;
	[key: string]: unknown;
}

/** Props passed to every ShellViewDescriptor.render() call. */
export interface ShellViewRenderProps {
	/** The document this view is rendering. */
	document: DocumentState;
	/** Opaque app-specific context from AppDescriptor.appContext. */
	appContext: unknown;
}

/**
 * Descriptor that registers a viewType with the shell's rendering engine.
 *
 * Apps supply an array of these in `AppDescriptor.viewRegistry`.  When the
 * active view's viewType matches descriptor.viewType, the shell calls
 * descriptor.render(props) to produce the React node for that tab panel.
 */
export interface ShellViewDescriptor {
	viewType: string;
	render: (props: ShellViewRenderProps) => React.ReactNode;
	defaultLabel?: string;
	singleton?: boolean;
	hasDocument?: boolean;
	tabIcon?: React.ComponentType<{ size?: number }>;
	getTabLabel?: (doc: DocumentState) => string;
}

// =============================================================================
// SETTINGS
// =============================================================================

/**
 * Declares a single runtime configuration setting that an app requires.
 *
 * Shell collects settings from all loaded apps, deduplicates by key, and
 * exposes them in the Settings view backed by settings.json on disk.
 */
export interface AppSettingDefinition {
	key: string;
	label: string;
	description?: string;
	default?: string;
	required?: boolean;
}

// =============================================================================
// WORKSPACE PREFS
// =============================================================================

/** Persistent user preferences stored by the shell. */
export interface WorkspacePrefs {
	theme: string;
	[key: string]: unknown;
}

// =============================================================================
// MANIFEST
// =============================================================================

/** A single subscription plan offered for a paid app. */
export interface StripePlan {
	priceId: string;
	label: string;
	interval: 'month' | 'year';
	amount: string;
}

/**
 * Lightweight descriptor for an app always available in the shell manifest,
 * even before the bundle has been loaded.
 */
export interface AppManifestEntry {
	id: string;
	name: string;
	description?: string;
	icon?: string;
	readme?: string;
	categories?: string[];
	settings?: AppSettingDefinition[];
	stripeProductId?: string;
	/** Pricing tiers from the dynamic marketplace manifest. */
	stripePrices?: StripePlan[];
	load: () => Promise<AppDescriptor>;
}

// =============================================================================
// APP DESCRIPTOR
// =============================================================================

/** Branding tokens for a specific app shown in the shell. */
export interface ShellBrandingConfig {
	appName: string;
	logo?: React.ReactNode;
	logoCollapsed?: React.ReactNode;
	welcomeLogo?: React.ReactNode;
	welcomeTitle?: string;
	welcomeSubtitle?: string;
}

/**
 * Full descriptor contributed by each app plugin bundle.
 *
 * The shell stores one of these per app in WorkspaceContext.loadedApps once
 * the dynamic import triggered by AppManifestEntry.load() resolves.
 */
export interface AppDescriptor {
	id: string;
	name: string;
	icon?: React.ReactNode;
	branding: ShellBrandingConfig;
	SidebarContent: React.ComponentType<{ collapsed: boolean }>;
	viewRegistry: ShellViewDescriptor[];
	onSaveDocument?: (documentId: string) => Promise<void>;
	appContext?: unknown;
}

// =============================================================================
// SHELL CONFIG
// =============================================================================

/** A single theme option shown in the shell's theme picker. */
export interface ShellThemeOption {
	id: string;
	name: string;
}

/** Theme configuration supplied by the host (cloud) app. */
export interface ShellThemeConfig {
	options: ShellThemeOption[];
	onThemeChange?: (themeId: string) => void;
}

/**
 * Global configuration injected by the shell host.
 *
 * Accessed via useShellApiConfig() — values come from the server's .env
 * and are available to all app plugins without each app querying the server.
 */
export interface ShellApiConfig {
	[key: string]: string | undefined;
}

// =============================================================================
// WORKSPACE CONTEXT
// =============================================================================

/** Context object returned by useWorkspace(). */
export interface WorkspaceContext {
	prefs: WorkspacePrefs;
	apps: AppManifestEntry[];
	loadedApps: Map<string, AppDescriptor>;
	openDocument: (doc: Partial<DocumentState>) => void;
	closeDocument: (id: string) => void;
	updateDocument: (id: string, patch: Partial<DocumentState>) => void;
	[key: string]: unknown;
}
