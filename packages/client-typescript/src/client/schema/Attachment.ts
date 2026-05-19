// Copyright (c) 2026 Aparavi Software AG
// SPDX-License-Identifier: MIT

/**
 * First-class schema type for binary attachments on chat messages.
 *
 * Distinct from `Doc` (text-oriented). Carries a filestore path; the
 * bytes live in the per-user filestore under the chat's directory.
 * See TDD §6.1.
 */
export interface Attachment {
  /** uuid4 generated client-side at upload time. */
  attachment_id: string;
  /** RFC 6838 MIME type, e.g. "image/png", "application/pdf". */
  mime: string;
  /** User-visible original filename. */
  filename: string;
  /** Byte length on disk. */
  size_bytes: number;
  /** Filestore path relative to the user root, e.g.
   *  `.chats/<chat-guid>/<attachment-id>.<ext>`. */
  path: string;
}
