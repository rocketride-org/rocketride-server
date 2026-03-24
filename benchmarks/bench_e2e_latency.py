#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
E2E pipeline latency benchmark with P50/P95/P99 percentiles.

Measures per-stage and end-to-end latency for a complete RAG pipeline:
  ingest → parse → chunk → index → search

Runs multiple iterations for statistical significance and reports
percentile latencies per stage.

Usage:
    python benchmarks/bench_e2e_latency.py <docs_dir> [iterations]
"""

import gc
import hashlib
import mimetypes
import os
import statistics
import sys
import time
from collections import defaultdict

import psutil


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


class PipelineBenchmark:
    """Measures per-stage latencies across multiple iterations."""

    def __init__(self):
        """Initialize latency collectors."""
        self.latencies = defaultdict(list)

    def measure(self, stage, func, *args, **kwargs):
        """Time a function call and record its latency."""
        t0 = time.perf_counter()
        result = func(*args, **kwargs)
        elapsed = time.perf_counter() - t0
        self.latencies[stage].append(elapsed)
        return result

    def print_stats(self):
        """Print percentile latency table."""
        print(f'\n{"Stage":<20} | {"P50 (ms)":>10} | {"P95 (ms)":>10} | {"P99 (ms)":>10} | {"Mean (ms)":>10}')
        print('-' * 72)
        for stage in ['discover', 'parse', 'chunk', 'index', 'search', 'e2e_ingest', 'e2e_search']:
            times = self.latencies.get(stage, [])
            if not times:
                continue
            ms = [t * 1000 for t in times]
            p50 = percentile(ms, 50)
            p95 = percentile(ms, 95)
            p99 = percentile(ms, 99)
            mean = statistics.mean(ms)
            print(f'{stage:<20} | {p50:>10.2f} | {p95:>10.2f} | {p99:>10.2f} | {mean:>10.2f}')

    def get_results(self):
        """Return results dict for comparison runner."""
        results = {}
        for stage in ['discover', 'parse', 'chunk', 'index', 'search', 'e2e_ingest', 'e2e_search']:
            times = self.latencies.get(stage, [])
            if times:
                ms = [t * 1000 for t in times]
                results[f'{stage}_p50_ms'] = percentile(ms, 50)
                results[f'{stage}_p95_ms'] = percentile(ms, 95)
                results[f'{stage}_p99_ms'] = percentile(ms, 99)
                results[f'{stage}_mean_ms'] = statistics.mean(ms)
        return results


# Pipeline stages
def discover_files(root_dir):
    """Discover text files in directory."""
    entries = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in sorted(filenames):
            fpath = os.path.join(dirpath, fname)
            mime = mimetypes.guess_type(fpath)[0] or 'application/octet-stream'
            if mime.startswith('text/') or mime in ('application/json', 'application/xml'):
                entries.append(fpath)
    return entries


def parse_file(fpath):
    """Read and hash a file."""
    with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    content_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
    return content, content_hash


def chunk_text(text, chunk_size=512, overlap=50):
    """Split text into fixed-size chunks with overlap."""
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunks.append(text[start:end])
        start += chunk_size - overlap
    return chunks


def build_index(chunks):
    """Build inverted index."""
    index = defaultdict(set)
    for i, chunk in enumerate(chunks):
        for word in chunk.lower().split():
            cleaned = ''.join(c for c in word if c.isalnum())
            if cleaned:
                index[cleaned].add(i)
    return index


def search_query(index, query):
    """Search inverted index."""
    terms = query.lower().split()
    result_ids = None
    for term in terms:
        cleaned = ''.join(c for c in term if c.isalnum())
        if cleaned in index:
            ids = index[cleaned]
            result_ids = ids if result_ids is None else result_ids & ids
    return result_ids or set()


def run(root_dir, iterations=5):
    """Run E2E latency benchmark with multiple iterations."""
    print('=' * 60)
    print('E2E PIPELINE LATENCY BENCHMARK')
    print(f'Dataset: {root_dir}')
    print(f'Iterations: {iterations}')
    print('=' * 60)

    bench = PipelineBenchmark()
    queries = ['data processing', 'machine learning', 'pipeline configuration', 'error handling', 'vector database', 'authentication', 'memory management', 'inverted index', 'embedding model', 'chunk strategy']

    gc.collect()
    mem_start = get_mem_mb()

    # Warmup iteration (not counted)
    print('\n[Warmup] Running 1 warmup iteration...')
    files = discover_files(root_dir)

    total_chunks = 0
    total_terms = 0

    for iteration in range(iterations):
        print(f'\n[Iteration {iteration + 1}/{iterations}]')

        # E2E ingest
        t_ingest_start = time.perf_counter()

        # Discover
        file_list = bench.measure('discover', discover_files, root_dir)

        # Parse all files
        all_chunks = []
        t_parse_start = time.perf_counter()
        docs = []
        for fpath in file_list:
            content, _hash = parse_file(fpath)
            docs.append(content)
        bench.latencies['parse'].append(time.perf_counter() - t_parse_start)

        # Chunk all docs
        t_chunk_start = time.perf_counter()
        for doc in docs:
            all_chunks.extend(chunk_text(doc))
        bench.latencies['chunk'].append(time.perf_counter() - t_chunk_start)

        # Index
        index = bench.measure('index', build_index, all_chunks)

        bench.latencies['e2e_ingest'].append(time.perf_counter() - t_ingest_start)

        total_chunks = len(all_chunks)
        total_terms = len(index)

        # E2E search (multiple queries)
        for q in queries:
            t_search_start = time.perf_counter()
            search_query(index, q)
            bench.latencies['search'].append(time.perf_counter() - t_search_start)
            bench.latencies['e2e_search'].append(time.perf_counter() - t_search_start)

    mem_end = get_mem_mb()

    # Results
    print('\n' + '=' * 72)
    print('LATENCY PERCENTILES')
    bench.print_stats()

    print(f'\n{"=" * 60}')
    print('SUMMARY')
    print(f'{"=" * 60}')
    print(f'  Files:        {len(files)}')
    print(f'  Chunks:       {total_chunks}')
    print(f'  Index terms:  {total_terms}')
    print(f'  Iterations:   {iterations}')
    print(f'  Memory delta: {mem_end - mem_start:.1f} MB')

    e2e_ingest_times = bench.latencies.get('e2e_ingest', [])
    if e2e_ingest_times:
        print(f'  E2E Ingest P50: {percentile([t * 1000 for t in e2e_ingest_times], 50):.1f} ms')
        print(f'  E2E Ingest P95: {percentile([t * 1000 for t in e2e_ingest_times], 95):.1f} ms')

    e2e_search_times = bench.latencies.get('e2e_search', [])
    if e2e_search_times:
        print(f'  E2E Search P50: {percentile([t * 1000 for t in e2e_search_times], 50):.3f} ms')
        print(f'  E2E Search P95: {percentile([t * 1000 for t in e2e_search_times], 95):.3f} ms')

    print(f'{"=" * 60}')

    # Return results compatible with run_comparison.py
    result = {
        'tool': 'e2e_latency',
        'total_time': statistics.mean(e2e_ingest_times) if e2e_ingest_times else 0,
        'docs': len(files),
        'chars': sum(len(d) for d in docs),
        'chunks': total_chunks,
        'index_terms': total_terms,
        'mem_delta_mb': mem_end - mem_start,
    }
    result.update(bench.get_results())
    return result


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory> [iterations]')
        sys.exit(1)
    iters = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    run(sys.argv[1], iterations=iters)
