# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
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

"""
Pre-download the Hugging Face models of heavy dynamic node tests.

Driven by ``pytest --warmup-models``: the caller passes the (config, profile)
pairs that will actually run, so downloads follow the same selection and gates
as the test run, and happen outside the per-test timeout.
"""

from dataclasses import dataclass, field
from fnmatch import fnmatch
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .discovery import NodeTestConfig

# Files no loader here reads: other weight formats (several repos ship them next
# to the torch weights) and repository housekeeping.
IGNORE_PATTERNS = (
    '*.onnx',
    '*.onnx_data',
    'onnx/*',
    'openvino/*',
    '*.tflite',
    '*.msgpack',
    '*.h5',
    'tf_model*',
    'flax_model*',
    'rust_model*',
    '*.ot',
    'coreml/*',
    '*.mlmodel',
    '*.mlpackage/*',
    '*.gguf',
    '.git*',
    '*.md',
    'LICENSE*',
    'requirements*.txt',
    'handler.py',
    'train_script.py',
    'data_config.json',
)
_TORCH_CHECKPOINTS = ('.bin', '.pt', '.pth', '.ckpt')

# faster-whisper's size -> repo map for names that don't follow Systran/faster-whisper-<size>.
_WHISPER_REPOS = {
    'large': 'Systran/faster-whisper-large-v3',
    'large-v3-turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    'turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    'distil-large-v2': 'Systran/faster-distil-whisper-large-v2',
    'distil-medium.en': 'Systran/faster-distil-whisper-medium.en',
    'distil-small.en': 'Systran/faster-distil-whisper-small.en',
    'distil-large-v3': 'Systran/faster-distil-whisper-large-v3',
    'distil-large-v3.5': 'distil-whisper/distil-large-v3.5-ct2',
}
# What faster-whisper's download_model fetches.
_WHISPER_FILES = ('config.json', 'preprocessor_config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*')


@dataclass
class ModelRef:
    """One Hugging Face snapshot to fetch.

    Attributes:
        repo_id: Repository id.
        revision: Pinned revision, or None for the default branch.
        allow: File patterns to fetch; empty means every file not ignored.
        prefer_safetensors: Skip torch checkpoints when safetensors weights exist.
        users: ``node:profile`` labels that need this snapshot.
    """

    repo_id: str
    revision: Optional[str] = None
    allow: Tuple[str, ...] = ()
    prefer_safetensors: bool = True
    users: List[str] = field(default_factory=list)

    @property
    def label(self) -> str:
        """``repo`` or ``repo@<short revision>``."""
        return f'{self.repo_id}@{self.revision[:8]}' if self.revision else self.repo_id


Resolver = Callable[[Dict[str, Any]], Optional[ModelRef]]


def _hf(profile: Dict[str, Any], prefer_safetensors: bool = True) -> Optional[ModelRef]:
    """Map a profile's ``model`` (+ ``revision``) to a snapshot.

    Args:
        profile: Node profile from ``preconfig.profiles``.
        prefer_safetensors: See :attr:`ModelRef.prefer_safetensors`.

    Returns:
        The snapshot, or None when ``model`` is not an ``org/name`` repo id.
    """
    model = str(profile.get('model') or '').strip()
    if '/' not in model:
        return None
    revision = str(profile.get('revision') or '').strip() or None
    return ModelRef(model, revision, prefer_safetensors=prefer_safetensors)


def _whisper(profile: Dict[str, Any]) -> Optional[ModelRef]:
    """Map a faster-whisper size name (or repo id) to its CTranslate2 snapshot.

    Args:
        profile: ``audio_transcribe`` profile.

    Returns:
        The snapshot, or None without a model.
    """
    name = str(profile.get('model') or '').strip()
    if not name:
        return None
    repo = name if '/' in name else _WHISPER_REPOS.get(name, f'Systran/faster-whisper-{name}')
    return ModelRef(repo, str(profile.get('revision') or '').strip() or None, _WHISPER_FILES, False)


def _detect(profile: Dict[str, Any]) -> Optional[ModelRef]:
    """Map a ``detect`` profile; the rfdetr package fetches its own checkpoint.

    Args:
        profile: ``detect`` profile.

    Returns:
        The snapshot, or None for the rfdetr engine (its HF model is only a fallback).
    """
    return None if profile.get('engine') == 'rfdetr' else _hf(profile)


def _self_managed(profile: Dict[str, Any]) -> Optional[ModelRef]:
    """Nodes whose engines download their own weights from outside the Hub.

    Args:
        profile: Node profile (unused).

    Returns:
        None.
    """
    return None


# Node -> how a profile maps to a download. Unlisted nodes use `model` (+ `revision`).
RESOLVERS: Dict[str, Resolver] = {
    'anonymize': lambda p: _hf(p, prefer_safetensors=False),  # GLiNER may read pytorch_model.bin
    'audio_transcribe': _whisper,
    'audio_tts': lambda p: ModelRef('hexgrad/Kokoro-82M', prefer_safetensors=False),
    'detect': _detect,
    'face_detection': _self_managed,
    'ocr': _self_managed,
    'pose_estimation': _self_managed,
}


def collect_refs(pairs: Iterable[Tuple[NodeTestConfig, Optional[str]]]) -> List[ModelRef]:
    """Work out the downloads the given tests need.

    Args:
        pairs: ``(config, profile)`` of each test that will run; a None profile
            means the node's default profile.

    Returns:
        Unique snapshots in first-seen order, each listing its users.
    """
    refs: Dict[Tuple[str, Optional[str], Tuple[str, ...]], ModelRef] = {}
    for config, profile_name in pairs:
        preconfig = config.preconfig or {}
        name = profile_name or preconfig.get('default')
        profile = preconfig.get('profiles', {}).get(name) if name else None
        if not isinstance(profile, dict):
            continue
        ref = RESOLVERS.get(config.node_name, _hf)(profile)
        if ref is None:
            continue
        ref = refs.setdefault((ref.repo_id, ref.revision, ref.allow), ref)
        user = f'{config.node_name}:{name}'
        if user not in ref.users:
            ref.users.append(user)
    return list(refs.values())


def select_files(ref: ModelRef, files: List[Tuple[str, int]]) -> List[Tuple[str, int]]:
    """Keep the repository files the loaders read.

    Args:
        ref: The snapshot.
        files: ``(path, size)`` of every file in the repository.

    Returns:
        The selected ``(path, size)`` pairs, in input order.
    """
    chosen = [f for f in files if not _matches(f[0], IGNORE_PATTERNS)]
    if ref.allow:
        chosen = [f for f in chosen if _matches(f[0], ref.allow)]
    if ref.prefer_safetensors and any(path.endswith('.safetensors') for path, _ in chosen):
        chosen = [f for f in chosen if not f[0].endswith(_TORCH_CHECKPOINTS)]
    return chosen


def _matches(path: str, patterns: Iterable[str]) -> bool:
    """Whether ``path`` matches any glob in ``patterns`` (``*`` also crosses ``/``)."""
    return any(fnmatch(path, pattern) for pattern in patterns)


@dataclass
class RefStatus:
    """What fetching a snapshot involves right now.

    Attributes:
        ref: The snapshot.
        files: Selected ``(path, size)`` pairs.
        missing: The subset not in the local cache.
        error: Why the repository could not be listed, if it could not.
    """

    ref: ModelRef
    files: List[Tuple[str, int]] = field(default_factory=list)
    missing: List[Tuple[str, int]] = field(default_factory=list)
    error: Optional[str] = None

    @property
    def missing_bytes(self) -> int:
        """Size of the files still to download."""
        return sum(size for _, size in self.missing)

    @property
    def total_bytes(self) -> int:
        """Size of all selected files."""
        return sum(size for _, size in self.files)


def inspect(ref: ModelRef) -> RefStatus:
    """List the repository (metadata only) and check the local cache.

    Args:
        ref: The snapshot.

    Returns:
        Its status; ``error`` is set when the repository cannot be listed
        (offline, gated without a token, not found).
    """
    from huggingface_hub import HfApi, try_to_load_from_cache

    try:
        tree = HfApi().list_repo_tree(ref.repo_id, revision=ref.revision, recursive=True)
        files = [(entry.path, int(getattr(entry, 'size', 0) or 0)) for entry in tree if hasattr(entry, 'size')]
    except Exception as exc:
        return RefStatus(ref, error=_first_line(exc))
    files = select_files(ref, files)
    missing = [
        f for f in files if not isinstance(try_to_load_from_cache(ref.repo_id, f[0], revision=ref.revision), str)
    ]
    return RefStatus(ref, files, missing)


def download(status: RefStatus) -> Optional[str]:
    """Fetch the files ``status`` found missing.

    Args:
        status: Result of :func:`inspect`.

    Returns:
        An error message, or None on success (including nothing to fetch).
    """
    if status.error or not status.missing:
        return status.error
    from huggingface_hub import snapshot_download

    try:
        snapshot_download(
            status.ref.repo_id, revision=status.ref.revision, allow_patterns=[path for path, _ in status.missing]
        )
    except Exception as exc:
        return _first_line(exc)
    return None


def describe(status: RefStatus) -> str:
    """Summarise a status on one line.

    Args:
        status: Result of :func:`inspect`.

    Returns:
        E.g. ``'org/model@abcd1234: 8.27 GB to download (4 of 9 files) [caption:qwen3-vl-4b]'``.
    """
    users = ', '.join(status.ref.users)
    if status.error:
        return f'{status.ref.label}: unavailable ({status.error}) [{users}]'
    if not status.files:
        return f'{status.ref.label}: no matching files [{users}]'
    if not status.missing:
        return f'{status.ref.label}: cached, {format_size(status.total_bytes)} [{users}]'
    return (
        f'{status.ref.label}: {format_size(status.missing_bytes)} to download '
        f'({len(status.missing)} of {len(status.files)} files) [{users}]'
    )


def format_size(size: int) -> str:
    """Format a byte count as GB, or MB below 0.1 GB.

    Args:
        size: Bytes.

    Returns:
        E.g. ``'8.27 GB'`` or ``'42 MB'``.
    """
    if size >= 0.1 * 1024**3:
        return f'{size / 1024**3:.2f} GB'
    return f'{size / 1024**2:.0f} MB'


def _first_line(exc: Exception) -> str:
    """Compact an exception to ``Type: first line of message``."""
    text = str(exc).strip().splitlines()
    return f'{type(exc).__name__}: {text[0]}' if text else type(exc).__name__
