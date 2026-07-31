"""Read-only index of the repository's source tree.

Built once per run and shared by every check. Everything here is a lookup the
classifier needs in order to attach *evidence* to a verdict: not just "this
citation is dead" but "no file, basename, or source literal named X exists".
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Trees that are vendored, generated, or otherwise not ours to audit.
EXCLUDED_PARTS = frozenset(
    {
        '.git',
        'node_modules',
        'site-packages',
        'engine-lib',
        'dist',
        'build',
        '__pycache__',
        '.venv',
        'venv',
        '.eggs',
    }
)

# Source extensions we search for citation referents.
SOURCE_SUFFIXES = frozenset(
    {
        '.py',
        '.ts',
        '.tsx',
        '.js',
        '.mjs',
        '.cjs',
        '.cpp',
        '.cc',
        '.h',
        '.hpp',
        '.cmake',
        '.json',
        '.toml',
        '.yaml',
        '.yml',
        '.sh',
        '.cmd',
    }
)

# Skip files larger than this when scanning for string literals. Lockfiles and
# generated blobs blow up the scan and never contain meaningful referents.
MAX_SCAN_BYTES = 512 * 1024


def is_excluded(relpath: Path) -> bool:
    """True if any path segment is in an excluded tree."""
    return any(part in EXCLUDED_PARTS for part in relpath.parts)


@dataclass
class CodeIndex:
    """Paths and source text of the auditable tree."""

    root: Path
    paths: set[str] = field(default_factory=set)
    basenames: dict[str, list[str]] = field(default_factory=dict)
    _sources: dict[str, str] = field(default_factory=dict)

    @classmethod
    def build(cls, root: Path) -> CodeIndex:
        root = root.resolve()
        index = cls(root=root)
        for dirpath, dirnames, filenames in os.walk(root):
            rel_dir = Path(dirpath).relative_to(root)
            # Prune excluded directories in place so os.walk never descends them.
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_PARTS]
            if is_excluded(rel_dir):
                continue
            for name in list(dirnames) + filenames:
                # No lstrip('./') here: it strips a character SET, not a prefix,
                # so `.env` becomes `env` and `.github/...` loses its dot.
                # `Path('.') / name` already yields a clean relative path.
                rel = (rel_dir / name).as_posix()
                index.paths.add(rel)
                index.basenames.setdefault(name, []).append(rel)
            for name in filenames:
                path = Path(dirpath) / name
                if path.suffix.lower() not in SOURCE_SUFFIXES:
                    continue
                try:
                    if path.stat().st_size > MAX_SCAN_BYTES:
                        continue
                    text = path.read_text(encoding='utf-8', errors='replace')
                except OSError:
                    continue
                index._sources[(rel_dir / name).as_posix()] = text
        return index

    def has_path(self, relpath: str) -> bool:
        return relpath.strip('/') in self.paths

    def find_basename(self, basename: str) -> list[str]:
        """Every indexed path whose final segment is ``basename``."""
        return self.basenames.get(basename, [])

    def find_literal(self, token: str) -> tuple[str, int] | None:
        """First ``(relpath, line_number)`` where ``token`` appears in source text.

        This is what separates a genuinely dead reference from one naming a
        path the code builds at runtime (a doc citing ``version.docker.json``
        is correct even though no such file exists at rest, because
        ``engine-docker.ts`` constructs it).
        """
        for relpath, text in self._sources.items():
            position = text.find(token)
            if position != -1:
                return relpath, text.count('\n', 0, position) + 1
        return None
