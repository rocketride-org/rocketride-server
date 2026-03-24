#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Memory efficiency benchmark for local-first / edge RAG deployments.

Measures how many documents can be indexed in limited RAM by incrementally
ingesting batches and tracking RSS after each batch.

Pipeline per batch:
  1. Parse text files (encoding detection + binary filtering)
  2. Chunk with character-level splitter (512 chars, 50 overlap)
  3. Add chunks to a running inverted index
  4. Measure process RSS

Usage:
    pip install psutil
    python benchmarks/bench_memory.py <docs_dir> [--mem-limit 512] [--batch-size 100]
"""

import argparse
import gc
import mimetypes
import os
import re
import sys
import time
from collections import defaultdict

import psutil

TEXT_EXTENSIONS = {
    '.c',
    '.h',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.js',
    '.ts',
    '.tsx',
    '.jsx',
    '.cpp',
    '.cc',
    '.hpp',
    '.hh',
    '.cxx',
    '.txt',
    '.md',
    '.rst',
    '.csv',
    '.json',
    '.xml',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.pl',
    '.rb',
    '.lua',
    '.r',
    '.m',
    '.swift',
    '.kt',
    '.html',
    '.htm',
    '.css',
    '.scss',
    '.less',
    '.sql',
    '.graphql',
    '.makefile',
    '.cmake',
    '.mk',
    '.s',
    '.S',
    '.asm',
}
KNOWN_TEXT_NAMES = {
    'Makefile',
    'Kconfig',
    'Kbuild',
    'README',
    'LICENSE',
    'COPYING',
    'MAINTAINERS',
    'CREDITS',
    'TODO',
    'CHANGES',
    'NEWS',
}


def get_mem_mb():
    """Return current process RSS in MB."""
    return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)


def _is_text_file(fpath, fname):
    """Heuristic check for text files."""
    ext = os.path.splitext(fname)[1].lower()
    if fname in KNOWN_TEXT_NAMES or ext in TEXT_EXTENSIONS:
        return True
    mime = mimetypes.guess_type(fpath)[0] or ''
    return mime.startswith('text/')


def discover_files(root_dir):
    """Walk root_dir and return list of text file paths."""
    files = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d != '.git']
        for fname in sorted(filenames):
            fpath = os.path.join(dirpath, fname)
            if _is_text_file(fpath, fname):
                files.append(fpath)
    return files


def parse_and_chunk(file_list, chunk_size=512, overlap=50):
    """Parse a batch of files and split into chunks.

    Returns (chunks, total_chars, errors) where each chunk is a str.
    """
    chunks = []
    total_chars = 0
    errors = 0
    step = max(1, chunk_size - overlap)

    for fpath in file_list:
        try:
            with open(fpath, 'rb') as f:
                raw = f.read()
            text = raw.decode('utf-8', errors='replace')
        except Exception:
            errors += 1
            continue

        text = text.strip()
        if not text:
            continue

        total_chars += len(text)

        # Character-level chunking with overlap
        if len(text) <= chunk_size:
            chunks.append(text)
        else:
            pos = 0
            while pos < len(text):
                chunks.append(text[pos : pos + chunk_size])
                pos += step

    return chunks, total_chars, errors


# Simple tokenizer: split on non-alphanumeric, lowercase, drop short tokens
_TOKEN_RE = re.compile(r'[a-zA-Z0-9_]{2,}')


def incremental_index(index, new_chunks, chunk_id_offset):
    """Add new_chunks to an existing inverted index (dict of term -> set of chunk IDs).

    Returns updated term count.
    """
    for i, chunk in enumerate(new_chunks):
        cid = chunk_id_offset + i
        tokens = _TOKEN_RE.findall(chunk.lower())
        for token in tokens:
            index[token].add(cid)
    return len(index)


def run(root_dir, mem_limit_mb=512, batch_size=100):
    """Full memory-efficiency pipeline with incremental batching."""
    gc.collect()
    mem_baseline = get_mem_mb()
    t_start = time.perf_counter()

    print('=' * 65)
    print('  MEMORY EFFICIENCY BENCHMARK')
    print(f'  Source: {root_dir}')
    print(f'  Memory limit: {mem_limit_mb} MB  |  Batch size: {batch_size}')
    print('=' * 65)

    # Discover
    print('\nDiscovering files...')
    all_files = discover_files(root_dir)
    print(f'  {len(all_files):,} text files found')

    if not all_files:
        print('No text files found. Exiting.')
        return {
            'tool': 'memory',
            'total_time': 0,
            'docs': 0,
            'chars': 0,
            'chunks': 0,
            'index_terms': 0,
            'mem_delta_mb': 0,
            'docs_per_mb': 0,
            'estimated_max_8gb': 0,
        }

    # Incremental ingest
    index = defaultdict(set)
    total_docs = 0
    total_chars = 0
    total_chunks = 0
    total_errors = 0
    chunk_id_offset = 0
    snapshots = []
    hit_limit = False

    header = f'{"Docs":>7} | {"Chunks":>8} | {"Index Terms":>12} | {"RSS (MB)":>9} | {"Docs/MB":>8}'
    print('\nMEMORY EFFICIENCY')
    print(header)
    print('-' * len(header))

    for batch_start in range(0, len(all_files), batch_size):
        batch_files = all_files[batch_start : batch_start + batch_size]

        chunks, chars, errors = parse_and_chunk(batch_files, chunk_size=512, overlap=50)
        n_terms = incremental_index(index, chunks, chunk_id_offset)

        total_docs += len(batch_files) - errors
        total_chars += chars
        total_chunks += len(chunks)
        total_errors += errors
        chunk_id_offset += len(chunks)

        # Force GC before measuring to get stable numbers
        gc.collect()
        mem_now = get_mem_mb()
        mem_delta = mem_now - mem_baseline
        docs_per_mb = total_docs / mem_delta if mem_delta > 0 else float('inf')

        snapshots.append(
            {
                'docs': total_docs,
                'chunks': total_chunks,
                'index_terms': n_terms,
                'rss_mb': round(mem_now, 1),
                'docs_per_mb': round(docs_per_mb, 1),
            }
        )

        print(f'{total_docs:>7,} | {total_chunks:>8,} | {n_terms:>12,} | {mem_now:>8.1f}  | {docs_per_mb:>8.1f}')

        if mem_delta >= mem_limit_mb:
            print(f'\n  ** Memory limit ({mem_limit_mb} MB delta) reached after {total_docs:,} docs **')
            hit_limit = True
            break

    t_total = time.perf_counter() - t_start
    mem_final = get_mem_mb()
    mem_delta = mem_final - mem_baseline

    # Peak efficiency = best docs/MB across all snapshots
    peak_efficiency = max(s['docs_per_mb'] for s in snapshots) if snapshots else 0
    estimated_max_8gb = int(peak_efficiency * 8 * 1024) if peak_efficiency != float('inf') else 0

    print(f'\n{"=" * 65}')
    print('  RESULTS')
    print(f'{"=" * 65}')
    print(f'  Documents:      {total_docs:>10,}')
    print(f'  Parse errors:   {total_errors:>10,}')
    print(f'  Total chars:    {total_chars:>10,}')
    print(f'  Chunks:         {total_chunks:>10,}')
    print(f'  Index terms:    {len(index):>10,}')
    print(f'  {"-" * 45}')
    print(f'  Baseline RSS:   {mem_baseline:>10.1f} MB')
    print(f'  Final RSS:      {mem_final:>10.1f} MB')
    print(f'  Memory delta:   {mem_delta:>+10.1f} MB')
    print(f'  {"-" * 45}')
    print(f'  Peak efficiency:{peak_efficiency:>10.1f} docs/MB')
    print(f'  Est. max in 8GB:{estimated_max_8gb:>10,} docs')
    print(f'  Total time:     {t_total:>10.2f}s')
    if hit_limit:
        print('  (stopped early — memory limit reached)')
    print()

    return {
        'tool': 'memory',
        'total_time': round(t_total, 3),
        'docs': total_docs,
        'chars': total_chars,
        'chunks': total_chunks,
        'index_terms': len(index),
        'mem_delta_mb': round(mem_delta, 1),
        'docs_per_mb': round(peak_efficiency, 1),
        'estimated_max_8gb': estimated_max_8gb,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Memory efficiency benchmark for document indexing')
    parser.add_argument('docs_dir', help='Directory containing documents to index')
    parser.add_argument('--mem-limit', type=int, default=512, help='Memory limit in MB (default: 512)')
    parser.add_argument('--batch-size', type=int, default=100, help='Documents per batch (default: 100)')
    args = parser.parse_args()

    if not os.path.isdir(args.docs_dir):
        print(f'ERROR: {args.docs_dir} not found or not a directory')
        sys.exit(1)

    run(args.docs_dir, mem_limit_mb=args.mem_limit, batch_size=args.batch_size)
