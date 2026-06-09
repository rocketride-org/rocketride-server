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
// CHAT STORE — file operations for persistent chat sessions
// =============================================================================
//
// All paths are relative to CHAT_DIR (e.g. "My Chat.chat").
// Files are JSON with { messages: ChatMessage[] }.
// =============================================================================

import type { RocketRideClient } from 'rocketride';

/** Server-side directory where chat files are stored. */
const CHAT_DIR = '.chats';

/** Read a chat file. Path is relative, e.g. "My Chat.chat". */
export function loadChat(client: RocketRideClient, path: string): Promise<any> {
	return client.fsReadJson(`${CHAT_DIR}/${path}`);
}

/** Write a chat file. Path is relative, e.g. "My Chat.chat". */
export function saveChat(client: RocketRideClient, path: string, data: any): Promise<void> {
	return client.fsWriteJson(`${CHAT_DIR}/${path}`, data);
}

/** Delete a chat file. */
export function deleteChat(client: RocketRideClient, path: string): Promise<void> {
	return client.fsDelete(`${CHAT_DIR}/${path}`);
}

/** Rename a chat file. Both paths are relative. */
export function renameChat(client: RocketRideClient, oldPath: string, newPath: string): Promise<void> {
	return client.fsRename(`${CHAT_DIR}/${oldPath}`, `${CHAT_DIR}/${newPath}`);
}

/** List files in the chat directory. Path is relative ("" for root). */
export function listChatDir(client: RocketRideClient, path: string): Promise<any> {
	const storePath = path ? `${CHAT_DIR}/${path}` : CHAT_DIR;
	return client.fsListDir(storePath);
}

/** Strip .chat extension for display. */
export function displayName(path: string): string {
	const name = path.split('/').pop() ?? path;
	return name.endsWith('.chat') ? name.slice(0, -5) : name;
}
