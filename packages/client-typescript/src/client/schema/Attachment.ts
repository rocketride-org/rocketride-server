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
 * First-class schema type for binary attachments on chat messages.
 *
 * Distinct from `Doc` (text-oriented). Carries a filestore path; the
 * bytes live in the per-user filestore under the chat's directory.
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
