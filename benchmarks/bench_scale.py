#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Scale benchmark — where C++ wins over Python.

Tests all frameworks at increasing document counts (1K → 5K → 10K → 50K → 100K)
to find the "scaling cliff" where Python frameworks degrade or crash.

Measures at each scale:
  - Ingestion time (chunk + index)
  - Memory usage (RSS)
  - Throughput (docs/sec, tokens/sec)
  - Whether the framework survives (OOM detection)

Usage:
    python benchmarks/bench_scale.py [max_docs]
"""

import gc
import os
import random
import sys
import time

import psutil

sys.path.insert(0, os.path.dirname(__file__))
from chunkers import CHUNKERS, build_inverted_index


def get_mem_mb():
    """Return current process RSS in MB."""
    return psutil.Process().memory_info().rss / (1024 * 1024)


# Paragraph templates for doc generation
_PARAGRAPHS = [
    'Data processing pipelines are the backbone of modern AI systems. They transform raw data into structured formats suitable for machine learning models and analytics workloads.',
    'Vector databases enable semantic search by storing high-dimensional embeddings alongside metadata. This allows applications to find conceptually similar content rather than relying on keyword matching alone.',
    'Pipeline configuration requires careful attention to node ordering, error handling, and resource allocation. Each node in the pipeline processes data and passes results downstream.',
    'The embedding model converts text into dense vector representations. These vectors capture semantic meaning and enable similarity comparisons between documents.',
    'Chunking strategies significantly impact retrieval quality. Too large chunks lose specificity, while too small chunks lose context. Overlap between chunks helps maintain continuity.',
    'Machine learning workflows often involve data ingestion, preprocessing, feature extraction, model training, and inference. Each stage has distinct computational requirements.',
    'Error handling in distributed pipelines must account for network failures, timeout conditions, and partial results. Retry logic with exponential backoff is a common pattern.',
    'Memory management is critical when processing large document collections. Streaming approaches and batch processing help control resource consumption.',
    'The inverted index maps terms to document identifiers, enabling fast full-text search. Posting lists are typically sorted for efficient intersection operations.',
    'Authentication and authorization protect pipeline endpoints from unauthorized access. API keys, OAuth tokens, and role-based access control are common mechanisms.',
]


def generate_doc(doc_id):
    """Generate a synthetic document with deterministic content."""
    random.seed(doc_id + 42)
    n_paragraphs = random.randint(3, 12)
    selected = [random.choice(_PARAGRAPHS) for _ in range(n_paragraphs)]
    title = f'Document {doc_id}: Analysis and Report'
    return f'# {title}\n\n' + '\n\n'.join(selected) + '\n'


def generate_docs(count):
    """Generate N synthetic documents in memory."""
    docs = []
    for i in range(count):
        content = generate_doc(i)
        docs.append({'content': content, 'id': i})
    return docs


def benchmark_at_scale(name, chunker_func, docs, mem_limit_mb=4096):
    """Run chunking + indexing at a given scale. Return results or error."""
    gc.collect()
    mem_before = get_mem_mb()
    total_chars = sum(len(d['content']) for d in docs)

    t0 = time.perf_counter()
    try:
        chunks = chunker_func(docs)
    except Exception as e:
        return {'name': name, 'error': f'chunk failed: {e!s:.50}', 'docs': len(docs)}

    t_chunk = time.perf_counter() - t0
    mem_after_chunk = get_mem_mb()

    # Check memory limit
    if mem_after_chunk - mem_before > mem_limit_mb:
        return {'name': name, 'error': f'OOM at chunking ({mem_after_chunk - mem_before:.0f} MB)', 'docs': len(docs)}

    t0 = time.perf_counter()
    try:
        index = build_inverted_index(chunks)
    except Exception as e:
        return {'name': name, 'error': f'index failed: {e!s:.50}', 'docs': len(docs)}

    t_index = time.perf_counter() - t0
    mem_after_index = get_mem_mb()

    total_time = t_chunk + t_index
    tokens = total_chars // 4
    mem_delta = mem_after_index - mem_before

    return {
        'name': name,
        'docs': len(docs),
        'chunks': len(chunks),
        'terms': len(index),
        'total_time': total_time,
        'chunk_time': t_chunk,
        'index_time': t_index,
        'tokens_per_sec': tokens / max(0.001, total_time),
        'docs_per_sec': len(docs) / max(0.001, total_time),
        'mem_delta': mem_delta,
        'docs_per_mb': len(docs) / max(0.1, mem_delta),
        'total_chars': total_chars,
    }


def run(max_docs=100000):
    """Run scale benchmark across all frameworks."""
    print('=' * 90)
    print('SCALE BENCHMARK — Finding the Python Scaling Cliff')
    print(f'Max docs: {max_docs:,}')
    print('=' * 90)

    scales = [s for s in [1000, 5000, 10000, 50000, 100000, 200000, 500000, 1000000] if s <= max_docs]
    if not scales:
        scales = [max_docs]

    # Generate all docs upfront
    print(f'\nGenerating {max(scales):,} synthetic docs...')
    t0 = time.perf_counter()
    all_docs = generate_docs(max(scales))
    total_chars = sum(len(d['content']) for d in all_docs)
    print(f'  Generated in {time.perf_counter() - t0:.1f}s ({total_chars:,} chars)')

    # Results table
    all_results = {}

    for scale in scales:
        docs = all_docs[:scale]
        print(f'\n{"=" * 90}')
        print(f'SCALE: {scale:,} docs ({sum(len(d["content"]) for d in docs):,} chars)')
        print(f'{"=" * 90}')
        print(f'{"Framework":<15} {"Time":>8} {"Chunks":>10} {"tok/s":>12} {"Mem MB":>10} {"docs/MB":>10} {"Status":>10}')
        print('-' * 80)

        for fw_name, chunker_func in CHUNKERS.items():
            gc.collect()
            r = benchmark_at_scale(fw_name, chunker_func, docs)

            if 'error' in r:
                print(f'{fw_name:<15} {"—":>8} {"—":>10} {"—":>12} {"—":>10} {"—":>10} {"FAILED":>10}')
                print(f'  Error: {r["error"]}')
            else:
                status = 'OK'
                if r['mem_delta'] > 1024:
                    status = 'HIGH MEM'
                print(
                    f'{r["name"]:<15} {r["total_time"]:>8.2f} {r["chunks"]:>10,} '
                    f'{r["tokens_per_sec"]:>12,.0f} {r["mem_delta"]:>10.1f} '
                    f'{r["docs_per_mb"]:>10.1f} {status:>10}'
                )

            if fw_name not in all_results:
                all_results[fw_name] = []
            all_results[fw_name].append(r)

    # Summary: scaling curves
    print(f'\n{"=" * 90}')
    print('SCALING CURVES — Throughput (tok/s) at each scale')
    print(f'{"=" * 90}')
    header = f'{"Framework":<15}'
    for s in scales:
        header += f' {s//1000}K tok/s'.rjust(12)
    print(header)
    print('-' * (15 + 12 * len(scales)))

    for fw_name in CHUNKERS:
        row = f'{fw_name:<15}'
        for r in all_results.get(fw_name, []):
            if 'error' in r:
                row += f'{"FAILED":>12}'
            else:
                row += f'{r["tokens_per_sec"]:>12,.0f}'
        print(row)

    # Memory scaling
    print(f'\n{"=" * 90}')
    print('MEMORY SCALING — RSS delta (MB) at each scale')
    print(f'{"=" * 90}')
    header = f'{"Framework":<15}'
    for s in scales:
        header += f' {s//1000}K MB'.rjust(12)
    print(header)
    print('-' * (15 + 12 * len(scales)))

    for fw_name in CHUNKERS:
        row = f'{fw_name:<15}'
        for r in all_results.get(fw_name, []):
            if 'error' in r:
                row += f'{"OOM":>12}'
            else:
                row += f'{r["mem_delta"]:>12.1f}'
        print(row)

    # Markdown
    print('\n### Scale Benchmark (throughput tok/s)')
    header = '| Framework |'
    sep = '|---|'
    for s in scales:
        header += f' {s//1000}K docs |'
        sep += '---|'
    print(header)
    print(sep)
    for fw_name in CHUNKERS:
        row = f'| {fw_name} |'
        for r in all_results.get(fw_name, []):
            if 'error' in r:
                row += ' FAILED |'
            else:
                row += f' {r["tokens_per_sec"]:,.0f} |'
        print(row)


if __name__ == '__main__':
    max_d = int(sys.argv[1]) if len(sys.argv) > 1 else 50000
    run(max_docs=max_d)
