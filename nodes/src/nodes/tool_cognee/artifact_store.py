# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Contained, atomic storage for Cognee graph visualization artifacts."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path


def write_html_artifact(artifact_dir: str | Path, *, dataset: str, html: bytes) -> Path:
    """Atomically write a mode-0600 ``<dataset>-graph.html`` below ``artifact_dir``."""
    root = Path(artifact_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)

    safe_dataset = re.sub(r'[^A-Za-z0-9._-]+', '-', dataset).strip('._-') or 'dataset'
    target = (root / f'{safe_dataset}-graph.html').resolve()
    if target.parent != root:
        raise ValueError('artifact path escapes the configured directory')

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f'.{safe_dataset}-graph-',
        suffix='.tmp',
        dir=root,
    )
    temporary = Path(temporary_name)
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(html)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)
        raise

    return target.resolve()
