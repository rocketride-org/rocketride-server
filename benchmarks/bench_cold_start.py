#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Cold-start benchmark — drop N files and measure time to first search result.

Simulates a developer's first experience: "I have 10K docs, how fast until
I can search them?" This is the #1 adoption driver per Reddit 2026.

Tests each framework end-to-end: parse → chunk → index → first successful query.

Usage:
    python benchmarks/bench_cold_start.py <docs_dir>
"""

import gc
import os
import re
import sys
import time
from collections import defaultdict

import psutil

from chunkers import CHUNKERS


def get_mem_mb():
    """Return current process RSS in MB."""
    return psutil.Process().memory_info().rss / (1024 * 1024)


def load_docs(root_dir, limit=None):
    """Load text files from directory."""
    docs = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in sorted(filenames):
            if limit and len(docs) >= limit:
                break
            fpath = os.path.join(dirpath, fname)
            try:
                with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                    content = f.read()
                if content.strip():
                    docs.append({'content': content, 'path': fpath, 'id': len(docs)})
            except OSError:
                continue
    return docs


def build_index_and_search(chunks, query):
    """Build inverted index from chunks and run a query. Return time and hit."""
    index = defaultdict(set)
    for i, chunk in enumerate(chunks):
        for w in set(re.findall(r'\w{2,}', chunk['text'].lower())):
            index[w].add(i)

    words = re.findall(r'\w{2,}', query.lower())
    scores = defaultdict(int)
    for w in words:
        for idx in index.get(w, set()):
            scores[idx] += 1
    results = sorted(scores.keys(), key=lambda x: -scores[x])[:10]
    return len(results) > 0, len(index)


def benchmark_cold_start(name, chunker, docs, query):
    """Measure total time from zero to first search result."""
    gc.collect()
    mem_before = get_mem_mb()

    t_start = time.perf_counter()

    # Full pipeline: chunk → index → search
    chunks = chunker(docs)

    t_chunked = time.perf_counter()

    hit, terms = build_index_and_search(chunks, query)

    t_end = time.perf_counter()
    mem_after = get_mem_mb()

    return {
        'name': name,
        'total_ms': (t_end - t_start) * 1000,
        'chunk_ms': (t_chunked - t_start) * 1000,
        'index_search_ms': (t_end - t_chunked) * 1000,
        'chunks': len(chunks),
        'terms': terms,
        'hit': hit,
        'mem_delta': mem_after - mem_before,
    }


def run(root_dir):
    """Run cold-start benchmark for all frameworks at different scales."""
    print('=' * 80)
    print('COLD START BENCHMARK — Time to First Search Result')
    print(f'Dataset: {root_dir}')
    print('=' * 80)

    all_docs = load_docs(root_dir)
    if not all_docs:
        print('No documents found.')
        return

    query = 'data processing pipeline machine learning'
    scales = [100, 500, 1000]
    scales = [s for s in scales if s <= len(all_docs)]
    if not scales:
        scales = [len(all_docs)]

    for scale in scales:
        docs = all_docs[:scale]
        total_chars = sum(len(d['content']) for d in docs)
        print(f'\n--- {scale} docs ({total_chars:,} chars) ---')
        print(f'{"Framework":<15} {"Total (ms)":>12} {"Chunk (ms)":>12} {"Idx+Search":>12} {"Chunks":>8} {"Mem MB":>8}')
        print('-' * 72)

        for name, func in CHUNKERS.items():
            try:
                r = benchmark_cold_start(name, func, docs, query)
            except Exception as e:
                print(f'  SKIP {name}: {e}')
                continue
            if 'error' in r:
                print(f'{name:<15} SKIP ({r["error"][:40]})')
            else:
                print(f'{r["name"]:<15} {r["total_ms"]:>12.1f} {r["chunk_ms"]:>12.1f} {r["index_search_ms"]:>12.1f} {r["chunks"]:>8} {r["mem_delta"]:>8.1f}')

    # Summary
    print(f'\n{"=" * 80}')
    print('COLD START — MARKDOWN FOR README')
    print(f'{"=" * 80}')
    docs = all_docs[: max(scales)]
    print(f'\n| Framework | Cold Start ({max(scales)} docs) | Chunks | Memory |')
    print('|---|---|---|---|')
    for name, func in CHUNKERS.items():
        try:
            r = benchmark_cold_start(name, func, docs, query)
        except Exception as e:
            print(f'  SKIP {name}: {e}')
            continue
        if 'error' not in r:
            print(f'| {name} | {r["total_ms"]:.0f}ms | {r["chunks"]:,} | +{r["mem_delta"]:.0f} MB |')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory>')
        sys.exit(1)
    run(sys.argv[1])
