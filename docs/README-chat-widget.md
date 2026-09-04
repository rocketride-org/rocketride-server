<h1 align="center">RocketRide Chat Widget</h1>

<p align="center">
  Embed a brandable AI chat on any web page — one script tag, zero frameworks.
</p>

<p align="center">
  <a href="https://github.com/rocketride-org/rocketride-server"><img src="https://img.shields.io/github/stars/rocketride-org/rocketride-server?style=flat&color=238636&label=GitHub&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://discord.gg/PMXrtenMsY"><img src="https://img.shields.io/badge/Discord-Join-370b7a?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE"><img src="https://img.shields.io/badge/License-MIT-41b6e6" alt="MIT License"></a>
</p>

`rocketride-chat-widget` is a framework-free chat UI for [RocketRide](https://rocketride.org) pipelines. One lean browser bundle (no React, no CSS frameworks) gives you two consumption modes:

- **Floating chat bubble** — a single `<script>` tag adds a launcher button to the corner of your site that opens a chat panel.
- **Inline web component** — place `<rocketride-chat>` anywhere in your markup, like a help panel or a docs sidebar.

Both modes render inside shadow DOM, so your page's CSS cannot break the widget and the widget's CSS cannot leak into your page. Branding is done with attributes and CSS custom properties.

## Quick Start

You need two values, both produced by your pipeline's **chat source node** when the pipeline is running:

- the **engine URL** (e.g. `http://localhost:5565`), and
- the pipeline's **Public Authorization Key** — the `{public_auth}` value from the `{host}/chat?auth={public_auth}` link the chat node publishes. Public keys are prefixed `pk_`.

> **Never use the engine API key** (`ROCKETRIDE_APIKEY`) or any private token in a web page. See [Security](#security-public-auth-key-only).

### Getting the bundle

`rocketride-chat-widget` is **not published to a package registry yet** — today you build the bundle from this repository and serve it yourself:

```bash
./builder chat-widget:build          # -> packages/chat-widget/dist/rocketride-chat.js
```

Copy `dist/rocketride-chat.js` (and its `.map`, if you want source maps in production) next to your site's other static assets. Every snippet below uses `/js/rocketride-chat.js` as that self-hosted path — substitute wherever you put it. See [Local development](#local-development) for the full build.

Once the package is published to npm the same snippets work unchanged against a CDN — swap the `src` for `https://unpkg.com/rocketride-chat-widget@1.3.0/dist/rocketride-chat.js` (or the jsDelivr equivalent) and use `npm install rocketride-chat-widget` for the bundler flow. Whether the repo publishes this package, and under which release workflow, is still an open maintainer decision; treat every registry/CDN reference in this document as "once published".

### Option 1 — floating chat bubble (one script tag)

```html
<script
	src="/js/rocketride-chat.js"
	data-engine-url="http://localhost:5565"
	data-auth="pk_YOUR-PUBLIC-AUTH-KEY"
	data-title="RocketRide Assistant"
	data-accent="#5f2167"
	data-position="bottom-right"
	data-welcome="Hi! How can I help?"
	data-placeholder="Ask me anything..."
	data-theme="auto"
	defer></script>
```

That is the whole integration: a launcher bubble appears in the chosen corner, clicking it opens the chat panel, and <kbd>Escape</kbd> closes it again. The loader reads its configuration from the script tag's own `data-*` attributes.

> Use a **classic** script tag (`defer` is fine). With `type="module"` the browser leaves `document.currentScript` unset, so the loader cannot find its configuration and no bubble is mounted.

### Option 2 — inline web component

The same bundle also registers the `<rocketride-chat>` custom element (with a plain script tag, just omit `data-engine-url` if you don't want the bubble too):

```html
<script src="/js/rocketride-chat.js" defer></script>

<div style="height: 560px; max-width: 480px">
	<rocketride-chat
		engine-url="http://localhost:5565"
		auth="pk_YOUR-PUBLIC-AUTH-KEY"
		title="Support"
		accent="#5f2167"
		welcome="Hi! How can I help?"
		theme="auto">
	</rocketride-chat>
</div>
```

The element fills its container (and keeps a 320px minimum height), so give it a sized parent.

With a bundler, add the package and import it once — the import registers the element. Until the package is on npm, point your dependency at the built folder (`"rocketride-chat-widget": "file:../path/to/packages/chat-widget"`) or at the `.tgz` produced by `npm pack` in that directory; **once published** the same thing installs by name:

```bash
# NPM (once published)
npm install rocketride-chat-widget
# Yarn
yarn add rocketride-chat-widget
# PNPM
pnpm add rocketride-chat-widget
```

```typescript
import 'rocketride-chat-widget'; // registers <rocketride-chat>
```

Don't have a pipeline yet? Visit [RocketRide on GitHub](https://github.com/rocketride-org/rocketride-server) or download the extension directly in your IDE.

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open-source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE -
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

- **50+ ready-to-use nodes** - 13 LLM providers, 8 vector databases, OCR, NER, PII anonymization, and more
- **High-performance C++ engine** - production-grade speed and reliability
- **Deploy anywhere** - locally, on-premises, or self-hosted with Docker
- **MIT licensed** - fully open source, OSI-compliant

You build your `.pipe` - and the widget puts a chat UI on it, anywhere on the web.

## Features

- **Two modes, one bundle** - inline `<rocketride-chat>` web component and script-tag launcher bubble
- **Framework-free** - vanilla TypeScript web component; no React, no runtime dependencies
- **Style isolation** - shadow DOM keeps host CSS out and widget CSS in
- **Brandable** - accent color, title, welcome text, placeholder via attributes; full theming via CSS custom properties
- **Light / dark / auto** - `auto` follows `prefers-color-scheme` and updates live
- **Live status** - connecting / online / offline states, a "thinking" line with the pipeline's live status while it works, and an error banner with a Retry button
- **Safe output rendering** - escape-first formatter for assistant text (paragraphs, code, bold, http(s) links only); raw model output is never injected as HTML
- **Accessible** - `role="log"` with `aria-live="polite"`, labeled controls, keyboard support, focus management, reduced-motion support
- **Public-key auth only** - designed so no private credential ever ships to the browser

---

## Security: public auth key only

**The widget must only ever be configured with a pipeline's PUBLIC Authorization Key.**

- **Where to find it:** when a pipeline with a chat source node is running, the node publishes a link of the form `{host}/chat?auth={public_auth}` along with the key itself (labeled _Public Authorization Key_, prefixed `pk_`). That `pk_…` value is what goes into the widget's `auth` / `data-auth`.
- **What it grants:** the public key is scoped to that one running pipeline's chat interface. It both authenticates the connection and addresses the pipeline — the widget needs nothing else.
- **What must never appear in a page:** the RocketRide engine API key (`ROCKETRIDE_APIKEY`) or any private task token (`tk_…`). Anything in an HTML attribute is readable by every visitor via _View Source_. The widget also never falls back to ambient environment credentials — the only credential it will ever send is the one you set explicitly.
- **Treat it like a public endpoint:** anyone with the page (and therefore the key) can chat with that pipeline. Restarting the pipeline issues a new public key, so an old key can be retired by republishing. Apply the same rate limiting / abuse protection you would give any public form.

### Exposing an engine to browsers (CORS and TLS)

- **CORS.** By default the engine's web endpoints accept requests from any `localhost` / `127.0.0.1` origin (any port) — enough for local development. To embed the widget on a real site, set the `RR_CORS_ORIGINS` environment variable on the engine to a comma-separated list of allowed origins (e.g. `RR_CORS_ORIGINS=https://www.example.com`).
- **TLS is required off-loopback.** The widget refuses to open a connection when `engine-url` is cleartext (`http:` / `ws:`) against a non-loopback host, and reports it as a connection error: the SDK maps a non-TLS URL to a plain `ws:` socket, which would put the auth key and every message on the wire unencrypted. `http://localhost:5565` and other loopback hosts (`127.0.0.0/8`, `::1`, `*.localhost`) stay allowed for local development; everything else needs `https:` / `wss:` — in practice, put the engine behind a TLS-terminating reverse proxy and use that URL.
- **Mixed content.** Browsers separately block insecure connections from `https` pages, so an `https` embedding page needs an `https` `engine-url` regardless (the SDK upgrades it to a secure WebSocket automatically).
- **Don't expose more than you need.** The page only needs to reach the engine's chat endpoint; keep engine management interfaces off the public network.

---

## `<rocketride-chat>` attributes

All attributes are observed — changing them on a live element takes effect immediately. Changing `engine-url` or `auth` tears down the connection and reconnects.

| Attribute     | Required | Default                       | Description                                                                                                                                      |
| ------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `engine-url`  | Yes      | -                             | RocketRide engine URL, e.g. `https://engine.example.com`. `http(s)` or `ws(s)` accepted; converted to WebSocket internally. Cleartext `http:`/`ws:` is refused unless the host is loopback — see [Security](#security-public-auth-key-only). |
| `auth`        | Yes      | -                             | The pipeline's **PUBLIC** Authorization Key (`pk_…`). Never an engine API key or private token — see [Security](#security-public-auth-key-only). |
| `title`       | No       | `RocketRide Assistant`        | Header title. Note: `title` is also a global HTML attribute, so browsers additionally show it as a hover tooltip on the element.                 |
| `accent`      | No       | `#5f2167` (RocketRide violet) | Brand accent color; any CSS color value. Shorthand for setting `--rr-accent`.                                                                    |
| `welcome`     | No       | (none)                        | Assistant-styled welcome bubble shown before the first exchange. Not sent to the pipeline as history.                                            |
| `placeholder` | No       | `Type a message…`             | Input placeholder text.                                                                                                                          |
| `theme`       | No       | `auto`                        | `light` \| `dark` \| `auto`. `auto` follows `prefers-color-scheme` and updates live when the OS theme changes.                                   |

The element connects when both `engine-url` and `auth` are present and it is attached to the document. Until then it renders in the idle/offline state.

## Script-tag loader (`data-*` attributes)

The IIFE bundle auto-initializes the bubble when its own `<script>` tag carries `data-engine-url`. Without `data-engine-url` the script only registers the web component and mounts nothing. Initialization is idempotent per script tag.

| Attribute          | Required | Default                | Description                                                                                                |
| ------------------ | -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `data-engine-url`  | Yes      | -                      | Engine URL; also the switch that enables bubble mode.                                                      |
| `data-auth`        | Yes\*    | -                      | The pipeline's PUBLIC auth key (`pk_…`). \*Technically optional, but without it the widget cannot connect. |
| `data-title`       | No       | `RocketRide Assistant` | Panel title and accessible dialog name.                                                                    |
| `data-accent`      | No       | `#5f2167`              | Accent for the launcher and the chat panel; any CSS color value.                                           |
| `data-position`    | No       | `bottom-right`         | `bottom-right` \| `bottom-left`. Invalid values fall back to the default with a console warning.           |
| `data-welcome`     | No       | (none)                 | Welcome message passed through to the chat component.                                                      |
| `data-placeholder` | No       | (none)                 | Input placeholder passed through to the chat component.                                                    |
| `data-theme`       | No       | `auto`                 | `light` \| `dark` \| `auto`. Invalid values fall back to `auto` with a console warning.                    |

Values are trimmed; empty strings count as absent. The launcher is a real `<button>` with `aria-expanded` / `aria-haspopup="dialog"`; the panel is a `role="dialog"` region sized `min(380px, viewport)` x `min(600px, viewport)`; <kbd>Escape</kbd> closes it and returns focus to the launcher. The bubble is mounted on `document.body` (deferred to `DOMContentLoaded` if the body doesn't exist yet) with a high `z-index` (2147483000).

## Theming

Brand the widget with CSS custom properties. They inherit through the shadow boundary, so you can set them on the element itself, any ancestor, or `:root` — host-set values win over the widget's defaults in **both** light and dark themes.

| Custom property    | Light default                          | Dark default                | Applies to                                  |
| ------------------ | -------------------------------------- | --------------------------- | ------------------------------------------- |
| `--rr-accent`      | `#5f2167`                              | `#5f2167`                   | Header, user bubbles, send button, launcher |
| `--rr-accent-text` | `#ffffff`                              | `#ffffff`                   | Text/icons on accent-colored surfaces       |
| `--rr-radius`      | `12px` (widget), `16px` (bubble panel) | same                        | Corner rounding                             |
| `--rr-font`        | system font stack                      | system font stack           | All widget text                             |
| `--rr-bg`          | `#ffffff`                              | `#17121b`                   | Widget background                           |
| `--rr-text`        | `#211a26`                              | `#f0ecf3`                   | Body text                                   |
| `--rr-muted`       | `#6f6878`                              | `#a79fb0`                   | Status line, placeholder, system notices    |
| `--rr-border`      | `rgba(33, 26, 38, 0.14)`               | `rgba(240, 236, 243, 0.16)` | Borders and dividers                        |
| `--rr-surface`     | `#f4f1f6`                              | `#262029`                   | Assistant bubbles                           |

```css
/* Example: brand the widget to match your site */
rocketride-chat,
[data-rocketride-chat-bubble] {
	--rr-accent: #0a6c5b;
	--rr-radius: 8px;
	--rr-font: 'Inter', sans-serif;
}
```

The `accent` attribute (or `data-accent`) is a convenience for the common case — it just sets `--rr-accent`. In bubble mode the loader host element carries the selector `[data-rocketride-chat-bubble]`.

## Events

Both events are `CustomEvent`s that bubble and cross the shadow boundary (`composed`), so a listener on `document` works.

| Event        | `detail`                                                    | Fired when                                                                                                                  |
| ------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `rr-message` | `{ role: 'user' \| 'assistant' \| 'system', text: string }` | Any entry is appended to the transcript (including the welcome bubble and system notices).                                  |
| `rr-error`   | `{ message: string, source: 'connection' \| 'chat' }`       | A chat request fails, or the connection enters the error state (connection errors fire once per transition, not per retry). |

```typescript
document.addEventListener('rr-message', (event) => {
	const { role, text } = (event as CustomEvent).detail;
	analytics.track('chat_message', { role, length: text.length });
});
```

## JS API

### `RocketRideChatElement`

| Member            | Type / Signature                                   | Description                                                                                                 |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `sendMessage`     | `sendMessage(text: string): Promise<void>`         | Sends a message exactly as if the user typed it. Resolves once the reply (or an error notice) was appended. |
| `clear`           | `clear(): void`                                    | Clears the transcript back to the welcome message (if configured).                                          |
| `messages`        | `readonly ChatMessage[]` (getter)                  | Read-only copy of the transcript (`{ role, text, transient? }`).                                            |
| `connectionState` | `'idle' \| 'connecting' \| 'connected' \| 'error'` | Current connection state.                                                                                   |
| `busy`            | `boolean` (getter)                                 | True while a question is in flight (the composer is disabled).                                              |
| `clientFactory`   | `ChatClientFactory` (property)                     | Test seam: inject a stub SDK client before attaching the element. Not needed for normal use.                |

### Module exports (ESM)

Importing `rocketride-chat-widget` registers the element and exports the building blocks: `RocketRideChatElement`, `WIDGET_TAG`, `defineRocketRideChat` (guarded `customElements.define`, aliased as `register`), the protocol layer (`WidgetConnection`, `extractAnswerTexts`, `HISTORY_LIMIT`), the safe renderer (`renderMessageHtml`, `escapeHtml`), theming constants (`WIDGET_STYLES`, `DEFAULT_ACCENT`), the loader API (`mountChatBubble`, `parseLoaderConfig`, `initFromScript`), and all TypeScript types. The IIFE bundle exposes the same surface on the `RocketRideChat` global.

### Mounting the bubble programmatically

```typescript
import { mountChatBubble } from 'rocketride-chat-widget';

const bubble = mountChatBubble({
	engineUrl: 'http://localhost:5565',
	auth: 'pk_YOUR-PUBLIC-AUTH-KEY',
	title: 'RocketRide Assistant',
	accent: '#5f2167',
	position: 'bottom-right',
	welcome: 'Hi! How can I help?',
	theme: 'auto',
});

bubble.open(); // also: close(), toggle(), isOpen()
bubble.chat; // the embedded <rocketride-chat> element
bubble.destroy(); // remove the bubble and detach listeners
```

## How assistant output is rendered

Model output is untrusted input. The widget never assigns raw model text to `innerHTML`; instead a minimal built-in formatter **escapes all HTML first** and then applies an allowlisted set of rules:

- paragraphs and line breaks
- fenced code blocks (` ```lang `) and inline `` `code` ``
- `**bold**`
- links — markdown `[label](url)` and bare URLs — for `http(s)` URLs **only**, emitted with `rel="noopener noreferrer" target="_blank"`; `javascript:`, `data:` and every other scheme is never linkified

The produced HTML contains only `p`, `br`, `pre`, `code`, `strong`, and `a` tags built by the widget itself. There is no external markdown dependency.

## UX and accessibility

- Connection states in the header: _Connecting…_ / _Online_ / _Offline_, plus an error banner with a **Retry** button.
- While the pipeline works, a "thinking" line shows its live status messages (animated dots respect `prefers-reduced-motion`).
- User messages on the right, assistant messages on the left; autoscroll follows new messages but stays put when you've scrolled up to read history.
- <kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> inserts a newline; the input is disabled while a reply is pending, and the send button while disconnected.
- Message area is `role="log"` with `aria-live="polite"`; the input and all buttons are labeled; focus outlines are visible; <kbd>Escape</kbd> closes the bubble panel and returns focus to the launcher (`aria-expanded` kept in sync).
- Requires an evergreen browser (custom elements + shadow DOM, ES2020).

## Limitations

Answers currently render when they are complete: the widget shows the pipeline's live status ("thinking") line while the request is processed, then displays the full answer once the pipeline returns it. Token-by-token streaming of the answer text is an engine capability that hasn't shipped yet — when it does, the widget will pick it up transparently through the same SDK, with no integration changes on your side. Also note: one widget talks to one pipeline (one public key), only the most recent conversation history (last 6 messages) is replayed to the pipeline for context, and the transcript lives in memory only — reloading the page starts a fresh conversation.

## Troubleshooting

| Symptom                                          | Likely cause and fix                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The bubble never appears                         | The script tag is missing `data-engine-url`, or uses `type="module"` (which hides `document.currentScript` from the loader). Use a classic `<script … defer>` tag.        |
| Header stuck on _Connecting…_                    | Engine not reachable — wrong `engine-url`, engine not running, or a firewall in between. The widget keeps retrying automatically; check the browser devtools Network tab. |
| _Offline_ with an error banner                   | The engine rejected the connection — usually a wrong or stale auth key. Verify you're using the current **public** key (`pk_…`); restarting a pipeline issues a new one.  |
| Works on `localhost`, fails on the deployed site | Set `RR_CORS_ORIGINS` on the engine to your site's origin, and make sure an `https` page uses an `https` engine URL (browsers block mixed content).                       |
| Send button disabled                             | Not connected yet — wait for _Online_ (input stays usable so you can type meanwhile). The input itself is only disabled while a reply is pending.                         |
| "Not connected yet" notice after sending         | The message was submitted while offline; it is not queued. Wait for _Online_ and send again.                                                                              |
| Widget ignores my page's CSS                     | By design — shadow DOM isolates styles. Brand it with the `--rr-*` custom properties or the attributes instead.                                                           |
| Two bubbles on the page                          | Two loader script tags each carry `data-engine-url`; the loader is idempotent per tag, not per page. Remove one.                                                          |

## Local development

The package lives at `packages/chat-widget` in the [rocketride-server](https://github.com/rocketride-org/rocketride-server) monorepo.

```bash
# From the repository root
pnpm install

# Build the bundles + type declarations
pnpm --filter rocketride-chat-widget build     # or: ./builder chat-widget:build

# Run the unit tests (jest + jsdom; no engine server required)
pnpm --filter rocketride-chat-widget test      # or: ./builder chat-widget:test

# Typecheck only
pnpm --filter rocketride-chat-widget typecheck
```

| Output                        | Contents                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `dist/rocketride-chat.mjs`    | ESM bundle (package `main` / `module`; for `import` consumers)                   |
| `dist/rocketride-chat.js`     | IIFE bundle for `<script src>` (global `RocketRideChat`; the file you self-host, and the `unpkg`/`jsdelivr` entry once published) |
| `dist/types/`                 | TypeScript declarations                                                          |

A demo page showing both modes with live theming controls is included at `packages/chat-widget/demo/index.html` — build the bundle, serve the package folder statically (e.g. `npx serve packages/chat-widget`), and open `/demo/`. All auth values in the demo are placeholders; paste your own pipeline's public key.

## Links

- [Documentation](https://docs.rocketride.org/)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Discord](https://discord.gg/PMXrtenMsY)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
