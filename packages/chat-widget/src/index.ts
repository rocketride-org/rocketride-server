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
 * RocketRide Chat Widget — public entry point (ESM bundle).
 *
 * Importing this module registers the <rocketride-chat> custom element
 * (guarded, so double-loading the bundle is harmless) and exports the
 * building blocks for programmatic use.
 *
 * AUTH MODEL: the widget is configured with the pipeline's PUBLIC auth key
 * only (the `?auth=` value published by the chat source node) — never an
 * engine API key or private token. See component.ts and connection.ts.
 *
 * @packageDocumentation
 */

import { defineRocketRideChat } from './component';

export { RocketRideChatElement, WIDGET_TAG, defineRocketRideChat } from './component';
export { WidgetConnection, extractAnswerTexts, HISTORY_LIMIT } from './connection';
export type { WidgetConnectionOptions } from './connection';
export { escapeHtml, renderMessageHtml } from './render';
export { WIDGET_STYLES, DEFAULT_ACCENT } from './styles';
export type { ChatClientFactory, ChatClientLike, ChatHistoryItem, ChatMessage, ChatRole, ConnectionState, ErrorEventDetail, MessageEventDetail, ThemeSetting } from './types';
export { mountChatBubble, parseLoaderConfig, initFromScript } from './loader';
export type { BubblePosition, BubbleTheme, ChatBubbleHandle, LoaderConfig } from './loader';

/** Alias of {@link defineRocketRideChat} kept for embed-loader compatibility. */
export const register = defineRocketRideChat;

// Register <rocketride-chat> on import (guarded — double-loading is harmless).
defineRocketRideChat();
