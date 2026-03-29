"""5-way chunking benchmark: RocketRide vs LangChain vs LlamaIndex vs Chonkie vs Haystack.

All frameworks configured for character-count chunk_size=512 where supported.
Haystack uses word-based splitting (no character mode) — noted in results.

Timing: perf_counter, 1 warmup + 5 measured, median reported.
"""

from __future__ import annotations

import os
import statistics
import sys
import time

# ---------------------------------------------------------------------------
CHUNK_SIZE = 512
CHUNK_OVERLAP = 50
WARMUP = 1
ITERATIONS = 5

sys.path.insert(0, os.path.dirname(__file__))
from bench_datasets import paul_graham_essay

docs = paul_graham_essay()
text = docs[0]

print(f'Dataset: {len(docs)} docs, {len(text):,} chars')
print(f'Config: chunk_size={CHUNK_SIZE} chars, overlap={CHUNK_OVERLAP}, iterations={ITERATIONS}')
print()

results: list[tuple[str, float, int, str]] = []  # (name, median_s, chunks, note)


def bench(name: str, setup_fn, chunk_fn, note: str = '') -> None:
    try:
        ctx = setup_fn()
    except (ImportError, Exception) as e:
        print(f'SKIP {name}: {e}')
        return

    for _ in range(WARMUP):
        chunk_fn(ctx)

    times: list[float] = []
    n_chunks = 0
    for _ in range(ITERATIONS):
        t0 = time.perf_counter()
        out = chunk_fn(ctx)
        times.append(time.perf_counter() - t0)
        n_chunks = len(out) if out else 0

    results.append((name, statistics.median(times), n_chunks, note))


# ---------------------------------------------------------------------------
# 1. RocketRide (C++/recursive) — same algorithm as LangChain
# ---------------------------------------------------------------------------
def _rr_build_dir():
    d = os.path.join(os.path.dirname(__file__), '..', 'nodes', 'src', 'nodes', 'preprocessor_native', 'build')
    if d not in sys.path:
        sys.path.insert(0, d)


def _rr_recursive_setup():
    _rr_build_dir()
    import rr_native

    cfg = rr_native.ChunkerConfig()
    cfg.target_size = CHUNK_SIZE
    cfg.overlap = CHUNK_OVERLAP
    cfg.mode = rr_native.SplitMode.recursive
    return rr_native.Chunker(cfg)


def _rr_icu_setup():
    _rr_build_dir()
    import rr_native

    cfg = rr_native.ChunkerConfig()
    cfg.target_size = CHUNK_SIZE
    cfg.overlap = CHUNK_OVERLAP
    cfg.mode = rr_native.SplitMode.icu
    return rr_native.Chunker(cfg)


def _rr_chunk(chunker):
    return chunker.chunk(text, 0)


bench('RocketRide (C++/recursive)', _rr_recursive_setup, _rr_chunk, 'same separators as LangChain')
bench('RocketRide (C++/ICU)', _rr_icu_setup, _rr_chunk, 'Unicode sentence detection')


# ---------------------------------------------------------------------------
# 2. LangChain
# ---------------------------------------------------------------------------
def _lc_setup():
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    return RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP, length_function=len)


bench('LangChain', _lc_setup, lambda s: s.split_text(text), 'RecursiveCharacterTextSplitter')


# ---------------------------------------------------------------------------
# 3. LlamaIndex
# ---------------------------------------------------------------------------
def _li_setup():
    from llama_index.core import Document
    from llama_index.core.node_parser import SentenceSplitter

    splitter = SentenceSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP, tokenizer=list)
    doc = Document(text=text)
    return (splitter, doc)


bench('LlamaIndex', _li_setup, lambda ctx: ctx[0].get_nodes_from_documents([ctx[1]]), 'SentenceSplitter (char mode)')


# ---------------------------------------------------------------------------
# 4. Chonkie
# ---------------------------------------------------------------------------
def _chonkie_recursive_setup():
    from chonkie import RecursiveChunker

    return RecursiveChunker(tokenizer='character', chunk_size=CHUNK_SIZE)


bench(
    'Chonkie (recursive)',
    _chonkie_recursive_setup,
    lambda c: c.chunk(text),
    "RecursiveChunker, tokenizer='character'",
)


def _chonkie_token_setup():
    from chonkie import TokenChunker

    return TokenChunker(tokenizer='character', chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)


bench(
    'Chonkie (token/char)',
    _chonkie_token_setup,
    lambda c: c.chunk(text),
    "TokenChunker, tokenizer='character'",
)


# ---------------------------------------------------------------------------
# 5. Haystack
# ---------------------------------------------------------------------------
def _haystack_setup():
    from haystack import Document as HDoc
    from haystack.components.preprocessors import DocumentSplitter

    # Haystack has no character-based mode. Use word-based (closest approximation).
    # split_length=85 words ≈ 512 chars (avg 6 chars/word)
    splitter = DocumentSplitter(split_by='word', split_length=85, split_overlap=8)
    doc = HDoc(content=text)
    return (splitter, doc)


def _haystack_chunk(ctx):
    splitter, doc = ctx
    result = splitter.run(documents=[doc])
    return result['documents']


bench('Haystack', _haystack_setup, _haystack_chunk, 'word-based (no char mode), ~85 words ≈ 512 chars')


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
print('--- 5-Way Chunking Benchmark ---')
print(f'{"Framework":<30} {"Median":>10} {"Chunks":>8} {"Speedup":>10}  Note')
print('-' * 100)

if not results:
    print('No frameworks available.')
    sys.exit(1)

baseline_time = max(r[1] for r in results)

for name, median, chunks, note in results:
    speedup = baseline_time / median if median > 0 else 0
    base = ' (baseline)' if median == baseline_time else ''
    print(f'{name:<30} {median:>9.4f}s {chunks:>8} {speedup:>8.1f}x{base}  {note}')

print()
print('Fairness notes:')
print('  - All character-counting frameworks use chunk_size=512 chars, overlap=50 chars')
print('  - Haystack has no character mode; word-based splitting (~85 words ≈ 512 chars)')
print('  - Chunk count differences reflect algorithm differences, not unfair parameters')
print("  - RocketRide recursive uses same separators (\\n\\n, \\n, ' ', '') as LangChain")
