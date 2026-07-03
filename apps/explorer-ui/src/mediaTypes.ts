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
// MEDIA TYPES — file extension → viewer category + MIME type
// =============================================================================

/** The viewer category determines which pane component renders the file. */
export type FileCategory = 'text' | 'code' | 'image' | 'video' | 'audio' | 'pdf' | 'docx' | 'spreadsheet' | 'markdown' | 'json' | 'binary';

/**
 * How the VFS delivers file data to the viewer.
 *
 * - `'inline'`  — content is the actual file data (text string).
 * - `'link'`    — content is a presigned URL for native streaming
 *                 (video/audio).  Ephemeral — refreshed on mount.
 * - `'blob'`    — data is fetched from a presigned URL and served as
 *                 a local blob URL (images, PDF, docx, spreadsheets).
 */
export type ContentMode = 'inline' | 'link' | 'blob';

interface MediaInfo {
	category: FileCategory;
	mime: string;
	contentMode: ContentMode;
}

/** Extension → MediaInfo lookup (lowercase, with leading dot). */
const MEDIA_MAP: Record<string, MediaInfo> = {
	// Images — blob (fetched and served as blob URL)
	'.png':  { category: 'image', mime: 'image/png',       contentMode: 'blob' },
	'.jpg':  { category: 'image', mime: 'image/jpeg',      contentMode: 'blob' },
	'.jpeg': { category: 'image', mime: 'image/jpeg',      contentMode: 'blob' },
	'.gif':  { category: 'image', mime: 'image/gif',       contentMode: 'blob' },
	'.webp': { category: 'image', mime: 'image/webp',      contentMode: 'blob' },
	'.svg':  { category: 'image', mime: 'image/svg+xml',   contentMode: 'blob' },
	'.bmp':  { category: 'image', mime: 'image/bmp',       contentMode: 'blob' },
	'.ico':  { category: 'image', mime: 'image/x-icon',    contentMode: 'blob' },
	'.avif': { category: 'image', mime: 'image/avif',      contentMode: 'blob' },

	// Video — link (presigned URL for native streaming with Range support)
	'.mp4':  { category: 'video', mime: 'video/mp4',          contentMode: 'link' },
	'.webm': { category: 'video', mime: 'video/webm',         contentMode: 'link' },
	'.ogv':  { category: 'video', mime: 'video/ogg',          contentMode: 'link' },
	'.mov':  { category: 'video', mime: 'video/quicktime',    contentMode: 'link' },
	'.avi':  { category: 'video', mime: 'video/x-msvideo',    contentMode: 'link' },
	'.mkv':  { category: 'video', mime: 'video/x-matroska',   contentMode: 'link' },

	// Audio — link (presigned URL for native streaming with Range support)
	'.mp3':  { category: 'audio', mime: 'audio/mpeg', contentMode: 'link' },
	'.wav':  { category: 'audio', mime: 'audio/wav',  contentMode: 'link' },
	'.ogg':  { category: 'audio', mime: 'audio/ogg',  contentMode: 'link' },
	'.flac': { category: 'audio', mime: 'audio/flac', contentMode: 'link' },
	'.aac':  { category: 'audio', mime: 'audio/aac',  contentMode: 'link' },
	'.m4a':  { category: 'audio', mime: 'audio/mp4',  contentMode: 'link' },
	'.weba': { category: 'audio', mime: 'audio/webm', contentMode: 'link' },

	// PDF — blob (fetched and served as blob URL for iframe)
	'.pdf':  { category: 'pdf', mime: 'application/pdf', contentMode: 'blob' },

	// JSON — inline (read as text, rendered with syntax highlighting)
	'.json':     { category: 'json', mime: 'application/json',   contentMode: 'inline' },
	'.jsonl':    { category: 'json', mime: 'application/jsonl',  contentMode: 'inline' },
	'.geojson':  { category: 'json', mime: 'application/geo+json', contentMode: 'inline' },
	'.pipe':     { category: 'json', mime: 'application/json',   contentMode: 'inline' },

	// Markdown — inline (read as text, rendered via MarkdownRenderer)
	'.md':       { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },
	'.markdown': { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },
	'.mdx':      { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },
	'.mdown':    { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },
	'.mkd':      { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },
	'.mkdn':     { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },

	// MS Word — blob (fetched and decoded by docx-preview; OOXML .docx only)
	'.docx': { category: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentMode: 'blob' },

	// Spreadsheets — blob (fetched and decoded by SheetJS)
	'.xlsx': { category: 'spreadsheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentMode: 'blob' },
	'.xls':  { category: 'spreadsheet', mime: 'application/vnd.ms-excel', contentMode: 'blob' },
	'.csv':  { category: 'spreadsheet', mime: 'text/csv', contentMode: 'blob' },

	// Binary — link (hex viewer fetches data directly; no VFS prefetch needed)
	// Legacy .doc is Compound File Binary Format (not OOXML); docx-preview cannot
	// render it, so it opens in the hex/binary viewer alongside other binaries.
	'.doc':    { category: 'binary', mime: 'application/msword',               contentMode: 'link' },
	'.zip':    { category: 'binary', mime: 'application/zip',                  contentMode: 'link' },
	'.gz':     { category: 'binary', mime: 'application/gzip',                 contentMode: 'link' },
	'.tar':    { category: 'binary', mime: 'application/x-tar',                contentMode: 'link' },
	'.7z':     { category: 'binary', mime: 'application/x-7z-compressed',      contentMode: 'link' },
	'.rar':    { category: 'binary', mime: 'application/vnd.rar',              contentMode: 'link' },
	'.bin':    { category: 'binary', mime: 'application/octet-stream',         contentMode: 'link' },
	'.exe':    { category: 'binary', mime: 'application/vnd.microsoft.portable-executable', contentMode: 'link' },
	'.dll':    { category: 'binary', mime: 'application/vnd.microsoft.portable-executable', contentMode: 'link' },
	'.so':     { category: 'binary', mime: 'application/octet-stream',         contentMode: 'link' },
	'.dylib':  { category: 'binary', mime: 'application/octet-stream',         contentMode: 'link' },
	'.sqlite': { category: 'binary', mime: 'application/vnd.sqlite3',          contentMode: 'link' },
	'.db':     { category: 'binary', mime: 'application/octet-stream',         contentMode: 'link' },
	'.wasm':   { category: 'binary', mime: 'application/wasm',                 contentMode: 'link' },
	'.class':  { category: 'binary', mime: 'application/java-vm',              contentMode: 'link' },
	'.pyc':    { category: 'binary', mime: 'application/octet-stream',         contentMode: 'link' },
	'.o':      { category: 'binary', mime: 'application/octet-stream',         contentMode: 'link' },
	'.obj':    { category: 'binary', mime: 'application/octet-stream',         contentMode: 'link' },

	// Code / programming languages — inline (Monaco editor)
	'.js':     { category: 'code', mime: 'text/javascript',              contentMode: 'inline' },
	'.jsx':    { category: 'code', mime: 'text/javascript',              contentMode: 'inline' },
	'.mjs':    { category: 'code', mime: 'text/javascript',              contentMode: 'inline' },
	'.cjs':    { category: 'code', mime: 'text/javascript',              contentMode: 'inline' },
	'.ts':     { category: 'code', mime: 'text/typescript',              contentMode: 'inline' },
	'.tsx':    { category: 'code', mime: 'text/typescript',              contentMode: 'inline' },
	'.mts':    { category: 'code', mime: 'text/typescript',              contentMode: 'inline' },
	'.cts':    { category: 'code', mime: 'text/typescript',              contentMode: 'inline' },
	'.html':   { category: 'code', mime: 'text/html',                    contentMode: 'inline' },
	'.htm':    { category: 'code', mime: 'text/html',                    contentMode: 'inline' },
	'.css':    { category: 'code', mime: 'text/css',                     contentMode: 'inline' },
	'.scss':   { category: 'code', mime: 'text/x-scss',                  contentMode: 'inline' },
	'.less':   { category: 'code', mime: 'text/x-less',                  contentMode: 'inline' },
	'.py':     { category: 'code', mime: 'text/x-python',                contentMode: 'inline' },
	'.pyi':    { category: 'code', mime: 'text/x-python',                contentMode: 'inline' },
	'.pyw':    { category: 'code', mime: 'text/x-python',                contentMode: 'inline' },
	'.rb':     { category: 'code', mime: 'text/x-ruby',                  contentMode: 'inline' },
	'.rake':   { category: 'code', mime: 'text/x-ruby',                  contentMode: 'inline' },
	'.java':   { category: 'code', mime: 'text/x-java-source',           contentMode: 'inline' },
	'.kt':     { category: 'code', mime: 'text/x-kotlin',                contentMode: 'inline' },
	'.kts':    { category: 'code', mime: 'text/x-kotlin',                contentMode: 'inline' },
	'.scala':  { category: 'code', mime: 'text/x-scala',                 contentMode: 'inline' },
	'.groovy': { category: 'code', mime: 'text/x-groovy',                contentMode: 'inline' },
	'.gradle': { category: 'code', mime: 'text/x-groovy',                contentMode: 'inline' },
	'.c':      { category: 'code', mime: 'text/x-csrc',                  contentMode: 'inline' },
	'.h':      { category: 'code', mime: 'text/x-csrc',                  contentMode: 'inline' },
	'.cpp':    { category: 'code', mime: 'text/x-c++src',                contentMode: 'inline' },
	'.cxx':    { category: 'code', mime: 'text/x-c++src',                contentMode: 'inline' },
	'.cc':     { category: 'code', mime: 'text/x-c++src',                contentMode: 'inline' },
	'.hpp':    { category: 'code', mime: 'text/x-c++src',                contentMode: 'inline' },
	'.hxx':    { category: 'code', mime: 'text/x-c++src',                contentMode: 'inline' },
	'.cs':     { category: 'code', mime: 'text/x-csharp',                contentMode: 'inline' },
	'.go':     { category: 'code', mime: 'text/x-go',                    contentMode: 'inline' },
	'.rs':     { category: 'code', mime: 'text/x-rustsrc',               contentMode: 'inline' },
	'.swift':  { category: 'code', mime: 'text/x-swift',                 contentMode: 'inline' },
	'.php':    { category: 'code', mime: 'text/x-php',                   contentMode: 'inline' },
	'.lua':    { category: 'code', mime: 'text/x-lua',                   contentMode: 'inline' },
	'.r':      { category: 'code', mime: 'text/x-rsrc',                  contentMode: 'inline' },
	'.R':      { category: 'code', mime: 'text/x-rsrc',                  contentMode: 'inline' },
	'.dart':   { category: 'code', mime: 'text/x-dart',                  contentMode: 'inline' },
	'.ex':     { category: 'code', mime: 'text/x-elixir',                contentMode: 'inline' },
	'.exs':    { category: 'code', mime: 'text/x-elixir',                contentMode: 'inline' },
	'.erl':    { category: 'code', mime: 'text/x-erlang',                contentMode: 'inline' },
	'.hrl':    { category: 'code', mime: 'text/x-erlang',                contentMode: 'inline' },
	'.hs':     { category: 'code', mime: 'text/x-haskell',               contentMode: 'inline' },
	'.fs':     { category: 'code', mime: 'text/x-fsharp',                contentMode: 'inline' },
	'.fsx':    { category: 'code', mime: 'text/x-fsharp',                contentMode: 'inline' },
	'.fsi':    { category: 'code', mime: 'text/x-fsharp',                contentMode: 'inline' },
	'.jl':     { category: 'code', mime: 'text/x-julia',                 contentMode: 'inline' },
	'.pl':     { category: 'code', mime: 'text/x-perl',                  contentMode: 'inline' },
	'.pm':     { category: 'code', mime: 'text/x-perl',                  contentMode: 'inline' },
	'.clj':    { category: 'code', mime: 'text/x-clojure',               contentMode: 'inline' },
	'.cljs':   { category: 'code', mime: 'text/x-clojure',               contentMode: 'inline' },
	'.cljc':   { category: 'code', mime: 'text/x-clojure',               contentMode: 'inline' },
	'.sql':    { category: 'code', mime: 'text/x-sql',                   contentMode: 'inline' },
	'.sh':     { category: 'code', mime: 'text/x-shellscript',           contentMode: 'inline' },
	'.bash':   { category: 'code', mime: 'text/x-shellscript',           contentMode: 'inline' },
	'.zsh':    { category: 'code', mime: 'text/x-shellscript',           contentMode: 'inline' },
	'.bat':    { category: 'code', mime: 'text/x-bat',                   contentMode: 'inline' },
	'.cmd':    { category: 'code', mime: 'text/x-bat',                   contentMode: 'inline' },
	'.ps1':    { category: 'code', mime: 'text/x-powershell',            contentMode: 'inline' },
	'.psm1':   { category: 'code', mime: 'text/x-powershell',            contentMode: 'inline' },
	'.psd1':   { category: 'code', mime: 'text/x-powershell',            contentMode: 'inline' },
	'.yaml':   { category: 'code', mime: 'text/x-yaml',                  contentMode: 'inline' },
	'.yml':    { category: 'code', mime: 'text/x-yaml',                  contentMode: 'inline' },
	'.toml':   { category: 'code', mime: 'text/x-toml',                  contentMode: 'inline' },
	'.ini':    { category: 'code', mime: 'text/x-ini',                   contentMode: 'inline' },
	'.cfg':    { category: 'code', mime: 'text/x-ini',                   contentMode: 'inline' },
	'.conf':   { category: 'code', mime: 'text/x-ini',                   contentMode: 'inline' },
	'.xml':    { category: 'code', mime: 'text/xml',                     contentMode: 'inline' },
	'.xsl':    { category: 'code', mime: 'text/xml',                     contentMode: 'inline' },
	'.xslt':   { category: 'code', mime: 'text/xml',                     contentMode: 'inline' },
	'.xsd':    { category: 'code', mime: 'text/xml',                     contentMode: 'inline' },
	'.graphql':{ category: 'code', mime: 'text/x-graphql',               contentMode: 'inline' },
	'.gql':    { category: 'code', mime: 'text/x-graphql',               contentMode: 'inline' },
	'.proto':  { category: 'code', mime: 'text/x-protobuf',              contentMode: 'inline' },
	'.dockerfile': { category: 'code', mime: 'text/x-dockerfile',        contentMode: 'inline' },
	'.tf':     { category: 'code', mime: 'text/x-hcl',                   contentMode: 'inline' },
	'.tfvars': { category: 'code', mime: 'text/x-hcl',                   contentMode: 'inline' },
	'.diff':   { category: 'code', mime: 'text/x-diff',                  contentMode: 'inline' },
	'.patch':  { category: 'code', mime: 'text/x-diff',                  contentMode: 'inline' },
	'.tex':    { category: 'code', mime: 'text/x-latex',                 contentMode: 'inline' },
	'.latex':  { category: 'code', mime: 'text/x-latex',                 contentMode: 'inline' },
	'.coffee': { category: 'code', mime: 'text/x-coffeescript',          contentMode: 'inline' },
	'.hbs':    { category: 'code', mime: 'text/x-handlebars-template',   contentMode: 'inline' },
	'.handlebars': { category: 'code', mime: 'text/x-handlebars-template', contentMode: 'inline' },
	'.pug':    { category: 'code', mime: 'text/x-pug',                   contentMode: 'inline' },
	'.sol':    { category: 'code', mime: 'text/x-solidity',              contentMode: 'inline' },
	'.razor':  { category: 'code', mime: 'text/x-razor',                 contentMode: 'inline' },
	'.cshtml': { category: 'code', mime: 'text/x-razor',                 contentMode: 'inline' },
	'.pas':    { category: 'code', mime: 'text/x-pascal',                contentMode: 'inline' },
	'.vb':     { category: 'code', mime: 'text/x-vb',                    contentMode: 'inline' },
	'.m':      { category: 'code', mime: 'text/x-objectivec',            contentMode: 'inline' },
	'.mm':     { category: 'code', mime: 'text/x-objectivec',            contentMode: 'inline' },
};

/**
 * Returns the viewer category, MIME type, and content mode for a file path.
 * Defaults to inline text for unrecognised extensions.
 */
export function getMediaInfo(path: string): MediaInfo {
	const dotIdx = path.lastIndexOf('.');
	if (dotIdx < 0) return { category: 'text', mime: 'text/plain', contentMode: 'inline' };
	const ext = path.substring(dotIdx).toLowerCase();
	return MEDIA_MAP[ext] ?? { category: 'text', mime: 'text/plain', contentMode: 'inline' };
}


