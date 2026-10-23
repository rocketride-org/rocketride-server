"""
Whisper: Combined loader and user-facing API using faster-whisper.

This module provides:
- WhisperLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- Whisper: User-facing class with automatic local/remote mode detection
  (used by connectors)

Uses faster-whisper (CTranslate2) for efficient GPU inference with built-in
Silero VAD. No pyannote dependency - fully MIT licensed.

Binary Transfer:
    Audio is transferred as raw PCM int16 bytes (16kHz mono).
    This is the most efficient format - half the size of float32.
    Server converts: np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0

Note:
    This module does NOT support speaker diarization.
    For diarization, use the NeMo loader separately.
"""

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple, Union

from ai.web.metrics import metrics
from ai.common.utils.cuda_utils import model_gpu_gb
from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.whisper')

# The GPU probe runs in a child process so a native crash (SIGABRT or SIGSEGV
# from ctranslate2, cuBLAS or cuDNN) cannot take the caller down. Three stages,
# each printed, so a failure names where it stopped:
#   1. version guard: ctranslate2 4.7.x with the CUDA 12.8 runtime corrupts the
#      heap in cuBLAS 12.8.4 (tcache_thread_shutdown SIGABRT on H200); exit 1.
#      The upper bound lifts the guard once 4.8+ is installed.
#   2. storage view: a CUDA StorageView through the documented from_array API.
#   3. inference: load the smallest Whisper model on the GPU through
#      faster-whisper and transcribe one second of audio, consuming the lazy
#      segments so the encoder (cuDNN convolutions) and the decoder (cuBLAS)
#      both run. A probe that only touched a StorageView passed on hosts whose
#      cuDNN libraries were not loadable, and the first real transcription
#      then failed or fell back (#2498).
# Every stage line starts with "probe:" and the last one is "probe: ok"; the
# parent reads only those lines, because the engine binary that hosts the
# child appends its own trailer to stdout on a non-zero exit. A crash at
# interpreter shutdown after "probe: ok" still exits non-zero and counts as
# failure. torch is imported first because its import preloads the CUDA
# libraries from the nvidia-* wheels.
_GPU_PROBE_MODEL = 'tiny'
# Each group needs one local file. CTranslate2 accepts either vocabulary format;
# faster-whisper downloads a tokenizer if tokenizer.json is absent, even when
# the snapshot lookup was local-only. preprocessor_config.json is optional.
_GPU_PROBE_ASSET_GROUPS = (
    ('model.bin',),
    ('config.json',),
    ('tokenizer.json',),
    ('vocabulary.json', 'vocabulary.txt'),
)
# The child reads only local files, so this covers the torch import, a cold CUDA
# context (10-30 s on H100-class GPUs, #1936), the tiny load and one second of audio.
# A timeout is cached for the process, so the bound errs on the generous side.
_GPU_PROBE_TIMEOUT_S = 120
# The longest the parent waits for the probe weights to download when they are not
# cached. The fetch holds the probe lock, so a hub that accepts the connection but
# never answers, or a firewall that drops packets until the OS connect timeout
# (minutes), must not stall every Whisper load in the process. A fetch that runs
# out of time is killed; the download resumes from its partial files next time.
_GPU_PROBE_PREFETCH_TIMEOUT_S = 30
# What a full GPU prints: the CUDA and CTranslate2 wording, and the status cuBLAS and
# cuDNN return when an allocation inside the library fails. Matched on lowercased output.
_GPU_OUT_OF_MEMORY_MARKERS = ('out of memory', 'cublas_status_alloc_failed', 'cudnn_status_alloc_failed')


def _gpu_probe_script(
    device_index: int = 0,
    model_name: str = _GPU_PROBE_MODEL,
    download_root: Optional[Union[str, 'os.PathLike[str]']] = None,
) -> str:
    """Return the source of the GPU probe child process.

    Args:
        device_index: CUDA device the probe loads on.
        model_name: Whisper model the inference stage loads (the smallest by default),
            or a local model directory.
        download_root: faster-whisper cache the weights are looked up in.

    The child never downloads: it loads the model from the local cache (or the
    directory) when it is there, and when the weights are simply not cached it
    skips the inference stage and ends on the storage-view verdict, which is
    what the probe checked before #2498, so a host without the weights keeps
    its GPU. A snapshot missing model, config, tokenizer or vocabulary assets
    (an interrupted download: the hub lists a snapshot before all its files
    arrive) counts as not cached; in particular a missing tokenizer must not
    trigger faster-whisper's network fallback. Any other error while resolving
    the weights (a ``download_root`` the engine user cannot read) skips the
    stage as well and names the error:
    the verdict is shared by every load in the process, and a cache one caller
    cannot use says nothing about the GPU stack. The loader always probes with
    the default model today; ``model_name`` is there for a caller that wants to
    probe a specific one.

    Returns:
        Python source for ``python -c``.
    """
    # A pathlib.Path would be embedded as PosixPath(...), a NameError in the child.
    if isinstance(download_root, os.PathLike):
        download_root = os.fspath(download_root)
    return (
        'import sys\n'
        '# stdout is ASCII under the engine (the ANSI code page on Windows): a non-ASCII path in a message is escaped.\n'
        'sys.stdout.reconfigure(errors="backslashreplace")\n'
        'import torch\n'
        'import ctranslate2\n'
        'try:\n'
        '    cudnn = torch.backends.cudnn.version()\n'
        'except RuntimeError as exc:\n'
        '    cudnn = type(exc).__name__\n'
        'print("probe: versions ctranslate2", ctranslate2.__version__, "torch", torch.__version__,\n'
        '      "cuda", torch.version.cuda or "", "cudnn", cudnn, flush=True)\n'
        f'index = {int(device_index)!r}\n'
        '# A set (pybind unordered_set), queried for the device being probed.\n'
        'v = set(ctranslate2.get_supported_compute_types("cuda", device_index=index))\n'
        'assert v, "no cuda compute types"\n'
        'try:\n'
        '    ct2 = tuple(int(x) for x in ctranslate2.__version__.split(".")[:2])\n'
        'except (ValueError, AttributeError):\n'
        '    ct2 = (999, 999)\n'
        'cuda = torch.version.cuda or ""\n'
        'if (4, 7) <= ct2 < (4, 8) and cuda.startswith("12.8"):\n'
        '    print("probe: guard excludes ctranslate2 4.7.x with the CUDA 12.8 runtime", flush=True)\n'
        '    sys.exit(1)\n'
        't = torch.zeros(1, dtype=torch.float32, device=f"cuda:{index}")\n'
        'sv = ctranslate2.StorageView.from_array(t)\n'
        'print("probe: storage view ok", flush=True)\n'
        'import os\n'
        'import numpy as np\n'
        'from faster_whisper import WhisperModel, download_model\n'
        f'name, root = {model_name!r}, {download_root!r}\n'
        'try:\n'
        '    path = name if os.path.isdir(name) else download_model(name, cache_dir=root, local_files_only=True)\n'
        f'    for group in {_GPU_PROBE_ASSET_GROUPS!r}:\n'
        '        if not any(os.path.isfile(os.path.join(path, asset)) for asset in group):\n'
        '            raise FileNotFoundError(" or ".join(group) + " is missing from " + str(path))\n'
        '# Not cached: huggingface_hub raises a FileNotFoundError subclass, an unresolvable name\n'
        '# is a ValueError. Any other lookup error (an unreadable download_root) skips the stage\n'
        '# too: a cache this caller cannot use says nothing about the GPU stack.\n'
        'except (FileNotFoundError, ValueError) as exc:\n'
        '    print("probe: inference skipped:", name, "weights are not cached locally;", type(exc).__name__, flush=True)\n'
        '    print("probe: ok", flush=True)\n'
        '    sys.exit(0)\n'
        'except Exception as exc:\n'
        '    print("probe: inference skipped:", name, "weights could not be looked up;", f"{type(exc).__name__}: {exc}", flush=True)\n'
        '    print("probe: ok", flush=True)\n'
        '    sys.exit(0)\n'
        '# Fastest precision the device supports; float32 is always in the set.\n'
        'compute_type = next(c for c in ("float16", "int8_float16", "bfloat16", "int8_float32", "int8", "float32") if c in v)\n'
        'model = WhisperModel(path, device="cuda", device_index=index, compute_type=compute_type)\n'
        'audio = np.zeros(16000, dtype=np.float32)\n'
        'segments, _info = model.transcribe(audio, beam_size=1, vad_filter=False, language="en")\n'
        'count = sum(1 for _ in segments)\n'
        'print("probe: inference ok", count, flush=True)\n'
        'del model\n'
        'print("probe: ok", flush=True)\n'
    )


class WhisperLoader(BaseLoader):
    """
    Static loader for Whisper speech transcription models using faster-whisper.

    Used by:
    - Model server (directly calls static methods)
    - Whisper wrapper (for local mode)

    Features:
    - CTranslate2-based inference (fast, efficient)
    - Built-in Silero VAD (no pyannote needed)
    - MIT licensed - no restrictions

    Model Identity (for sharing):
        model_name + compute_type
        See _DEFAULTS for default values applied before hashing.

        `language` is deliberately excluded: faster-whisper models are multilingual and
        `language` is a transcribe()-time decode hint, so folding it into identity loads
        an identical copy of the weights per language. `compute_type` stays — precision
        genuinely changes the loaded weights.

        `beam_size`, `vad_filter`, `vad_parameters` and `word_timestamps` are excluded
        for the same reason — all four are decode-time (#1809). The exclusion is
        enforced by _SERVER_PARAMS, so it holds even when an old client sends them.

        Anything else in `**kwargs` is treated as a genuine WhisperModel option and
        forwarded to it, so `revision` or `download_root` change both the weights and
        the identity, as they should.

    Performance Note:
        - Typical throughput: ~8-15 req/s depending on model size and audio length
    """

    LOADER_TYPE: str = 'whisper'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_whisper.txt')

    # Per-model locks for thread safety (faster-whisper is NOT thread-safe)
    _model_locks: Dict[int, threading.Lock] = {}
    _locks_lock = threading.Lock()

    # Defaults applied before hashing (ensures consistent model IDs).
    # `language` is not here — it is a per-request decode hint, not a load param.
    _DEFAULTS = {
        'compute_type': 'float16',
    }

    # Excluded from the identity hash, not merely omitted by the facade: an older client
    # that still sends these in loader_options would otherwise hash to a different
    # model_id and duplicate the weights for the length of a rolling upgrade. Same
    # reasoning as GLiNER's #1750; load() absorbs them and never applies them.
    _SERVER_PARAMS = BaseLoader._SERVER_PARAMS | {
        'language',
        'beam_size',
        'vad_filter',
        'vad_parameters',
        'word_timestamps',
    }

    # Merged under a caller's vad_parameters. Unlike _DEFAULTS, never reaches identity.
    _VAD_DEFAULTS = {
        'threshold': 0.5,
        'min_silence_duration_ms': 500,
        'speech_pad_ms': 400,
    }

    # Cached result of the GPU probe (None = not yet run) and, when it failed,
    # the reason the fallback messages and metadata carry.
    _gpu_compatible: Optional[bool] = None
    _gpu_probe_reason: Optional[str] = None
    # Set when the last probe's result rests on the storage view alone: the probe
    # weights were not local or could not be looked up, or the GPU ran out of
    # memory in the inference stage. Reset at the start of every probe.
    _gpu_probe_inference_skipped: Optional[str] = None
    # Weight fetches that ran out of time in this process. After the first, a
    # storage-view-only verdict is provisional (the next load fetches again).
    _gpu_probe_fetch_timeouts: int = 0
    # Server-mode probes that ran out of GPU memory after the storage view. The
    # first is not cached; the second caches the storage-view verdict (the GPU
    # may stay full).
    _gpu_probe_out_of_memory: int = 0
    _gpu_probe_lock = threading.Lock()

    @classmethod
    def _check_gpu_compatible(
        cls,
        device_index: int = 0,
        download_root: Optional[Union[str, 'os.PathLike[str]']] = None,
        local_files_only: bool = False,
        placed_by_allocator: bool = False,
    ) -> bool:
        """Return True if ctranslate2 GPU inference works on this machine.

        Runs the probe in ``_gpu_probe_script`` in a subprocess so a native
        crash does not kill the caller. A verdict is cached, so the probe runs
        once per process, on the first device asked for (hosts are assumed
        homogeneous), unless a result is not a verdict (an out-of-memory, or a
        first weight fetch that ran out of time): then the next load probes
        again, on the device it asks for. The probe weights are fetched here,
        best effort; the child only reads the local cache and skips the
        inference stage when they are absent or cannot be read, so no download
        or cache problem ever becomes a CPU verdict. The fetch is skipped when
        the caller asked for local files only, or when the installed versions
        would stop the child at the guard anyway. A timeout is a failure like
        any other and is cached. A child that ran out of GPU memory says nothing
        about the CUDA stack. Before the storage view, or without an allocator
        (local mode, where the load would need the room the probe did not
        find), it is reported, nothing is cached and this load goes to the CPU.
        After the storage view with ``placed_by_allocator``, this load keeps the
        GPU and ``allocate_gpu`` places the model as it did before #2498; the
        first such result is not cached, the second is cached as the
        storage-view verdict, so a GPU that stays full does not cost every load
        a probe. On failure ``_gpu_probe_reason`` names the stage, the exit code
        and the child's last output lines.

        Args:
            device_index: CUDA device to probe.
            download_root: faster-whisper download root for the probe's weights.
            local_files_only: the loader option of the same name; no network at all.
            placed_by_allocator: server mode, where ``allocate_gpu`` places the
                model after the probe.

        Returns:
            True when the child passed every stage it ran (the inference stage
            may be skipped), or, with ``placed_by_allocator``, ran out of GPU
            memory after the storage view.
        """
        with cls._gpu_probe_lock:
            if cls._gpu_compatible is not None:
                return cls._gpu_compatible
            cls._gpu_probe_inference_skipped = None

            import subprocess
            import sys

            # Fetch the probe's weights here, not in the child, so the child never
            # waits on the network. The result decides nothing: without the weights
            # the child stops at the storage view and the GPU is still used.
            refused = cls._guard_refuses_installed_versions()
            fetched: Optional[bool] = True
            if local_files_only:
                logger.debug('Whisper GPU probe: local_files_only set, not fetching the probe weights')
            elif refused:
                logger.debug('Whisper GPU probe: not fetching the probe weights, the guard refuses %s', refused)
            else:
                fetched = cls._prefetch_probe_weights(download_root)

            script = _gpu_probe_script(device_index=device_index, download_root=download_root)
            try:
                result = subprocess.run(
                    [sys.executable, '-c', script],
                    capture_output=True,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    timeout=_GPU_PROBE_TIMEOUT_S,
                )
            except subprocess.TimeoutExpired as exc:
                # The child reads only local files, so a hang is not a slow link.
                # Cached like any other failure: it costs once per process, not per load.
                out = exc.stdout.decode(errors='replace') if isinstance(exc.stdout, bytes) else (exc.stdout or '')
                reached = [line.strip() for line in out.splitlines() if line.startswith('probe:')]
                stage = reached[-1] if reached else 'no output'
                cls._gpu_probe_reason = f'the GPU probe gave no answer within {_GPU_PROBE_TIMEOUT_S} s, after "{stage}"'
                cls._gpu_compatible = False
                return False
            except Exception as exc:  # noqa: BLE001
                cls._gpu_probe_reason = f'the GPU probe could not run: {type(exc).__name__}: {exc}'
                cls._gpu_compatible = False
                return False

            # Only the child's own stage lines count: the engine binary that
            # hosts it writes a trailer of its own to stdout on failure.
            lines = [line.strip() for line in (result.stdout or '').splitlines() if line.startswith('probe:')]
            # "probe: ok" must be the last stage: a crash at shutdown still
            # prints it, so the exit code decides as well.
            if result.returncode == 0 and lines and lines[-1] == 'probe: ok':
                cls._gpu_probe_reason = None
                skipped = next((line for line in lines if line.startswith('probe: inference skipped')), None)
                cls._gpu_probe_inference_skipped = skipped
                if skipped and fetched is None and cls._gpu_probe_fetch_timeouts <= 1:
                    # The weights were slow, not unavailable: this load keeps the
                    # GPU on the storage-view verdict, but the verdict is not cached,
                    # so the next load fetches again (resuming the download) and can
                    # run the inference stage. Once only: a hub that never answers
                    # must not cost every load the fetch bound.
                    logger.warning(
                        'Whisper GPU probe passed on the storage view only while the %s weights were still '
                        'downloading; the next load probes again.',
                        _GPU_PROBE_MODEL,
                    )
                    return True
                cls._gpu_compatible = True
                if skipped:
                    logger.warning('Whisper GPU probe passed on the storage view only; %s', skipped[len('probe: ') :])
            else:
                stage = lines[-1] if lines else 'no output'
                tail = ' | '.join((result.stderr or '').strip().splitlines()[-3:])
                reason = f'exit {result.returncode} after "{stage}"' + (f'; stderr: {tail}' if tail else '')
                output = ((result.stderr or '') + (result.stdout or '')).lower()
                if any(marker in output for marker in _GPU_OUT_OF_MEMORY_MARKERS):
                    # A full GPU says nothing about the CUDA stack (the CUDA and
                    # CTranslate2 wording is "out of memory"). Past the storage view
                    # the stack passed what the probe checked before #2498; in server
                    # mode allocate_gpu then places the model, so this load keeps the
                    # GPU. The first such result is not cached, so the next load can
                    # run the inference stage; the second caches the storage-view
                    # verdict. Before the storage view, or in local mode (no
                    # allocator, and the load needs the room the probe did not find),
                    # this load goes to the CPU with the reason and nothing is cached.
                    if placed_by_allocator and 'probe: storage view ok' in lines:
                        cls._gpu_probe_out_of_memory += 1
                        cls._gpu_probe_reason = None
                        cls._gpu_probe_inference_skipped = (
                            f'probe: inference skipped: GPU {device_index} ran out of memory'
                        )
                        if cls._gpu_probe_out_of_memory > 1:
                            cls._gpu_compatible = True
                            logger.warning(
                                'Whisper GPU probe passed on the storage view only: GPU %s ran out of memory in the '
                                'inference stage again (%s); the storage-view verdict is kept.',
                                device_index,
                                reason,
                            )
                            return True
                        logger.warning(
                            'Whisper GPU probe passed on the storage view only: GPU %s ran out of memory in the '
                            'inference stage (%s); the next load probes again.',
                            device_index,
                            reason,
                        )
                        return True
                    cls._gpu_probe_reason = (
                        f'GPU {device_index} ran out of memory during the probe, not a verdict: {reason}'
                    )
                    return False
                cls._gpu_probe_reason = reason
                cls._gpu_compatible = False
            return bool(cls._gpu_compatible)

    @staticmethod
    def _guard_refuses_installed_versions() -> Optional[str]:
        """The child's version guard, evaluated cheaply in the parent.

        Reads the installed ctranslate2 version from package metadata (no import)
        and the CUDA runtime torch carries. Returns the refused pairing when it is
        4.7.x with CUDA 12.8, so the probe weights are not fetched for a child
        that will stop at the guard anyway; None when the guard passes or cannot
        be evaluated here. The child's own check stays the authority.
        """
        try:
            from importlib.metadata import version

            from ai.common.torch import torch

            ct2_version = version('ctranslate2')
            ct2 = tuple(int(x) for x in ct2_version.split('.')[:2])
            cuda = str(torch.version.cuda or '')
        except Exception:  # noqa: BLE001
            return None
        if (4, 7) <= ct2 < (4, 8) and cuda.startswith('12.8'):
            return f'ctranslate2 {ct2_version} with the CUDA {cuda} runtime'
        return None

    @staticmethod
    def _probe_weights_cached(download_model: Any, download_root: Optional[Union[str, 'os.PathLike[str]']]) -> bool:
        """Whether a complete copy of the probe weights is in the local cache (no network call)."""
        try:
            path = download_model(_GPU_PROBE_MODEL, cache_dir=download_root, local_files_only=True)
            # A local-only hub lookup can return a snapshot before every asset
            # arrives. Use the child's completeness check so a partial fetch is
            # resumed, including when model.bin arrived before the tokenizer.
            return bool(path) and all(
                any(os.path.isfile(os.path.join(path, asset)) for asset in group) for group in _GPU_PROBE_ASSET_GROUPS
            )
        except Exception:  # noqa: BLE001
            return False

    @classmethod
    def _prefetch_probe_weights(cls, download_root: Optional[Union[str, 'os.PathLike[str]']]) -> Optional[bool]:
        """Fetch the probe model's weights into the cache the child reads, best effort.

        This is the only place the probe may touch the network, and only when a
        complete copy of the weights is not already cached. The download runs in
        a child process waited for at most ``_GPU_PROBE_PREFETCH_TIMEOUT_S`` and
        killed after that: the probe lock is held meanwhile, and a hub that
        accepts the connection but never answers must not stall every Whisper
        load in the process, nor may a slow download hold the interpreter at exit
        (a thread would, through huggingface_hub's non-daemon worker pool). The
        partial files stay in the cache, so the next attempt resumes. A failure
        or a timeout is logged and the probe goes on: the child skips the
        inference stage when the weights are not local and still returns a
        storage-view verdict, so an offline host, an image that bakes in only the
        model it serves, or a local model path never lands on the CPU because of
        the probe.

        Returns:
            True when the weights are cached in full (or faster-whisper is not
            importable, a test host), False when the fetch failed, None when it
            ran out of time and was stopped (the caller keeps the verdict
            provisional once, so the next load tries again).
        """
        try:
            from faster_whisper import download_model
        except ImportError:
            return True
        if cls._probe_weights_cached(download_model, download_root):
            return True

        import subprocess
        import sys

        # ai.common.ssl patches only this process; the child repeats it for hosts behind a TLS-intercepting proxy.
        script = (
            'import sys\n'
            'try:\n'
            '    import truststore\n'
            '    truststore.inject_into_ssl()\n'
            'except Exception:\n'
            '    pass\n'
            'from faster_whisper import download_model\n'
            'download_model(sys.argv[1], cache_dir=sys.argv[2] or None)\n'
        )
        try:
            fetch = subprocess.Popen(
                [sys.executable, '-c', script, _GPU_PROBE_MODEL, download_root or ''],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                encoding='utf-8',
                errors='replace',
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                'Could not start the fetch of the %s weights for the Whisper GPU probe (%s: %s); '
                'the probe will stop at the storage view unless they are cached.',
                _GPU_PROBE_MODEL,
                type(exc).__name__,
                exc,
            )
            return False
        try:
            _stdout, stderr = fetch.communicate(timeout=_GPU_PROBE_PREFETCH_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            fetch.kill()
            fetch.communicate()
            cls._gpu_probe_fetch_timeouts += 1
            logger.warning(
                'Fetching the %s weights for the Whisper GPU probe did not finish within %s s and was stopped; '
                'the probe goes on with what is local and the download resumes on the next attempt.',
                _GPU_PROBE_MODEL,
                _GPU_PROBE_PREFETCH_TIMEOUT_S,
            )
            return None
        if fetch.returncode != 0:
            tail = ' | '.join((stderr or '').strip().splitlines()[-3:])
            logger.warning(
                'Could not fetch the %s weights for the Whisper GPU probe (exit %s%s); '
                'the probe will stop at the storage view unless they are cached.',
                _GPU_PROBE_MODEL,
                fetch.returncode,
                f': {tail}' if tail else '',
            )
            return False
        return cls._probe_weights_cached(download_model, download_root)

    @staticmethod
    def _first_candidate_gpu(exclude_gpus: List[int], torch: Any) -> int:
        """The GPU the probe runs on, among those the allocator may hand out.

        Hosts are homogeneous, so any of them answers for the stack; the one with
        the most free memory is chosen so the probe's own model does not run into
        an out-of-memory on a busy device. Falls back to the lowest index when the
        memory query is unavailable.
        """
        try:
            count = int(torch.cuda.device_count())
        except Exception:  # noqa: BLE001
            count = 1
        candidates = [index for index in range(max(count, 1)) if index not in exclude_gpus] or [0]
        try:
            free = {index: int(torch.cuda.mem_get_info(index)[0]) for index in candidates}
            return max(candidates, key=lambda index: free[index])
        except Exception:  # noqa: BLE001
            return candidates[0]

    @classmethod
    def _get_model_lock(cls, model_id: int) -> threading.Lock:
        """Get or create a lock for a specific model instance."""
        with cls._locks_lock:
            if model_id not in cls._model_locks:
                cls._model_locks[model_id] = threading.Lock()
            return cls._model_locks[model_id]

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        language: str = 'en',
        compute_type: str = 'float16',
        # Named so they are absorbed rather than forwarded to WhisperModel(), which does
        # not accept them and would raise. An older client can still put them in
        # loader_options; forwarding **kwargs blindly would trade one bug for a worse
        # one (#1750). Everything else in **kwargs is a genuine WhisperModel option.
        beam_size: Optional[int] = None,
        vad_filter: Optional[bool] = None,
        vad_parameters: Optional[Dict[str, Any]] = None,
        word_timestamps: Optional[bool] = None,
        **kwargs,
    ) -> Tuple[Dict[str, Any], Dict[str, Any], int]:
        """
        Load faster-whisper model.

        Two modes:
        - Local mode (device specified): Load directly to device
        - Server mode (allocate_gpu provided): Estimate memory, allocate GPU, load

        Args:
            model_name: Whisper model size ('tiny', 'base', 'small', 'medium', 'large-v3')
            device: Device for local mode ('cuda:0', 'cuda', 'cpu')
            allocate_gpu: Callback for server mode (memory_gb, exclude_gpus) -> (gpu_index, device_str)
            exclude_gpus: GPUs to exclude (server mode)
            language: Language code for transcription (default: 'en')
            compute_type: Precision type (float16, int8, float32)
            beam_size: Absorbed, not applied — decode-time, see the class docstring
            vad_filter: Absorbed, not applied
            vad_parameters: Absorbed, not applied
            word_timestamps: Absorbed, not applied
            **kwargs: Forwarded to WhisperModel() as genuine loader options
                (revision, download_root, cpu_threads, …)

        Returns:
            Tuple of (model_bundle, metadata_dict, gpu_index)
        """
        WhisperLoader._ensure_dependencies()

        from faster_whisper import WhisperModel
        from ai.common.torch import torch

        # Strip 'whisper/' prefix if present (e.g., 'whisper/tiny' -> 'tiny')
        if model_name.startswith('whisper/'):
            model_name = model_name[8:]

        exclude_gpus = exclude_gpus or []
        # Set when a GPU was available but the loader went to the CPU anyway;
        # reported in the metadata so a caller can tell a fallback from a choice.
        device_fallback: Optional[str] = None
        download_root = kwargs.get('download_root')
        local_files_only = bool(kwargs.get('local_files_only'))

        if allocate_gpu:
            # === SERVER MODE: Estimate memory, allocate, then load ===
            memory_gb = WhisperLoader._estimate_memory(model_name)
            logger.debug(f'Estimated memory: {memory_gb:.2f} GB')

            # Probe GPU compatibility before allocating: the probe runs a real
            # transcription in a child process (when the tiny weights can be read
            # and the GPU has room for them), so a native crash or missing CUDA
            # library is found here, not on the first request. allocate_gpu
            # places the model, so a probe that ran out of memory after the
            # storage view keeps the GPU (placed_by_allocator).
            # Choosing the probe GPU reads free memory through torch, which opens
            # a CUDA context (a few hundred MB, kept until exit) on every
            # candidate GPU. A cached verdict ignores the index, so it is chosen
            # only while none is cached and CUDA is available; reading the memory
            # through NVML, as probe_cuda_memory in ai.common.utils.hardware
            # does, needs no context and is the fuller fix.
            probe_index = 0
            if torch.cuda.is_available() and WhisperLoader._gpu_compatible is None:
                probe_index = WhisperLoader._first_candidate_gpu(exclude_gpus, torch)
            if torch.cuda.is_available() and WhisperLoader._check_gpu_compatible(
                device_index=probe_index,
                download_root=download_root,
                local_files_only=local_files_only,
                placed_by_allocator=True,
            ):
                gpu_index, torch_device = allocate_gpu(memory_gb, exclude_gpus)
                logger.info(f'Allocated GPU {gpu_index} ({torch_device}) for Whisper {model_name}')
            else:
                gpu_index = -1
                torch_device = 'cpu'
                if not torch.cuda.is_available():
                    logger.warning('CUDA is not available — Whisper will use CPU in server mode.')
                else:
                    device_fallback = WhisperLoader._gpu_probe_reason or 'ctranslate2 CUDA probe failed'
                    logger.error(
                        'Whisper %s will use the CPU in server mode although CUDA is available: %s',
                        model_name,
                        device_fallback,
                    )
            # CTranslate2 does not support float16 on CPU (Intel or ARM). Use int8 for speed;
            # use float32 in loader_options if you prefer max precision on CPU (slower, more RAM).
            # Refs: https://opennmt.net/CTranslate2/quantization.html (fallback table),
            #       https://github.com/SYSTRAN/faster-whisper/issues/65 (float16 on CPU).
            if torch_device == 'cpu' and compute_type == 'float16':
                compute_type = 'int8'
        else:
            # === LOCAL MODE: Use specified device ===
            if device is None:
                if torch.cuda.is_available():
                    if WhisperLoader._check_gpu_compatible(
                        download_root=download_root, local_files_only=local_files_only
                    ):
                        device = 'cuda'
                    else:
                        device = 'cpu'
                        device_fallback = WhisperLoader._gpu_probe_reason or 'ctranslate2 CUDA probe failed'
                        logger.error(
                            'Whisper %s will use the CPU although CUDA is available: %s', model_name, device_fallback
                        )
                else:
                    device = 'cpu'
            elif device != 'cpu':
                # Explicit cuda / cuda:N requested: probe that device, and fall back to
                # the CPU on failure so the same crash protection applies regardless of
                # how the caller specified the device.
                requested_index = int(device.split(':')[1]) if ':' in device else 0
                if not WhisperLoader._check_gpu_compatible(
                    device_index=requested_index, download_root=download_root, local_files_only=local_files_only
                ):
                    device_fallback = WhisperLoader._gpu_probe_reason or 'ctranslate2 CUDA probe failed'
                    logger.error(
                        'Whisper %s will use the CPU instead of the requested %r: %s',
                        model_name,
                        device,
                        device_fallback,
                    )
                    device = 'cpu'

            if device == 'cpu':
                gpu_index = -1
                torch_device = 'cpu'
                # CTranslate2: no float16 on CPU (Intel or ARM). int8 = faster; float32 = max precision.
                # Refs: https://opennmt.net/CTranslate2/quantization.html, faster-whisper #65.
                if compute_type == 'float16':
                    compute_type = 'int8'
            elif ':' in device:
                gpu_index = int(device.split(':')[1])
                torch_device = device
            else:
                gpu_index = 0
                torch_device = 'cuda:0'

            memory_gb = WhisperLoader._estimate_memory(model_name)

        # Load faster-whisper model
        # faster-whisper uses device='cuda' + device_index, NOT 'cuda:0'
        logger.info(f'Loading Whisper model {model_name} on {torch_device}')

        try:
            if torch_device == 'cpu':
                model = WhisperModel(
                    model_name,
                    device='cpu',
                    compute_type=compute_type,
                    **kwargs,
                )
            else:
                # Extract real device index from torch_device (e.g., 'cuda:0' -> 0)
                # In simulation mode, torch_device is always 'cuda:0' even for virtual GPUs 1,2,3
                real_device_index = int(torch_device.split(':')[1]) if ':' in torch_device else 0
                model = WhisperModel(
                    model_name,
                    device='cuda',
                    device_index=real_device_index,
                    compute_type=compute_type,
                    **kwargs,
                )
        except Exception as e:
            logger.error(f'Failed to load whisper model: {e}')
            raise Exception(f'Failed to load whisper model {model_name}: {e}')

        # Bundle model
        model_bundle = {
            'model': model,
            'language': language,
        }

        # Build metadata
        metadata = {
            'model_name': model_name,
            'device': torch_device,
            'gpu_index': gpu_index,
            'language': language,
            'compute_type': compute_type,
            'loader': 'whisper',
            'estimated_memory_gb': memory_gb,
        }
        if device_fallback:
            metadata['device_fallback'] = device_fallback

        logger.info(f'Whisper loaded: {model_name} on {torch_device}')

        return model_bundle, metadata, gpu_index

    @staticmethod
    def preprocess(
        model: Any,
        inputs: List[Any],
        metadata: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """
        Preprocess audio inputs for Whisper.

        Expects raw PCM int16 bytes (16kHz mono).

        Args:
            model: The model bundle (or ModelInstance for server mode)
            inputs: List of audio inputs (raw PCM int16 bytes)
            metadata: Optional metadata dict

        Returns:
            Dict with preprocessed audio data
        """
        import numpy as np

        processed_audios = []

        for inp in inputs:
            if not isinstance(inp, (bytes, bytearray)):
                raise ValueError(f'Expected bytes (PCM int16), got {type(inp)}')

            # Convert PCM int16 bytes to float32 numpy array
            int16_audio = np.frombuffer(inp, dtype=np.int16)
            float32_audio = int16_audio.astype(np.float32) / 32768.0
            processed_audios.append(float32_audio)

        # Get language from metadata or model bundle
        language = 'en'
        if metadata:
            language = metadata.get('language', 'en')
        elif isinstance(model, dict):
            language = model.get('language', 'en')

        return {
            'audios': processed_audios,
            'batch_size': len(inputs),
            'language': language,
        }

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
        language: Optional[str] = None,
        beam_size: int = 5,
        # Upstream defaults this to False; True is ours. Flipping it turns VAD off for
        # every existing caller.
        vad_filter: bool = True,
        vad_parameters: Optional[Dict[str, Any]] = None,
        word_timestamps: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Run Whisper transcription.

        Uses faster-whisper with built-in Silero VAD for voice activity detection.

        Args:
            model: Model bundle or ModelInstance
            preprocessed: Output from preprocess()
            metadata: Optional metadata dict
            stream: Optional CUDA stream (not used)
            language: Per-request decode language. Falls back to the value carried on
                preprocessed/the bundle, so callers that do not pass it keep the
                previous load-time behaviour.
            beam_size: Per-request beam size.
            vad_filter: Per-request VAD toggle.
            vad_parameters: Merged over _VAD_DEFAULTS rather than replacing them, so
                setting one key leaves the others at our defaults. A nested None means
                "unset"; 0 is a real value. Mapping only — unlike upstream, not a
                VadOptions.
            word_timestamps: Populate each segment's `words`. Off by default, matching
                upstream — turning it on costs an alignment pass and moves segment
                boundaries. The `words` block below was unreachable until this existed.

        Returns:
            List of transcription results with segments
        """
        # Handle both direct model bundle and ModelInstance (server mode)
        if hasattr(model, 'model_obj'):
            # Server mode - ModelInstance
            models = model.model_obj
        else:
            # Local mode - direct model bundle
            models = model

        whisper_model = models['model']
        # Per-request language wins; fall back to whatever the model was loaded with.
        if language is None:
            language = preprocessed.get('language', models.get('language', 'en'))

        # Merge, not replace: setting only `threshold` must keep our 500ms min-silence
        # instead of inheriting upstream's 2000ms. `is None`, not truthiness — 0 is real.
        vad_options = {
            **WhisperLoader._VAD_DEFAULTS,
            **{k: v for k, v in (vad_parameters or {}).items() if v is not None},
        }

        # Get lock for this model instance (faster-whisper is NOT thread-safe)
        model_lock = WhisperLoader._get_model_lock(id(whisper_model))

        results = []

        for audio in preprocessed['audios']:
            # Validate audio - must be at least 0.1 seconds (1600 samples at 16kHz)
            if len(audio) < 1600:
                logger.warning(f'Audio too short ({len(audio)} samples), skipping')
                results.append({'segments': [], 'language': language, 'text': ''})
                continue

            try:
                # Lock to prevent concurrent access to faster-whisper model
                with model_lock:
                    # Transcribe with Silero VAD
                    segments_gen, info = whisper_model.transcribe(
                        audio,
                        language=language,
                        beam_size=beam_size,
                        vad_filter=vad_filter,
                        vad_parameters=vad_options,
                        word_timestamps=word_timestamps,
                    )

                    # Convert generator to list and build result
                    segments = []
                    full_text_parts = []

                    for segment in segments_gen:
                        seg_dict = {
                            'start': segment.start,
                            'end': segment.end,
                            'text': segment.text.strip(),
                        }
                        # Include word-level info if available
                        if segment.words:
                            seg_dict['words'] = [
                                {
                                    'word': w.word,
                                    'start': w.start,
                                    'end': w.end,
                                    'probability': w.probability,
                                }
                                for w in segment.words
                            ]
                        segments.append(seg_dict)
                        full_text_parts.append(segment.text.strip())

                    result = {
                        'segments': segments,
                        'language': info.language,
                        'text': ' '.join(full_text_parts),
                    }

                results.append(result)

            except Exception as e:
                logger.error(f'Transcription failed: {e}')
                results.append({'segments': [], 'language': language, 'text': '', 'error': str(e)})

        return results

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: List[Dict[str, Any]],
        batch_size: int,
        output_fields: List[str],
        language: Optional[str] = None,
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """
        Postprocess Whisper output - extract only requested fields.

        Args:
            model: Model bundle or ModelInstance
            raw_output: Output from inference()
            batch_size: Expected batch size
            output_fields: Fields to extract (e.g., ['$text', '$segments'])
            language: Language resolved for this request. Used only as a fallback for
                results that don't already carry one; falls back to the loaded value
                when not supplied, preserving the previous behaviour.
            **kwargs: Additional parameters (ignored)

        Returns:
            List of dicts with requested fields only
        """
        from ..extract import extract_outputs

        # Fall back to the loaded language only when the caller didn't resolve one.
        if language is None:
            if hasattr(model, 'metadata'):
                language = model.metadata.get('language', 'en')
            elif isinstance(model, dict):
                language = model.get('language', 'en')
            else:
                language = 'en'

        results = []
        for output in raw_output:
            # Fallback first, so a language already on the output — the one the decoder
            # actually detected — is preserved rather than overwritten.
            output_with_lang = {'language': language, **output}
            extracted = extract_outputs(output_with_lang, output_fields)
            results.append(extracted)

        # Pad to batch size if needed
        empty = extract_outputs({'segments': [], 'language': language, 'text': ''}, output_fields)
        while len(results) < batch_size:
            results.append(empty.copy())

        return results[:batch_size]

    @staticmethod
    def _estimate_memory(model_name: str, **kwargs) -> float:
        """
        Estimate GPU memory required.

        Args:
            model_name: Whisper model size

        Returns:
            Estimated memory in GB
        """
        whisper_memory = {
            'tiny': 0.5,
            'tiny.en': 0.5,
            'base': 0.7,
            'base.en': 0.7,
            'small': 1.5,
            'small.en': 1.5,
            'medium': 3.0,
            'medium.en': 3.0,
            'large': 5.0,
            'large-v1': 5.0,
            'large-v2': 5.0,
            'large-v3': 5.0,
            'large-v3-turbo': 4.0,
            'turbo': 4.0,
        }

        return whisper_memory.get(model_name, 3.0)

    @staticmethod
    def get_supported_models() -> List[str]:
        """Get list of supported Whisper model sizes."""
        return [
            'tiny',
            'tiny.en',
            'base',
            'base.en',
            'small',
            'small.en',
            'medium',
            'medium.en',
            'large',
            'large-v1',
            'large-v2',
            'large-v3',
            'large-v3-turbo',
            'turbo',
        ]


class Whisper:
    """
    User-facing Whisper API with automatic local/remote detection.

    Uses faster-whisper (CTranslate2) with built-in Silero VAD.
    No pyannote dependency - fully MIT licensed.

    Usage:
        from ai.common.models import Whisper

        # Basic transcription
        model = Whisper('base', output_fields=['$text'])
        result = model.transcribe(audio_bytes)
        print(result['text'])

        # With segments
        model = Whisper('base', output_fields=['$text', '$segments'])
        result = model.transcribe(audio_bytes)
        for seg in result['segments']:
            print(f"{seg['start']:.2f} - {seg['end']:.2f}: {seg['text']}")
    """

    def __init__(
        self,
        model_name: str = 'base',
        output_fields: Optional[List[str]] = None,
        device: Optional[str] = None,
        language: str = 'en',
        compute_type: str = 'float16',
        **kwargs,
    ):
        """
        Initialize Whisper.

        Args:
            model_name: Whisper model size ('tiny', 'base', 'small', 'medium', 'large-v3')
            output_fields: Fields to extract (default: ['$text'])
            device: Device ('server', 'cuda', 'cpu', 'cuda:N', or None for auto)
            language: Language code for transcription
            compute_type: Compute type ('float16', 'int8', etc.)
            **kwargs: Loader options, forwarded to WhisperModel() and part of model
                identity. Decode parameters do not belong here — pass them to
                transcribe() instead; sent here they are absorbed and ignored.
        """
        self.model_name = model_name
        self.output_fields = output_fields or ['$text']
        self.device = device
        self.language = language
        self.compute_type = compute_type
        self.kwargs = kwargs

        # Check if we should proxy to server
        server_addr = get_model_server_address()
        should_proxy = server_addr and (device is None or device == 'server')

        if should_proxy:
            # === REMOTE MODE ===
            self._proxy_mode = True
            self._client = ModelClient(server_addr)
            self._model = None
            self._metadata = {}
            self._init_proxy()
        else:
            # === LOCAL MODE ===
            self._proxy_mode = False
            self._client = None

            # Use loader to load model
            self._model, self._metadata, _ = WhisperLoader.load(
                model_name,
                device=device if device != 'server' else None,
                language=language,
                compute_type=compute_type,
            )

    def _init_proxy(self) -> None:
        """Initialize proxy connection and load model on server.

        `language` is deliberately not sent: faster-whisper models are multilingual and
        it is a decode-time hint, sent per request by _transcribe_remote(). Including it
        here made generate_model_id() load one identical copy of the weights per
        language. `compute_type` stays — it genuinely changes the loaded weights.
        """
        loader_options = {
            'compute_type': self.compute_type,
        }
        if self.kwargs:
            loader_options.update(self.kwargs)

        self._client.load_model(
            model_name=self.model_name,
            model_type='whisper',
            loader_options=loader_options,
        )
        self._metadata = self._client.metadata

    def transcribe(
        self,
        audio: bytes,
        beam_size: int = 5,
        vad_filter: bool = True,
        vad_parameters: Optional[Dict[str, Any]] = None,
        language: Optional[str] = None,
        word_timestamps: bool = False,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Transcribe audio to text with timestamps.

        Args:
            audio: Raw PCM int16 bytes (16kHz mono)
            beam_size: Beam size for decoding
            vad_filter: Enable voice activity detection (Silero VAD)
            vad_parameters: VAD settings, merged over WhisperLoader._VAD_DEFAULTS rather
                than replacing them. Mapping only; a VadOptions is not accepted.
            language: Override the instance's default decode language for this call
            word_timestamps: Populate each segment's `words` with per-word timings.
                Off by default; turning it on costs an alignment pass and shifts
                segment boundaries.
            **kwargs: Additional transcription arguments

        Returns:
            Dict with requested output fields (e.g., 'text', 'segments')
        """
        if not isinstance(audio, bytes):
            raise TypeError(f'audio must be bytes (PCM int16), got {type(audio)}')

        # Count inference call — perf timing handled per-mode below
        metrics.counter('gpu_inference_count', 1)

        language = language if language is not None else self.language

        if self._proxy_mode:
            # Model server mode — ModelClient.send_command handles perf timing
            return self._transcribe_remote(
                audio, beam_size, vad_filter, vad_parameters, language, word_timestamps, **kwargs
            )
        else:
            # Local mode — time each phase
            return self._transcribe_local(
                audio, beam_size, vad_filter, vad_parameters, language, word_timestamps, **kwargs
            )

    def _transcribe_local(
        self,
        audio: bytes,
        beam_size: int,
        vad_filter: bool,
        vad_parameters: Optional[Dict[str, Any]],
        language: str,
        word_timestamps: bool = False,
        **kwargs,
    ) -> Dict[str, Any]:
        """Execute local transcription with perf timing."""
        # Preprocess phase — convert raw PCM bytes to model input format
        t0 = time.perf_counter()
        preprocessed = WhisperLoader.preprocess(self._model, [audio], self._metadata)
        t_pre = (time.perf_counter() - t0) * 1000

        # GPU inference phase — run transcription model
        t0 = time.perf_counter()
        raw_output = WhisperLoader.inference(
            self._model,
            preprocessed,
            self._metadata,
            language=language,
            beam_size=beam_size,
            vad_filter=vad_filter,
            vad_parameters=vad_parameters,
            word_timestamps=word_timestamps,
        )
        t_gpu = (time.perf_counter() - t0) * 1000

        # Postprocess phase — extract requested output fields
        t0 = time.perf_counter()
        results = WhisperLoader.postprocess(
            self._model,
            raw_output,
            1,
            self.output_fields,
            language=language,
        )
        t_post = (time.perf_counter() - t0) * 1000

        # Report all perf counters — same keys as model server response
        inference_sec = (t_pre + t_gpu + t_post) / 1000.0
        metrics.add_time(
            {
                'gpu_preprocess': t_pre,
                'gpu_compute': t_gpu,
                'gpu_postprocess': t_post,
                'gpu_queue_wait': 0,
                'gpu_memory': model_gpu_gb(self._model) * inference_sec,
            }
        )

        return results[0] if results else {}

    def _transcribe_remote(
        self,
        audio: bytes,
        beam_size: int,
        vad_filter: bool,
        vad_parameters: Optional[Dict[str, Any]],
        language: str,
        word_timestamps: bool = False,
        **kwargs,
    ) -> Dict[str, Any]:
        """Execute remote transcription via model server.

        `language` travels with the request rather than the load, so every language
        shares one server-side copy of the weights.
        """
        result = self._client.send_command(
            'rrext_ms_inference',
            {
                'data': audio,
                'beam_size': beam_size,
                'vad_filter': vad_filter,
                'vad_parameters': vad_parameters,
                'language': language,
                'word_timestamps': word_timestamps,
                'output_fields': self.output_fields,
                **kwargs,
            },
        )

        results = result.get('result', [])
        if results and len(results) > 0:
            return results[0]
        return {}

    def disconnect(self) -> None:
        """Disconnect from model server (proxy mode only)."""
        if self._proxy_mode and self._client:
            self._client.disconnect()

    @property
    def is_proxy(self) -> bool:
        """Check if running in proxy mode."""
        return self._proxy_mode

    @property
    def metadata(self) -> Dict:
        """Get model metadata."""
        return self._metadata
