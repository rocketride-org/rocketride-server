"""Embedding benchmark: measure where time is actually spent in a RAG pipeline.

This benchmark shows that embedding (the GPU/model step) dominates pipeline
latency, not chunking or indexing. Our C++ chunker+indexer speeds up the
CPU-bound stages, but embedding remains the bottleneck.

Requires: pip install sentence-transformers
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
ITERATIONS = 3  # fewer iterations — embedding is slow
MODEL_NAME = 'all-MiniLM-L6-v2'

# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(__file__))
from bench_datasets import paul_graham_essay

docs = paul_graham_essay()
text = docs[0]

print(f'Dataset: {len(text):,} chars')
print(f'Model: {MODEL_NAME}')
print()

# ---------------------------------------------------------------------------
# Stage 1: Chunk with RocketRide (C++/recursive) and LangChain
# ---------------------------------------------------------------------------
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

try:
    import rr_native
except ImportError:
    print('SKIP: rr_native not built. Run cmake --build in preprocessor_native/')
    sys.exit(1)

try:
    from langchain_text_splitters import RecursiveCharacterTextSplitter
except ImportError:
    print('SKIP: langchain-text-splitters not installed')
    sys.exit(1)

# RocketRide chunking
cfg = rr_native.ChunkerConfig()
cfg.target_size = CHUNK_SIZE
cfg.overlap = CHUNK_OVERLAP
cfg.mode = rr_native.SplitMode.recursive
rr_chunker = rr_native.Chunker(cfg)
rr_chunks_raw = rr_chunker.chunk(text, 0)
rr_chunk_texts = [text[c.offset : c.offset + c.length] for c in rr_chunks_raw]

# LangChain chunking
lc_splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP, length_function=len)
lc_chunk_texts = lc_splitter.split_text(text)

print(f'RocketRide chunks: {len(rr_chunk_texts)}')
print(f'LangChain chunks:  {len(lc_chunk_texts)}')
print()

# ---------------------------------------------------------------------------
# Stage 2: Embed chunks
# ---------------------------------------------------------------------------
try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    print('SKIP: sentence-transformers not installed (pip install sentence-transformers)')
    sys.exit(1)

print(f'Loading {MODEL_NAME}...')
model = SentenceTransformer(MODEL_NAME)

# Warmup
model.encode(rr_chunk_texts[:5], show_progress_bar=False)

# Benchmark embedding
embed_times_rr: list[float] = []
embed_times_lc: list[float] = []

for _ in range(ITERATIONS):
    t0 = time.perf_counter()
    model.encode(rr_chunk_texts, show_progress_bar=False, batch_size=32)
    embed_times_rr.append(time.perf_counter() - t0)

for _ in range(ITERATIONS):
    t0 = time.perf_counter()
    model.encode(lc_chunk_texts, show_progress_bar=False, batch_size=32)
    embed_times_lc.append(time.perf_counter() - t0)

# ---------------------------------------------------------------------------
# Stage 3: Time breakdown
# ---------------------------------------------------------------------------
# Chunk timing
chunk_times_rr: list[float] = []
chunk_times_lc: list[float] = []

for _ in range(5):
    t0 = time.perf_counter()
    rr_chunker.chunk(text, 0)
    chunk_times_rr.append(time.perf_counter() - t0)

for _ in range(5):
    t0 = time.perf_counter()
    lc_splitter.split_text(text)
    chunk_times_lc.append(time.perf_counter() - t0)

# Index timing
rr_idx = rr_native.Indexer()
idx_times_rr: list[float] = []
for _ in range(5):
    rr_idx.reset()
    t0 = time.perf_counter()
    for i, ct in enumerate(rr_chunk_texts):
        rr_idx.add(i, ct)
    idx_times_rr.append(time.perf_counter() - t0)

# Search timing
search_queries = [
    'What did Paul Graham work on before Y Combinator?',
    'How did Viaweb get started?',
    'What programming language did he use?',
]
search_times_rr: list[float] = []
for _ in range(5):
    t0 = time.perf_counter()
    for q in search_queries:
        rr_idx.search(q, 5)
    search_times_rr.append(time.perf_counter() - t0)

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
chunk_rr = statistics.median(chunk_times_rr)
chunk_lc = statistics.median(chunk_times_lc)
embed_rr = statistics.median(embed_times_rr)
embed_lc = statistics.median(embed_times_lc)
index_rr = statistics.median(idx_times_rr)
search_rr = statistics.median(search_times_rr)

total_rr = chunk_rr + embed_rr + index_rr + search_rr
total_lc = chunk_lc + embed_lc  # LangChain doesn't have built-in index/search

print('--- Full RAG Pipeline Breakdown ---')
print(f'{"Stage":<25} {"RocketRide":>12} {"LangChain":>12} {"Speedup":>10}')
print(f'{"Chunking":<25} {chunk_rr:>11.4f}s {chunk_lc:>11.4f}s {chunk_lc / chunk_rr:>8.1f}x')
print(f'{"Embedding":<25} {embed_rr:>11.4f}s {embed_lc:>11.4f}s {embed_lc / embed_rr:>8.1f}x')
print(f'{"Indexing (BM25)":<25} {index_rr:>11.4f}s {"N/A":>12} {"":>10}')
print(f'{"Search (3 queries)":<25} {search_rr:>11.6f}s {"N/A":>12} {"":>10}')
print()
print(f'{"Pipeline total":<25} {total_rr:>11.4f}s')
print()
print(f'--- Time Distribution (RocketRide) ---')
print(f'  Chunking:  {chunk_rr / total_rr * 100:>5.1f}%')
print(f'  Embedding: {embed_rr / total_rr * 100:>5.1f}%  <-- bottleneck (GPU/model)')
print(f'  Indexing:  {index_rr / total_rr * 100:>5.1f}%')
print(f'  Search:    {search_rr / total_rr * 100:>5.1f}%')
print()
print('Note: Embedding dominates pipeline latency. Our C++ chunker+indexer')
print('speeds up the CPU stages, but the real bottleneck is the embedding model.')
print('Future: C++ ONNX embedding node would address this.')
