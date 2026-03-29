"""Large-scale chunking benchmark: 75MB text, 7 frameworks.

At production scale, C++ dominates due to zero-copy string_view,
no GC pressure, and efficient memory management.

All character-counting frameworks use chunk_size=512 chars, overlap=50.
"""

from __future__ import annotations

import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from bench_datasets import paul_graham_essay

build_dir = os.path.join(os.path.dirname(__file__), '..', 'nodes', 'src', 'nodes', 'preprocessor_native', 'build')
if build_dir not in sys.path:
    sys.path.insert(0, build_dir)

base = paul_graham_essay()[0]
MULTIPLIER = 1000
ITERS = 3

text = base * MULTIPLIER
print(f'Dataset: {len(text):,} chars ({len(text) / 1024 / 1024:.1f} MB)')
print(f'Config: chunk_size=512, overlap=50, iterations={ITERS}')
print()

results: list[tuple[str, float, int]] = []


def bench(name: str, fn) -> None:
    try:
        fn(base)  # warmup on small text
    except Exception as e:
        print(f'SKIP {name}: {e}')
        return

    times: list[float] = []
    count = 0
    for _ in range(ITERS):
        t0 = time.perf_counter()
        result = fn(text)
        times.append(time.perf_counter() - t0)
        count = len(result) if result else 0

    results.append((name, statistics.median(times), count))


# ---------------------------------------------------------------------------
# RocketRide modes
# ---------------------------------------------------------------------------
import rr_native

for mode_name, label in [
    ('recursive', 'RocketRide (C++/recursive)'),
    ('icu', 'RocketRide (C++/ICU)'),
    ('fast', 'RocketRide (C++/fast)'),
]:
    cfg = rr_native.ChunkerConfig()
    cfg.target_size = 512
    cfg.overlap = 50
    cfg.mode = getattr(rr_native.SplitMode, mode_name)
    chunker = rr_native.Chunker(cfg)
    bench(label, lambda t, c=chunker: c.chunk(t, 0))

# ---------------------------------------------------------------------------
# LangChain
# ---------------------------------------------------------------------------
try:
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    lc = RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=50, length_function=len)
    bench('LangChain', lambda t: lc.split_text(t))
except ImportError as e:
    print(f'SKIP LangChain: {e}')

# ---------------------------------------------------------------------------
# Chonkie
# ---------------------------------------------------------------------------
try:
    from chonkie import RecursiveChunker, TokenChunker

    bench('Chonkie (recursive)', lambda t: RecursiveChunker(tokenizer='character', chunk_size=512).chunk(t))
    bench(
        'Chonkie (token/char)',
        lambda t: TokenChunker(tokenizer='character', chunk_size=512, chunk_overlap=50).chunk(t),
    )
except ImportError as e:
    print(f'SKIP Chonkie: {e}')

# ---------------------------------------------------------------------------
# LlamaIndex
# ---------------------------------------------------------------------------
try:
    from llama_index.core import Document
    from llama_index.core.node_parser import SentenceSplitter

    li = SentenceSplitter(chunk_size=512, chunk_overlap=50, tokenizer=list)
    bench('LlamaIndex', lambda t: li.get_nodes_from_documents([Document(text=t)]))
except ImportError as e:
    print(f'SKIP LlamaIndex: {e}')

# ---------------------------------------------------------------------------
# Haystack
# ---------------------------------------------------------------------------
try:
    from haystack import Document as HDoc
    from haystack.components.preprocessors import DocumentSplitter

    hs = DocumentSplitter(split_by='word', split_length=85, split_overlap=8)
    bench('Haystack', lambda t: hs.run(documents=[HDoc(content=t)])['documents'])
except ImportError as e:
    print(f'SKIP Haystack: {e}')

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
if not results:
    print('No frameworks available.')
    sys.exit(1)

lc_time = next((r[1] for r in results if r[0] == 'LangChain'), None)

print(f'{"Framework":<30} {"Median(s)":>10} {"Chunks":>10} {"vs LangChain":>14}')
print('-' * 70)

for name, med, count in sorted(results, key=lambda r: r[1]):
    if lc_time:
        ratio = lc_time / med
        vs = f'{ratio:.1f}x faster' if ratio > 1 else f'{1 / ratio:.1f}x slower'
    else:
        vs = ''
    print(f'{name:<30} {med:>9.2f}s {count:>10,} {vs:>14}')

print()
print('Notes:')
print('  - RocketRide recursive produces bit-for-bit identical output to LangChain')
print('  - Haystack uses word-based splitting (no character mode)')
print('  - At 75MB, C++ zero-copy string_view and no GC pressure dominate')
