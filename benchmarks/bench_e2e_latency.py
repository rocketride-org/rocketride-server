#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
E2E pipeline latency benchmark with P50/P95/P99 percentiles.

Measures per-stage and end-to-end latency for all 5 frameworks:
  discover → parse → chunk → index → search

Runs multiple iterations for statistical significance.

Usage:
    python benchmarks/bench_e2e_latency.py <docs_dir> [iterations]
"""

import gc
import mimetypes
import os
import sys
import time

import psutil

from chunkers import CHUNKERS, build_inverted_index, search_index


def percentile(data, p):
    """Calculate the p-th percentile of a list of values."""
    if not data:
        return 0.0
    sorted_data = sorted(data)
    k = (len(sorted_data) - 1) * (p / 100)
    f = int(k)
    c = f + 1
    if c >= len(sorted_data):
        return sorted_data[f]
    return sorted_data[f] + (k - f) * (sorted_data[c] - sorted_data[f])


def get_mem_mb():
    """Return current process RSS in MB."""
    return psutil.Process().memory_info().rss / (1024 * 1024)


def discover_files(root_dir):
    """Discover text files in directory."""
    entries = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames.sort()
        for fname in sorted(filenames):
            fpath = os.path.join(dirpath, fname)
            mime = mimetypes.guess_type(fpath)[0] or 'application/octet-stream'
            if mime.startswith('text/') or mime in ('application/json', 'application/xml'):
                entries.append(fpath)
    return entries


def parse_files(file_list):
    """Read and hash all files."""
    docs = []
    for fpath in file_list:
        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        docs.append({'content': content, 'path': fpath, 'id': len(docs)})
    return docs


def run(root_dir, iterations=5):
    """Run E2E latency benchmark for all frameworks."""
    if not os.path.isdir(root_dir):
        print(f'Error: {root_dir} not found')
        sys.exit(1)

    print('=' * 80)
    print('E2E PIPELINE LATENCY BENCHMARK (all frameworks)')
    print(f'Dataset: {root_dir}, Iterations: {iterations}')
    print('=' * 80)

    queries = ['data processing', 'machine learning', 'pipeline configuration', 'error handling', 'vector database', 'authentication', 'memory management', 'inverted index', 'embedding model', 'chunk strategy']

    # Discover + parse once (shared across frameworks)
    file_list = discover_files(root_dir)
    docs = parse_files(file_list)
    print(f'\n{len(docs)} docs, {sum(len(d["content"]) for d in docs):,} chars\n')

    all_framework_results = []

    for fw_name, chunker_func in CHUNKERS.items():
        print(f'\n--- {fw_name} ({iterations} iterations) ---')

        latencies = {'chunk': [], 'index': [], 'search': [], 'e2e_ingest': [], 'e2e_search': []}

        # Warmup
        try:
            warmup_chunks = chunker_func(docs[:10])
            warmup_idx = build_inverted_index(warmup_chunks)
            search_index(warmup_idx, 'test query')
        except Exception as e:
            print(f'  SKIP ({e!s:.60})')
            continue

        gc.collect()

        for iteration in range(iterations):
            # E2E ingest
            t_ingest_start = time.perf_counter()

            # Chunk
            t0 = time.perf_counter()
            try:
                chunks = chunker_func(docs)
            except Exception as e:
                print(f'  SKIP iteration {iteration}: {e!s:.40}')
                break
            latencies['chunk'].append(time.perf_counter() - t0)

            # Index
            t0 = time.perf_counter()
            index = build_inverted_index(chunks)
            latencies['index'].append(time.perf_counter() - t0)

            latencies['e2e_ingest'].append(time.perf_counter() - t_ingest_start)

            # Search
            for q in queries:
                t0 = time.perf_counter()
                search_index(index, q)
                latencies['search'].append(time.perf_counter() - t0)

            # E2E search (batch of 10 queries)
            t0 = time.perf_counter()
            for q in queries:
                search_index(index, q)
            latencies['e2e_search'].append(time.perf_counter() - t0)

        if not latencies['chunk']:
            continue

        # Print per-framework results
        print(f'  {"Stage":<15} {"P50 (ms)":>10} {"P95 (ms)":>10} {"P99 (ms)":>10}')
        print(f'  {"-" * 50}')
        fw_result = {'name': fw_name}
        for stage in ['chunk', 'index', 'search', 'e2e_ingest', 'e2e_search']:
            times = latencies.get(stage, [])
            if not times:
                continue
            ms = [t * 1000 for t in times]
            p50 = percentile(ms, 50)
            p95 = percentile(ms, 95)
            p99 = percentile(ms, 99)
            print(f'  {stage:<15} {p50:>10.2f} {p95:>10.2f} {p99:>10.2f}')
            fw_result[f'{stage}_p50'] = p50
            fw_result[f'{stage}_p95'] = p95
            fw_result[f'{stage}_p99'] = p99

        all_framework_results.append(fw_result)

    if not all_framework_results:
        print('No frameworks completed.')
        return

    # Comparison table
    print(f'\n{"=" * 80}')
    print('E2E INGEST LATENCY COMPARISON (P50 ms)')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"Chunk P50":>12} {"Index P50":>12} {"E2E Ingest":>12} {"Search P50":>12}')
    print('-' * 65)
    for r in sorted(all_framework_results, key=lambda x: x.get('e2e_ingest_p50', 9999)):
        print(f'{r["name"]:<15} {r.get("chunk_p50", 0):>12.2f} {r.get("index_p50", 0):>12.2f} {r.get("e2e_ingest_p50", 0):>12.2f} {r.get("search_p50", 0):>12.4f}')

    # Markdown
    print('\n| Framework | Chunk P50 | Index P50 | E2E Ingest P50 | Search P50 |')
    print('|---|---|---|---|---|')
    for r in sorted(all_framework_results, key=lambda x: x.get('e2e_ingest_p50', 9999)):
        print(f'| {r["name"]} | {r.get("chunk_p50", 0):.2f}ms | {r.get("index_p50", 0):.2f}ms | {r.get("e2e_ingest_p50", 0):.2f}ms | {r.get("search_p50", 0):.4f}ms |')

    return {'tool': 'e2e_latency', 'frameworks': all_framework_results}


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory> [iterations]')
        sys.exit(1)
    iters = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    run(sys.argv[1], iterations=iters)
