# RocketRide App UI Components

Generated from the component gallery — the gallery inside the App Builder's
Design tab shows these same components live.

The per-component reference for the public shell API surface RocketRide apps
build on. Everything below is imported **from `'shell'`** — never from a
relative path, never from another app:

```tsx
import { Button, Card, DataGrid, useShellConnection } from 'shell';
```

In prop tables, Dir is the direction — `in` = data the component consumes,
`out` = a callback it fires — and `(req)` marks a required prop. Groups
match the gallery's own: [Host chrome](#host-chrome),
[Sidebar content](#sidebar-content), [Document system](#document-system),
[Content components](#content-components), [Hooks & context](#hooks--context),
[Utilities](#utilities).

---

## Host chrome

The standing zones the SHELL owns. Hosted (cloud) apps never mount any of
these — the platform bootstraps the frame and mounts the active app inside.
Documented so you know what already exists around your app and what you must
never rebuild.

### Shell frame

The standard application frame: **Sidebar** (shell container, one
app-fillable slot), **Client area** (the app's canvas, under the DocTabs
strip, above the StatusBar), **StatusBar**, **Overlays**
(Account / Settings / Environment / Checkout), and the ALT+D **Debug
panel**. Ownership is one-way: the shell mounts the frame; the app fills the
client area and the sidebar slot. Only a standalone host (own repo, own
bootstrap) mounts `Shell` itself with a full `ShellConfig` (branding, theme,
account, auth, app registration); `Shell` also runs the auth bootstrap and
the pre-shell screens (loading, sign-in, error).

**Rule:** Hosted apps never mount Shell, never draw frame chrome, never
build lookalike zones.

```tsx
// STANDALONE HOSTS ONLY - the one Shell mount in a host's bootstrap.
import { Shell } from 'shell';
<Shell config={shellConfig} />
```

### Sidebar frame

The shell-owned sidebar container: fixed Header (brand) and Footer (user
card) around one scrolling app-content slot — the `sidebar` prop of the
app's root `<AppLayout>`, filled with stock components (`SidebarMenu`,
`Explorer`) plus custom sections. 260px expanded, 56px icon rail,
drag-resizable. No `sidebar` prop = one-column app, no sidebar chrome.
**Collapsed is still mounted** — on the icon rail the slot keeps rendering
and components read `useSidebarCollapsed(): boolean` (false when no
provider) to choose their icon form.

**Rule:** Apps never mount, fill, or restyle the Header and Footer. Memoize
the sidebar node — an inline node re-registers every render.

```tsx
import { useMemo, useState } from 'react';
import { AppLayout, SidebarMenu } from 'shell';

export default function MyApp() {
	const [page, setPage] = useState('documents');
	// Stable node - the shell dedupes registrations by node identity.
	const sidebar = useMemo(() => (
		<SidebarMenu menu={PAGES} activeId={page} onSelect={setPage} sectionLabel="chat.pipe" />
	), [page]);
	return <AppLayout sidebar={sidebar} showStatus>{/* content */}</AppLayout>;
}
```

### Overlay system

The shell-owned modal dialogs — Account, Settings, Environment, Checkout —
rendered above the client area on a dimmed backdrop. Apps never create
overlays; they only ASK by emitting `shell:openOverlay` with
`{ id: 'account' | 'settings' | 'environment' }`. Unknown ids are ignored
(guarded allowlist); opening one closes any other. For the app's OWN records
use a `DetailPanel`; app-side modals are only for confirmations
(`ConfirmDialog`) and multi-step flows (`Modal`).

**Rule:** Overlay dialogs render OUTSIDE the client area's providers —
components inside them cannot rely on app-side context.

```tsx
import { ConnectionManager } from 'shell';
ConnectionManager.getInstance().emit('shell:openOverlay', { id: 'account' });
```

### StatusBar

The bottom bar with the GLOBAL connection status. There is ONE connection
state for the whole shell; the StatusBar is its single visual home. An app
REACTS to the same state via `useShellConnection()` instead of inventing a
second status UI.

**Rule:** Never mount the StatusBar, never build a per-app status strip.
Per-item state = StatusBadge in the view; view-level messages = Banner.

```tsx
import { useShellConnection, Button } from 'shell';

function RunControls({ onRun }: { onRun: () => void }) {
	const { isConnected } = useShellConnection();
	return <Button disabled={!isConnected} onClick={onRun}>Run</Button>;
}
```

### Bottom panel

Fixed-height (140px) output panel above the StatusBar: tab row
(Output / Run / Logs), close button, scrolling content. On the frozen
surface for STANDALONE hosts only — the current cloud shell does not mount
it. Props: `onClose: () => void` (out, req).

**Rule:** Hosted apps never mount BottomPanel or build their own bottom
strip.

```tsx
// STANDALONE HOSTS ONLY.
import { BottomPanel } from 'shell';
{showBottomPanel && <BottomPanel onClose={() => setShowBottomPanel(false)} />}
```

### Debug panel

The right-docked (360px) **ALT+D** event trace: a live log of every shell
event and iframe postMessage, with a name filter and Clear. It passively
listens to the ConnectionManager wildcard handler and window `message`
traffic, so every `shell:*` event shows up with its payload — the first tool
to reach for when an event does not arrive. Auto-scroll locks to the bottom
until you scroll up.

**Rule:** Apps never mount DebugPanel — the shell owns the ALT+D toggle.
Use it to VERIFY your app's `shell:*` traffic during development.

---

## Sidebar content

What an app mounts inside the sidebar frame's scrolling slot.

### Explorer

VFS-backed tree/list for pipelines, chats, connections, and files: S3-style
flat paths, per-entry children (source components), inline create/rename,
status dots. The host supplies a flat entries array and handles every action
via callbacks.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `vfs` | `IVirtualFileSystem` | in (req) | Unused but pinned by the frozen contract — pass the stock `NOOP_VFS`. |
| `config` | `ExplorerConfig` | in (req) | `{ title, extensions?, displayName?, createPlaceholder?, ... }` — title, extension filter (null = all), display-name formatter. |
| `entries` | `ExplorerEntry[]` | in (req) | Flat paths; directory hierarchy derived by path parsing. |
| `statuses` | `Map<string, ExplorerStatus>` | in | Per entry/child `{ running, errors[], warnings[] }` — drives the dots. |
| `isConnected` | `boolean` | in (req) | Enables/disables the action buttons. |
| `activeFilePath` | `string` | in | Open file path (row highlight). |
| `fileActions` | `ExplorerFileAction[]` | in | Host-injected kebab-menu actions. |
| `onOpenFile` | `(path) => void` | out (req) | File entry clicked. |
| `onRefresh` | `() => void` | out (req) | Refresh clicked. |
| `onFileManage` | `(action, path, newName?) => void` | out | Rename/delete/create; absent = file-management UI hidden. |
| `onChildAction` | `(action, filePath, childId, documentId?) => void` | out | Run/stop on child items; absent = no action buttons. |

`ExplorerEntry` = `{ path, type?: 'file' \| 'dir', documentId?, children?:
ExplorerChild[] }`; `ExplorerChild` = `{ id, name, provider? }`.

```tsx
import { Explorer, NOOP_VFS } from 'shell';

<Explorer
	vfs={NOOP_VFS}
	config={{ title: 'Pipelines', extensions: ['.pipe'] }}
	entries={[
		{ path: 'chat.pipe', children: [{ id: 'webhook', name: 'Webhook', provider: 'webhook' }] },
		{ path: 'ingest/analyze.pipe' },
	]}
	isConnected={isConnected}
	activeFilePath={openPath}
	onOpenFile={openDocument}
	onRefresh={reloadEntries}
	onFileManage={(action, path, newName) => applyFileAction(action, path, newName)}
/>
```

### SidebarMenu

Standard vertical menu list on the shared `ViewMenu` entry shape — counts,
severity badges, one-level accordion sections. Mount any number; it
auto-iconifies when the sidebar collapses.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `menu` | `ViewMenu` | in (req) | `{ entries: ViewMenuEntry[] }` (shape below). |
| `activeId` | `string` | in (req) | Active entry (brand-tinted pill). |
| `sectionLabel` | `string` | in | Label above the menu (e.g. the owning document); rows nest 10px beneath it. |
| `collapsed` | `boolean` | in | Icon-rail rendering; omitted = falls back to the `useSidebarCollapsed` context. |
| `onSelect` | `(id) => void` | out (req) | Entry selected. |

`ViewMenuEntry` (shared with TabControl and DetailPanel tabs): `id` +
`label` (required), `count?: number` (count badge), `severity?: 'error'`
(error-colored count), `icon?: ReactNode` (icon-rail glyph; fallback =
first letter), `disabled?: boolean` (muted, unselectable — SidebarMenu
only), `children?: ViewMenuEntry[]` (expandable SECTION, one level deep,
accordion — at most one open; a section row does not navigate).

```tsx
import { SidebarMenu } from 'shell';

const menu = { entries: [
	{ id: 'overview', label: 'Overview' },
	{ id: 'events', label: 'Events', count: 48 },
	{ id: 'pipelines', label: 'Pipelines', children: [
		{ id: 'chat', label: 'chat.pipe' },
	] },
] };

<SidebarMenu menu={menu} activeId={view} onSelect={setView} sectionLabel="chat.pipe" />
```

### NavButton

A single sidebar navigation row: icon + label expanded, icon-only on the
rail. For custom sidebar navigation when `SidebarMenu` is too structured.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `icon` | `IconComponent` | in (req) | Any `Bx*` icon. |
| `label` | `string` | in (req) | Label when expanded; tooltip fallback. |
| `isActive` | `boolean` | in | Active-row treatment. |
| `collapsed` | `boolean` | in (req) | Pass the frame's collapsed state. |
| `iconColor` / `title` | `string` | in | Icon colour override / tooltip override. |
| `onClick` | `() => void` | out | Row activation. |

```tsx
import { NavButton, BxRocket } from 'shell';
<NavButton icon={BxRocket} label="Pipelines" isActive collapsed={collapsed} onClick={openView} />
```

### SidebarFooter

The unified sidebar footer: announcements ticker, optional Documentation
link, user card (rocket branding when anonymous), and a portalled popup menu
with flyout submenus, checkmarks, status rows, and section headers. In the
hosted cloud the SHELL renders it; apps meet it directly only in a
standalone host's sidebar.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `collapsed` | `boolean` | in (req) | Icon-only rendering on the icon rail. |
| `userName` | `string` | in | Display name; drives avatar initials. Absent = anonymous branding. |
| `userEmail` | `string` | in | Shown below the name. |
| `onOpenDocs` | `() => void` | out | When provided, shows the Documentation link. |
| `menuItems` | `SidebarFooterMenuItem[]` | in | Host-specific popup menu items, in order. |

`SidebarFooterMenuItem`: `id` + `label` (required), `icon?`, `onClick?`
(leaf activation), `submenu?` (flyout instead of onClick), `checked?`
(radio-style checkmark), `statusText?: string` + `statusState?:
'connected' | 'connecting' | 'disconnected'` (status line + dot),
`dividerBefore?`, `header?` (non-clickable section header).

```tsx
import { SidebarFooter, BxCog } from 'shell';

<SidebarFooter
	collapsed={false}
	userName={user?.name}
	userEmail={user?.email}
	onOpenDocs={openDocs}
	menuItems={[
		{ id: 'settings', label: 'Settings', icon: BxCog, onClick: openSettings },
		{ id: 'theme', label: 'Theme', submenu: themeItems },
		{ id: 'status', label: 'Cloud', statusText: 'Connected', statusState: 'connected', dividerBefore: true },
	]}
/>
```

---

## Document system

### Documents (model)

The app-owned document / editor / group model: VS Code semantics (dirty
tracking, splits, per-editor viewports) as one React-subscribable store. One
instance per app, over the app's VFS. Documents are one-per-URI with
`content`/`dirty`/`version`/`isNew`; editors are views with independent
viewports; groups sit in a binary split tree (`LayoutLeaf`/`LayoutSplit`)
rendered by `DocSplitLayout`. React binding: `docs.useStore()` (tear-free);
non-React: `getState()` / `subscribe()`. With a `WorkspaceBinding`
(`{ appState, updateAppState }` from `useWorkspace`) the model restores from
workspace appState and debounce-saves every change.

**Rule:** The APP owns the instance — create ONE `Documents` per app and
pass it down; DocTabs and DocSplitLayout only read from and dispatch to it.

| Method | Signature | Note |
| --- | --- | --- |
| `new Documents(vfs?, workspace?)` | `(IVirtualFileSystem \| null, WorkspaceBinding?)` | Create; with a binding, restores + debounce-saves. |
| `useStore` / `getState` / `subscribe` | hook / snapshot / listener | `DocumentsState = { documents, editors, groups, rootNode, activeGroupId }`. |
| `openDocument` | `(uri, groupId?) => Promise<void>` | Open (or focus) a VFS-backed document. |
| `openStaticDocument` | `(uri, label, content?, groupId?) => void` | Non-VFS document (monitor/webview); never dirty. |
| `createDocument` | `(groupId?, initialContent?) => string` | New untitled; returns the URI. |
| `updateContent` | `(uri, content) => void` | Set content, mark dirty (no-op if unchanged). |
| `saveDocument` / `revertDocument` | `(uri) => Promise<void>` | Write VFS + mark clean / re-read discarding changes. |
| `closeEditor` / `discardDocument` | `(editorId)` / `(uri)` | Close one editor (disposes clean docs, collapses empty groups) / force-remove regardless of dirty. |
| `splitGroup` / `splitGroupWithDocument` | `(groupId, orientation) => string` | Split a pane (empty / cloning the active doc); returns the new group id. |
| `moveEditor` / `closeGroup` | `(editorId, targetGroupId)` / `(groupId)` | Move editor between groups / close a group. |
| `setActiveEditor` / `setActiveGroup` | `(groupId, editorIndex)` / `(groupId)` | Activate an editor / focus a group. |
| `updateEditorViewport` / `updateEditorViewState` | `(editorId, patch) => void` | Persist scroll/cursor / opaque view state (Monaco). |
| `updateSplitSizes` | `(splitNodeId, [a, b]) => void` | Persist pane sizes after drag resize. |
| `destroy` | `() => void` | Flush persistence, clear state on teardown. |

```tsx
import { useMemo } from 'react';
import { Documents, useWorkspace } from 'shell';

const { appState, updateAppState } = useWorkspace();
const docs = useMemo(() => new Documents(vfs, { appState, updateAppState }), []);

await docs.openDocument('ingest/analyze.pipe');
docs.updateContent('ingest/analyze.pipe', nextContent); // marks dirty
await docs.saveDocument('ingest/analyze.pipe');         // writes VFS, marks clean

const state = docs.useStore();  // re-render on every model change
```

### DocTabs

The document tab strip at the top of the client area — one tab per open
editor per group: modified dots, hover close, drag to reorder and between
split groups. Anything that opens a document (Explorer `onOpenFile`, deep
links) adds a tab.

**Rule:** Never draw a lookalike tab bar for documents. For pages INSIDE one
document use TabControl — DocTabs only switches documents.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `docs` | `Documents` | in (req) | The app-owned document store. |
| `groupId` | `string` | in (req) | The editor group whose tabs render here. |
| `isActive` | `boolean` | in | Focused group (brand underline). |
| `canClose` | `boolean` | in | Whether the group may be closed (false when it is the only one). |
| `onDirtyClose` | `(editorId, documentUri) => void` | out | Fired instead of closing on unsaved changes; the app shows its confirm dialog. |
| `onSplit` | `(groupId, orientation) => void` | out | Requests splitting this group. |
| `onCloseGroup` | `(groupId) => void` | out | Requests closing this group. |

### DocSplitLayout

The recursive split-tree renderer for the client area: walks the model's
`LayoutNode` tree, renders one resizable pane per leaf via
`renderPane(groupId)` — typically a `DocTabs` strip plus the editor for its
active document. Drag-resizes are debounced back into the model, so pane
sizes persist with the workspace. Props: `docs: Documents` (in, req);
`renderPane: (groupId: string) => ReactNode` (in, req).

**Rule:** The layout tree lives in the Documents model — splitting/closing
panes are MODEL operations (`splitGroup` / `closeGroup`), usually triggered
from DocTabs callbacks.

```tsx
import { Documents, DocTabs, DocSplitLayout } from 'shell';

<DocSplitLayout
	docs={docs}
	renderPane={(groupId) => (
		<>
			<DocTabs
				docs={docs}
				groupId={groupId}
				isActive={docs.useStore().activeGroupId === groupId}
				onSplit={(id, orientation) => docs.splitGroupWithDocument(id, orientation)}
				onCloseGroup={(id) => docs.closeGroup(id)}
			/>
			<PipelineEditor docs={docs} groupId={groupId} />
		</>
	)}
/>
```

### DocExplorer

The document system's name for Explorer — a thin re-export, not a fork; the
identical component with `Doc*` type aliases (`DocExplorerProps` =
`IExplorerProps`, `DocExplorerConfig` = `ExplorerConfig`, `DocEntry` =
`ExplorerEntry`, `DocEntryChild` = `ExplorerChild`, `DocEntryStatus` =
`ExplorerStatus`). See **Explorer** for the prop table. Typical wiring:
`onOpenFile={(path) => docs.openDocument(path)}`.

---

## Content components

The stock building blocks apps compose inside the client area.

### Banner

Info / warning / error callout strip — a tinted, bordered message row for
inline notices inside a view.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `variant` | `'info' \| 'warning' \| 'error'` | in (req) | Selects border, text, tinted background token. |
| `children` | `ReactNode` | in (req) | Message content. |

```tsx
import { Banner } from 'shell';
<Banner variant="info">Deploys are paused while the pipeline rebuilds.</Banner>
```

### Button

The stock action button: primary / secondary / ghost / danger variants, with
small (26px) and mini (16px, canvas chrome) sizes.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'danger'` | in | Default `'primary'`. |
| `small` | `boolean` | in | Compact 26px size. |
| `mini` | `boolean` | in | Micro 16px size (canvas-node chrome). Wins over `small`. |
| `disabled` | `boolean` | in | Dimmed and non-interactive. |
| `children` | `ReactNode` | in (req) | Label / content. |
| `title` | `string` | in | Native tooltip. |
| `pressed` | `boolean` | in | Rendered as `aria-pressed` (toggle usage). |
| `ariaExpanded` | `boolean` | in | Rendered as `aria-expanded` (dropdown-trigger usage). |
| `onClick` | `() => void` | out | Click handler. |

```tsx
import { Button } from 'shell';

<Button onClick={handleClick}>Run pipeline</Button>
<Button variant="secondary" small onClick={refresh}>Refresh</Button>
<Button variant="danger" disabled={!canDelete} onClick={remove}>Delete</Button>
```

### Card

Bordered content group: header row + body. `onClick` makes the whole card
interactive (pointer, hover border shift, button semantics).

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `header` | `ReactNode` | in | Header — plain string title or custom node. |
| `headerActions` | `ReactNode` | in | Right side of the header row. |
| `children` | `ReactNode` | in (req) | Card body. |
| `toolbar` | `ReactNode` | in | Row beneath the header, above the body (filter/search strips), own divider. |
| `noBodyPadding` | `boolean` | in | Drop body padding (tables/media that fill the card). |
| `fill` | `boolean` | in | Fill parent height, flex the body — pair with `noBodyPadding` to host an internally-scrolling grid. |
| `onClick` | `() => void` | out | Makes the whole card clickable. |

```tsx
import { Card, Button } from 'shell';

<Card header="Last ingest"
	headerActions={<Button variant="secondary" small onClick={refresh}>Refresh</Button>}>
	Ingest finished for 1,284 documents.
</Card>
```

### ChatView

The single chat implementation, everywhere: message thread + input sharing
one centered column (720px cap, exported as `CHAT_COLUMN_MAX_WIDTH`),
markdown rendering, typing indicator, in-thread error banners. The host owns
the message state and transport (via `useChatMessages`); ChatView only
renders and collects input. The composer is disabled while `isConnected` is
false. `MessageList` (the scrollable thread with scroll-locked autoscroll;
props `{ messages, isTyping, emptyTitle?, emptyDescription? }`) is exported
for custom layouts.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `messages` | `ChatMessage[]` | in (req) | Managed by the host via `useChatMessages`. |
| `isTyping` | `boolean` | in (req) | Assistant is composing (typing indicator). |
| `isConnected` | `boolean` | in (req) | Gates the input. |
| `placeholder` | `string` | in | Input placeholder. Default "Ask anything...". |
| `emptyTitle` / `emptyDescription` | `string` | in | EmptyState text when there are no messages. |
| `leadingInputSlot` | `ReactNode` | in | Node before the input (reserved for attachments). |
| `onSend` | `(text: string) => void` | out (req) | User submitted a message. |

`ChatMessage`: `{ id: number, text (markdown ok), sender: 'user' | 'bot' |
'system' | 'status', timestamp: string, resultKey? (pipeline result key
label under bot bubbles), sseType?, meta? (e.g. "2,340 tokens - 1.8s"),
isError? (renders as an in-thread error Banner instead of a bubble) }`.
`'status'` messages are SSE progress lines grouped as a thinking group.

**Wiring ChatView to a chat pipeline** — the verified recipe.
`sendMessage(text, client, token)` appends the user message, builds the
question with the last 6 non-system/status messages as history, calls
`client.chat({ token, question, onSSE })`, streams SSE progress in as
`'status'` messages, appends the pipeline's text/answers results as bot
messages, and turns thrown errors into `isError` messages. The token comes
from starting the pipeline once with `client.use(...)`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatView, useChatMessages, useShellConnection } from 'shell';

function PipelineChat({ pipeline }: { pipeline: object }) {
	const { client, isConnected } = useShellConnection();
	const [token, setToken] = useState<string | null>(null);
	const startedRef = useRef(false);

	// Start the chat pipeline ONCE; keep its token for every send.
	useEffect(() => {
		if (!isConnected || !client || startedRef.current) return;
		startedRef.current = true;
		client.use({ pipeline, useExisting: true, name: 'My Chat' })
			.then((result) => setToken(result.token))
			.catch(() => { startedRef.current = false; });
	}, [isConnected, client]);

	const { messages, isTyping, sendMessage } =
		useChatMessages({ welcomeMessage: 'Hi - ask me anything.' });

	const handleSend = useCallback((text: string) => {
		if (!client || !token) return;
		void sendMessage(text, client, token);
	}, [client, token, sendMessage]);

	return (
		<ChatView
			messages={messages}
			isTyping={isTyping}
			isConnected={isConnected && !!token}
			onSend={handleSend}
			placeholder="Ask about your documents..."
		/>
	);
}
```

`useChatMessages(options?)` — options `{ welcomeMessage?, initialMessages? }`
(`initialMessages` restores a saved conversation) — returns `{ messages,
isTyping, sendMessage(text, client, authToken), clearMessages,
addSystemMessage }`. `clearMessages()` resets the thread to the welcome
message; `addSystemMessage(text)` appends a system note. Persist only
`user`/`bot` messages; `system`/`status` are ephemeral.

### MarkdownRenderer

(Shell surface export used by ChatView's bot bubbles; also usable directly.)
Renders markdown/GFM to themed React — the one renderer for chat responses,
README previews, and pipeline-produced rich text. Props: `content: string`
(in, req). Verified behavior:

- **GFM** — tables (in a horizontally-scrolling wrapper), task lists,
  strikethrough.
- **Raw HTML** allowed but sanitized (GitHub schema). Images may use
  `data:image/*` sources and keep `width`/`height` — how hosts inline local
  images; scriptable URLs stay blocked.
- **Fenced ` ```html ` blocks** render live in a sandboxed iframe
  (`sandbox="allow-scripts"`); full documents as-is, fragments get a minimal
  wrapper.
- **Fenced ` ```chartjs ` blocks** render as a live chart — the body is a
  Chart.js config as JSON (stringified function values are stripped; invalid
  configs show an inline error card).
- **Other fenced code** gets syntax highlighting by language tag.
- **Links** restricted to `http(s)` / `mailto` / `tel`; open in a new tab
  with `rel="noopener noreferrer"`.

```tsx
import { MarkdownRenderer } from 'shell';
<MarkdownRenderer content={readmeText} />
```

### Chip / ChipAdd

Removable tag pill plus the matching add affordance — permissions, labels,
tag sets.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `label` | `string` | in (req) | Tag label (Chip) / add-affordance label after the plus glyph (ChipAdd). |
| `onRemove` | `() => void` | out | Chip only — when provided, renders a remove glyph. |
| `onClick` | `() => void` | out (req) | ChipAdd only — add affordance activated. |

```tsx
import { Chip, ChipAdd } from 'shell';

<Chip label="deploy" onRemove={() => removeTag('deploy')} />
<ChipAdd label="Add permission" onClick={openPicker} />
```

### ConfirmDialog

The stock confirm/cancel dialog on Modal — the ONE way to confirm anything:
dirty closes, deletes, plan changes. Deliberately no corner close glyph:
Cancel is the dismiss control (Escape works too). Set `destructive` when the
action cannot be undone; `confirmDisabled` while a required input is
missing.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `title` | `string` | in (req) | Dialog title. |
| `message` | `ReactNode` | in (req) | Body — plain string or custom node. |
| `confirmLabel` | `string` | in | Primary button label. Default `'Save'`. |
| `cancelLabel` | `string` | in | Cancel label. Default `'Cancel'`. |
| `secondaryLabel` | `string` | in | Optional third action, between Cancel and confirm. |
| `destructive` | `boolean` | in | Danger styling on confirm. |
| `confirmDisabled` | `boolean` | in | Disable confirm. |
| `onConfirm` | `() => void` | out (req) | Confirmed. |
| `onCancel` | `() => void` | out (req) | Dismissed (Cancel or Escape). |
| `onSecondary` | `() => void` | out | Secondary action chosen. |

```tsx
import { ConfirmDialog } from 'shell';

{confirming && (
	<ConfirmDialog
		title="Delete pipeline?"
		message="chat.pipe has unsaved changes that will be lost."
		confirmLabel="Delete"
		destructive
		onConfirm={deletePipeline}
		onCancel={() => setConfirming(false)}
	/>
)}
```

### ConnectionCard

Source card: icon, name, address, StatusBadge, hover-revealed edit/delete —
plus the matching `ConnectionCardAdd` tile (`{ label, onClick }`).

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `icon` | `ReactNode` | in | Source icon (30px, inherits the card's icon colour). |
| `name` / `address` | `string` | in (req) | Source name / endpoint. |
| `status` | `'success' \| 'muted' \| 'error'` | in (req) | StatusBadge variant. |
| `statusLabel` | `string` | in (req) | StatusBadge label, e.g. "Connected". |
| `connected` | `boolean` | in | Brand border + brand icon colour. |
| `onEdit` / `onDelete` | `() => void` | out | Hover-revealed pencil / trash. |
| `onClick` | `() => void` | out | Select the whole card. |

```tsx
import { ConnectionCard, ConnectionCardAdd } from 'shell';

<ConnectionCard
	name="Production" address="wss://app.rocketride.io"
	status="success" statusLabel="Connected" connected
	onEdit={editConnection} onDelete={deleteConnection} onClick={selectConnection}
/>
<ConnectionCardAdd label="New Connection" onClick={createConnection} />
```

### ContentHeader

Page title (24/700) + subtitle (14, secondary) + right-aligned actions — the
first element of every page, below the TabControl strip.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `title` | `string` | in (req) | Page / document title. |
| `subtitle` | `string` | in | One-line description of the view. |
| `actions` | `ReactNode` | in | Right-aligned actions (primary Button at most once per view). |

```tsx
import { ContentHeader, Button } from 'shell';

<ContentHeader
	title="Connections"
	subtitle="Manage the sources this workspace ingests from."
	actions={<Button onClick={createConnection}>New connection</Button>}
/>
```

### DataGrid / CardDataGrid

Tabulator-based table: tri-state sorting, pagination, server-side search,
Excel-style per-column filter/format popups, per-user persisted layouts.
`CardDataGrid` is the identical component re-typed with `title` REQUIRED —
for call sites where the grid IS the card.

**Two data modes, mutually exclusive.** Local: pass `data` (the full row
set) — the grid pages, sorts, searches, and filters client-side; a new
`data` identity applies silently in place. Remote: pass `fetchPage` — called
with `{ page, size, sort, filters, search }` on every page / sort / filter /
search change; return `{ rows, total }`. This is how views feed the grid
from the server `list_*` APIs (their `ListPageRequest`/`ListPageResponse`
contract matches).

**Sorting** — headers tri-state sort. Local grids sort loaded rows; with
`remoteSort` the sorters ride the request (`sort: [{ field, dir }]`) so the
server sorts across all pages. Default sort: `rrDefaultSort` per column.

**Pagination** — footer pager + size selector; `pageSizes` default
`[10, 25, 50]` (first = initial). `paginate={false}` disables paging;
`height` enables internal scrolling + virtual DOM (pair with
`<Card fill noBodyPadding>`).

**Search** — magnifier-collapsed field in the title bar (250ms debounce).
Remote grids forward the term as `req.search` — the server matches
case-insensitively across the endpoint's searchable columns, so matches span
ALL pages. Local grids narrow across every string/number value.

**Filtering** — each column gets a header popup whose control follows its
`rrType` (`string` contains, `number` min/max, `date` range with optional
time, `boolean`, `enum`/`strings` checklist). Committed values reach
`req.filters` as: string = contains, array = IN, range bounds as separate
`${field}__gte` / `${field}__lte` keys. Pass `filters` (`IGridFilterDef[]`)
to also get the FilterStrip above the table — values auto-apply after a
300ms debounce; remote grids refetch from page 1, local grids filter their
own rows with the same semantics. `fetchDistinct` supplies checklist values
for `enum` columns on remote grids (wire to the server's `list_distinct`);
local grids derive uniques from loaded rows.

**Export** — gear menu CSV / JSON covering EVERY row matching the current
filters AND search (remote grids walk all pages at 100 rows/request, capped
at 10,000), restricted to visible columns in display order.

**Persistence** — a stable `tableId` persists layout (columns, sort, page
size, display settings) per user automatically over the grid config channel
(see *DataGrid helpers*): web shell answers from workspace prefs, VS Code
from project state, no bridge = declared defaults. "Reset layout" restores
the declared column contract.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `columns` | `GridColumnDefinition[]` | in (req) | Declare EVERY available column (contract below). Memoize. |
| `data` | `Row[]` | in | LOCAL mode row set. |
| `fetchPage` | `(req: IDataGridPageRequest) => Promise<IDataGridPage<Row>>` | in | REMOTE mode page fetcher; returns `{ rows, total }`. |
| `remoteSort` | `boolean` | in | Send sorters to `fetchPage` instead of sorting locally. |
| `tableId` | `string` | in | Stable id keying layout persistence. |
| `title` | `string` | in | Title-bar heading. Required on `CardDataGrid`. |
| `actions` | `ReactNode` | in | Card action buttons; `actions` or `title` switches the bar to its card-header form (one shared header, not Card header + grid bar). |
| `noSearch` / `noExport` | `boolean` | in | Hide the title-bar search / the export section. Exceptional — search costs one glyph collapsed. |
| `pageSizes` | `number[]` | in | First entry = default size. Default `[10, 25, 50]`. |
| `paginate` | `boolean` | in | `false` disables pagination (no footer). |
| `height` | `string \| number` | in | Definite height; internal scroll + virtual DOM. |
| `emptyTitle` / `emptyDescription` | `string` | in | Empty-set placeholder text. |
| `filters` | `IGridFilterDef[]` | in | Grid-owned FilterStrip above the table (300ms debounce). |
| `onFiltersChange` | `(values: Record<string, string \| string[]>) => void` | out | Debounced committed filter values — optional observation hook (URL sync, strip-only keys). |
| `fetchDistinct` | `(field: string) => Promise<(string \| number \| boolean)[]>` | in | Distinct values for `enum` checklists on remote grids. |
| `autoColumns` | `boolean` | in | Derive addable hidden columns from undeclared row keys. Prefer declaring the full set (auto columns fall back to the text filter). |
| `persistence` | `IDataGridPersistence` | in | Adapter override. Normally OMITTED — `tableId` alone persists via the channel. |
| `options` | `Options` | in | Native Tabulator options escape hatch, merged over defaults. |
| `onRowClick` | `(row: Row) => void` | out | Row activation — typically opens the record DetailPanel. Ignored for clicks on action buttons. |
| `onLoadError` | `(error: Error) => void` | out | Remote load failure (prior rows kept; brief overlay). |

`GridColumnDefinition` — any native Tabulator column option (`title`,
`field`, `width`, `formatter`, `headerSort`, ...) plus the rr extensions:

| Extension | Type | Note |
| --- | --- | --- |
| `rrDescription` | `string` | REQUIRED — header tooltip + COLUMNS toggle-list tooltip. State what the value IS. |
| `rrType` | `'string' \| 'number' \| 'boolean' \| 'date' \| 'enum' \| 'strings' \| 'json'` | Value type — selects the filter control. |
| `rrDefault` | `boolean` | Part of the DEFAULT view; default order = order of flagged columns in the array. Unflagged = available (toggleable, filterable, exportable) but hidden. A saved user layout wins; Reset restores the declared defaults. |
| `rrDefaultSort` | `'asc' \| 'desc'` | Contributes to the default sort (composes in array order; sent on the first remote request). |
| `rrGroup` | `boolean` | Default row grouping by this column (client-side). |
| `rrOptions` | `(string \| { value, label })[]` | Curated filter vocabulary — checklist of these options unioned with live distinct values. How enum-like strings and JSON string-array columns get real selectors. |
| `rrNoPopup` | `boolean` | Exempt from the header popup and toggle list (icon/chrome columns). |

Ref handle `IDataGridHandle`: `table` (the live Tabulator instance),
`refetch({ resetPage? })` (re-run the remote query; `resetPage` returns to
page 1), `resetLayout()` (drop persisted layout, sort, filters, search, then
rebuild). `IDataGridPageRequest`: `page` (1-based), `size`, `sort`
(populated only with `remoteSort`), `filters`, `search?` (present only when
non-empty — forward verbatim as the `list_*` `search` arg).

```tsx
import { useRef } from 'react';
import { DataGrid } from 'shell';
import type { GridColumnDefinition, IDataGridHandle } from 'shell';

const columns: GridColumnDefinition[] = [
	{ title: 'Name', field: 'name', rrType: 'string', rrDefault: true, rrDescription: 'Pipeline file name.' },
	{ title: 'Documents', field: 'documents', rrType: 'number', rrDefault: true, rrDescription: 'Documents processed by the last run.' },
	{ title: 'Updated', field: 'updated', rrType: 'date', rrDefault: true, rrDefaultSort: 'desc', rrDescription: 'Date of the last run.' },
	{ title: 'Status', field: 'status', rrType: 'enum', rrOptions: ['running', 'stopped'], rrDescription: 'Run state.' },
];

// Local mode - the grid pages/sorts/filters the rows itself:
<DataGrid title="Pipelines" columns={columns} data={rows} />

// Remote mode - fetchPage on every page/sort/filter/search change:
const grid = useRef<IDataGridHandle>(null);
<DataGrid
	ref={grid}
	tableId="pipelines"
	title="Pipelines"
	columns={columns}
	remoteSort
	fetchPage={({ page, size, sort, filters, search }) =>
		client.listPipelines({ page, size, sort, filters, search })}
	onRowClick={(row) => openDetail(row)}
/>
// After a mutation: re-request the current page.
grid.current?.refetch();

// CardDataGrid: identical API, title required - the grid IS the card.
// <CardDataGrid title="Team members" columns={columns} fetchPage={fetchMembers} />
```

### DataGrid helpers

The toolkit around the grid: DOM cell factories, the actions-column builder,
the local-search predicate, and layout persistence.

Tabulator formatters build DOM **outside React**, so custom cells are
assembled from these factories instead of JSX — each returns a token-styled
`HTMLElement` ready to return from a `formatter`. `autoFormatter` is the
default when a column declares none: booleans as yes/no badges, ISO dates as
muted local datetimes, arrays as badge lists, objects as truncated JSON.

| Function | Signature | Note |
| --- | --- | --- |
| `badgeEl` | `(variant, label) => HTMLElement` | Status pill; variants `'success' \| 'info' \| 'warning' \| 'error' \| 'muted'`. |
| `buttonEl` | `(kind, label, action) => HTMLElement` | Small action button; `data-action` routes clicks. Kinds `'ghost' \| 'secondary' \| 'danger'`. |
| `avatarEl` | `(initials, background) => HTMLElement` | 32px round avatar with initials. |
| `monoEl` / `mutedEl` | `(text) => HTMLElement` | Monospace span (ids) / muted secondary span (dates). |
| `autoFormatter` | `(cell) => HTMLElement \| string` | Type-heuristic default formatter. |
| `matchesSearch` | `(row, term) => boolean` | Case-insensitive substring match over every string/number value; empty term matches all. The grid's local-search semantics, exported for host-side lists. |
| `createActionsColumn` | `<Row>(config) => GridColumnDefinition` | Trailing right-aligned Actions column — exempt from sort/move/popup, excluded from row-click. Config: `{ actions: IGridAction[], onAction(key, row), width? (default 120) }`; `IGridAction` = `{ key, label, kind? }`, `label`/`kind` may be functions of the row. |

```tsx
import { createActionsColumn, badgeEl } from 'shell';
import type { GridColumnDefinition } from 'shell';

const columns: GridColumnDefinition[] = [
	{ title: 'Status', field: 'status', rrType: 'enum', rrDescription: 'Run state.',
		formatter: (cell) => badgeEl(cell.getValue() === 'running' ? 'success' : 'muted', cell.getValue()) },
	createActionsColumn({
		actions: [
			{ key: 'open', label: 'Open' },
			{ key: 'delete', label: 'Delete', kind: 'danger' },
		],
		onAction: (key, row) => handleAction(key, row),
	}),
];
```

**Layout persistence** — host-agnostic and normally invisible: a grid with a
`tableId` persists over the `rr:grid-config:*` CustomEvent channel by
default; whatever host is present answers. Touch these exports only when
building a host bridge or a custom store:

| Name | Type | Note |
| --- | --- | --- |
| `createMessageGridPersistence` | `() => IDataGridPersistence` | Channel adapter; reads seed a per-instance cache with ONE synchronous `get` per tableId (the bridge replies before dispatch returns); writes/clears fire-and-forget. No bridge = reads return false (defaults apply), writes drop. |
| `IDataGridPersistence` | `{ read(tableId, type), write(tableId, type, data), clear(tableId) }` | Storage contract. `read` MUST be synchronous (Tabulator reads persistence synchronously); returns the blob or `false`. |
| `DataGridLayout` | `Record<string, unknown>` | Blobs for one table, keyed by Tabulator persistence type (`'sort'`, `'columns'`, `'page'`, ...). |
| `GRID_CONFIG_GET` | `'rr:grid-config:get'` | Synchronous read. Detail `{ tableId, reply(layouts \| undefined) }`. |
| `GRID_CONFIG_SET` | `'rr:grid-config:set'` | Persist one blob. Detail `{ tableId, type, blob }`. |
| `GRID_CONFIG_CLEAR` | `'rr:grid-config:clear'` | Drop every blob for a table (Reset layout). Detail `{ tableId }`. |

### DetailPanel / PanelTabBody

THE record panel: one slide-over surface for inspect / edit / create —
EntityHeader + optional tabs + sectioned body + footer verb row. Stacks,
resizes, and can anchor `contained` to the record-owning surface. With
`tabs`, the panel's outer body does not scroll — wrap every tab's content in
`PanelTabBody` (props: `children`, req — the stock scroll wrapper that owns
the tab's scrolling).

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `open` | `boolean` | in (req) | False = renders nothing. |
| `title` | `string` | in (req) | Entity title — 17px/700. |
| `subtitle` | `string` | in | Secondary line under the title. |
| `avatar` | `ReactNode` | in | 42px round avatar/icon slot in the EntityHeader. |
| `tabs` | `ViewMenuEntry[]` | in | Optional tab strip (ViewMenu entry shape), with `activeTab` / `onTabSelect`. |
| `activeTab` | `string` | in | Active tab id (brand underline). |
| `children` | `ReactNode` | in (req) | Body — Section / LabelValue / Chip / StatusBadge / MiniContainer / Button. |
| `footer` | `ReactNode` | in | Fixed action row below the scrolling body (Save / Cancel / destructive verbs). |
| `side` | `'right' \| 'bottom'` | in | `'right'` (default) full-height drawer; `'bottom'` full-width tray for wide ambient content (consoles, logs). |
| `width` / `height` | `number` | in | Drawer width (right) / tray height (bottom), px. |
| `minWidth` | `number` | in | Resize floor override (right only; default 380). Lower for palettes that read fine narrow. |
| `contained` | `boolean` | in | Anchor to the nearest positioned ancestor instead of the viewport — host surface must be `position: relative` + `overflow: hidden`. For drawers inside dialogs. |
| `resizable` | `boolean` | in | Growing-edge drag resizing, ON by default. Clamps between the floor and 85% of the owning surface; double-click restores the default; in a stack only the top handle is live. |
| `flushBody` | `boolean` | in | Body hosts a full View owning its own scrolling — body becomes a definite non-scrolling flex box, no padding. Ignored with `tabs`. |
| `dirty` | `boolean` | in | Form holds unsaved changes — arms the DISCARD GUARD: Escape, back, sliver click, and header close raise the stock "Discard changes?" confirm instead of exiting silently. |
| `editing` | `boolean` | in | In a FORM mode (Edit/Create). Escape acts as Cancel (guarded by `dirty`) and calls `onExitMode` instead of closing. |
| `busy` | `boolean` | in | Async record action in flight — the panel is undismissable. |
| `modeless` | `boolean` | in | No dim backdrop; pointer/drag events pass through to the surface behind (tool/palette drawers over a live canvas). Not for records. |
| `persistKey` | `string` | in | Opt-in width persistence via the ambient prefs (one STABLE key per panel role). Omitted = session-local sizing. |
| `onClose` | `() => void` | out (req) | Dismissed (close glyph or Escape). |
| `onTabSelect` | `(id: string) => void` | out | Tab selected. |
| `onExitMode` | `() => void` | out | Leave form mode back to Inspect (Escape's Cancel path, confirmed discard). Create-mode panels typically close instead. |

```tsx
import { DetailPanel, Section, LabelValue, Button } from 'shell';

<DetailPanel
	open={open}
	onClose={() => setOpen(false)}
	title="chat.pipe"
	subtitle="Pipeline - deployed 2 hours ago"
	footer={<>
		<Button variant="secondary" onClick={close}>Cancel</Button>
		<Button onClick={save}>Save</Button>
	</>}
>
	<Section label="Details">
		<LabelValue label="Name">chat.pipe</LabelValue>
	</Section>
</DetailPanel>
```

### DropZone

Dashed file-drop target — fires `onFiles` with the dropped FileList.
Verified behavior: the whole zone is also a click-to-browse button backed by
a hidden `<input type="file" multiple>`, keyboard-operable via Enter /
Space, with a brand highlight during drag-over. **Multiple files** are
supported by drop and picker. There is **no accepted-types prop** — the
component never filters by extension or MIME type; `hint` only COMMUNICATES
the supported formats, and the host validates inside `onFiles`. The hidden
input resets after each pick, so choosing the same file twice fires again.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `title` | `string` | in (req) | Primary prompt, e.g. "Drop documents here to ingest". |
| `hint` | `string` | in | Secondary hint (e.g. supported formats). Informational only. |
| `onFiles` | `(files: FileList) => void` | out (req) | Dropped or picked files (may contain multiple). |

```tsx
import { DropZone } from 'shell';

<DropZone
	title="Drop documents here to ingest"
	hint="Supports PDF, TXT, MD, HTML, CSV"
	onFiles={(files) => {
		// The host validates types - DropZone does not filter.
		const accepted = Array.from(files).filter((f) => /\.(pdf|txt|md|html|csv)$/i.test(f.name));
		void uploadFiles(accepted);
	}}
/>
```

### EmptyState

Icon + title + description + optional single action — the standard
nothing-here placeholder for lists, panels, and panes.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `icon` | `ReactNode` | in | Icon above the title (inherits the disabled text colour). |
| `title` | `string` | in (req) | Heading line. |
| `description` | `string` | in | Supporting line. |
| `action` | `ReactNode` | in | Single action (at most one Button). |

```tsx
import { EmptyState, Button } from 'shell';

<EmptyState
	title="No pipelines yet"
	description="Create your first pipeline to start processing documents."
	action={<Button onClick={createPipeline}>New pipeline</Button>}
/>
```

### FilterStrip

The DataGrid's built-in filter row: one labelled control per definition —
text, select, date, or async typeahead. Normally you never mount it: pass
`filters` to `DataGrid` and the grid renders the strip, debounces edits
(300ms), and applies the values (remote refetch / local predicate). Mount
directly only for filter bars over non-grid content, holding the values
yourself — there is no Apply button; every edit fires `onChange`.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `defs` | `IGridFilterDef[]` | in (req) | Controls to render, in order. |
| `values` | `Record<string, string \| string[]>` | in (req) | Committed values keyed by def key (shared with header-popup filters, so values may be arrays; the strip's own controls are string-valued). |
| `labels` | `Record<string, string>` | in (req) | Display labels for typeahead selections, keyed by def key. |
| `onChange` | `(key, value, label?) => void` | out (req) | Every user edit (`''` clears; `label` accompanies typeahead picks). |

`IGridFilterDef`: `key` + `label` (required), `type: 'text' | 'select' |
'date' | 'typeahead'` (required), `placeholder?`, `options?` (`{ value,
label }[]` — include an empty-value "All ..." entry), `search?: (query) =>
Promise<IGridFilterOption[]>` (typeahead lookup), `width?` (px; per-type
defaults, text/typeahead 180).

```tsx
import { DataGrid } from 'shell';
import type { IGridFilterDef } from 'shell';

// The normal path: DataGrid renders the strip itself.
const filters: IGridFilterDef[] = [
	{ key: 'name', label: 'Name', type: 'text', placeholder: 'Search name' },
	{ key: 'status', label: 'Status', type: 'select', options: [
		{ value: '', label: 'All statuses' },
		{ value: 'running', label: 'Running' },
	] },
	{ key: 'owner', label: 'Owner', type: 'typeahead', search: lookupUsers },
];

<DataGrid title="Pipelines" columns={columns} filters={filters} fetchPage={fetchPipelines} />
```

### InputField

The stock text-input base — a styled native input carrying the full
`InputHTMLAttributes<HTMLInputElement>` surface. No custom props: `value`,
`placeholder`, `type` (`text` / `password` / `number` / ...), `disabled`,
`onChange`, and every other native input attribute pass straight through.

```tsx
import { InputField } from 'shell';

<InputField placeholder="Pipeline name"
	value={name} onChange={(e) => setName(e.target.value)} />
<InputField type="password" placeholder="API key"
	value={key} onChange={(e) => setKey(e.target.value)} />
```

### MiniCard / MiniContainer

Compact metric tile — big value (22px/700) over an uppercase label — laid
out in equal columns by the MiniContainer grid row (16px gaps).

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `value` | `ReactNode` | in (req) | MiniCard — the metric value. |
| `label` | `string` | in (req) | MiniCard — caption beneath the value, uppercase by default. |
| `title` | `string` | in | MiniCard — optional uppercase heading ABOVE the value. Prefer plain `label`. |
| `color` | `string` | in | MiniCard — CSS colour for the value text (e.g. `'var(--rr-color-success)'`). |
| `columns` | `number` | in | MiniContainer — explicit column count; default one per child. |
| `children` | `ReactNode` | in (req) | MiniContainer — the MiniCards to lay out. |

```tsx
import { MiniCard, MiniContainer } from 'shell';

<MiniContainer>
	<MiniCard value="1,284" label="Documents" />
	<MiniCard value="98.2%" label="Success rate" color="var(--rr-color-success)" />
	<MiniCard value="14s" label="Avg duration" />
</MiniContainer>
```

### Modal

The stock dialog: a centered box over a dimmed INERT backdrop —
outside-click never closes. For **multi-step flows and pickers**; use
`ConfirmDialog` for confirmations, `DetailPanel` for the app's own records.
Free behavior: page-scroll lock, Tab focus trap, prior-focus restore, a
layered overlay stack (Escape only closes the topmost), and the top-right
close glyph appearing exactly when there is no footer. Helper: `CLOSE_GLYPH`
(exported string, U+2715) — the one canonical close glyph for custom
affordances.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `title` | `ReactNode` | in (req) | Header title — plain string or custom node (pair with `ariaLabel`). |
| `children` | `ReactNode` | in (req) | Body content. |
| `footer` | `ReactNode` | in | Footer action row (Cancel / primary). Its presence hides the default close glyph. |
| `showClose` | `boolean` | in | Force the close glyph on/off; default "only when there is no footer". |
| `closeOnEscape` | `boolean` | in | Escape closes. Default true. |
| `width` | `number` | in | Box width, px. Default 440. |
| `noBodyPadding` | `boolean` | in | Drop body padding for content that fills the box (e.g. a DataGrid). |
| `ariaLabel` | `string` | in | Accessible label when `title` is not a plain string. |
| `onClose` | `() => void` | out (req) | Dismissed (close glyph or Escape). |

```tsx
import { Modal, Button } from 'shell';

{open && (
	<Modal title="Add source" onClose={() => setOpen(false)}
		footer={<>
			<Button variant="secondary" small onClick={() => setOpen(false)}>Cancel</Button>
			<Button small onClick={onSave}>Save</Button>
		</>}>
		{/* body */}
	</Modal>
)}
```

### SaveFileDialog

(Shell surface export; opened from code, not browsed in the gallery.) The
platform's stock "Save As" dialog over a virtual file system — one dialog
for every host and file kind. Verified behavior: the tree root renders as
`rootLabel`; `defaultDir` is preselected and rendered EVEN WHEN it does not
exist yet (a dimmed "ghost" row) — missing segments are created via
`vfs.mkdir` only when the save is confirmed. Folders can be created inline;
row click selects, ONLY the chevron toggles expansion. Files matching the
active type show dimmed for context; saving onto one routes through an
explicit overwrite confirm. Name entry is forgiving: bare base name OR full
filename; a typed extension matching the active type is not doubled, and a
different known type's extension switches the type picker. The live result
path is always visible under the name input.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `title` | `string` | in (req) | Dialog title, e.g. "Save Pipeline As". |
| `vfs` | `IVirtualFileSystem` | in (req) | Browsed file system — only `list` and `mkdir` are called. |
| `fileTypes` | `ISaveFileType[]` | in (req) | `{ label, extension }` (extension WITH the dot, e.g. `'.pipe'`). First = initial selection; a single-entry list hides the type picker. |
| `rootLabel` | `string` | in | Tree-root label. Default `"$/"`. |
| `defaultDir` | `string` | in | Preselected directory, `/`-separated relative to the VFS root; ghost-rendered when missing. |
| `initialName` | `string` | in | Initial name-input value (no extension). |
| `onConfirm` | `(path: string) => void` | out (req) | Chosen path (extension included) AFTER missing directories were created. The caller performs the write. |
| `onCancel` | `() => void` | out (req) | Dismissed (Cancel or Escape). |

```tsx
import { SaveFileDialog } from 'shell';

{saving && (
	<SaveFileDialog
		title="Save Pipeline As"
		vfs={vfs}
		fileTypes={[{ label: 'RocketRide Pipeline', extension: '.pipe' }]}
		defaultDir="pipelines"
		initialName="untitled"
		onConfirm={(path) => { void writePipeline(path); setSaving(false); }}
		onCancel={() => setSaving(false)}
	/>
)}
```

### PopupRow

A single clickable item inside a popup menu: the hover-highlighted flex row
used by every kebab / footer / context menu. Content is free-form children
(icon + label + chevron). Pair with `useFixedPopupPosition` for the anchored
container and `useClickOutside` for dismissal. Props: `children` (in, req);
`onClick?: (e: MouseEvent) => void` (out).

```tsx
import { PopupRow, BxCog, BxTrash } from 'shell';

<div style={popupStyle}>
	<PopupRow onClick={openSettings}><BxCog size={16} /> Settings</PopupRow>
	<PopupRow onClick={remove}><BxTrash size={16} /> Delete</PopupRow>
</div>
```

### RocketRideMark

The RocketRide rocket brand mark (icon only): body fill follows the text
colour (`currentColor`; override with `color` / `bodyColor`), exhaust swoosh
stays the fixed RocketRide red — reads correctly on any theme. Use wherever
the product identifies itself: empty states, about panes, anonymous user
cards. Props: `size?: number` (default 24), `color?`, `bodyColor?`
(overrides `color`), `className?` / `style?`.

```tsx
import { RocketRideMark } from 'shell';
<RocketRideMark size={48} />
```

### Section / LabelValue

Uppercase section label with divider + fixed-width label/value rows — the
DetailPanel body vocabulary.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `label` | `string` | in (req) | Uppercase section label (Section) / row label in the fixed-width left column (LabelValue). |
| `children` | `ReactNode` | in (req) | Section body (typically LabelValue rows) / the row value. |
| `mono` | `boolean` | in | LabelValue only — monospace value. |

```tsx
import { Section, LabelValue, StatusBadge } from 'shell';

<Section label="Details">
	<LabelValue label="Name">chat.pipe</LabelValue>
	<LabelValue label="Task id" mono>rod.demo.chat</LabelValue>
	<LabelValue label="Status"><StatusBadge variant="success">Running</StatusBadge></LabelValue>
</Section>
```

### StatusBadge / StatusDot

Dot + label pill in five semantic variants, plus the bare StatusDot for
inline state. `StatusBadge` takes `variant` + `children` (both required);
`StatusDot` takes `variant` alone. Variants: `'success' | 'info' |
'warning' | 'error' | 'muted'` — selects the palette for dot, text, and
tinted pill.

```tsx
import { StatusBadge, StatusDot } from 'shell';

<StatusBadge variant="success">Connected</StatusBadge>
<StatusBadge variant="error">Failed</StatusBadge>
<StatusDot variant="warning" />
```

### TabControl + TabPanel

The page-tabs pattern: TabControl renders the strip at the very top of a
view (above its ContentHeader); TabPanel renders the panel stack beneath it
with every panel MOUNTED — inactive panels hide with `display: none` so
state survives switches.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `menu` | `ViewMenu` | in (req) | TabControl — entries render as strip tabs (id, label, count, severity; entry shape under SidebarMenu). |
| `activeId` | `string` | in (req) | Active entry / visible panel. |
| `trailing` | `ReactNode` | in | TabControl — right-aligned slot (e.g. an id note). |
| `panels` | `Record<string, { content: ReactNode }>` | in (req) | TabPanel — panel id to content. Hidden panels measure 0x0: canvases must lazy-mount on first activation. |
| `onSelect` | `(id: string) => void` | out (req) | TabControl — entry selected. |

```tsx
import { TabControl, TabPanel } from 'shell';

const menu = { entries: [
	{ id: 'overview', label: 'Overview' },
	{ id: 'events', label: 'Events', count: 48 },
	{ id: 'settings', label: 'Settings' },
] };

<TabControl menu={menu} activeId={tab} onSelect={setTab} />
<TabPanel activeId={tab} panels={{
	overview: { content: <OverviewPanel /> },
	events: { content: <EventsPanel /> },
	settings: { content: <SettingsPanel /> },
}} />
```

### ToggleGroup

Segmented control for time ranges and mode switches — single-select by
default, multi-select via the discriminated `multi` prop (a TypeScript union
enforces each mode's prop set). Built on the stock small Button.

| Prop | Type | Dir | Note |
| --- | --- | --- | --- |
| `options` | `{ id: T; label: string }[]` | in (req) | Ordered options. |
| `value` / `onChange` | `T` / `(id: T) => void` | in/out (req in mode) | Single-select: selected id + change handler. |
| `multi` | `true` | in | Opt into multi-select (switches to `values`/`onToggle`). |
| `values` / `onToggle` | `T[]` / `(id: T) => void` | in/out (req in mode) | Multi-select: active ids + flip handler. |
| `wrap` | `boolean` | in | Flow options onto multiple rows when they exceed the width. |
| `disabled` | `boolean` | in | Disable the entire group. |

```tsx
import { ToggleGroup } from 'shell';

// Single-select:
<ToggleGroup
	options={[{ id: 'hour', label: 'Hour' }, { id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }]}
	value={range}
	onChange={setRange}
/>

// Multi-select:
<ToggleGroup multi options={options} values={ranges}
	onToggle={(id) => setRanges((prev) =>
		prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id])} />
```

---

## Hooks & context

### Connection & client

The ONE connection: the shell-owned ConnectionManager singleton, the shared
RocketRideClient it serves, and the hooks to reach both. The shell
exclusively owns auth and the client — apps never construct a
`RocketRideClient` or wire their own connection. All client traffic is DAP
over the one WebSocket — no per-feature HTTP.

**Rule:** Apps NEVER initialize the ConnectionManager, construct clients, or
handle auth. Consume the connection; do not create it.

| Hook | Type | Note |
| --- | --- | --- |
| `useShellConnection` | `() => { client, isConnected, statusMessage }` | The everyday hook; re-renders on connect/disconnect and status changes. |
| `useClient` | `() => RocketRideClient \| null` | The shared client, null until connected. |
| `getClient` | `() => RocketRideClient \| null` | Non-React accessor to the same singleton (callbacks, module code). |
| `useConnectionStatus` | `() => ConnectionStatus` | Full state machine: state (`'disconnected' \| 'connecting' \| 'connected' \| 'failed' \| 'auth-failed'`), connectionMode, retryAttempt, lastError, progressMessage. |

ConnectionManager (advanced): `getInstance()` is the entry point;
`emit` / `on` / `onAny` are the typed event bus (`on()` replays buffered
user-intent events); `isConnected()` / `isConnecting()` /
`isDisconnected()`; `getConnectionStatus()` / `getAccountInfo()`;
`getDebugLog()` / `clearDebugLog()` back the ALT+D trace.
`initialize` / `connect` / `disconnect` / `logout` are HOST BOOTSTRAP ONLY.

```tsx
import { useShellConnection, useClient, getClient, Button } from 'shell';

function RunButton() {
	const { isConnected } = useShellConnection();
	const client = useClient();
	if (!client) return null;
	return <Button disabled={!isConnected} onClick={() => client.use({ pipeline })}>Run</Button>;
}

// Outside React (module code, event handlers):
const client = getClient();
if (client) await client.listTasks({ page: 1, page_size: 50 });
```

### Shell events

The typed platform event bus: every `shell:*` event in `ShellEventMap`,
subscribed via `useShellEvent(name, handler)` (typed payload, auto-cleanup,
handler ref stays current without resubscribing) and emitted with
`ConnectionManager.getInstance().emit(name, payload)`. Server pushes arrive
as `shell:event` carrying the raw DAP message — the one firehose for live
data. `useSubscriptions()` returns `{ desktopApps, isOnDesktop, getStatus }`
over the account's desktop apps. Press **ALT+D** to watch the bus live.

**Rule:** ShellEventMap is for shared platform events ONLY — never add
app-private messages to it.

Event catalog (`out` = the shell emits it; `in` = an app emits it):

| Event | Payload | Dir | Note |
| --- | --- | --- | --- |
| `shell:connected` / `shell:disconnected` | `void` / `{ reason, hasError }` | out | Handshake + auth succeeded / socket closed. |
| `shell:statusChange` | `ConnectionStatus` | out | Every state-machine transition. |
| `shell:statusMessage` | `{ message: string \| null }` | out | Transient status-bar text; null clears. |
| `shell:error` | `{ error }` | out | Connection or operation failure. |
| `shell:event` | `{ event: DAPMessage }` | out | EVERY server push — the live-data firehose. |
| `shell:accountUpdate` | `ConnectResult` | out | Account/subscription update. |
| `shell:servicesUpdated` | `{ services, icons?, servicesError? }` | out | Service catalog fetched or refreshed. |
| `shell:appsUpdated` | `{ apps: ShellAppEntry[] }` | out | App catalog changed (full replacement). |
| `shell:login` / `shell:logout` | `{ user: ConnectResult }` / `void` | out | Authenticated / identity cleared. |
| `shell:loginRequest` / `shell:logoutRequest` | `{ appId?, register? }` / `void` | in | UI-initiated sign-in / sign-out. |
| `shell:switchApp` | `{ appId }` | in | Switch the active app. |
| `shell:openOverlay` | `{ id: 'account' \| 'settings' \| 'environment' }` | in | Open a shell overlay (guarded allowlist). |
| `shell:subscribe` / `shell:unsubscribe` | `{ app, plan?, promo? }` / `{ appId }` | in | Open checkout for a paid app / subscription cancelled. |
| `shell:myApps` | `void` | in | Navigate to the My Apps launcher. |
| `shell:themeChange` | `{ tokens: Record<string, string> }` | out | Theme tokens changed — canvases repaint from these. |
| `shell:viewActivated` / `shell:sidebarCollapsing` | `{ viewId }` / `void` | out | View became active / sidebar starting to collapse. |
| `shell:manifestRefresh` | `{ source }` | out | Server-side app manifest changed (dev overlay, publish, expiry). |
| `app:statusChanged` | `{ appId, status, notes? }` | out | Marketplace review status changed. |
| `store:changed` | `{ prefix, paths }` | out | Files changed under a watched store prefix. |

```tsx
import { useShellEvent, ConnectionManager } from 'shell';

useShellEvent('shell:event', ({ event }) => {
	if (event.type === 'apaext_billing') refreshLedger();
});
useShellEvent('shell:themeChange', ({ tokens }) => repaintCanvas(tokens));

ConnectionManager.getInstance().emit('shell:switchApp', { appId: 'monitor' });
```

### Auth & identity

Identity is server-driven: `useAuthUser(): AuthUser | null` returns the
`ConnectResult` the server produced at connect — name, email, subscription,
apps, credits — or null when not authenticated. Apps read it; they never
write it. Trigger auth flows by emitting `shell:loginRequest` /
`shell:logoutRequest`. `useLogout()` currently always returns null (sign-out
is a shell page-reload flow) — a forward-compatible seam. The providers
(`CloudAuthProvider`, `ApiKeyAuthProvider`, `IAuthProvider`) are HOST
bootstrap machinery; hosted apps never touch them.

**Rule:** The shell owns auth end to end. Apps read identity via
`useAuthUser` and emit the intent events — never instantiate providers or
handle tokens.

```tsx
import { useAuthUser, ConnectionManager, Button } from 'shell';

function AccountCard() {
	const user = useAuthUser();
	if (!user) {
		return <Button onClick={() =>
			ConnectionManager.getInstance().emit('shell:loginRequest', {})
		}>Sign in</Button>;
	}
	return <span>{user.name} - {user.email}</span>;
}
```

### Workspace & prefs

Per-app persisted state, two layers:

- **`usePrefs()`** — the small surface most components want:
  `getPref(key)` / `setPref(key, value)` against the active app's prefs bag
  (writes shallow-merge). The ONE prefs API; no-op accessor without a
  provider.
- **`useWorkspace()`** — the full `IWorkspaceContext`; throws outside its
  provider. Key members: `prefs`/`updatePrefs`; `appState` +
  `updateAppState` (opaque app-owned state, functional updater — the
  Documents persistence binding); `settings` / `settingsOverrides` /
  `updateSetting(key, value?)` (effective settings = defaults + overrides;
  delta-only writer — writing the default deletes the override);
  `activeAppId` / `appManifest` / `loadedApps`; `loadApp` / `retryApp` /
  `invalidateApp` (lazy descriptor loads); `themeOptions` / `setTheme`;
  `emit` / `on` (workspace event bus); `loaded` / `seeded` / `appLoading`
  lifecycle flags.

`WorkspaceProvider` / `PrefsProvider` are host bootstrap — hosted apps
already live inside them.

**Rule:** Prefs are per-app and workspace-persisted — store view state
(selected tab, collapsed sections), not data. Data lives on the server.

```tsx
import { usePrefs, useWorkspace } from 'shell';

const { getPref, setPref } = usePrefs();
const open = getPref('runs.sectionOpen') !== false;
setPref('runs.sectionOpen', !open);

const { settings, updateSetting, appState, updateAppState, activeAppId } = useWorkspace();
```

### Polling & dashboard data

- `usePolling(fetcher, interval, options?)` — fires immediately, then every
  `interval` ms; by default only while the shell is connected
  (`options.gate: 'shell'`, the default; `'none'` polls unconditionally) —
  views never poll into a dead socket.
- `useDashboardData(): { data, events, error, refresh }` — the ONE shared
  dashboard feed: a module singleton where the FIRST consumer starts the 3s
  poll plus the `shell:event` subscription and the LAST unmount stops it.
  Data survives view switches; one request in flight regardless of
  consumers. `data` = the current `DashboardResponse` (null until first
  load); `events` = activity events newest-first.

Related exported types: `DashboardResponse`, `DashboardOverview`,
`DashboardConnection`, `DashboardTask`, `DashboardEvent`, `TaskEvent`,
`ActivityEvent`, plus `ListPageRequest` / `ListPageResponse` — the paged
contract of the server `list_*` APIs that feed `DataGrid.fetchPage`.

**Rule:** Do not hand-roll a poll-every-N-seconds effect for dashboard data
— the shared feed exists so N views cost one poll.

```tsx
import { usePolling, useDashboardData, Banner, MiniContainer } from 'shell';

usePolling(() => refreshRunList(), 5000);

function OverviewTiles() {
	const { data, events, error, refresh } = useDashboardData();
	if (error) return <Banner variant="error">{error}</Banner>;
	return <MiniContainer>{/* tiles from data.overview */}</MiniContainer>;
}
```

### UI utility hooks

The small cross-cutting hooks — reach for these before writing an effect by
hand:

| Hook | Type | Note |
| --- | --- | --- |
| `useDebouncedValue` | `<T>(value: T, delayMs: number) => T` | Trailing-debounced copy of a changing value — search inputs feeding `fetchPage` or `matchesSearch`. |
| `useClickOutside` | `(ref, onClose: () => void) => void` | onClose on mousedown outside the referenced element. |
| `useFixedPopupPosition` | `(triggerRef, isOpen, placement?: 'below' \| 'above') => { top, left } \| null` | Fixed-position anchor from the trigger rect; null while closed. The popup pair with `useClickOutside`. |
| `useAnnouncements` | `() => Announcement[]` | Platform announcements: fetched JSON, 1h cache, validity-window filtered; empty on failure. `Announcement = { id, title, body, priority: 'info' \| 'warning' \| 'urgent', valid_from?, valid_until?, link?, dismissable? }` (title/body markdown). |
| `useAppComponent` | `(appId, componentName) => ComponentType \| null` | Loads a component from ANOTHER app's catalog (triggers its lazy descriptor load); null while loading or missing. The sanctioned cross-app surface — never import another app's code. |

```tsx
import { useState, useRef } from 'react';
import { useClickOutside, useFixedPopupPosition } from 'shell';

function FilterPopup({ trigger }) {
	const [open, setOpen] = useState(false);
	const popupRef = useRef<HTMLDivElement>(null);
	const pos = useFixedPopupPosition(trigger, open, 'below');
	useClickOutside(popupRef, () => setOpen(false));
	return open && pos && (
		<div ref={popupRef} style={{ position: 'fixed', top: pos.top, left: pos.left }}>...</div>
	);
}
```

### Iframe bridge

The typed shell-to-iframe postMessage protocol for iframe-hosted app views.
The shell side attaches `useIframeBridge(iframeRef)`: the shell waits for
the frame's `view:ready`, answers with `shell:init` (`{ type, theme, user,
isConnected, apiConfig }`), then forwards theme changes, connection changes,
login/logout, server events, and view activation (`ShellToIframeMsg`).
Inbound (`IframeToShellMsg`) the frame may post `view:ready`,
`view:initialized`, `shell:logout`, `shell:openTab`. Keep the frame
`visibility: hidden` until `view:ready` is answered — the flash-free
pattern; theme CSS for the initial paint belongs in the srcdoc itself.

**Rule:** The bridge forwards shell events only AFTER the frame signals
`view:ready` — an iframe that skips the handshake receives nothing.

**Rule:** Host the frame with `srcdoc` or a same-origin URL. The shell side
ignores any inbound message whose `source` is not the managed frame's
`contentWindow`, and posts outbound with the shell's own origin (never
`'*'`) — a cross-origin `src` therefore never receives `shell:init`'s
`user`/`apiConfig`. The frame side must guard the same way: only accept
messages posted by `window.parent`.

```tsx
// Shell side - the hosting view wires the bridge to its frame:
import { useRef } from 'react';
import { useIframeBridge } from 'shell';

function EmbeddedView({ src }) {
	const frameRef = useRef<HTMLIFrameElement>(null);
	useIframeBridge(frameRef);
	return <iframe ref={frameRef} src={src} />;
}

// Iframe side - the handshake:
window.parent.postMessage({ type: 'view:ready' }, '*');
window.addEventListener('message', (e) => {
	// Only the hosting shell document may drive this frame.
	if (e.source !== window.parent) return;
	if (e.data.type === 'shell:init') applyTheme(e.data.theme);
});
```

---

## Utilities

### Formatters

The stock display formatters — the one vocabulary for numbers across every
view; grids use the same treatments via `autoFormatter`.

| Function | Signature | Example |
| --- | --- | --- |
| `formatBytes` | `(bytes: number) => string` | `2048` renders `'2.0 KB'`. |
| `formatDate` | `(iso: string) => string` | `'Jun 12, 4:02 PM'`. |
| `formatDuration` | `(ms: number) => string` | `90000` renders `'1m 30s'`. |

```tsx
import { formatBytes, formatDate, formatDuration } from 'shell';

formatBytes(1536000);         // '1.5 MB'
formatDuration(90000);        // '1m 30s'
formatDate(run.finishedAt);   // 'Jun 12, 4:02 PM'
```

### Icons

The full `Bx*` icon set — every glyph importable by name from `'shell'`
(e.g. `BxRocket`, `BxCog`, `BxTrash`, `BxBookOpen`, `BxChevronRight`,
`BxFile`, `BxFolderOpen`). One shared prop contract (`IconProps`); icons
inherit `currentColor` and recolor with the surrounding text and theme.
Browse the complete set in the gallery's Icons entry (click a tile to copy
its import name). Props: `size?: number` (default 24), `color?: string`
(default `currentColor`), `className?` / `style?`.

```tsx
import { BxRocket } from 'shell';
<BxRocket size={18} />
```

### Theme & commonStyles

The styling vocabulary, two layers:

**Tokens** — every colour, font, radius, and shadow is a `--rr-*` CSS
variable declared on `:root` and re-declared per theme (`ThemeTokens` is the
typed map, ~80 tokens). Never hardcode colours; reference `var(--rr-...)` so
every theme applies without component changes.

**commonStyles** — the shared `CSSProperties` map. Reach for a member BEFORE
writing a one-off style; single-use styles stay in the component. Members by
family:

- **Cards & sections**: `card`, `cardHeader`, `cardBody`, `cardFlat`,
  `section`, `sectionHeader`, `sectionHeaderLabel`
- **Buttons**: `buttonPrimary`, `buttonSecondary`, `buttonDanger`,
  `buttonDangerOutline`, the `*Small` variants, `buttonDisabled`,
  `cardHeaderButton`, `cardBodyButton`, `toggleButton(active)`, `toggleGroup`
- **Layout**: `splitHeader`, `tabContent`, `columnFill`, `headerBar`,
  `divider`
- **Text**: `textMuted`, `textEllipsis`, `fontMono`, `labelUppercase`,
  `empty`
- **Overlays & menus**: `overlay`, `modalOverlay`, `dialog`, `modalDialog`,
  `modalHeader`, `modalBody`, `modalFooter`, `popupMenu`, `menuRow`
- **Controls & lists**: `inputField`, `listRow(active)`, `emptyState`,
  `iconBox`, `badge`
- **Tables**: `tableHeader`, `tableCell`
- **Status indicators**: `indicatorSuccess`, `indicatorInfo`,
  `indicatorWarning`, `indicatorError`, `indicatorMuted`

(`toggleButton` and `listRow` are functions of the active state;
`viewPadding` is deprecated.)

**Rule:** Never hardcode a colour — reference `var(--rr-*)` tokens, and
check commonStyles for an existing member before writing a new style block.

```tsx
import { commonStyles } from 'shell';
import type { ThemeTokens } from 'shell';

const styles: Record<string, React.CSSProperties> = {
	header: { ...commonStyles.labelUppercase, marginBottom: 8 },
	row: { ...commonStyles.textMuted, ...commonStyles.textEllipsis },
	callout: { border: '1px solid var(--rr-border)', background: 'var(--rr-bg-surface-alt)' },
};
```
