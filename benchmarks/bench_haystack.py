#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Benchmark: Haystack DocumentSplitter chunking.

Runs the same pipeline as bench_langchain.py and bench_chonkie.py
but uses Haystack's DocumentSplitter for a fair comparison
across chunking frameworks.

Usage:
    pip install haystack-ai psutil
    python benchmarks/bench_haystack.py <docs_dir>
"""

import gc
import hashlib
import mimetypes
import os
import sys
import time
from collections import defaultdict

import psutil


def get_mem_mb():
    """Return current process RSS in MB."""
    return psutil.Process().memory_info().rss / (1024 * 1024)


def discover_with_metadata(root_dir):
    """Walk directory and return list of file entries with metadata."""
    entries = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in sorted(filenames):
            fpath = os.path.join(dirpath, fname)
            try:
                stat = os.stat(fpath)
                mime = mimetypes.guess_type(fpath)[0] or 'application/octet-stream'
                entries.append(
                    {
                        'path': fpath,
                        'name': fname,
                        'size': stat.st_size,
                        'mime': mime,
                    }
                )
            except OSError:
                continue
    return entries


def is_text_file(entry):
    """Check if file is a text file based on MIME type."""
    return entry['mime'].startswith('text/') or entry['mime'] in (
        'application/json',
        'application/xml',
        'application/javascript',
    )


def parse_document(entry):
    """Read file content and compute hash."""
    try:
        with open(entry['path'], 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        content_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
        return {'content': content, 'hash': content_hash, 'path': entry['path']}
    except Exception:
        return None


def chunk_with_haystack(docs, split_length=100, split_overlap=10):
    """Chunk using Haystack DocumentSplitter (word-based, ~512 chars)."""
    from haystack import Document
    from haystack.components.preprocessors import DocumentSplitter

    splitter = DocumentSplitter(
        split_by='word',
        split_length=split_length,
        split_overlap=split_overlap,
    )
    all_chunks = []
    for doc in docs:
        haystack_doc = Document(content=doc['content'], meta={'path': doc['path']})
        result = splitter.run(documents=[haystack_doc])
        for chunk_doc in result['documents']:
            all_chunks.append(
                {
                    'text': chunk_doc.content,
                    'doc_path': doc['path'],
                }
            )
    return all_chunks


def build_inverted_index(chunks):
    """Build inverted index from chunks (same as other benchmarks)."""
    index = defaultdict(set)
    for i, chunk in enumerate(chunks):
        words = chunk['text'].lower().split()
        for word in words:
            cleaned = ''.join(c for c in word if c.isalnum())
            if cleaned:
                index[cleaned].add(i)
    return index


def search_index(index, query, chunks, top_k=10):
    """Search inverted index (same as other benchmarks)."""
    terms = query.lower().split()
    if not terms:
        return []
    result_ids = None
    for term in terms:
        cleaned = ''.join(c for c in term if c.isalnum())
        if cleaned in index:
            if result_ids is None:
                result_ids = set(index[cleaned])
            else:
                result_ids &= index[cleaned]
    if not result_ids:
        return []
    return [chunks[i] for i in sorted(result_ids)[:top_k]]


def run(root_dir):
    """Run the full benchmark pipeline."""
    print('=' * 60)
    print('BENCHMARK: Haystack (DocumentSplitter)')
    print('=' * 60)

    gc.collect()
    mem_start = get_mem_mb()
    t_total_start = time.perf_counter()

    # Stage 1: Discovery
    print('\n[1/6] Discovering files...')
    t0 = time.perf_counter()
    entries = discover_with_metadata(root_dir)
    text_entries = [e for e in entries if is_text_file(e)]
    t1 = time.perf_counter()
    print(f'  Found {len(text_entries)} text files ({len(entries)} total) in {t1 - t0:.3f}s')

    # Stage 2: Parsing + hashing
    print('\n[2/6] Parsing documents...')
    t0 = time.perf_counter()
    docs = []
    for entry in text_entries:
        doc = parse_document(entry)
        if doc:
            docs.append(doc)
    t1 = time.perf_counter()
    total_chars = sum(len(d['content']) for d in docs)
    print(f'  Parsed {len(docs)} docs ({total_chars:,} chars) in {t1 - t0:.3f}s')

    # Stage 3: Chunking with Haystack DocumentSplitter
    print('\n[3/6] Chunking with Haystack DocumentSplitter (word=100, overlap=10)...')
    gc.collect()
    mem_before_chunk = get_mem_mb()
    t0 = time.perf_counter()
    chunks = chunk_with_haystack(docs, split_length=100, split_overlap=10)
    t1 = time.perf_counter()
    mem_after_chunk = get_mem_mb()
    print(f'  {len(chunks)} chunks in {t1 - t0:.3f}s')
    print(f'  Memory: {mem_after_chunk - mem_before_chunk:.1f} MB delta')

    # Stage 4: Indexing
    print('\n[4/6] Building inverted index...')
    t0 = time.perf_counter()
    index = build_inverted_index(chunks)
    t1 = time.perf_counter()
    print(f'  {len(index)} terms in {t1 - t0:.3f}s')

    # Stage 5: Search
    print('\n[5/6] Searching...')
    queries = ['data processing', 'machine learning', 'pipeline configuration', 'error handling']
    t0 = time.perf_counter()
    for q in queries:
        search_index(index, q, chunks)
    t1 = time.perf_counter()
    print(f'  {len(queries)} queries in {t1 - t0:.6f}s')

    # Summary
    t_total = time.perf_counter() - t_total_start
    mem_end = get_mem_mb()

    print('\n' + '=' * 60)
    print('RESULTS: Haystack')
    print('=' * 60)
    print(f'  Total time:     {t_total:.3f}s')
    print(f'  Documents:      {len(docs)}')
    print(f'  Total chars:    {total_chars:,}')
    print(f'  Chunks:         {len(chunks)}')
    print(f'  Index terms:    {len(index)}')
    print(f'  Memory start:   {mem_start:.1f} MB')
    print(f'  Memory end:     {mem_end:.1f} MB')
    print(f'  Memory delta:   {mem_end - mem_start:.1f} MB')
    print('=' * 60)

    return {
        'tool': 'haystack',
        'total_time': t_total,
        'docs': len(docs),
        'chars': total_chars,
        'chunks': len(chunks),
        'index_terms': len(index),
        'mem_delta_mb': mem_end - mem_start,
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory>')
        sys.exit(1)
    run(sys.argv[1])
