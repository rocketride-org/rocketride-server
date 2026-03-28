"""Scale benchmark: find the crossover point where C++ beats Python.

Tests chunking at 75KB, 1MB, 10MB, and 100MB to show how performance
scales with data size. C++ should dominate at large scale due to
zero-copy string_view and no GC pressure.
"""

from __future__ import annotations

import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from datasets import paul_graham_essay

base_text = paul_graham_essay()[0]  # ~75KB

CHUNK_SIZE = 512
CHUNK_OVERLAP = 50
ITERATIONS = 3

# Generate datasets at different scales by repeating the base text
SCALES = [
    ('75KB', 1),
    ('750KB', 10),
    ('7.5MB', 100),
    ('75MB', 1000),
]

build_dir = os.path.join(os.path.dirname(__file__), '..', 'nodes', 'src', 'nodes', 'preprocessor_native', 'build')
if build_dir not in sys.path:
    sys.path.insert(0, build_dir)

try:
    import rr_native
except ImportError:
    print('SKIP: rr_native not built')
    sys.exit(1)

try:
    from langchain_text_splitters import RecursiveCharacterTextSplitter
except ImportError:
    print('SKIP: langchain-text-splitters not installed')
    sys.exit(1)

print(f'Config: chunk_size={CHUNK_SIZE}, overlap={CHUNK_OVERLAP}, iterations={ITERATIONS}')
print()
print(f'{"Scale":<10} {"Size":>10} {"RR (s)":>10} {"LC (s)":>10} {"RR/LC":>8} {"RR chunks":>10} {"LC chunks":>10}')
print('-' * 80)

for label, multiplier in SCALES:
    text = base_text * multiplier
    text_size = len(text)

    # RocketRide
    cfg = rr_native.ChunkerConfig()
    cfg.target_size = CHUNK_SIZE
    cfg.overlap = CHUNK_OVERLAP
    cfg.mode = rr_native.SplitMode.recursive
    chunker = rr_native.Chunker(cfg)

    # Warmup
    chunker.chunk(text[:10000], 0)

    rr_times = []
    rr_count = 0
    for _ in range(ITERATIONS):
        t0 = time.perf_counter()
        chunks = chunker.chunk(text, 0)
        rr_times.append(time.perf_counter() - t0)
        rr_count = len(chunks)

    # LangChain
    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP, length_function=len)

    # Warmup
    splitter.split_text(text[:10000])

    lc_times = []
    lc_count = 0
    for _ in range(ITERATIONS):
        t0 = time.perf_counter()
        chunks = splitter.split_text(text)
        lc_times.append(time.perf_counter() - t0)
        lc_count = len(chunks)

    rr_median = statistics.median(rr_times)
    lc_median = statistics.median(lc_times)
    ratio = rr_median / lc_median if lc_median > 0 else 0

    winner = 'C++ wins' if ratio < 1.0 else 'Python wins'
    print(f'{label:<10} {text_size:>9,} {rr_median:>9.3f}s {lc_median:>9.3f}s {ratio:>7.2f}x {rr_count:>10,} {lc_count:>10,}  {winner}')

print()
print('Ratio < 1.0 = C++ faster. Ratio > 1.0 = Python faster.')
print('Note: text is repeated base essay. Real-world data may differ.')
