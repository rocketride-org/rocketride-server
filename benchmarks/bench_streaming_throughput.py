#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Streaming throughput benchmark — process N docs without accumulating state.

Simulates a real-world ETL/ingestion pipeline:
  1. Read documents in batches
  2. Chunk each batch
  3. "Send" chunks to external vector store (simulated by hashing)
  4. Discard — no in-memory index accumulation

This tests pure processing throughput — the metric that matters when
your vector store is external (Milvus, Qdrant, Pinecone, Weaviate).

Usage:
    python benchmarks/bench_streaming_throughput.py [max_docs]
"""

import gc
import hashlib
import os
import random
import sys
import time

import psutil

sys.path.insert(0, os.path.dirname(__file__))
from chunkers import CHUNKERS


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


def simulate_vector_store_write(chunks):
    """Simulate sending chunks to external vector store by hashing."""
    for chunk in chunks:
        hashlib.md5(chunk['text'].encode()).hexdigest()  # noqa: S324


def run(max_docs=1000000):
    """Run streaming throughput benchmark."""
    batch_size = 10000

    print('=' * 80)
    print('STREAMING THROUGHPUT BENCHMARK')
    print('Process docs → chunk → "send to vector store" → discard')
    print(f'Max docs: {max_docs:,}, batch size: {batch_size:,}')
    print('=' * 80)

    results = {}

    for fw_name, chunker_func in CHUNKERS.items():
        print(f'\n--- {fw_name} ---')
        gc.collect()
        mem_baseline = get_mem_mb()

        total_docs = 0
        total_chunks = 0
        total_chars = 0
        batch_times = []
        peak_mem = mem_baseline
        failed = False

        t_total_start = time.perf_counter()

        while total_docs < max_docs:
            batch = generate_batch(total_docs, batch_size)
            batch_chars = sum(len(d['content']) for d in batch)

            t0 = time.perf_counter()
            try:
                chunks = chunker_func(batch)
                simulate_vector_store_write(chunks)
            except Exception as e:
                print(f'  FAILED at {total_docs:,} docs: {e!s:.50}')
                failed = True
                break

            batch_time = time.perf_counter() - t0
            batch_times.append(batch_time)

            total_docs += batch_size
            total_chunks += len(chunks)
            total_chars += batch_chars

            current_mem = get_mem_mb()
            if current_mem > peak_mem:
                peak_mem = current_mem

            # No accumulation — chunks are discarded
            del chunks, batch

            # Progress every 100K
            if total_docs % 100000 == 0:
                elapsed = time.perf_counter() - t_total_start
                tok_s = (total_chars // 4) / elapsed
                print(f'  {total_docs:>10,} docs | {tok_s:>12,.0f} tok/s | {current_mem:.0f} MB | {elapsed:.1f}s')

        t_total = time.perf_counter() - t_total_start
        mem_final = get_mem_mb()
        tokens = total_chars // 4

        if not failed:
            tok_per_sec = tokens / t_total
            docs_per_sec = total_docs / t_total
            avg_batch = sum(batch_times) / len(batch_times) if batch_times else 0

            results[fw_name] = {
                'docs': total_docs,
                'chunks': total_chunks,
                'chars': total_chars,
                'tokens': tokens,
                'total_time': t_total,
                'tok_per_sec': tok_per_sec,
                'docs_per_sec': docs_per_sec,
                'avg_batch_ms': avg_batch * 1000,
                'peak_mem': peak_mem,
                'mem_delta': mem_final - mem_baseline,
            }
            print(f'  DONE: {total_docs:,} docs in {t_total:.1f}s ({tok_per_sec:,.0f} tok/s, peak {peak_mem:.0f} MB)')
        else:
            results[fw_name] = {'docs': total_docs, 'failed': True}

    # Summary
    print(f'\n{"=" * 80}')
    print(f'STREAMING THROUGHPUT — {max_docs:,} docs')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"Time":>8} {"tok/s":>14} {"docs/s":>12} {"Peak MB":>10} {"Mem delta":>10}')
    print('-' * 72)

    for fw_name in CHUNKERS:
        r = results.get(fw_name, {})
        if r.get('failed'):
            print(f'{fw_name:<15} {"FAILED":>8}')
            continue
        if 'tok_per_sec' not in r:
            continue
        print(f'{fw_name:<15} {r["total_time"]:>8.1f} {r["tok_per_sec"]:>14,.0f} {r["docs_per_sec"]:>12,.0f} {r["peak_mem"]:>10.0f} {r["mem_delta"]:>10.1f}')

    # Markdown
    print(f'\n### Streaming Throughput ({max_docs // 1000}K docs, no index accumulation)')
    print('| Framework | Time | Throughput (tok/s) | Docs/sec | Peak Memory |')
    print('|---|---|---|---|---|')
    for fw_name in sorted(results, key=lambda x: results[x].get('total_time', 9999)):
        r = results[fw_name]
        if r.get('failed'):
            print(f'| {fw_name} | FAILED | — | — | — |')
            continue
        if 'tok_per_sec' not in r:
            continue
        print(f'| {fw_name} | {r["total_time"]:.1f}s | {r["tok_per_sec"]:,.0f} | {r["docs_per_sec"]:,.0f} | {r["peak_mem"]:.0f} MB |')


if __name__ == '__main__':
    max_d = int(sys.argv[1]) if len(sys.argv) > 1 else 1000000
    run(max_docs=max_d)
