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

// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient globals must load via reference; an import would scope them to this module
/// <reference path="./types/global.d.ts" />
//
// The reference above pulls the shell's ambient module declarations (the
// `import.meta.webpackContext` typing, asset imports) into the program when
// `./builder shell:freeze` bundles this entry with dts-bundle-generator, which
// builds its program from this file's import graph and does NOT read the
// tsconfig `files` array. Without it, transitively-reached shell modules
// fail to compile during generation.

// =============================================================================
// shell — curated app-facing API surface (contract entry)
// =============================================================================
//
// This module is the SINGLE curated surface that Module Federation remote apps
// consume from shell. Per the design-owner decision the contract covers
// shell's ENTIRE public export surface (not just the currently-consumed
// subset): every value symbol is gathered into one `shellApi` object and every
// standalone type is named via explicit type re-exports.
//
// `./builder shell:freeze` bundles this file into a frozen, versioned `.d.ts`
// (packages/shell/contract/versions/vN.d.ts). `ShellApiShape` is the compile-time
// contract; breaking it must break shell's own `tsc`. Do NOT narrow this
// surface without a freeze — removing a member is a breaking change.
// =============================================================================

// =============================================================================
// VALUE IMPORTS — hooks, client access, classes, components, icons
// =============================================================================

// Theme styles FIRST — a leaf module (no imports back into this graph) that
// MUST initialize before any shared module below re-enters this barrel:
// shared modules spread commonStyles into top-level style consts at module
// init, so in the shell⇄shared import cycle this binding has to be live
// before the first 'shared/*' import statement evaluates.
import { commonStyles } from './themes/styles';

// Hooks
import { useShellConnection } from './connection/ConnectionContext';
import { useAuthUser, useLogout } from './hooks/useAuthUser';
import { useWorkspace } from './components/workspace/WorkspaceContext';
import { useClient } from './hooks/useClient';
import { useShellEvent } from './hooks/useShellEvent';
import { useSubscriptions } from './hooks/useSubscriptions';
import { usePolling } from './hooks/usePolling';
import { useDashboardData } from './hooks/useDashboardData';
import { useConnectionStatus } from './hooks/useConnectionStatus';
import { useShellApiConfig } from './connection/ShellApiConfigContext';
import { useIframeBridge } from './hooks/useIframeBridge';
import { useAppComponent } from './hooks/useAppComponent';

// Shared hooks re-exported through shell for app convenience
import { useClickOutside } from './hooks/useClickOutside';
import { useLatest } from './hooks/useLatest';
import { useFixedPopupPosition } from './hooks/useFixedPopupPosition';

// Non-React client access + connection manager singleton
import { getClient } from './util/getClient';
import { ConnectionManager } from './connection/connection';

// Connection state enum (re-exported from shared)
import { ConnectionState } from './types/connection';

// Workspace-preferences accessor + provider (re-exported from shared) — the ONE
// prefs API every app and shared surface reads/writes through (get/set a key
// in the app's workspace prefs bag). shared sits below shell, so the
// implementation lives there; the shell surfaces it here as the frozen contract.
import { usePrefs, PrefsProvider } from './components/contexts/PrefsContext';

// Tool framework values — imported here so the shellApi aggregator can carry
// them as lazy getters (the freeze fingerprints VALUE names off shellApi's
// members; a standalone re-export is invisible to it).
import { createToolChannel, asToolStateMessage, asToolEventMessage } from './components/workspace/toolChannel';
import { createToolController, createToolOpServer, asToolCallMessage, asToolReplyMessage, DEFAULT_OP_TIMEOUT_MS } from './components/workspace/toolOps';
import { typedToolChannel, useToolState, useConnectionReady, publishHostConnectionState, HOST_CONNECTION_TOPIC } from './components/workspace/toolProtocol';
import { typedPrefs, scopedPrefs, createBridgedPrefsStore, usePref } from './components/workspace/prefsStore';
import { ToolHostProvider, useToolHost, createLoopbackPeer } from './components/workspace/toolHost';
import { createOpBus, typedBusOps, registerOpHandlers, BusNoHandlerError, DEFAULT_BUS_REQUEST_TIMEOUT_MS } from './ops/busOps';
import { attachRealmToRoot, createBusRouter, createLocalEndpointPair, DEFAULT_SUMMON_TIMEOUT_MS } from './ops/busBridge';
import { createRetainedRegistry, localRetainedPort } from './ops/retained';
import { registerClientOps } from './ops/clientOps';
import { useGridConfigAnswering } from './components/data-grid/gridConfigAnswering';
import { hostConnectionPayload, TOOL_RELAY_BUFFER_LIMIT } from './components/workspace/toolRelay';
import { createSidebarBusPeer, createFrameBusPeer } from './components/workspace/busPeer';
import { toolDocUri, parseToolDocUri, activeDocKeyFor, TOOL_DOC_PREFIX } from './components/workspace/toolDocUri';

// Auth providers
import { CloudAuthProvider } from './auth/CloudAuthProvider';
import { ApiKeyAuthProvider } from './auth/ApiKeyAuthProvider';

// Workspace provider
import { WorkspaceProvider } from './components/workspace/WorkspaceContext';

// Document component library
import { Documents } from './components/docs/Documents';
// The no-op virtual filesystem — Documents' companion for apps that mount
// document workspaces without a backing store (demonstrated third-party
// need; entered the surface via the graduation pipeline).
import { NOOP_VFS, Explorer, CachedVfs } from './modules/explorer';
// The caching VFS decorator's standalone types (entry inventory + overlay
// producer contract) — append-only additions alongside IVirtualFileSystem.
export type { VfsEntry, VfsOverlay, CachedVfsOptions } from './modules/explorer';
// Explorer's contract types under their NATIVE names (the Doc* aliases the
// document system exports remain; both names refer to the same types —
// append-only). Standalone apps cannot bundle the library, so a
// demonstrated third-party file-tree need graduates the component itself.
export type { IExplorerProps, ExplorerEntry, ExplorerChild, ExplorerConfig, ExplorerStatus, ExplorerFileAction } from './modules/explorer';
import DocTabs from './components/docs/DocTabs';
import DocSplitLayout from './components/docs/DocSplitLayout';
import { DocExplorer } from './components/docs/DocExplorer';

// Top-level shell frame + zone components
import Shell from './components/layout/Shell';
import Sidebar from './components/layout/Sidebar';
import BottomPanel from './components/layout/BottomPanel';
import DebugPanel from './components/layout/DebugPanel';

// The one app-root layout — apps render it as the root of their `app` mount
// and declare their layout with props (sidebar, showStatus, status).
import { AppLayout } from './components/layout/AppLayout';
export type { AppLayoutProps } from './components/layout/AppLayout';

// Layout building blocks
import { NavButton } from './components/layout/Sidebar';
// The SURFACE ConfirmDialog is the stock modal one (richer: ReactNode
// message, destructive, confirmDisabled) — the layout-local dialog stays
// shell-internal chrome.
import { ConfirmDialog } from './components/modal/ConfirmDialog';
import { showConfirmDialog } from './components/modal/confirmService';
import { PopupRow } from './components/PopupRow';
import { AnchoredPopup } from './components/AnchoredPopup';

// Shell-owned overlay pages
import AccountProvider from './providers/AccountProvider';
import SettingsProvider from './providers/SettingsProvider';
import { CheckoutFlow } from './components/layout/CheckoutFlow';

// Icons — a DELIBERATE subset of ./icons/BoxIcon: only the glyphs shell chrome
// itself renders are part of the frozen contract. Apps needing other icons take
// them from the shared library (the full set); every name
// added here is frozen forever, so the surface grows only on demonstrated need.
import { BxPlus, BxEditAlt, BxTrash, BxDesktop, BxGridAlt, BxCog, BxListUl, BxStop, BxPlay, BxHome, BxNote, BxComponent, BxUser, BxRocket, BxLockOpen, BxPurchaseTag, BxChevronRight, BxFolderOpen } from './components/BoxIcon';

// =============================================================================
// TYPE RE-EXPORTS — standalone types apps import from 'shell'
// =============================================================================
//
// These have no corresponding runtime value in `shellApi`, so they are named
// in the frozen bundle via explicit type re-exports. The prop/return types of
// the value symbols above are captured structurally through `ShellApiShape`.
//
// Known gaps queued for the NEXT freeze (adding a name here is an actionable
// contract change, so they ride the already-planned v3 re-freeze rather than
// minting a version alone): BottomPanelProps, IUsePollingOptions. Until then
// both are reachable structurally via the BottomPanel / usePolling values.
// =============================================================================

// Shell component prop contracts + workspace/config types
export type { ShellAppProps, AppDescriptor, DevToolProps, AppManifestEntry, ShellConfig, ShellApiConfig, WorkspacePrefs, WorkspaceState, AppWorkspaceState, SettingValue, SettingSchema, AppConfiguration, ShellBrandingConfig, ShellThemeConfig, ShellThemeOption, ShellAccountConfig } from './components/workspace/types';

// Tool channel — the typed state/event surface between a tool's controller
// (devToolSidebar) and its document views (devToolFrame). Hosts construct it
// over the peer transport; tools receive it as DevToolProps.channel.
export { createToolChannel, asToolStateMessage, asToolEventMessage } from './components/workspace/toolChannel';
export type { ToolChannel, ToolChannelUnsubscribe, IToolStateMessage, IToolEventMessage } from './components/workspace/toolChannel';

// Tool protocol — typed protocol maps over the tool channel (the ShellEventMap
// pattern per tool): the host-owned base state map (`host:*` reserved), each
// tool's private extension, the typed channel view, and the hooks tools read
// system topics with.
export { typedToolChannel, useToolState, useConnectionReady, publishHostConnectionState, HOST_CONNECTION_TOPIC } from './components/workspace/toolProtocol';
export type { ToolStateMap, ToolEventMap, TypedToolChannel, IHostConnectionState } from './components/workspace/toolProtocol';

// Tool ops — the correlated request/reply lane between a tool's frames and
// its sidebar controller, typed by the tool's op map. The call/reply wire
// guards are for host relays (calls are never retained, replies never
// buffered or summoning).
export { createToolController, createToolOpServer, asToolCallMessage, asToolReplyMessage, DEFAULT_OP_TIMEOUT_MS } from './components/workspace/toolOps';
export type { ToolOpMap, ToolOpSpec, ToolOpParams, ToolOpResult, ToolControllerFn, IToolOpServer, IToolCallOptions, IToolCallMessage, IToolReplyMessage } from './components/workspace/toolOps';

// Workspace prefs store — the host framework's persisted-preference seam:
// the shell types its SYSTEM partition (ShellPrefsMap); each app privately
// types its own keys and receives a pre-scoped partition (scopedPrefs) —
// isolation by construction, no shared flat bag.
export { useLatest } from './hooks/useLatest';
// The shell's own confirmation dialog — realm UI, usable by any tool
// without a host capability (ToolHostServices.confirm is deprecated).
export { showConfirmDialog } from './components/modal/confirmService';
export { typedPrefs, scopedPrefs, createBridgedPrefsStore, usePref } from './components/workspace/prefsStore';
export { useGridConfigAnswering } from './components/data-grid/gridConfigAnswering';
export type { PrefScope, PrefsStore, ShellPrefsMap, TypedPrefsStore } from './components/workspace/prefsStore';

// Tool host — host-wide capabilities beside the per-mount DevToolProps:
// provided once per realm, read by tools, absent capabilities degrade
// (and FAIL SAFE). In-repo builtins extend ToolHostServices privately in
// apps/shared, the same pattern as the protocol maps.
export { ToolHostProvider, useToolHost, createLoopbackPeer } from './components/workspace/toolHost';
export type { ToolHostServices, ToolWorkspaceFs } from './components/workspace/toolHost';

// Tool relay — the ONE relay policy between a tool's two mounts (hosts wire
// transport + scheduling; the relay decides retention/buffering/summon).
export { hostConnectionPayload, TOOL_RELAY_BUFFER_LIMIT } from './components/workspace/toolRelay';
export { createSidebarBusPeer, createFrameBusPeer } from './components/workspace/busPeer';

// Tool document URIs — the `tool:<appId>[/<docKey>]` convention, spelled once.
export { toolDocUri, parseToolDocUri, activeDocKeyFor, TOOL_DOC_PREFIX } from './components/workspace/toolDocUri';

// Shell bus OPS — the addressed-operation lane (request/handle/emitOp) and
// its cross-realm plumbing: hub-and-spoke with the framework root as the
// router; hosts supply only transport endpoints. Registration is the
// allowlist is the routing entry; summon wakes installed-but-dormant
// owners and never installs.
export { createOpBus, typedBusOps, registerOpHandlers, BusNoHandlerError, DEFAULT_BUS_REQUEST_TIMEOUT_MS } from './ops/busOps';
export type { ShellOpMap, ShellOpSpec, ShellOpParams, ShellOpResult, IOpBus, IBusForwarder, IBusRequestOptions, ITypedBusOps, BusOpHandler, OpImplTable } from './ops/busOps';
export { attachRealmToRoot, createBusRouter, createLocalEndpointPair, DEFAULT_SUMMON_TIMEOUT_MS } from './ops/busBridge';
export { createRetainedRegistry, localRetainedPort } from './ops/retained';
export type { IRetainedRegistry, IRetainedPort, RetainedSubscriber } from './ops/retained';
export { registerClientOps } from './ops/clientOps';
export type { ClientOpMap, ClientMonitorKey, IClientOpsSource, IClientOpsOptions } from './ops/clientOps';
export type { IBusEndpoint, IBusRouter, IBusRouterOptions, SummonLookup, IRealmAttachment } from './ops/busBridge';

// Top-level shell + sidebar component prop types
export type { ShellProps } from './components/layout/Shell';
export type { SidebarProps, NavButtonProps } from './components/layout/Sidebar';
export type { IConfirmDialogProps as ConfirmDialogProps } from './components/modal/ConfirmDialog';
export type { AnchoredPopupProps } from './components/AnchoredPopup';
export type { FixedPopupOptions } from './hooks/useFixedPopupPosition';

// Workspace context interface + provider props
export type { IWorkspaceContext, IWorkspaceProviderProps } from './components/workspace/WorkspaceContext';

// Polling options — graduated from the known-gaps queue (was reachable
// only structurally through usePolling).
export type { IUsePollingOptions } from './hooks/usePolling';

// The shared RocketRide client — an MF shared singleton the shell serves to
// every app, so its API surface is PART of this contract. Exporting the type
// by name gives it its own per-version floor (Frozen = Current, covariant):
// SDK additions pass, removals/narrowings of anything ever frozen fail
// shell's tsc. The client is deliberately kept INLINED in the frozen
// bundle. It must never appear in an
// input position on this surface — see contract-hold.ts.
export type { RocketRideClient } from 'rocketride';

// The ENTIRE SDK type surface rides the contract (type-only): out-of-repo
// apps have no 'rocketride' workspace package, so every payload/result/config
// type they touch must be importable from 'shell'. Values are deliberately
// excluded — the runtime client only ever arrives via useShellConnection().
export type * from 'rocketride';

// Connection manager standalone types
export type { InitOptions, DebugLogEntry } from './connection/connection';

// Auth identity type (ConnectResult aliased as AuthUser)
export type { AuthUser } from './hooks/useAuthUser';

// Event map + connection status/mode/auth-provider types (from shared)
export type { ShellConnectionEventMap as ShellEventMap } from './types/shell';
// The shell:notify payload union (platform notification bus)
export type { ShellNotification } from './types/shell';
export type { ConnectionStatus, ConnectionMode, IAuthProvider } from './types/connection';

// Iframe protocol message types
export type { ShellToIframeMsg, IframeToShellMsg, ShellInitMsg } from './util/iframeBridgeProtocol';

// Document component library standalone types.
// `Documents` itself is captured as a constructor via `shellApi.Documents`;
// these are its standalone helper/model types that apps import directly.
export type { Editor, WorkspaceBinding, Document, EditorGroup, SplitOrientation, SplitPosition, EditorDragSession, DocumentsState, LayoutNode, LayoutLeaf, LayoutSplit } from './components/docs/Documents';
export type { DocTabsProps } from './components/docs/DocTabs';
export type { DocSplitLayoutProps } from './components/docs/DocSplitLayout';
export type { DocExplorerProps, DocExplorerConfig, DocEntry, DocEntryChild, DocEntryStatus } from './components/docs/DocExplorer';
export type { IVirtualFileSystem } from './modules/explorer/types';

// ViewMenu declaration types (consumed by shared's TabControl/SidebarMenu)
export type { DashboardData } from './hooks/useDashboardData';
export type { ViewMenu, ViewMenuEntry } from './types/viewMenu';

// The workspace-prefs accessor shape ({ getPref, setPref }) for usePrefs/PrefsProvider.
export type { IPrefsApi } from './components/contexts/PrefsContext';

// =============================================================================
// STOCK LIBRARY SURFACE — curated, NOT the shared barrel wholesale
// =============================================================================
//
// Stock components get the same append-only guarantee as the client: an app
// can fail if Card changes. But the shared barrel was never a curated list —
// it accumulated app-domain modules (PlayBar, the monitor panels, chat,
// checkout…) for MF convenience. Those are STATIC library components (each
// app bundles its own copy via 'shared/<group>' deep specs) and freezing
// them would pin app-domain churn into a forever-contract. So the surface
// is an explicit pick: generic building blocks, chrome, icons, the theme
// vocabulary, and platform types. Growing it is a conscious api.ts edit.
// Relative path per the boot-chain import rule; the phase-4 partition
// repoints these at in-package files without changing the surface.

// Stock component values, imported from their CONCRETE modules (the shared
// root barrel is retired; these lines are generated from its final map).
import { Button } from './components/button/Button';
import { StatusBadge, StatusDot } from './components/status-badge/StatusBadge';
import { EmptyState } from './components/empty-state/EmptyState';
import { Banner } from './components/banner/Banner';
import { InputField } from './components/input-field/InputField';
import { ToggleGroup } from './components/toggle-group/ToggleGroup';
import { Chip, ChipAdd } from './components/chip/Chip';
import { DropZone } from './components/drop-zone/DropZone';
import { Card } from './components/card/Card';
import { MiniCard, MiniContainer } from './components/mini-card/MiniCard';
import { Section, LabelValue } from './components/section/Section';
import { ContentHeader } from './components/content-header/ContentHeader';
import { RocketRideMark } from './components/RocketRideMark';
import { DetailPanel } from './components/detail-panel/DetailPanel';
import { PanelTabBody } from './components/detail-panel/PanelTabBody';
import { TabControl } from './components/tab-control/TabControl';
import { TabPanel } from './components/tab-panel/TabPanel';
import { Modal, CLOSE_GLYPH, acquireOverlayLayer, isTopOverlayLayer, releaseOverlayLayer } from './components/modal/Modal';
import { SaveFileDialog } from './components/save-file-dialog/SaveFileDialog';
import { SidebarMenu } from './components/sidebar-menu/SidebarMenu';
import { SidebarCollapsedProvider, SidebarCollapsedGate, useSidebarCollapsed } from './components/sidebar-menu/SidebarCollapsedContext';
import { SidebarActiveViewProvider, useSidebarActiveView } from './components/sidebar-menu/SidebarActiveViewContext';
import { viewsFromMenu, menuSectionEntries } from './components/sidebar-menu/viewsFromMenu';
import { SidebarFooter } from './components/sidebar-footer/SidebarFooter';
import { DataGrid } from './components/data-grid/DataGrid';
import { CardDataGrid } from './components/data-grid/CardDataGrid';
import { FilterStrip } from './components/data-grid/FilterStrip';
import { createActionsColumn, autoFormatter, badgeEl, buttonEl, avatarEl, monoEl, mutedEl, matchesSearch, formatDateValue } from './components/data-grid/defaults';
import { createMessageGridPersistence, GRID_CONFIG_GET, GRID_CONFIG_SET, GRID_CONFIG_CLEAR } from './components/data-grid/gridConfigChannel';
import { ChatView } from './components/chat/ChatView';
import { MessageList } from './components/chat/components/MessageList';
import { MarkdownRenderer } from './components/chat/components/MarkdownRenderer';
import { useChatMessages } from './components/chat/hooks/useChatMessages';
import { ConnectionCard, ConnectionCardAdd } from './components/connection-card/ConnectionCard';
import { ConnectionManagerView } from './components/connection-manager/ConnectionManagerView';
import { useDebouncedValue } from './hooks/useDebouncedValue';
import { useAnnouncements } from './hooks/useAnnouncements';
import { formatBytes, formatDate, formatDuration } from './util/format';
// (commonStyles is imported at the very top of this file — cycle-order
// constraint — and re-exported from the export block below.)
// Values graduated from deep shell/src imports when the package exports map
// closed those paths: theme application (vscode webviews apply tokens at
// mount), the vscode-host probe, the OAuth root, and the pipeline-schema
// runtime values shared's project module re-exports.
import { applyTheme } from './themes';
import { isInVSCode } from './themes/vscode';
import { OAUTH_ROOT_URL } from './auth/oauth';
import { ITaskState, IServiceCapabilities, DEFAULT_TOOLCHAIN_STATE } from './types/project';
import { getAppVersionOverride, applyAppVersionOverride, versionedEntryUrl } from './util/versionOverride';
export type { AppVersionOverride } from './util/versionOverride';

export {
	Button, StatusBadge, StatusDot, EmptyState, Banner, InputField,
	ToggleGroup, Chip, ChipAdd, DropZone, Card, MiniCard, MiniContainer,
	Section, LabelValue, ContentHeader, RocketRideMark,
	DetailPanel, PanelTabBody, TabControl, TabPanel, Modal, CLOSE_GLYPH,
	// The overlay-layer stack (Escape/scroll coordination across stacked
	// overlays) — public so shared surfaces coordinate with shell modals
	// through the barrel; the tgz's exports map closes every deep path.
	acquireOverlayLayer, isTopOverlayLayer, releaseOverlayLayer,
	SaveFileDialog,
	SidebarMenu, SidebarCollapsedProvider, SidebarCollapsedGate,
	useSidebarCollapsed, SidebarFooter,
	// Workbench sidebar modes ('vscode'/'cursor'): the active-view channel
	// shared sidebar content reads when the shell rail owns the selection.
	SidebarActiveViewProvider, useSidebarActiveView,
	// Opt-in projection of a menu-shaped sidebar onto the activity rail
	// (sections -> rail views); never applied automatically by the shell.
	viewsFromMenu, menuSectionEntries,
	DataGrid, CardDataGrid, FilterStrip, createActionsColumn, autoFormatter,
	badgeEl, buttonEl, avatarEl, monoEl, mutedEl, matchesSearch,
	createMessageGridPersistence, GRID_CONFIG_GET, GRID_CONFIG_SET,
	GRID_CONFIG_CLEAR,
	useDebouncedValue, useAnnouncements, formatBytes, formatDate,
	formatDuration, formatDateValue,
	ChatView, MessageList, MarkdownRenderer, useChatMessages,
	ConnectionCard, ConnectionCardAdd, ConnectionManagerView,
	commonStyles,
	applyTheme, isInVSCode, OAUTH_ROOT_URL,
	ITaskState, IServiceCapabilities, DEFAULT_TOOLCHAIN_STATE,
};

// Prop/config types for the kept components, plus platform data types —
// concrete module paths (generated from the retired barrel's map).
export type { IButtonProps, ButtonVariant } from './components/button/Button';
export type { IStatusBadgeProps, IStatusDotProps, StatusVariant } from './components/status-badge/StatusBadge';
export type { IChatViewProps, ChatMessage, UseChatMessagesOptions, TextResult } from './components/chat/types';
export type { IConnectionCardProps, IConnectionCardAddProps } from './components/connection-card/ConnectionCard';
export type { IConnectionManagerViewProps, IConnectionCardDisplay, IConnectionFormField } from './components/connection-manager/ConnectionManagerView';
export type { IEmptyStateProps } from './components/empty-state/EmptyState';
export type { IBannerProps, BannerVariant } from './components/banner/Banner';
export type { IInputFieldProps } from './components/input-field/InputField';
export type { IToggleGroupProps, IToggleGroupOption } from './components/toggle-group/ToggleGroup';
export type { IChipProps, IChipAddProps } from './components/chip/Chip';
export type { IDropZoneProps } from './components/drop-zone/DropZone';
export type { ICardProps } from './components/card/Card';
export type { IMiniCardProps, IMiniContainerProps } from './components/mini-card/MiniCard';
export type { ISectionProps, ILabelValueProps } from './components/section/Section';
export type { IContentHeaderProps } from './components/content-header/ContentHeader';
export type { IRocketRideMarkProps } from './components/RocketRideMark';
export type { IDetailPanelProps } from './components/detail-panel/DetailPanel';
export type { IPanelTabBodyProps } from './components/detail-panel/PanelTabBody';
export type { ITabControlProps } from './components/tab-control/TabControl';
export type { ITabPanelProps, ITabPanelPanel } from './components/tab-panel/TabPanel';
export type { IModalProps } from './components/modal/Modal';
export type { IConfirmDialogProps } from './components/modal/ConfirmDialog';
export type { ISaveFileDialogProps, ISaveFileType } from './components/save-file-dialog/SaveFileDialog';
export type { ISidebarMenuProps } from './components/sidebar-menu/SidebarMenu';
export type { ISidebarCollapsedProviderProps, ISidebarCollapsedGateProps } from './components/sidebar-menu/SidebarCollapsedContext';
export type { SidebarActiveView, ISidebarActiveViewProviderProps } from './components/sidebar-menu/SidebarActiveViewContext';
// Sidebar chrome declaration types (AppLayout's sidebarMode/sidebarViews).
export type { ShellSidebarMode, SidebarViewContainer } from './types/sidebarChrome';
export type { ViewsFromMenuOptions } from './components/sidebar-menu/viewsFromMenu';
export type { SidebarFooterProps, SidebarFooterMenuItem } from './components/sidebar-footer/SidebarFooter';
export type { IDataGridProps, IDataGridHandle, IDataGridPage, IDataGridPageRequest } from './components/data-grid/DataGrid';
export type { ICardDataGridProps } from './components/data-grid/CardDataGrid';
export type { GridColumnDefinition, GridCellComponent, GridColumnRRType, IGridAction, IActionsColumnConfig, CellBadgeVariant, CellButtonKind } from './components/data-grid/defaults';
export type { IGridFilterDef, IGridFilterOption, IFilterStripProps } from './components/data-grid/FilterStrip';
export type { IDataGridPersistence, DataGridLayout } from './components/data-grid/persistence';
export type { IGridConfigGetDetail, IGridConfigSetDetail, IGridConfigClearDetail } from './components/data-grid/gridConfigChannel';
export type { Announcement } from './hooks/useAnnouncements';
export type { DashboardResponse, DashboardOverview, DashboardConnection, DashboardTask, DashboardEvent, TaskEvent, ActivityEvent, ListPageRequest, ListPageResponse, MonitorPageId } from './modules/server';
// =============================================================================
// PLATFORM VIEW MODULES — the shared partition's shell half, now in-package
// =============================================================================
//
// These view modules were shared residents that shell's own surface always
// re-exported pieces of (Explorer, the dashboard types). With the partition
// they live in packages/shell, so their host-facing components graduate to
// the contract: the vscode webviews and first-party apps consume them from
// 'shell' like any other surface member.

import MonitorView, { parseActivityEvent } from './modules/server';
import { ActivityPanel, ConnectionsPanel, TasksPanel, OverviewGrid, getEventDisplay } from './modules/server/components';
import { formatNumber, formatTime, formatUptime, formatTimeAgo, formatDayTime } from './modules/server/util';
import AccountView from './modules/account';
import { DesktopView } from './modules/desktop';
import { EnvironmentView } from './modules/environment';
import { CheckoutModal, PlanPicker } from './modules/checkout';
import { UpgradeModal } from './modules/billing';

export {
	MonitorView, parseActivityEvent,
	ActivityPanel, ConnectionsPanel, TasksPanel, OverviewGrid, getEventDisplay,
	formatNumber, formatTime, formatUptime, formatTimeAgo, formatDayTime,
	AccountView, DesktopView, EnvironmentView,
	CheckoutModal, PlanPicker, UpgradeModal,
};

// The shared desktop page's type surface (the component itself is exported
// above and on shellApi; its default server adapter stays internal).
export type { DesktopApp, DesktopViewProps, DesktopAdapter, DesktopQuote, DesktopVersionRow, DesktopVersionOverride } from './modules/desktop';

export type { EventTone } from './modules/server/components';
export type { CheckoutPlan, PlanAction, PromoRedemption, PromoValidation } from './modules/checkout/types';
export type { EnvironmentSlotConfig, EnvironmentScope } from './modules/environment';

// The FULL pipeline-schema type family — shared's project module and the
// vscode Project webview consume all of it, so the whole set is surface.
export type { IProject, IValidateResponse, IServiceCatalog, IProjectComponent, IComponentUI, IControlConnection, IInputConnection, IPosition, IDimensions, IService, IServiceSchema, IServiceLaneEntry, INodeConfig, IComponentValidatePayload, IValidatePipelinePayload, IToolchainExport, IToolchainState, IForm, IFormData, ITaskStatus, IFlowData } from './types/project';

// The FULL icon set (the explicit Bx* subset below stays for chrome and
// wins its names per TS star-export rules; every other glyph flows through).
export * from './components/BoxIcon';
import * as stockIcons from './components/BoxIcon';

// Theme vocabulary: the token map type.
export type { ThemeTokens } from './themes/tokens';


// =============================================================================
// SHELL API SURFACE
// =============================================================================

/**
 * The curated set of value symbols shell exposes to remote apps.
 *
 * Per the design-owner decision this covers shell's ENTIRE value export
 * surface. The object is frozen at build time so its type — `ShellApiShape` —
 * becomes the versioned contract enforced against shell's own compilation.
 */
export const shellApi = {
	// LAZY BY DESIGN — every member is a getter, so building this object
	// reads NOTHING at module evaluation. The aggregator is the one place
	// that would otherwise read every surface binding eagerly, and inside
	// the host bundle that is a boot-order landmine: any shared module the
	// shell chrome pulls that imports the 'shell' barrel creates a require
	// cycle back into this file, and an eager read of a still-evaluating
	// module's binding is a TDZ ReferenceError at boot (this happened:
	// Shell.tsx -> AccountProvider -> account module -> barrel -> here ->
	// read of Shell). Getters defer every read to first ACCESS, which is
	// always post-boot. typeof is unchanged (get-only = readonly member).

	// The stock library surface. The icon namespace spread is the one
	// eager read allowed here: BoxIcon is a LEAF module (react only), so
	// it can never participate in a cycle.
	...stockIcons,
	get Button() { return Button; },
	get StatusBadge() { return StatusBadge; },
	get StatusDot() { return StatusDot; },
	get EmptyState() { return EmptyState; },
	get Banner() { return Banner; },
	get InputField() { return InputField; },
	get ToggleGroup() { return ToggleGroup; },
	get Chip() { return Chip; },
	get ChipAdd() { return ChipAdd; },
	get DropZone() { return DropZone; },
	get Card() { return Card; },
	get MiniCard() { return MiniCard; },
	get MiniContainer() { return MiniContainer; },
	get Section() { return Section; },
	get LabelValue() { return LabelValue; },
	get ContentHeader() { return ContentHeader; },
	get RocketRideMark() { return RocketRideMark; },
	get DetailPanel() { return DetailPanel; },
	get PanelTabBody() { return PanelTabBody; },
	get TabControl() { return TabControl; },
	get TabPanel() { return TabPanel; },
	get Modal() { return Modal; },
	get CLOSE_GLYPH() { return CLOSE_GLYPH; },
	get SaveFileDialog() { return SaveFileDialog; },
	get SidebarMenu() { return SidebarMenu; },
	get SidebarCollapsedProvider() { return SidebarCollapsedProvider; },
	get SidebarCollapsedGate() { return SidebarCollapsedGate; },
	get useSidebarCollapsed() { return useSidebarCollapsed; },
	get SidebarActiveViewProvider() { return SidebarActiveViewProvider; },
	get useSidebarActiveView() { return useSidebarActiveView; },
	get SidebarFooter() { return SidebarFooter; },
	get DataGrid() { return DataGrid; },
	get CardDataGrid() { return CardDataGrid; },
	get FilterStrip() { return FilterStrip; },
	get createActionsColumn() { return createActionsColumn; },
	get autoFormatter() { return autoFormatter; },
	get badgeEl() { return badgeEl; },
	get buttonEl() { return buttonEl; },
	get avatarEl() { return avatarEl; },
	get monoEl() { return monoEl; },
	get mutedEl() { return mutedEl; },
	get matchesSearch() { return matchesSearch; },
	get createMessageGridPersistence() { return createMessageGridPersistence; },
	get GRID_CONFIG_GET() { return GRID_CONFIG_GET; },
	get GRID_CONFIG_SET() { return GRID_CONFIG_SET; },
	get GRID_CONFIG_CLEAR() { return GRID_CONFIG_CLEAR; },
	get useDebouncedValue() { return useDebouncedValue; },
	get useAnnouncements() { return useAnnouncements; },
	get formatBytes() { return formatBytes; },
	get formatDate() { return formatDate; },
	get formatDuration() { return formatDuration; },
	get commonStyles() { return commonStyles; },
	get useShellConnection() { return useShellConnection; },
	get useAuthUser() { return useAuthUser; },
	get useLogout() { return useLogout; },
	get useWorkspace() { return useWorkspace; },
	get useClient() { return useClient; },
	get useShellEvent() { return useShellEvent; },
	get useLatest() { return useLatest; },
	get showConfirmDialog() { return showConfirmDialog; },

	// Tool framework — channel, protocol maps, ops, prefs store, tool host.
	get createToolChannel() { return createToolChannel; },
	get asToolStateMessage() { return asToolStateMessage; },
	get asToolEventMessage() { return asToolEventMessage; },
	get createToolController() { return createToolController; },
	get createToolOpServer() { return createToolOpServer; },
	get asToolCallMessage() { return asToolCallMessage; },
	get asToolReplyMessage() { return asToolReplyMessage; },
	get DEFAULT_OP_TIMEOUT_MS() { return DEFAULT_OP_TIMEOUT_MS; },
	get typedToolChannel() { return typedToolChannel; },
	get useToolState() { return useToolState; },
	get useConnectionReady() { return useConnectionReady; },
	get publishHostConnectionState() { return publishHostConnectionState; },
	get HOST_CONNECTION_TOPIC() { return HOST_CONNECTION_TOPIC; },
	get typedPrefs() { return typedPrefs; },
	get scopedPrefs() { return scopedPrefs; },
	get createBridgedPrefsStore() { return createBridgedPrefsStore; },
	get usePref() { return usePref; },
	get ToolHostProvider() { return ToolHostProvider; },
	get useToolHost() { return useToolHost; },
	get createLoopbackPeer() { return createLoopbackPeer; },
	get useGridConfigAnswering() { return useGridConfigAnswering; },
	get hostConnectionPayload() { return hostConnectionPayload; },
	get TOOL_RELAY_BUFFER_LIMIT() { return TOOL_RELAY_BUFFER_LIMIT; },
	get createSidebarBusPeer() { return createSidebarBusPeer; },
	get createFrameBusPeer() { return createFrameBusPeer; },
	get toolDocUri() { return toolDocUri; },
	get parseToolDocUri() { return parseToolDocUri; },
	get activeDocKeyFor() { return activeDocKeyFor; },
	get TOOL_DOC_PREFIX() { return TOOL_DOC_PREFIX; },
	get createOpBus() { return createOpBus; },
	get typedBusOps() { return typedBusOps; },
	get registerOpHandlers() { return registerOpHandlers; },
	get BusNoHandlerError() { return BusNoHandlerError; },
	get DEFAULT_BUS_REQUEST_TIMEOUT_MS() { return DEFAULT_BUS_REQUEST_TIMEOUT_MS; },
	get attachRealmToRoot() { return attachRealmToRoot; },
	get createBusRouter() { return createBusRouter; },
	get createLocalEndpointPair() { return createLocalEndpointPair; },
	get DEFAULT_SUMMON_TIMEOUT_MS() { return DEFAULT_SUMMON_TIMEOUT_MS; },
	get createRetainedRegistry() { return createRetainedRegistry; },
	get localRetainedPort() { return localRetainedPort; },
	get registerClientOps() { return registerClientOps; },
	get useIframeBridge() { return useIframeBridge; },
	get useSubscriptions() { return useSubscriptions; },
	get usePolling() { return usePolling; },
	get useDashboardData() { return useDashboardData; },
	get useConnectionStatus() { return useConnectionStatus; },
	get useShellApiConfig() { return useShellApiConfig; },
	get useAppComponent() { return useAppComponent; },
	get useClickOutside() { return useClickOutside; },
	get useFixedPopupPosition() { return useFixedPopupPosition; },
	get usePrefs() { return usePrefs; },
	get getClient() { return getClient; },
	get ConnectionManager() { return ConnectionManager; },
	get ConnectionState() { return ConnectionState; },
	get CloudAuthProvider() { return CloudAuthProvider; },
	get ApiKeyAuthProvider() { return ApiKeyAuthProvider; },
	get WorkspaceProvider() { return WorkspaceProvider; },
	get PrefsProvider() { return PrefsProvider; },
	get Documents() { return Documents; },
	get NOOP_VFS() { return NOOP_VFS; },
	get CachedVfs() { return CachedVfs; },
	get Explorer() { return Explorer; },
	get DocTabs() { return DocTabs; },
	get DocSplitLayout() { return DocSplitLayout; },
	get DocExplorer() { return DocExplorer; },
	get Shell() { return Shell; },
	get Sidebar() { return Sidebar; },
	get BottomPanel() { return BottomPanel; },
	get DebugPanel() { return DebugPanel; },
	get NavButton() { return NavButton; },
	get ConfirmDialog() { return ConfirmDialog; },
	get PopupRow() { return PopupRow; },
	get AnchoredPopup() { return AnchoredPopup; },
	get AccountProvider() { return AccountProvider; },
	get SettingsProvider() { return SettingsProvider; },
	get CheckoutFlow() { return CheckoutFlow; },
	get BxPlus() { return BxPlus; },
	get BxEditAlt() { return BxEditAlt; },
	get BxTrash() { return BxTrash; },
	get BxDesktop() { return BxDesktop; },
	get BxGridAlt() { return BxGridAlt; },
	get BxCog() { return BxCog; },
	get BxListUl() { return BxListUl; },
	get BxStop() { return BxStop; },
	get BxPlay() { return BxPlay; },
	get BxHome() { return BxHome; },
	get BxNote() { return BxNote; },
	get BxComponent() { return BxComponent; },
	get BxUser() { return BxUser; },
	get BxRocket() { return BxRocket; },
	get BxLockOpen() { return BxLockOpen; },
	get BxPurchaseTag() { return BxPurchaseTag; },
	get BxChevronRight() { return BxChevronRight; },
	get BxFolderOpen() { return BxFolderOpen; },
	get AppLayout() { return AppLayout; },
	// The shared desktop page (greeting + quote + app-card grid) — consumed
	// by every launcher host (hello, home, rocket-ui's Desktop page).
	get DesktopView() { return DesktopView; },
	// Desktop version selector — session override read + apply/clear
	get getAppVersionOverride() { return getAppVersionOverride; },
	get applyAppVersionOverride() { return applyAppVersionOverride; },
	// Stable versioned entry URL (constructed, never minted — the server
	// enforces entitlement per request on the /apps/<id>/v<N>/ route)
	get versionedEntryUrl() { return versionedEntryUrl; },
} as const;

// =============================================================================
// NAMED VALUE EXPORTS — the frozen bundle must MIRROR the runtime module
// =============================================================================
//
// The real shell module (index.ts, served over the MF share scope) exports
// every one of these as a NAMED export, and app code imports them by name
// (`import { DocTabs, useShellConnection } from 'shell'`). Without this
// list the frozen .d.ts — which standalone app repos use AS their 'shell'
// types — exposed the values only through the `shellApi` object, so every
// named value import failed with TS2459 ("declares locally but not
// exported") despite working at runtime. Same members as `shellApi` above;
// additions are append-only, exactly like the object.
export {
	// Hooks
	useShellConnection, useAuthUser, useLogout, useWorkspace, useClient,
	useShellEvent, useIframeBridge, useSubscriptions, usePolling,
	useDashboardData, useConnectionStatus, useShellApiConfig, useAppComponent,
	useClickOutside, useFixedPopupPosition, usePrefs,
	// Client access + connection manager + connection state
	getClient, ConnectionManager, ConnectionState,
	// Auth providers
	CloudAuthProvider, ApiKeyAuthProvider,
	// Workspace provider + prefs provider
	WorkspaceProvider, PrefsProvider,
	// Document component library
	Documents, NOOP_VFS, CachedVfs, Explorer, DocTabs, DocSplitLayout, DocExplorer,
	// Top-level shell frame + zone components
	Shell, Sidebar, BottomPanel, DebugPanel,
	// Layout building blocks
	NavButton, ConfirmDialog, PopupRow, AnchoredPopup,
	// Shell-owned overlay pages (framework pages in any host realm)
	AccountProvider, SettingsProvider, CheckoutFlow,
	// Icons
	BxPlus, BxEditAlt, BxTrash, BxDesktop, BxGridAlt, BxCog, BxListUl,
	BxStop, BxPlay, BxHome, BxNote, BxComponent, BxUser, BxRocket,
	BxLockOpen, BxPurchaseTag, BxChevronRight, BxFolderOpen,
	// The one app-root layout
	AppLayout,
	// Desktop version selector — session override read + apply/clear
	getAppVersionOverride, applyAppVersionOverride, versionedEntryUrl,
};

/**
 * The compile-time shape of the shell API surface.
 *
 * This is the type frozen by `./builder shell:freeze` into `ShellApiVN`. Any
 * change that removes or narrows a member breaks conformance against a frozen
 * version and fails `tsc --noEmit`.
 */
export type ShellApiShape = typeof shellApi;

// =============================================================================
// EXPORT-LIST SYNC GUARD
// =============================================================================
//
// The named export list above duplicates shellApi's member list, and the two
// MUST stay identical — the frozen bundle mirrors the runtime module only if
// every shellApi member is also a named export. This assertion makes drift a
// compile error that NAMES the forgotten symbol(s): `typeof import('./api')`
// is this module's own value namespace, so any shellApi key missing from it
// survives the Exclude and poisons the assignment below. The freeze pre-check
// runs `tsc --noEmit`, so an out-of-sync surface can never freeze.
type _MissingNamedExports = Exclude<keyof ShellApiShape, keyof typeof import('./api')>;
const _exportsComplete: [_MissingNamedExports] extends [never] ? true : _MissingNamedExports = true;
void _exportsComplete;

// SHELL_API_VERSION lives in ./apiver.ts (its own file) so `shell:freeze` can
// auto-write it and the app registration step can read it — and so it never
// enters this frozen surface. shell's index re-exports it from there.

/**
 * Returns the curated shell API surface.
 *
 * Apps call this (via shell's public export) to obtain every shell-provided
 * hook, helper, class, component, and icon through one typed object rather than
 * importing each symbol individually.
 *
 * @returns The frozen `shellApi` object.
 */
export function getShellApi(): ShellApiShape {
	return shellApi;
}
