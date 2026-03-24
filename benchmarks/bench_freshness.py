#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Time to Searchable benchmark.

Measures how fast new documents become queryable after upload by
simulating incremental ingestion in batches of 100 documents:
  1. Start with an empty index
  2. Upload documents one batch at a time
  3. After each batch, immediately query for content from the latest batch
  4. Measure the time from upload start to first successful search hit

Usage:
    python benchmarks/bench_freshness.py <docs_dir>
"""

import gc
import hashlib
import mimetypes
import os
import sys
import time
from collections import defaultdict

import psutil

BATCH_SIZE = 100

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
    return psutil.Process().memory_info().rss / (1024 * 1024)


def discover_text_files(root_dir):
    """Walk root_dir and return paths to text files."""
    paths = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d != '.git']
        for fname in sorted(filenames):
            fpath = os.path.join(dirpath, fname)
            ext = os.path.splitext(fname)[1].lower()
            mime = mimetypes.guess_type(fpath)[0] or ''
            if fname in KNOWN_TEXT_NAMES or ext in TEXT_EXTENSIONS or mime.startswith('text/'):
                paths.append(fpath)
    return paths


def parse_docs(file_list):
    """Read files and return list of dicts with text content and metadata."""
    docs = []
    for fpath in file_list:
        try:
            with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                text = f.read()
        except OSError:
            continue
        if not text.strip():
            continue
        docs.append(
            {
                'path': fpath,
                'text': text,
                'hash': hashlib.sha256(text.encode()).hexdigest()[:16],
            }
        )
    return docs


def chunk_text(text, chunk_size=512, overlap=50):
    """Split text into fixed-size chunks with overlap."""
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunks.append(text[start:end])
        start += chunk_size - overlap
    return chunks


def incremental_index(existing_index, new_chunks, start_id=0):
    """Add new chunks to an existing inverted index. Returns updated index and term count."""
    for i, chunk in enumerate(new_chunks):
        chunk_id = start_id + i
        for word in chunk.lower().split():
            cleaned = ''.join(c for c in word if c.isalnum())
            if cleaned:
                existing_index[cleaned].add(chunk_id)
    return existing_index


def verify_searchable(index, chunks, query):
    """Check if query finds results in the index. Returns (found, num_hits)."""
    terms = query.lower().split()
    result_ids = None
    for term in terms:
        cleaned = ''.join(c for c in term if c.isalnum())
        if cleaned in index:
            ids = index[cleaned]
            result_ids = ids if result_ids is None else result_ids & ids
        else:
            return False, 0
    if result_ids:
        return True, len(result_ids)
    return False, 0


def pick_query_from_chunks(chunks):
    """Extract a multi-word query from the latest chunks for verification.

    Scans chunks for a line containing at least two alphanumeric words
    and returns them as a search query.
    """
    for chunk in reversed(chunks):
        words = []
        for w in chunk.split():
            cleaned = ''.join(c for c in w if c.isalnum())
            if cleaned and len(cleaned) > 3:
                words.append(cleaned.lower())
            if len(words) >= 2:
                return ' '.join(words[:2])
    # Fallback: single longest word
    for chunk in reversed(chunks):
        for w in chunk.split():
            cleaned = ''.join(c for c in w if c.isalnum())
            if cleaned and len(cleaned) > 3:
                return cleaned.lower()
    return ''


def run(root_dir):
    """Run the time-to-searchable benchmark."""
    if not os.path.isdir(root_dir):
        print(f'Error: {root_dir} not found')
        sys.exit(1)

    gc.collect()
    mem_start = get_mem_mb()

    print('=' * 70)
    print('  TIME TO SEARCHABLE BENCHMARK')
    print(f'  Dataset: {root_dir}')
    print(f'  Batch size: {BATCH_SIZE}')
    print('=' * 70)

    # Discover and parse all files upfront
    print('\n[1/2] Discovering and parsing files...')
    file_list = discover_text_files(root_dir)
    all_docs = parse_docs(file_list)
    total_chars = sum(len(d['text']) for d in all_docs)
    print(f'      {len(all_docs):,} documents ({total_chars / (1024 * 1024):.1f} MB text)')

    if not all_docs:
        print('\nNo documents found.')
        return {
            'tool': 'freshness',
            'total_time': 0,
            'docs': 0,
            'chars': 0,
            'chunks': 0,
            'index_terms': 0,
            'mem_delta_mb': 0,
            'avg_time_to_searchable_ms': 0,
        }

    # Incremental ingestion
    print('\n[2/2] Incremental ingestion + search verification...\n')
    print(f'{"Batch Size":>10} | {"Docs":>6} | {"Index Time":>11} | {"Search Verify":>14} | {"Total":>10}')
    print('-' * 62)

    index = defaultdict(set)
    total_chunks = 0
    batch_results = []
    t_pipeline_start = time.perf_counter()

    for batch_start in range(0, len(all_docs), BATCH_SIZE):
        batch_end = min(batch_start + BATCH_SIZE, len(all_docs))
        batch_docs = all_docs[batch_start:batch_end]

        # Chunk this batch
        batch_chunks = []
        for doc in batch_docs:
            batch_chunks.extend(chunk_text(doc['text']))

        if not batch_chunks:
            continue

        # Pick a query from the new batch before indexing
        query = pick_query_from_chunks(batch_chunks)

        # Index (timed)
        t_index_start = time.perf_counter()
        incremental_index(index, batch_chunks, start_id=total_chunks)
        t_index = time.perf_counter() - t_index_start

        total_chunks += len(batch_chunks)

        # Verify searchable (timed)
        t_search_start = time.perf_counter()
        found = False
        if query:
            found, _hits = verify_searchable(index, batch_chunks, query)
        t_search = time.perf_counter() - t_search_start

        t_total_batch = t_index + t_search

        batch_results.append(
            {
                'batch_size': len(batch_docs),
                'cumulative_docs': batch_end,
                'index_time_ms': t_index * 1000,
                'search_time_ms': t_search * 1000,
                'total_ms': t_total_batch * 1000,
                'query': query,
                'found': found,
            }
        )

        print(f'{len(batch_docs):>10} | {batch_end:>6} | {t_index * 1000:>8.2f}ms | {t_search * 1000:>11.2f}ms | {t_total_batch * 1000:>7.2f}ms')

    t_pipeline = time.perf_counter() - t_pipeline_start
    mem_end = get_mem_mb()

    # Summary
    avg_time_to_searchable = sum(r['total_ms'] for r in batch_results) / len(batch_results) if batch_results else 0
    n_terms = len(index)

    print(f'\nAverage time to searchable: {avg_time_to_searchable:.2f}ms per batch')

    print(f'\n{"=" * 70}')
    print('  SUMMARY')
    print(f'{"=" * 70}')
    print(f'  Documents:      {len(all_docs):>10,}')
    print(f'  Total chars:    {total_chars:>10,}')
    print(f'  Chunks:         {total_chunks:>10,}')
    print(f'  Index terms:    {n_terms:>10,}')
    print(f'  Batches:        {len(batch_results):>10}')
    print(f'  Pipeline time:  {t_pipeline:>10.2f}s')
    print(f'  Memory delta:   {mem_end - mem_start:>+10.1f} MB')
    print(f'  Avg T2S:        {avg_time_to_searchable:>10.2f}ms / batch')
    print('=' * 70)

    return {
        'tool': 'freshness',
        'total_time': t_pipeline,
        'docs': len(all_docs),
        'chars': total_chars,
        'chunks': total_chunks,
        'index_terms': n_terms,
        'mem_delta_mb': mem_end - mem_start,
        'avg_time_to_searchable_ms': avg_time_to_searchable,
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory>')
        sys.exit(1)
    run(sys.argv[1])
