/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Shadow-DOM stylesheet for <rocketride-chat>.
 *
 * Theming contract:
 * - Host pages brand the widget with CSS custom properties that inherit
 *   through the shadow boundary: `--rr-accent`, `--rr-radius`, `--rr-font`,
 *   `--rr-bg`, `--rr-text`, `--rr-muted`, `--rr-border`, `--rr-surface`,
 *   `--rr-accent-text`. Host-set values win in both light and dark themes.
 * - The effective theme (resolved from the `theme` attribute and
 *   prefers-color-scheme) is stamped by the component as
 *   `data-theme="light|dark"` on the internal root, which flips the defaults.
 * - Default accent is the RocketRide violet (#5f2167); default type is the
 *   system font stack.
 *
 * Style isolation is two-way: the shadow root keeps host CSS out and none of
 * these rules leak into the page.
 *
 * @module styles
 */

/** Default accent color (RocketRide violet). */
export const DEFAULT_ACCENT = '#5f2167';

/** Complete stylesheet injected into the component's shadow root. */
export const WIDGET_STYLES = `
:host {
	display: block;
	height: 100%;
	min-height: 320px;
	container-type: size;
}

*, *::before, *::after {
	box-sizing: border-box;
}

.rr-root {
	/* Public theming API (host-set values win) over light defaults */
	--_accent: var(--rr-accent, ${DEFAULT_ACCENT});
	--_accent-text: var(--rr-accent-text, #ffffff);
	--_radius: var(--rr-radius, 12px);
	--_font: var(--rr-font, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
	--_bg: var(--rr-bg, #ffffff);
	--_text: var(--rr-text, #211a26);
	--_muted: var(--rr-muted, #6f6878);
	--_border: var(--rr-border, rgba(33, 26, 38, 0.14));
	--_surface: var(--rr-surface, #f4f1f6);

	display: flex;
	flex-direction: column;
	height: 100%;
	overflow: hidden;
	background: var(--_bg);
	color: var(--_text);
	font-family: var(--_font);
	font-size: 14px;
	line-height: 1.5;
	border: 1px solid var(--_border);
	border-radius: var(--_radius);
}

.rr-root[data-theme='dark'] {
	--_bg: var(--rr-bg, #17121b);
	--_text: var(--rr-text, #f0ecf3);
	--_muted: var(--rr-muted, #a79fb0);
	--_border: var(--rr-border, rgba(240, 236, 243, 0.16));
	--_surface: var(--rr-surface, #262029);
}

/* ---------------------------------------------------------------- header */

.rr-header {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 12px 16px;
	background: var(--_accent);
	color: var(--_accent-text);
	flex: none;
}

.rr-title {
	font-weight: 600;
	font-size: 15px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.rr-conn {
	margin-left: auto;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
	opacity: 0.85;
	white-space: nowrap;
}

.rr-conn-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: currentColor;
	opacity: 0.6;
}

.rr-conn[data-state='connected'] .rr-conn-dot {
	background: #3ecf72;
	opacity: 1;
}

.rr-conn[data-state='connecting'] .rr-conn-dot {
	animation: rr-pulse 1.2s ease-in-out infinite;
}

.rr-conn[data-state='error'] .rr-conn-dot {
	background: #e5484d;
	opacity: 1;
}

/* -------------------------------------------------------------- messages */

.rr-messages {
	flex: 1;
	overflow-y: auto;
	padding: 16px;
	display: flex;
	flex-direction: column;
	gap: 10px;
	scroll-behavior: smooth;
}

.rr-msg {
	max-width: 85%;
	padding: 8px 12px;
	border-radius: var(--_radius);
	overflow-wrap: break-word;
}

.rr-msg p {
	margin: 0;
}

.rr-msg p + p {
	margin-top: 8px;
}

.rr-msg pre {
	margin: 8px 0;
	padding: 10px;
	border-radius: calc(var(--_radius) / 2);
	background: rgba(0, 0, 0, 0.25);
	overflow-x: auto;
	font-size: 12px;
}

.rr-msg code {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 0.92em;
}

.rr-msg a {
	color: inherit;
	text-decoration: underline;
}

.rr-user {
	align-self: flex-end;
	background: var(--_accent);
	color: var(--_accent-text);
	border-bottom-right-radius: 4px;
}

.rr-assistant {
	align-self: flex-start;
	background: var(--_surface);
	color: var(--_text);
	border-bottom-left-radius: 4px;
}

.rr-assistant pre {
	background: rgba(0, 0, 0, 0.06);
}

.rr-root[data-theme='dark'] .rr-assistant pre {
	background: rgba(0, 0, 0, 0.35);
}

.rr-system {
	align-self: center;
	max-width: 95%;
	background: transparent;
	color: var(--_muted);
	font-size: 12px;
	text-align: center;
	padding: 2px 8px;
}

/* --------------------------------------------------- status / thinking */

.rr-thinking {
	display: none;
	align-self: flex-start;
	align-items: center;
	gap: 8px;
	color: var(--_muted);
	font-size: 12px;
	padding: 2px 4px;
}

.rr-thinking[data-active] {
	display: inline-flex;
}

.rr-thinking-dots {
	display: inline-flex;
	gap: 3px;
	flex: none;
}

.rr-thinking-dots span {
	width: 5px;
	height: 5px;
	border-radius: 50%;
	background: var(--_muted);
	animation: rr-bounce 1.2s ease-in-out infinite;
}

.rr-thinking-dots span:nth-child(2) {
	animation-delay: 0.15s;
}

.rr-thinking-dots span:nth-child(3) {
	animation-delay: 0.3s;
}

/* ------------------------------------------------------------------ error */

.rr-error {
	display: flex;
	align-items: center;
	gap: 10px;
	margin: 0 16px 10px;
	padding: 8px 12px;
	border: 1px solid #e5484d;
	border-radius: calc(var(--_radius) / 1.5);
	color: #e5484d;
	font-size: 12px;
	flex: none;
}

.rr-error[hidden] {
	display: none;
}

.rr-error-text {
	flex: 1;
	overflow-wrap: anywhere;
}

.rr-retry {
	flex: none;
	appearance: none;
	border: 1px solid #e5484d;
	background: transparent;
	color: #e5484d;
	border-radius: 6px;
	padding: 4px 10px;
	font: inherit;
	font-size: 12px;
	cursor: pointer;
}

.rr-retry:hover {
	background: rgba(229, 72, 77, 0.1);
}

/* --------------------------------------------------------------- composer */

.rr-composer {
	display: flex;
	align-items: flex-end;
	gap: 8px;
	padding: 12px 16px;
	border-top: 1px solid var(--_border);
	flex: none;
}

.rr-input {
	flex: 1;
	resize: none;
	max-height: 120px;
	padding: 8px 12px;
	border: 1px solid var(--_border);
	border-radius: calc(var(--_radius) / 1.5);
	background: var(--_bg);
	color: var(--_text);
	font: inherit;
}

.rr-input::placeholder {
	color: var(--_muted);
}

.rr-input:disabled {
	opacity: 0.55;
	cursor: not-allowed;
}

.rr-send {
	flex: none;
	appearance: none;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	border: none;
	border-radius: calc(var(--_radius) / 1.5);
	background: var(--_accent);
	color: var(--_accent-text);
	cursor: pointer;
}

.rr-send:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}

.rr-send svg {
	width: 18px;
	height: 18px;
	fill: currentColor;
}

/* ----------------------------------------------------------------- focus */

.rr-input:focus-visible,
.rr-send:focus-visible,
.rr-retry:focus-visible {
	outline: 2px solid var(--_accent);
	outline-offset: 2px;
}

.rr-root[data-theme='dark'] .rr-input:focus-visible,
.rr-root[data-theme='dark'] .rr-send:focus-visible,
.rr-root[data-theme='dark'] .rr-retry:focus-visible {
	outline-color: var(--_accent-text);
}

/* ------------------------------------------------------------- animation */

@keyframes rr-pulse {
	0%, 100% { opacity: 0.3; }
	50% { opacity: 1; }
}

@keyframes rr-bounce {
	0%, 60%, 100% { transform: translateY(0); }
	30% { transform: translateY(-4px); }
}

@media (prefers-reduced-motion: reduce) {
	.rr-messages {
		scroll-behavior: auto;
	}
	.rr-thinking-dots span,
	.rr-conn[data-state='connecting'] .rr-conn-dot {
		animation: none;
	}
}
`;
