# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

# We now have real requirements, so load them before we start
# loading our driver
import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

import importlib
import re
from tree_sitter import Language, Parser
from typing import List, Dict, Any
from ai.common.config import Config
from ai.common.preprocessor import PreProcessorBase

RXFLAGS = re.MULTILINE | re.DOTALL


def _count(rx: str, text: str) -> int:
    return len(re.findall(rx, text, RXFLAGS))


def detect_language_by_regex(code: str) -> str:
    """
    Detect the most likely programming language from source text using regex heuristics.
    """
    MAX_BYTES = 5_000_000
    sample = code if len(code) <= MAX_BYTES else code[:MAX_BYTES]

    scores = {'python': 0, 'typescript': 0, 'javascript': 0, 'cpp': 0, 'c': 0}

    # --- Python ---
    scores['python'] += 6 * _count(r'\bdef\s+[A-Za-z_]\w*\s*\(', sample)
    scores['python'] += 6 * _count(r'\bclass\s+[A-Za-z_]\w*\s*:', sample)
    scores['python'] += 5 * _count(r'\bfrom\s+[A-Za-z_]\w*\s+import\b', sample)
    scores['python'] += 3 * _count(r'\bimport\s+[A-Za-z_]\w*', sample)
    scores['python'] += 3 * _count(r'@\w+', sample)
    scores['python'] += 2 * _count(r'"""[\s\S]*?"""', sample)
    scores['python'] += 5 * _count(r'\basync\s+def\s+[A-Za-z_]\w*\s*\(', sample)

    # --- TypeScript ---
    scores['typescript'] += 7 * _count(r'\binterface\s+[A-Za-z_]\w*', sample)
    scores['typescript'] += 6 * _count(r'\btype\s+[A-Za-z_]\w*\s*=', sample)
    scores['typescript'] += 6 * _count(r'\bimport\s+type\b', sample)
    scores['typescript'] += 6 * _count(r'\benum\s+[A-Za-z_]\w*', sample)
    scores['typescript'] += 5 * _count(r':\s*[A-Za-z_][\w<>\[\]\|&?,\s]*[;=,\)]', sample)
    scores['typescript'] += 4 * _count(r'\bexport\s+(default|const|function|class|type|interface|enum)\b', sample)
    scores['typescript'] += 2 * _count(r'\bfunction\s+[A-Za-z_]\w*\s*\(', sample)
    scores['typescript'] += 2 * _count(r'\b(const|let|var)\s+[A-Za-z_]\w*\s*=', sample)
    scores['typescript'] += 2 * _count(r'=>\s*\{?', sample)

    # --- JavaScript ---
    scores['javascript'] += 5 * _count(r'\bexport\s+(default|const|function|class)\b', sample)
    scores['javascript'] += 4 * _count(r'\bfunction\s+[A-Za-z_]\w*\s*\(', sample)
    scores['javascript'] += 4 * _count(r'\b(const|let|var)\s+[A-Za-z_]\w*\s*=', sample)
    scores['javascript'] += 3 * _count(r'=>\s*\{?', sample)
    scores['javascript'] += 3 * _count(r'\bimport\s+.*\s+from\s+["\']', sample)
    scores['javascript'] += 2 * _count(r'\brequire\s*\(\s*["\']', sample)
    scores['javascript'] += 2 * _count(r'\bmodule\.exports\b', sample)

    # --- C++ (C++-only markers) ---
    cpp_only = _count(r'\bstd::\w+', sample) + _count(r'\btemplate\s*<', sample) + _count(r'\bnamespace\s+[A-Za-z_]\w+', sample) + _count(r'::\s*[A-Za-z_]\w*', sample)
    scores['cpp'] += 8 * _count(r'\bstd::\w+', sample)
    scores['cpp'] += 6 * _count(r'\btemplate\s*<', sample)
    scores['cpp'] += 5 * _count(r'\busing\s+namespace\s+std\b', sample)
    scores['cpp'] += 3 * _count(r'\bclass\s+[A-Za-z_]\w+', sample)
    scores['cpp'] += 3 * _count(r'::\s*[A-Za-z_]\w*', sample)

    # --- C / Header patterns (apply to both; C gets stronger weight) ---
    guard_ifndef = _count(r'#\s*ifndef\b', sample)
    guard_define = _count(r'#\s*define\b', sample)
    guard_endif = _count(r'#\s*endif\b', sample)
    guard_trio = min(guard_ifndef, guard_define, guard_endif)

    scores['c'] += 2 * guard_trio
    scores['cpp'] += 1 * guard_trio

    # generic preprocessor noise
    pp_misc = _count(r'#\s*(ifn?def|ifdef|if|elif|define|undef|endif)\b', sample)
    scores['c'] += 1 * pp_misc
    scores['cpp'] += 1 * pp_misc

    # extern "C" + __cplusplus guards (classic C header for C++ consumers)
    ext_c = _count(r'extern\s+"C"', sample)
    has_cxx = _count(r'__cplusplus', sample)
    if ext_c:
        # Favor C strongly if no C++-only markers
        if cpp_only == 0:
            scores['c'] += 6
            scores['cpp'] -= 1
        else:
            scores['c'] += 2
            scores['cpp'] += 1
    if has_cxx:
        scores['c'] += 2  # typical in C headers providing C++ compatibility

    # prototypes that end with ';' (headers), weak for C++, stronger for C
    proto = _count(r'\b[A-Za-z_]\w+\s+\**[A-Za-z_]\w*\s*\([^;{]*\)\s*;', sample)
    scores['c'] += 4 * proto
    scores['cpp'] += 2 * proto

    # macro-based data declarations like: MACRO(Type) Name;
    macro_data = _count(r'[A-Z][A-Z0-9_]*\s*\([^)]+\)\s*[A-Za-z_]\w*\s*;', sample)
    scores['c'] += 4 * macro_data

    # common C typedef/struct hints
    scores['c'] += 5 * _count(r'\btypedef\s+struct\b', sample)
    scores['c'] += 3 * _count(r'\bstruct\s+[A-Za-z_]\w*\s*;', sample)

    # --- decision with C-vs-C++ tie-breaks ---
    winner, win_score = max(scores.items(), key=lambda kv: kv[1])
    sorted_scores = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    second_score = sorted_scores[1][1] if len(sorted_scores) > 1 else -10

    MIN_SCORE = 3
    GAP = 2

    # Hard tie-break: extern "C" present and no C++-only markers → choose C
    if ext_c and cpp_only == 0:
        winner = 'c'
        win_score = scores['c']

    # Otherwise apply thresholds
    if win_score < MIN_SCORE or (win_score - second_score) < GAP:
        # If the top two are C and C++ and gap is tiny, prefer C for header-like code
        top2 = {sorted_scores[0][0], sorted_scores[1][0]}
        if top2 == {'c', 'cpp'}:
            return 'c'
        return 'None'
    return winner


class PreProcessor(PreProcessorBase):
    """
    Use TreeSitter to split source code into meaningful chunks such as functions, classes, and statements.
    """

    languageParsers: Dict[str, Any] = {}
    language: str = 'auto'

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """
        Initialize the splitter with the given programming language.

        Supported languages: 'python', 'javascript', 'typescript', 'cpp'
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Save the language
        self.language = config.get('language', 'auto')

    def _getParser(self, language: str) -> Parser:
        """
        Load and cache a tree-sitter Parser for the given language.

        Supports: python, javascript, typescript, tsx, c, cpp.
        """
        lang_key = (language or 'auto').lower()
        if lang_key in self.languageParsers:
            return self.languageParsers[lang_key]

        lang_obj = None

        # Optional fast path: works if you `pip install tree_sitter_languages`
        try:
            from tree_sitter_languages import get_language  # optional dependency

            lang_obj = get_language(lang_key)  # handles 'typescript', 'tsx', 'python', 'javascript', 'c', 'cpp'
        except Exception:
            lang_obj = None

        if lang_obj is None:
            # Fallback to per-language modules with correct factory function names
            modmap = {
                'python': ('tree_sitter_python', 'language'),
                'javascript': ('tree_sitter_javascript', 'language'),
                'typescript': ('tree_sitter_typescript', 'language_typescript'),
                'tsx': ('tree_sitter_typescript', 'language_tsx'),
                'c': ('tree_sitter_c', 'language'),
                'cpp': ('tree_sitter_cpp', 'language'),
            }
            if lang_key not in modmap:
                raise Exception(f"Unsupported language '{lang_key}'")

            modname, fnname = modmap[lang_key]
            try:
                module = importlib.import_module(modname)
            except ImportError as e:
                raise Exception(f"Language module '{modname}' not installed for '{lang_key}'. Install it or add a loader.") from e

            if not hasattr(module, fnname):
                raise Exception(f"Module '{modname}' does not expose '{fnname}()' (required for '{lang_key}').")

            lang_ptr = getattr(module, fnname)()
            lang_obj = Language(lang_ptr)

        # Correct Parser API
        parser = Parser(lang_obj)

        # Cache and return
        self.languageParsers[lang_key] = parser
        return parser

    def _extract_chunks(self, node, source: bytes, chunks: List[str]):
        t = node.type
        parent = getattr(node, 'parent', None)
        pt = parent.type if parent else None

        # === Existing "big blocks" (keep) =======================================
        # Python
        if t in {
            'function_definition',
            'class_definition',
            'decorated_definition',
            'method_definition',
            # JS/TS
            'function_declaration',
            'function_expression',
            'arrow_function',
            'class_declaration',
            # C/C++
            'class_specifier',
            'struct_specifier',
            # NOTE: removed duplicate 'function_definition' here
        }:
            chunks.append(source[node.start_byte : node.end_byte].decode('utf-8'))

        # === NEW: C/C++ headers (top-level declarations) ========================
        # Many .h files have no function bodies—only prototypes/macros.
        # In tree-sitter C/C++, top-level declarations live under these parents.
        if pt in ('translation_unit', 'declaration_list', 'linkage_specification'):
            if t in ('declaration', 'field_declaration'):
                # Skip preprocessor lines (#include/#define/...)
                snippet = source[node.start_byte : node.end_byte].decode('utf-8').strip()
                if snippet and not snippet.lstrip().startswith('#'):
                    chunks.append(snippet)

        # === NEW: C/C++ extern "C" blocks =======================================
        # Capture the entire linkage block:  extern "C" { ... }
        if t == 'linkage_specification':
            snippet = source[node.start_byte : node.end_byte].decode('utf-8').strip()
            if snippet:
                chunks.append(snippet)

        # === Python module-level simple statements ===============================
        # Allow imports/assignments at the module root to become chunks
        if t in ('import_statement', 'import_from_statement', 'assignment', 'expression_statement'):
            if pt in ('module', 'program'):
                snippet = source[node.start_byte : node.end_byte].decode('utf-8')
                if snippet.strip():
                    chunks.append(snippet)

        # === JS/TS minified patterns ============================================
        # const f = () => {...}, var f = function(){...}, obj = { a: ()=>{} }
        if t in ('variable_declarator', 'assignment_expression', 'pair'):
            val = node.child_by_field_name('value') or node.child_by_field_name('right')
            if val and val.type in ('function_expression', 'arrow_function'):
                chunks.append(source[val.start_byte : val.end_byte].decode('utf-8'))

        # Recurse
        for ch in node.children:
            self._extract_chunks(ch, source, chunks)

    def process(self, code: str) -> List[str]:
        """
        Split the given source code into meaningful chunks using TreeSitter.
        """
        language = None

        if self.language == 'auto':
            # Use regex-based language detection
            language = detect_language_by_regex(code)

            if not language or language == 'None':
                return []
        else:
            # Use the specified language
            language = self.language

        # Get our parser
        parser = self._getParser(language)

        # Shake the tee
        tree = parser.parse(code.encode('utf-8'))

        # Grab the chunks
        chunks = []
        self._extract_chunks(tree.root_node, code.encode('utf-8'), chunks)

        # Return them
        return chunks
