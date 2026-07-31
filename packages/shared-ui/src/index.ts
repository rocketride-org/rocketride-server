// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Main entry point for the shared-ui package.
 *
 * Exports pure presentation components and shared utilities.
 * Transport / messaging logic lives in the VS Code extension, not here.
 */

// --- Project module (pipeline editor) ----------------------------------------
// Deliberately NOT exported from this barrel: this file is the MF 'shared'
// share the shell provides eagerly, and the project module drags the entire
// canvas (React Flow, node annotation markdown/prism, lucide) into the shell's
// boot bundle — ~1MB+ that only the pipeline editor uses. Its consumers
// (rocket-ui, the VS Code extension) import 'shared/modules/project' directly
// and bundle it themselves, so the cost is paid where and when it's used.

// --- Server module (dashboard monitor) ---------------------------------------
export { default as MonitorView } from './modules/server';
export type { IMonitorViewProps } from './modules/server';
export { parseActivityEvent } from './modules/server';
export type { DashboardResponse, DashboardOverview, DashboardConnection, DashboardTask, DashboardEvent, TaskEvent, ActivityEvent, ListPageRequest, ListPageResponse } from './modules/server';
export { OverviewPanel, OverviewGrid, ConnectionsPanel, TasksPanel, ActivityPanel, ConnectionRecordPanel, TaskRecordPanel, taskStatusText, taskStatusVariant, getEventDisplay } from './modules/server/components';
export type { IOverviewGridProps, IConnectionsPanelProps, ITasksPanelProps, IActivityPanelProps, IConnectionRecordPanelProps, ITaskRecordPanelProps, IEventDisplay, EventTone } from './modules/server/components';

// --- Sidebar module (unified sidebar) ----------------------------------------
export { SidebarView } from './modules/sidebar/SidebarView';
export type { ISidebarViewProps, ProjectEntry, ProjectSource, DirEntry, ActiveTaskState, UnknownTask, ConnectionInfo } from './modules/sidebar/types';
export { foldTaskEvent, foldDeployRunState, foldProjectDeployRuns } from './modules/sidebar/taskFold';
export type { TaskLifecycleEvent, TaskFoldResult } from './modules/sidebar/taskFold';

// --- Deploy panel family (teams-as-environments deployment surfaces) ---------
// Deliberately NOT exported from this barrel: DeploymentView drags the canvas
// (same weight problem as the project module). Consumers import
// 'shared/components/deploy-panel' directly, like 'shared/modules/project'.

// --- Explorer module (generic file tree panel) -------------------------------
export { Explorer } from './modules/explorer';
export type { IVirtualFileSystem, IExplorerProps, ExplorerFileAction, ExplorerConfig, ExplorerEntry, ExplorerChild, ExplorerStatus } from './modules/explorer';

// --- Shared types ------------------------------------------------------------
export type { IProject, IValidateResponse, IServiceCatalog } from './types/project';

// --- Supplementary components ------------------------------------------------
export { default as EndpointInfoModal } from './components/pipeline-actions/EndpointInfoModal';
export type { IEndpointInfo as EndpointInfo } from './components/pipeline-actions/PipelineActions';
export { appendAuthQueryParam, buildIntegrationExamples } from './components/pipeline-actions/endpointIntegrationExamples';
export type { IntegrationTabId } from './components/pipeline-actions/endpointIntegrationExamples';

export * from './components/BoxIcon';

export { TabPanel } from './components/tab-panel/TabPanel';
export type { ITabPanelProps, ITabPanelPanel } from './components/tab-panel/TabPanel';

// --- Sidebar footer ----------------------------------------------------------
export { SidebarFooter } from './components/sidebar-footer/SidebarFooter';
export type { SidebarFooterProps, SidebarFooterMenuItem } from './components/sidebar-footer/SidebarFooter';

// --- Account module (account management) ------------------------------------
// Types: import directly from 'rocketride' (ConnectResult, ApiKeyRecord, etc.)
export { default as AccountView } from './modules/account/AccountView';
export type { IAccountViewProps } from './modules/account/AccountView';

// --- Environment module (pipeline secrets / env vars) -------------------------
export { EnvironmentView } from './modules/environment';
export type { EnvironmentViewProps, EnvironmentSlotConfig, EnvironmentScope } from './modules/environment';

// --- Billing module (subscription management) --------------------------------
// Types: import directly from 'rocketride' (BillingDetail, CreditBalance, etc.)
export { CreditsPanel, UpgradeModal } from './modules/billing';
export type { UpgradeModalProps } from './modules/billing';

// --- Checkout module (subscription checkout flow) ----------------------------
export { CheckoutModal, PlanPicker } from './modules/checkout';
export type { CheckoutModalProps, CheckoutPlan, PlanAction, PlanPickerProps, PromoRedemption, PromoValidation } from './modules/checkout';

// --- Chat module (conversational chat surface) --------------------------------
export { ChatView } from './modules/chat';
export type { IChatViewProps, ChatMessage, ChatViewProps, UseChatMessagesOptions, TextResult } from './modules/chat';
export { MessageList, MessageBubble, ChatInputField, MarkdownRenderer, ChartRenderer, TypingIndicator } from './modules/chat';
export { useChatMessages } from './modules/chat';
export type { UseChatMessagesReturn } from './modules/chat';

// --- Shell connection types ---------------------------------------------------
export type { ShellConnectionEventMap, IConnectionManager, ShellAppEntry } from './types/shell';

// --- Connection state types (shared across shell-ui and VSCode) ---------------
export { ConnectionState } from './types/connection';
export type { ConnectionMode, ConnectionStatus, ManagerInfo, IAuthProvider } from './types/connection';

// --- Shared hooks & utilities ------------------------------------------------
export { useClickOutside } from './hooks/useClickOutside';
export { useFixedPopupPosition } from './hooks/useFixedPopupPosition';
export { useAnnouncements } from './hooks/useAnnouncements';
export type { Announcement } from './hooks/useAnnouncements';
export { PopupRow } from './components/PopupRow';

// --- Stock primitives (style guide section 6) --------------------------------
export { Button } from './components/button/Button';
export type { IButtonProps, ButtonVariant } from './components/button/Button';
export { StatusBadge, StatusDot } from './components/status-badge/StatusBadge';
export type { IStatusBadgeProps, IStatusDotProps, StatusVariant } from './components/status-badge/StatusBadge';
export { EmptyState } from './components/empty-state/EmptyState';
export type { IEmptyStateProps } from './components/empty-state/EmptyState';
export { Banner } from './components/banner/Banner';
export type { IBannerProps, BannerVariant } from './components/banner/Banner';
export { InputField } from './components/input-field/InputField';
export type { IInputFieldProps } from './components/input-field/InputField';
export { ToggleGroup } from './components/toggle-group/ToggleGroup';
export type { IToggleGroupProps, IToggleGroupOption } from './components/toggle-group/ToggleGroup';
export { Chip, ChipAdd } from './components/chip/Chip';
export type { IChipProps, IChipAddProps } from './components/chip/Chip';
export { DropZone } from './components/drop-zone/DropZone';
export type { IDropZoneProps } from './components/drop-zone/DropZone';

// --- DataGrid (style guide section 6.1) ---------------------------------------
export { DataGrid } from './components/data-grid/DataGrid';
export type { IDataGridProps, IDataGridHandle, IDataGridPage, IDataGridPageRequest } from './components/data-grid/DataGrid';
export { CardDataGrid } from './components/data-grid/CardDataGrid';
export type { ICardDataGridProps } from './components/data-grid/CardDataGrid';
export { createActionsColumn, autoFormatter, badgeEl, buttonEl, avatarEl, monoEl, mutedEl, matchesSearch } from './components/data-grid/defaults';
export type { GridColumnDefinition, GridColumnRRType, IGridAction, IActionsColumnConfig, CellBadgeVariant, CellButtonKind } from './components/data-grid/defaults';
export { FilterStrip } from './components/data-grid/FilterStrip';
export type { IGridFilterDef, IGridFilterOption, IFilterStripProps } from './components/data-grid/FilterStrip';
export type { IDataGridPersistence, DataGridLayout } from './components/data-grid/persistence';
export { createMessageGridPersistence, GRID_CONFIG_GET, GRID_CONFIG_SET, GRID_CONFIG_CLEAR } from './components/data-grid/gridConfigChannel';
export type { IGridConfigGetDetail, IGridConfigSetDetail, IGridConfigClearDetail } from './components/data-grid/gridConfigChannel';
export { useDebouncedValue } from './hooks/useDebouncedValue';
export type { ColumnDefinition, CellComponent, RowComponent, Options as TabulatorOptions } from 'tabulator-tables';

// --- Stock composition components (style guide sections 5-6) ------------------
export { ContentHeader } from './components/content-header/ContentHeader';
export type { IContentHeaderProps } from './components/content-header/ContentHeader';
export { Card } from './components/card/Card';
export type { ICardProps } from './components/card/Card';
export { MiniCard, MiniContainer } from './components/mini-card/MiniCard';
export type { IMiniCardProps, IMiniContainerProps } from './components/mini-card/MiniCard';
export { ConnectionCard, ConnectionCardAdd } from './components/connection-card/ConnectionCard';
export type { IConnectionCardProps, IConnectionCardAddProps } from './components/connection-card/ConnectionCard';
export { ConnectionManagerView } from './modules/connection-manager/ConnectionManagerView';
export type { IConnectionManagerViewProps, IConnectionCardDisplay, IConnectionFormField } from './modules/connection-manager/ConnectionManagerView';
export { Section, LabelValue } from './components/section/Section';
export type { ISectionProps, ILabelValueProps } from './components/section/Section';
export { DetailPanel } from './components/detail-panel/DetailPanel';
export type { IDetailPanelProps } from './components/detail-panel/DetailPanel';
export { PrefsProvider, usePrefs } from './contexts/PrefsContext';
export type { IPrefsApi } from './contexts/PrefsContext';
export { PanelTabBody } from './components/detail-panel/PanelTabBody';
export type { IPanelTabBodyProps } from './components/detail-panel/PanelTabBody';
export { TabControl } from './components/tab-control/TabControl';
export type { ITabControlProps } from './components/tab-control/TabControl';
export { PlayBar } from './components/play-bar/PlayBar';
export type { IPlayBarProps, ITimeSelection } from './components/play-bar/PlayBar';
export { Modal, CLOSE_GLYPH } from './components/modal/Modal';
export type { IModalProps } from './components/modal/Modal';
export { ConfirmDialog } from './components/modal/ConfirmDialog';
export type { IConfirmDialogProps } from './components/modal/ConfirmDialog';
export { SidebarMenu } from './components/sidebar-menu/SidebarMenu';
export type { ISidebarMenuProps } from './components/sidebar-menu/SidebarMenu';
export { SidebarCollapsedProvider, SidebarCollapsedGate, useSidebarCollapsed } from './components/sidebar-menu/SidebarCollapsedContext';
export type { ISidebarCollapsedProviderProps, ISidebarCollapsedGateProps } from './components/sidebar-menu/SidebarCollapsedContext';
export type { ViewMenu, ViewMenuEntry } from './types/viewMenu';
export { RocketRideMark } from './components/RocketRideMark';
export type { IRocketRideMarkProps } from './components/RocketRideMark';

// --- Shared value formatters -------------------------------------------------
export { formatBytes, formatDate, formatDuration } from './utils/format';
