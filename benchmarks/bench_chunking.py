"""Fair chunking benchmark: RocketRide (C++/ICU) vs LangChain vs LlamaIndex.

All frameworks use character-count chunk_size=512, overlap=50.
Timing via time.perf_counter(), 1 warm-up + 5 measured iterations, median reported.
Only the chunking call is timed -- no I/O, no setup, no imports.
"""

from __future__ import annotations

import os
import statistics
import sys
import time

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
CHUNK_SIZE = 512
CHUNK_OVERLAP = 50
WARMUP = 1
ITERATIONS = 5

# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(__file__))
from datasets import paul_graham_essay

docs = paul_graham_essay()
text = docs[0]

print(f'Dataset: {len(docs)} docs, {len(text):,} chars\n')
print(f'Config: chunk_size={CHUNK_SIZE} chars, overlap={CHUNK_OVERLAP} chars, iterations={ITERATIONS}\n')

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
results: list[tuple[str, float, int]] = []  # (name, median_s, chunk_count)


def bench(name: str, setup_fn, chunk_fn) -> None:
    """Run warm-up + measured iterations and record median."""
    try:
        ctx = setup_fn()
    except ImportError as e:
        print(f'SKIP {name}: {e}')
        return

    # Warm-up
    for _ in range(WARMUP):
        chunk_fn(ctx)

    # Measured runs
    times: list[float] = []
    chunk_count = 0
    for _ in range(ITERATIONS):
        start = time.perf_counter()
        out = chunk_fn(ctx)
        end = time.perf_counter()
        times.append(end - start)
        chunk_count = len(out)

    median = statistics.median(times)
    results.append((name, median, chunk_count))


# ---------------------------------------------------------------------------
# RocketRide (C++/ICU)
# ---------------------------------------------------------------------------
def _rr_build_dir():
    build_dir = os.path.join(
        os.path.dirname(__file__),
        '..',
        'nodes',
        'src',
        'nodes',
        'preprocessor_native',
        'build',
    )
    if build_dir not in sys.path:
        sys.path.insert(0, build_dir)


def _rr_setup(mode_name):
    def setup():
        _rr_build_dir()
        import rr_native

        config = rr_native.ChunkerConfig()
        config.target_size = CHUNK_SIZE
        config.overlap = CHUNK_OVERLAP
        config.mode = getattr(rr_native.SplitMode, mode_name)
        return rr_native.Chunker(config)

    return setup


def _rr_chunk(chunker):
    return chunker.chunk(text, 0)


bench('RocketRide (C++/recursive)', _rr_setup('recursive'), _rr_chunk)
bench('RocketRide (C++/fast)', _rr_setup('fast'), _rr_chunk)
bench('RocketRide (C++/ICU)', _rr_setup('icu'), _rr_chunk)


# ---------------------------------------------------------------------------
# LangChain
# ---------------------------------------------------------------------------
def _lc_setup():
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    return RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        length_function=len,
    )


def _lc_chunk(splitter):
    return splitter.split_text(text)


bench('LangChain', _lc_setup, _lc_chunk)


# ---------------------------------------------------------------------------
# LlamaIndex
# ---------------------------------------------------------------------------
def _li_setup():
    from llama_index.core import Document
    from llama_index.core.node_parser import SentenceSplitter

    # tokenizer=list makes chunk_size count characters, not tokens (fair comparison)
    splitter = SentenceSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP, tokenizer=list)
    doc = Document(text=text)
    return (splitter, doc)


def _li_chunk(ctx):
    splitter, doc = ctx
    return splitter.get_nodes_from_documents([doc])


bench('LlamaIndex', _li_setup, _li_chunk)


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
print('--- Chunking Speed ---')
header = f'{"Framework":<35} {"Median(s)":>10} {"Chunks":>8} {"Speedup":>10}'
print(header)

if not results:
    print('No frameworks available to benchmark.')
    sys.exit(1)

# Find the slowest as baseline (1.0x)
baseline_time = max(r[1] for r in results)

for name, median, chunks in results:
    speedup = baseline_time / median if median > 0 else float('inf')
    suffix = ' (baseline)' if median == baseline_time else ''
    print(f'{name:<35} {median:>9.4f}s {chunks:>8} {speedup:>8.1f}x{suffix}')
