#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Memory-constrained scale benchmark — simulates 8GB machine.

Monitors RSS and stops each framework when it exceeds the memory budget.
Shows the "scaling cliff" — max docs each framework can handle in 8GB.

Usage:
    python benchmarks/bench_scale_constrained.py [mem_limit_gb]
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


def generate_batch(start_id, count):
    """Generate a batch of synthetic documents."""
    docs = []
    for i in range(count):
        doc_id = start_id + i
        random.seed(doc_id + 42)
        n = random.randint(3, 12)
        content = f'# Document {doc_id}\n\n' + '\n\n'.join(random.choice(_PARAGRAPHS) for _ in range(n)) + '\n'
        docs.append({'content': content, 'id': doc_id})
    return docs


def run(mem_limit_gb=8.0):
    """Run constrained benchmark — find max docs per framework in limited RAM."""
    mem_limit_mb = mem_limit_gb * 1024
    batch_size = 5000

    print('=' * 80)
    print(f'MEMORY-CONSTRAINED SCALE BENCHMARK (simulated {mem_limit_gb:.0f}GB limit)')
    print(f'Batch size: {batch_size} docs, stopping when RSS exceeds {mem_limit_mb:.0f} MB')
    print('=' * 80)

    # Measure baseline
    baseline_mb = get_mem_mb()
    print(f'\nBaseline RSS: {baseline_mb:.0f} MB')
    budget_mb = mem_limit_mb - baseline_mb
    print(f'Available budget: {budget_mb:.0f} MB')

    results = {}

    for fw_name, chunker_func in CHUNKERS.items():
        print(f'\n{"=" * 60}')
        print(f'Framework: {fw_name}')
        print(f'{"=" * 60}')

        # Fresh start for each framework
        gc.collect()
        fw_baseline = get_mem_mb()
        total_docs = 0
        total_chunks = 0
        total_chars = 0
        total_time = 0
        stopped_reason = None
        max_docs = 0

        print(f'  {"Batch":>8} {"Docs":>10} {"Chunks":>10} {"Time":>8} {"RSS MB":>10} {"Delta":>10} {"Status":>10}')
        print(f'  {"-" * 68}')

        batch_num = 0
        while True:
            batch_num += 1
            batch_docs = generate_batch(total_docs, batch_size)
            batch_chars = sum(len(d['content']) for d in batch_docs)

            t0 = time.perf_counter()
            try:
                chunks = chunker_func(batch_docs)
                index = build_inverted_index(chunks)
            except MemoryError:
                stopped_reason = 'OOM (MemoryError)'
                break
            except Exception as e:
                stopped_reason = f'Error: {e!s:.40}'
                break

            batch_time = time.perf_counter() - t0
            total_docs += batch_size
            total_chunks += len(chunks)
            total_chars += batch_chars
            total_time += batch_time

            current_rss = get_mem_mb()
            delta = current_rss - fw_baseline

            status = 'OK'
            if delta > budget_mb:
                status = 'OVER LIMIT'
                stopped_reason = f'RSS exceeded {mem_limit_gb:.0f}GB ({current_rss:.0f} MB)'

            print(f'  {batch_num:>8} {total_docs:>10,} {total_chunks:>10,} {batch_time:>8.2f} {current_rss:>10.0f} {delta:>10.0f} {status:>10}')

            if status == 'OVER LIMIT':
                max_docs = total_docs - batch_size  # last good count
                break

            max_docs = total_docs
            del chunks, index
            gc.collect()

            # Safety: stop at 2M docs regardless
            if total_docs >= 2_000_000:
                stopped_reason = 'Reached 2M docs limit'
                break

        if stopped_reason:
            print(f'  STOPPED: {stopped_reason}')

        tokens_per_sec = (total_chars // 4) / max(0.001, total_time)
        results[fw_name] = {
            'max_docs': max_docs,
            'total_docs_attempted': total_docs,
            'total_chunks': total_chunks,
            'total_time': total_time,
            'tokens_per_sec': tokens_per_sec,
            'stopped': stopped_reason,
        }

    # Summary
    print(f'\n{"=" * 80}')
    print(f'MAX DOCUMENTS IN {mem_limit_gb:.0f}GB RAM')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"Max Docs":>12} {"Throughput":>14} {"Status":>20}')
    print('-' * 65)
    for fw_name in sorted(results, key=lambda x: -results[x]['max_docs']):
        r = results[fw_name]
        status = r['stopped'] or 'OK (limit not reached)'
        print(f'{fw_name:<15} {r["max_docs"]:>12,} {r["tokens_per_sec"]:>14,.0f} {status[:20]:>20}')

    # Markdown
    print(f'\n### Max Documents in {mem_limit_gb:.0f}GB RAM')
    print('| Framework | Max Docs | Throughput (tok/s) | Status |')
    print('|---|---|---|---|')
    for fw_name in sorted(results, key=lambda x: -results[x]['max_docs']):
        r = results[fw_name]
        status = r['stopped'] or 'OK'
        print(f'| {fw_name} | {r["max_docs"]:,} | {r["tokens_per_sec"]:,.0f} | {status[:30]} |')


if __name__ == '__main__':
    limit = float(sys.argv[1]) if len(sys.argv) > 1 else 8.0
    run(mem_limit_gb=limit)
