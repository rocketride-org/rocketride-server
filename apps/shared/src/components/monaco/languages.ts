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
// LANGUAGE DETECTION — file path -> Monaco language id
// =============================================================================

/**
 * The platform's one extension/filename -> Monaco language map (moved out
 * of explorer-ui's MonacoViewer so every Monaco surface shares it).
 */

/** Extension -> Monaco language id. */
const EXT_TO_LANGUAGE: Record<string, string> = {
	// Web
	'.html': 'html',
	'.htm': 'html',
	'.css': 'css',
	'.scss': 'scss',
	'.less': 'less',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.ts': 'typescript',
	'.tsx': 'typescript',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.vue': 'html',
	'.svelte': 'html',

	// Data / config
	'.json': 'json',
	'.jsonl': 'json',
	'.geojson': 'json',
	'.json5': 'json',
	'.pipe': 'json',
	'.yaml': 'yaml',
	'.yml': 'yaml',
	'.toml': 'ini',
	'.ini': 'ini',
	'.cfg': 'ini',
	'.conf': 'ini',
	'.properties': 'ini',
	'.env': 'ini',
	'.xml': 'xml',
	'.xsl': 'xml',
	'.xslt': 'xml',
	'.xsd': 'xml',
	'.svg': 'xml',
	'.plist': 'xml',
	'.graphql': 'graphql',
	'.gql': 'graphql',
	'.proto': 'protobuf',

	// Markdown
	'.md': 'markdown',
	'.markdown': 'markdown',
	'.mdx': 'markdown',
	'.mdown': 'markdown',
	'.mkd': 'markdown',
	'.mkdn': 'markdown',

	// Shell / scripting
	'.sh': 'shell',
	'.bash': 'shell',
	'.zsh': 'shell',
	'.fish': 'shell',
	'.bat': 'bat',
	'.cmd': 'bat',
	'.ps1': 'powershell',
	'.psm1': 'powershell',
	'.psd1': 'powershell',

	// Systems languages
	'.c': 'c',
	'.h': 'c',
	'.cpp': 'cpp',
	'.cxx': 'cpp',
	'.cc': 'cpp',
	'.hpp': 'cpp',
	'.hxx': 'cpp',
	'.cs': 'csharp',
	'.go': 'go',
	'.rs': 'rust',
	'.swift': 'swift',
	'.m': 'objective-c',
	'.mm': 'objective-c',
	'.zig': 'zig',

	// JVM
	'.java': 'java',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	'.scala': 'scala',
	'.groovy': 'groovy',
	'.gradle': 'groovy',
	'.clj': 'clojure',
	'.cljs': 'clojure',
	'.cljc': 'clojure',

	// Scripting / dynamic
	'.py': 'python',
	'.pyi': 'python',
	'.pyw': 'python',
	'.rb': 'ruby',
	'.rake': 'ruby',
	'.gemspec': 'ruby',
	'.php': 'php',
	'.pl': 'perl',
	'.pm': 'perl',
	'.lua': 'lua',
	'.r': 'r',
	'.dart': 'dart',
	'.ex': 'elixir',
	'.exs': 'elixir',
	'.erl': 'erlang',
	'.hrl': 'erlang',
	'.hs': 'haskell',
	'.lhs': 'haskell',
	'.fs': 'fsharp',
	'.fsx': 'fsharp',
	'.fsi': 'fsharp',
	'.jl': 'julia',

	// Database
	'.sql': 'sql',
	'.mysql': 'mysql',
	'.pgsql': 'pgsql',

	// Infrastructure / DevOps
	'.dockerfile': 'dockerfile',
	'.tf': 'hcl',
	'.tfvars': 'hcl',
	'.bicep': 'bicep',

	// Misc
	'.diff': 'diff',
	'.patch': 'diff',
	'.log': 'log',
	'.txt': 'plaintext',
	'.text': 'plaintext',
	'.rst': 'restructuredtext',
	'.tex': 'latex',
	'.latex': 'latex',
	'.bib': 'bibtex',
	'.coffee': 'coffeescript',
	'.litcoffee': 'coffeescript',
	'.handlebars': 'handlebars',
	'.hbs': 'handlebars',
	'.pug': 'pug',
	'.jade': 'pug',
	'.razor': 'razor',
	'.cshtml': 'razor',
	'.twig': 'twig',
	'.sol': 'sol',
	'.abt': 'abt',
	'.abap': 'abap',
	'.sb': 'sb',
	'.st': 'st',
	'.awk': 'awk',
	'.pas': 'pascal',
	'.pp': 'pascal',
	'.vb': 'vb',
	'.vbs': 'vb',

	// Lock / config files (by exact name handled via special case)
	'.lock': 'plaintext',
	'.gitignore': 'plaintext',
	'.editorconfig': 'ini',
	'.eslintrc': 'json',
	'.prettierrc': 'json',
};

/** Well-known filenames that don't rely on extensions. */
const NAME_TO_LANGUAGE: Record<string, string> = {
	'dockerfile': 'dockerfile',
	'makefile': 'makefile',
	'cmakelists.txt': 'cmake',
	'gemfile': 'ruby',
	'rakefile': 'ruby',
	'vagrantfile': 'ruby',
	'.gitignore': 'ini',
	'.dockerignore': 'ini',
	'.editorconfig': 'ini',
	'.env': 'ini',
	'.env.local': 'ini',
	'.env.development': 'ini',
	'.env.production': 'ini',
};

/**
 * Detects the Monaco language id from a file URI / path.
 *
 * @param uri - The file path or URI.
 * @returns The language id ('plaintext' when unknown).
 */
export function detectLanguage(uri: string): string {
	// step: exact filename match first
	const filename = uri.split('/').pop()?.toLowerCase() ?? '';
	const byName = NAME_TO_LANGUAGE[filename];
	if (byName) return byName;

	// step: then the extension
	const dotIdx = filename.lastIndexOf('.');
	if (dotIdx >= 0) {
		const ext = filename.substring(dotIdx).toLowerCase();
		const byExt = EXT_TO_LANGUAGE[ext];
		if (byExt) return byExt;
	}

	return 'plaintext';
}
