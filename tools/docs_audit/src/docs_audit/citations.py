"""Doc -> code direction: every path a doc cites, classified with evidence.

A naive "does this path exist?" check reports ~68% of this repo's doc citations
as dead. Nearly all of that is false: docs legitimately name files the *reader*
creates, files that only ever exist at runtime, and files that were deleted on
purpose (changelogs). Deleting on that signal destroys correct documentation.

So a citation is not boolean, it is classified:

``VERIFIED``     resolves to a real path in the tree
``PLACEHOLDER``  prose tells the reader to create it -- protected
``HISTORICAL``   changelog/release note describing the past -- protected
``RUNTIME``      no file at rest, but source code builds the name -- protected
``ORPHANED``     no referent found anywhere -- the only deletion candidate

Every verdict carries evidence so a human can check the tool's work.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .index import CodeIndex

VERIFIED = 'VERIFIED'
PLACEHOLDER = 'PLACEHOLDER'
HISTORICAL = 'HISTORICAL'
RUNTIME = 'RUNTIME'
ORPHANED = 'ORPHANED'

PROTECTED = frozenset({VERIFIED, PLACEHOLDER, HISTORICAL, RUNTIME})

_EXT = r'\.(?:py|ts|tsx|js|mjs|cjs|json|cpp|cc|h|hpp|cmake|toml|yaml|yml|sh|cmd|pipe|mdx?|env|tsv|csv)'
# An inline-code span that looks like a file or directory reference.
_PATH_SPAN = re.compile(r'`([A-Za-z0-9_.][A-Za-z0-9_.\-/]*' + _EXT + r')`')
_DIR_SPAN = re.compile(r'`((?:nodes|packages|apps|tools|docs|scripts|examples|deploy|docker)/[A-Za-z0-9_.\-/]+)`')

# Prose that introduces a file the reader -- or the code being described -- is
# about to make. ``emit``/``produce``/``output`` cover docs that describe what a
# pipeline or agent writes at run time, which is absent at rest by definition.
_CREATE_VERB = re.compile(
    r'\b(?:create|creating|add|adding|new|name\s+it|call\s+it|save\s+(?:this|it|that)?\s*as|scaffold|'
    r'generate|generates|generated|emit|emits|emitted|produce|produces|output|outputs|'
    r'write|writes|make|touch|rename\s+to|copy\s+to|place\s+in|put\s+in)\b',
    re.IGNORECASE,
)

# Directories that tooling installs into a *user's* workspace, never checked in.
# `.rocketride/` is written by the VS Code extension's installer
# (apps/vscode/src/agents/agent-manager.ts), so docs telling a reader to open a
# file under it are correct precisely because the repo does not contain it.
_INSTALLED_DIR = re.compile(r'(?:^|/)\.rocketride/')
# Prose citing a name to ILLUSTRATE a convention rather than to point at a file.
# Includes counter-examples ("NOT: `.pipeline.json`"), which are the most
# dangerous thing a cleanup pass can delete: removing them reintroduces exactly
# the mistake the doc exists to prevent.
_ILLUSTRATION = re.compile(
    r'(?:\bexamples?\s*:|\be\.g\.|\bfor\s+example\b|\bsuch\s+as\b|\blike\b\s*:|'
    r'\bNOT\s*:|\bnot\b\s*:|\bavoid\b|\binstead\s+of\b|\buse\s+descriptive\s+names?\b|'
    r'\binclude\s+purpose\b|\bnaming\b)',
    re.IGNORECASE,
)
# ASCII tree drawings in scaffolding docs.
_TREE_GLYPH = re.compile(r'[├└│]|^\s*[-*]?\s*\|--')
# Template-ish stems that are obviously stand-ins, not real repo files.
_TEMPLATE_STEM = re.compile(r'^(?:my|your|example|sample|foo|bar|placeholder|some|test)[-_A-Z]', re.IGNORECASE)

# Docs whose entire job is to describe the past.
_HISTORICAL_DOCS = re.compile(
    r'(?:^|/)(?:CHANGELOG|RELEASE|RELEASES|HISTORY|MIGRATION|UPGRADING)[^/]*\.mdx?$', re.IGNORECASE
)


@dataclass(frozen=True)
class Citation:
    """One path-like token cited by one doc at one line."""

    token: str
    doc: str
    line: int


@dataclass(frozen=True)
class Verdict:
    citation: Citation
    verdict: str
    evidence: str

    @property
    def is_protected(self) -> bool:
        return self.verdict in PROTECTED


def _strip_fenced_blocks(text: str) -> list[str]:
    """Return lines with fenced code-block bodies blanked out.

    Citations inside a fence are usually sample output or config the reader
    pastes, not claims about this repo's layout. We keep the line count stable
    so reported line numbers still point at the real file.
    """
    lines = text.splitlines()
    out: list[str] = []
    in_fence = False
    for line in lines:
        if re.match(r'^\s*(?:```|~~~)', line):
            in_fence = not in_fence
            out.append('')
            continue
        out.append('' if in_fence else line)
    return out


def extract(text: str, doc: str) -> list[Citation]:
    """Every distinct path-like citation in ``text``, with line numbers."""
    seen: set[tuple[str, int]] = set()
    found: list[Citation] = []
    for number, line in enumerate(_strip_fenced_blocks(text), start=1):
        for pattern in (_PATH_SPAN, _DIR_SPAN):
            for token in pattern.findall(line):
                token = token.rstrip('/')
                key = (token, number)
                if key in seen:
                    continue
                seen.add(key)
                found.append(Citation(token=token, doc=doc, line=number))
    return found


def _context(lines: list[str], line: int, before: int = 2) -> str:
    """The cited line plus a little preceding prose, for intent detection."""
    start = max(0, line - 1 - before)
    return '\n'.join(lines[start:line])


def classify(citation: Citation, index: CodeIndex, doc_lines: list[str]) -> Verdict:
    """Classify one citation, attaching the evidence behind the verdict."""
    token = citation.token
    doc_dir = Path(citation.doc).parent

    # 1. Resolves relative to the citing doc, or to the repo root.
    # No lstrip('./') -- it strips a character SET, not a prefix, so a citation
    # to `.env` would be looked up as `env`. Same bug as index.py had.
    sibling = (doc_dir / token).as_posix()
    if index.has_path(sibling):
        return Verdict(citation, VERIFIED, f'path exists: {sibling}')
    if index.has_path(token):
        return Verdict(citation, VERIFIED, f'path exists: {token}')

    # 2. Some file in the tree has this basename -- loosely worded, not wrong.
    basename = Path(token).name
    matches = index.find_basename(basename)
    if matches:
        return Verdict(citation, VERIFIED, f'basename matches {len(matches)} path(s), e.g. {matches[0]}')

    # 3. A changelog naming a deleted file is correct by definition.
    if _HISTORICAL_DOCS.search(citation.doc):
        return Verdict(citation, HISTORICAL, f'{citation.doc} documents past state')

    # 4. Installed into the reader's workspace by tooling, not stored here.
    if _INSTALLED_DIR.search(token):
        return Verdict(citation, RUNTIME, 'installed into the workspace by tooling, not checked in')

    # 5. No file at rest, but the code constructs the name at runtime.
    #
    # This runs before the prose heuristics below deliberately: finding the name
    # as a literal in source is hard evidence, while a create-verb nearby is a
    # guess about intent. Both verdicts are protected, so the ordering does not
    # change what survives a cleanup -- it changes the evidence a human reads,
    # and "source builds this name at pkg/real.py:3" is worth more than
    # "create-verb in context". (Prose like "Writes `x.json`" matches both.)
    # Prefer the whole citation. Falling straight back to the basename let any
    # source occurrence of a common final segment protect an unrelated path: a
    # citation ending in a bare English word was held RUNTIME because that word
    # appears somewhere in source, which is not evidence of anything.
    #
    # The fallback survives only for a basename carrying a file extension, which
    # is the real case: a build artifact referred to by filename in code while
    # the doc supplies its directory. Requiring the full token reports those as
    # dead.
    #
    # NB: no real repository path is named in this comment on purpose --
    # find_literal scans raw source text, so a path written here would index as
    # its own evidence. That cuts both ways and is a known limit: a path merely
    # mentioned in a comment anywhere in the tree counts as "source builds this
    # name". Narrowing that needs comment-stripping per language, which is a
    # bigger change than this fix.
    literal = index.find_literal(token)
    if literal is None and '.' in basename and basename != token:
        found = index.find_literal(basename)
        if found is not None:
            where, where_line = found
            return Verdict(citation, RUNTIME, f'source builds this filename: {where}:{where_line}')
    if literal is not None:
        where, where_line = literal
        return Verdict(citation, RUNTIME, f'source builds this name: {where}:{where_line}')

    # 6. Prose tells the reader to create it, or it is a template stand-in.
    context = _context(doc_lines, citation.line)
    if _CREATE_VERB.search(context):
        return Verdict(citation, PLACEHOLDER, f'create-verb in context at line {citation.line}')
    if _ILLUSTRATION.search(doc_lines[citation.line - 1] if citation.line <= len(doc_lines) else ''):
        return Verdict(citation, PLACEHOLDER, f'illustrative naming example at line {citation.line}')
    if _TREE_GLYPH.search(doc_lines[citation.line - 1] if citation.line <= len(doc_lines) else ''):
        return Verdict(citation, PLACEHOLDER, f'inside a directory-tree diagram at line {citation.line}')
    if _TEMPLATE_STEM.search(basename):
        return Verdict(citation, PLACEHOLDER, f'template stem: {basename}')

    return Verdict(citation, ORPHANED, 'no path, basename, or source literal found')


def audit_doc(path: Path, root: Path, index: CodeIndex) -> list[Verdict]:
    """Classify every citation in a single doc."""
    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return []
    doc = path.relative_to(root).as_posix()
    lines = text.splitlines()
    return [classify(citation, index, lines) for citation in extract(text, doc)]
