"""Fair indexing + search benchmark: RocketRide (C++/BM25) vs Python dict/BM25.

Uses LangChain-produced chunks as input so both indexers work on identical data.
Timing via time.perf_counter(), 1 warm-up + 5 measured iterations, median reported.
"""

from __future__ import annotations

import math
import os
import re
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
TOP_K = 5

SEARCH_QUERIES = [
    'What did Paul Graham work on before Y Combinator?',
    'How did Viaweb get started?',
    'What programming language did he use for Viaweb?',
    'What was his experience at art school?',
    'How does he describe the early days of Y Combinator?',
]

# ---------------------------------------------------------------------------
# Dataset — chunk with LangChain so both indexers get identical input
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(__file__))
from datasets import paul_graham_essay

docs = paul_graham_essay()
text = docs[0]

try:
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        length_function=len,
    )
    chunks: list[str] = splitter.split_text(text)
except ImportError:
    print('SKIP: langchain-text-splitters not installed (needed to produce chunks)')
    sys.exit(1)

print(f'Dataset: {len(docs)} docs, {len(text):,} chars, {len(chunks)} chunks\n')
print(f'Config: top_k={TOP_K}, queries={len(SEARCH_QUERIES)}, iterations={ITERATIONS}\n')


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def bench_index_search(
    name: str,
    setup_fn,
    index_fn,
    search_fn,
    teardown_fn=None,
):
    """Benchmark indexing and search separately, report medians."""
    try:
        ctx = setup_fn()
    except ImportError as e:
        print(f'SKIP {name}: {e}')
        return None

    # -- Index benchmark --
    for _ in range(WARMUP):
        ctx = setup_fn()
        index_fn(ctx)

    index_times: list[float] = []
    for _ in range(ITERATIONS):
        ctx = setup_fn()
        start = time.perf_counter()
        index_fn(ctx)
        end = time.perf_counter()
        index_times.append(end - start)

    # -- Search benchmark (on a fully indexed instance) --
    ctx = setup_fn()
    index_fn(ctx)

    for _ in range(WARMUP):
        for q in SEARCH_QUERIES:
            search_fn(ctx, q)

    search_times: list[float] = []
    for _ in range(ITERATIONS):
        start = time.perf_counter()
        for q in SEARCH_QUERIES:
            search_fn(ctx, q)
        end = time.perf_counter()
        search_times.append(end - start)

    if teardown_fn:
        teardown_fn(ctx)

    return (name, statistics.median(index_times), statistics.median(search_times))


# ---------------------------------------------------------------------------
# RocketRide (C++/BM25)
# ---------------------------------------------------------------------------
def _rr_setup():
    build_dir = os.path.join(
        os.path.dirname(__file__),
        '..',
        'nodes',
        'src',
        'nodes',
        'preprocessor_native',
        'build',
    )
    sys.path.insert(0, build_dir)
    import rr_native

    config = rr_native.IndexerConfig()
    indexer = rr_native.Indexer(config)
    return indexer


def _rr_index(indexer):
    for i, chunk_text in enumerate(chunks):
        indexer.add(i, chunk_text)


def _rr_search(indexer, query):
    return indexer.search(query, TOP_K)


# ---------------------------------------------------------------------------
# Python dict/BM25 (pure Python baseline)
# ---------------------------------------------------------------------------
class PythonBM25:
    """Minimal BM25 implementation using only stdlib."""

    def __init__(self, k1: float = 1.2, b: float = 0.75):  # noqa: D107
        self.k1 = k1
        self.b = b
        self.docs: list[list[str]] = []
        self.df: dict[str, int] = {}
        self.doc_lens: list[int] = []
        self.avgdl: float = 0.0
        self.n: int = 0
        self._token_re = re.compile(r'\w{2,}', re.UNICODE)

    def _tokenize(self, text: str) -> list[str]:
        return [t.lower() for t in self._token_re.findall(text)]

    def add(self, text: str) -> None:
        tokens = self._tokenize(text)
        self.docs.append(tokens)
        self.doc_lens.append(len(tokens))
        self.n += 1
        self.avgdl = sum(self.doc_lens) / self.n
        seen: set[str] = set()
        for t in tokens:
            if t not in seen:
                self.df[t] = self.df.get(t, 0) + 1
                seen.add(t)

    def search(self, query: str, top_k: int) -> list[tuple[int, float]]:
        q_tokens = self._tokenize(query)
        scores: list[float] = [0.0] * self.n
        for t in q_tokens:
            df_t = self.df.get(t, 0)
            if df_t == 0:
                continue
            idf = math.log((self.n - df_t + 0.5) / (df_t + 0.5) + 1.0)
            for i, doc_tokens in enumerate(self.docs):
                tf = doc_tokens.count(t)
                dl = self.doc_lens[i]
                denom = tf + self.k1 * (1 - self.b + self.b * dl / self.avgdl)
                scores[i] += idf * (tf * (self.k1 + 1)) / denom
        ranked = sorted(enumerate(scores), key=lambda x: -x[1])
        return ranked[:top_k]

    def reset(self) -> None:
        self.docs.clear()
        self.df.clear()
        self.doc_lens.clear()
        self.avgdl = 0.0
        self.n = 0


def _py_setup():
    return PythonBM25(k1=1.2, b=0.75)


def _py_index(bm25):
    for chunk_text in chunks:
        bm25.add(chunk_text)


def _py_search(bm25, query):
    return bm25.search(query, TOP_K)


# ---------------------------------------------------------------------------
# Run benchmarks
# ---------------------------------------------------------------------------
results = []

r = bench_index_search('RocketRide (C++/BM25)', _rr_setup, _rr_index, _rr_search)
if r:
    results.append(r)

r = bench_index_search('Python dict/BM25', _py_setup, _py_index, _py_search)
if r:
    results.append(r)

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Search quality agreement — do both return the same docs?
# ---------------------------------------------------------------------------
try:
    rr_idx = _rr_setup()
    _rr_index(rr_idx)
    py_idx = _py_setup()
    _py_index(py_idx)

    print('--- Search Quality Agreement ---')
    print(f'{"Query":<55} {"Overlap":>8}')
    total_overlap = 0
    for q in SEARCH_QUERIES:
        rr_results = _rr_search(rr_idx, q)
        py_results = _py_search(py_idx, q)
        rr_ids = {r.chunk_id for r in rr_results}
        py_ids = {r[0] for r in py_results}
        overlap = len(rr_ids & py_ids)
        total_overlap += overlap
        print(f'  {q[:53]:<55} {overlap}/{TOP_K}')

    avg_overlap = total_overlap / len(SEARCH_QUERIES)
    print(f'\n  Average overlap: {avg_overlap:.1f}/{TOP_K} ({avg_overlap / TOP_K * 100:.0f}%)')
    print(f'  Note: differences come from ICU vs regex tokenization (e.g. Unicode handling)')
    print()
except Exception as e:
    print(f'Quality check skipped: {e}\n')

if not results:
    print('No frameworks available to benchmark.')
    sys.exit(1)

print('--- Indexing Speed ---')
header = f'{"Framework":<30} {"Median(s)":>10} {"Speedup":>10}'
print(header)
baseline_idx = max(r[1] for r in results)
for name, idx_t, _ in results:
    speedup = baseline_idx / idx_t if idx_t > 0 else float('inf')
    suffix = ' (baseline)' if idx_t == baseline_idx else ''
    print(f'{name:<30} {idx_t:>9.4f}s {speedup:>8.1f}x{suffix}')

print()
print(f'--- Search Speed ({len(SEARCH_QUERIES)} queries) ---')
print(header)
baseline_search = max(r[2] for r in results)
for name, _, srch_t in results:
    speedup = baseline_search / srch_t if srch_t > 0 else float('inf')
    suffix = ' (baseline)' if srch_t == baseline_search else ''
    print(f'{name:<30} {srch_t:>9.4f}s {speedup:>8.1f}x{suffix}')
