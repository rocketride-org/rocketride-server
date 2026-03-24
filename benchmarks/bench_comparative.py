#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Comparative benchmark — all metrics across all frameworks.

Runs Recall@K, Time-to-Searchable, Memory efficiency, and Chunking speed
for each framework on the same dataset. Produces a single comparison table.

Frameworks: LangChain, Chonkie, LlamaIndex, Haystack, RocketRide (C++)

Usage:
    pip install -r benchmarks/requirements.txt
    python benchmarks/bench_comparative.py <docs_dir>
"""

import gc
import os
import re
import sys
import time
from collections import defaultdict

import psutil


def get_mem_mb():
    """Return current process RSS in MB."""
    return psutil.Process().memory_info().rss / (1024 * 1024)


# ---------------------------------------------------------------------------
# Common helpers
# ---------------------------------------------------------------------------


def load_docs(root_dir):
    """Load all text files from directory."""
    docs = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in sorted(filenames):
            fpath = os.path.join(dirpath, fname)
            try:
                with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
                    content = f.read()
                if content.strip():
                    docs.append({'content': content, 'path': fpath, 'id': len(docs)})
            except OSError:
                continue
    return docs


def build_inverted_index(chunks):
    """Build inverted index from chunk texts. Return (index, chunk_to_doc)."""
    index = defaultdict(set)
    for i, chunk in enumerate(chunks):
        words = set(re.findall(r'\w{2,}', chunk['text'].lower()))
        for w in words:
            index[w].add(i)
    return dict(index)


def search(index, query, top_k=10):
    """Search inverted index with TF-IDF-like scoring."""
    words = re.findall(r'\w{2,}', query.lower())
    if not words:
        return []
    scores = defaultdict(float)
    total_chunks = max(1, max(max(v) for v in index.values() if v) + 1) if index else 1
    for w in words:
        posting = index.get(w, set())
        if posting:
            idf = 1.0 / (1.0 + len(posting) / total_chunks)
            for idx in posting:
                scores[idx] += idf
    return sorted(scores.keys(), key=lambda x: -scores[x])[:top_k]


def generate_queries(docs):
    """Generate keyword queries from docs for recall evaluation."""
    queries = []
    for doc in docs:
        sentences = re.split(r'(?<=[.!?])\s+', doc['content'])
        for sent in sentences[:3]:
            words = re.findall(r'\w{4,}', sent)
            if len(words) >= 3:
                # Use 3 distinctive words as query
                query_words = sorted(words, key=len, reverse=True)[:3]
                queries.append(
                    {
                        'query': ' '.join(query_words),
                        'doc_id': doc['id'],
                    }
                )
                break
    return queries


# ---------------------------------------------------------------------------
# Chunker wrappers
# ---------------------------------------------------------------------------

CHUNKERS = {}


def register_chunker(name):
    """Register a chunker function by name."""

    def decorator(func):
        CHUNKERS[name] = func
        return func

    return decorator


@register_chunker('LangChain')
def chunk_langchain(docs):
    """Chunk with LangChain RecursiveCharacterTextSplitter."""
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    splitter = RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=50)
    chunks = []
    for doc in docs:
        for text in splitter.split_text(doc['content']):
            chunks.append({'text': text, 'doc_id': doc['id']})
    return chunks


@register_chunker('Chonkie')
def chunk_chonkie(docs):
    """Chunk with Chonkie TokenChunker."""
    from chonkie import TokenChunker

    chunker = TokenChunker(chunk_size=512, chunk_overlap=50)
    chunks = []
    for doc in docs:
        for c in chunker.chunk(doc['content']):
            chunks.append({'text': c.text, 'doc_id': doc['id']})
    return chunks


@register_chunker('LlamaIndex')
def chunk_llamaindex(docs):
    """Chunk with LlamaIndex SentenceSplitter."""
    from llama_index.core.node_parser import SentenceSplitter
    from llama_index.core.schema import TextNode

    splitter = SentenceSplitter(chunk_size=512, chunk_overlap=50)
    chunks = []
    for doc in docs:
        nodes = splitter.get_nodes_from_documents([TextNode(text=doc['content'])])
        for n in nodes:
            chunks.append({'text': n.text, 'doc_id': doc['id']})
    return chunks


@register_chunker('Haystack')
def chunk_haystack(docs):
    """Chunk with Haystack DocumentSplitter."""
    from haystack.components.preprocessors import DocumentSplitter
    from haystack import Document

    splitter = DocumentSplitter(split_by='word', split_length=100, split_overlap=10)
    hs_docs = [Document(content=doc['content'], meta={'doc_id': doc['id']}) for doc in docs]
    result = splitter.run(documents=hs_docs)
    chunks = []
    for d in result['documents']:
        chunks.append({'text': d.content, 'doc_id': d.meta.get('doc_id', 0)})
    return chunks


# ---------------------------------------------------------------------------
# Benchmark functions
# ---------------------------------------------------------------------------


def benchmark_framework(name, chunker_func, docs, queries):
    """Run all metrics for a single framework."""
    gc.collect()

    # 1. Chunking speed
    mem_before = get_mem_mb()
    t0 = time.perf_counter()
    try:
        chunks = chunker_func(docs)
    except Exception as e:
        return {'name': name, 'error': str(e)}
    chunk_time = time.perf_counter() - t0

    # 2. Index build
    t0 = time.perf_counter()
    index = build_inverted_index(chunks)
    index_time = time.perf_counter() - t0

    mem_after = get_mem_mb()

    # 3. Recall@K
    doc_to_chunks = defaultdict(set)
    for i, c in enumerate(chunks):
        doc_to_chunks[c['doc_id']].add(i)

    hits_at = {1: 0, 5: 0, 10: 0}
    mrr_sum = 0.0
    total_queries = len(queries)

    for q in queries:
        results = search(index, q['query'], top_k=10)
        target = doc_to_chunks.get(q['doc_id'], set())
        for k in hits_at:
            if set(results[:k]) & target:
                hits_at[k] += 1
        for rank, idx in enumerate(results, 1):
            if idx in target:
                mrr_sum += 1.0 / rank
                break

    recall_at = {k: hits_at[k] / max(1, total_queries) for k in hits_at}
    mrr = mrr_sum / max(1, total_queries)

    # 4. Time-to-Searchable (incremental batch of 100 docs)
    batch_size = min(100, len(docs))
    batch_docs = docs[:batch_size]
    gc.collect()
    t0 = time.perf_counter()
    batch_chunks = chunker_func(batch_docs)
    build_inverted_index(batch_chunks)
    t2s = (time.perf_counter() - t0) * 1000  # ms

    # 5. Memory efficiency
    docs_per_mb = len(docs) / max(0.1, mem_after - mem_before)
    est_8gb = int(docs_per_mb * 8192)

    total_chars = sum(len(d['content']) for d in docs)
    tokens = total_chars // 4

    return {
        'name': name,
        'chunk_time': chunk_time,
        'chunks': len(chunks),
        'index_time': index_time,
        'index_terms': len(index),
        'mem_delta': mem_after - mem_before,
        'recall_1': recall_at[1],
        'recall_5': recall_at[5],
        'recall_10': recall_at[10],
        'mrr': mrr,
        't2s_ms': t2s,
        'docs_per_mb': docs_per_mb,
        'est_8gb': est_8gb,
        'tokens_per_sec': tokens / max(0.001, chunk_time),
        'total_chars': total_chars,
    }


def run(root_dir):
    """Run comparative benchmark across all frameworks."""
    print('=' * 80)
    print('COMPARATIVE BENCHMARK — ALL METRICS, ALL FRAMEWORKS')
    print(f'Dataset: {root_dir}')
    print('=' * 80)

    docs = load_docs(root_dir)
    if not docs:
        print('No documents found.')
        sys.exit(1)

    total_chars = sum(len(d['content']) for d in docs)
    print(f'\n{len(docs)} docs, {total_chars:,} chars\n')

    queries = generate_queries(docs)
    print(f'{len(queries)} queries generated for Recall@K\n')

    results = []
    for name, func in CHUNKERS.items():
        print(f'  Running {name}...', end=' ', flush=True)
        r = benchmark_framework(name, func, docs, queries)
        if 'error' in r:
            print(f'SKIP ({r["error"][:50]})')
        else:
            print(f'{r["chunk_time"]:.3f}s, Recall@10={r["recall_10"]:.2f}')
            results.append(r)

    if not results:
        print('No frameworks completed.')
        return

    # Comparison tables
    print(f'\n{"=" * 80}')
    print('1. CHUNKING SPEED')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"Time":>8} {"Chunks":>8} {"tok/s":>12} {"Speedup":>8}')
    print('-' * 55)
    baseline = results[0]['chunk_time']
    for r in sorted(results, key=lambda x: x['chunk_time']):
        sp = f'{baseline / r["chunk_time"]:.1f}x' if r['name'] != results[0]['name'] else 'baseline'
        print(f'{r["name"]:<15} {r["chunk_time"]:>8.3f} {r["chunks"]:>8} {r["tokens_per_sec"]:>12,.0f} {sp:>8}')

    print(f'\n{"=" * 80}')
    print('2. RETRIEVAL QUALITY (Recall@K)')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"R@1":>8} {"R@5":>8} {"R@10":>8} {"MRR":>8}')
    print('-' * 50)
    for r in sorted(results, key=lambda x: -x['recall_10']):
        print(f'{r["name"]:<15} {r["recall_1"]:>8.2f} {r["recall_5"]:>8.2f} {r["recall_10"]:>8.2f} {r["mrr"]:>8.2f}')

    print(f'\n{"=" * 80}')
    print('3. TIME TO SEARCHABLE (100-doc batch)')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"T2S (ms)":>10}')
    print('-' * 28)
    for r in sorted(results, key=lambda x: x['t2s_ms']):
        print(f'{r["name"]:<15} {r["t2s_ms"]:>10.1f}')

    print(f'\n{"=" * 80}')
    print('4. MEMORY EFFICIENCY')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"Mem (MB)":>10} {"Docs/MB":>10} {"Est 8GB":>12}')
    print('-' * 50)
    for r in sorted(results, key=lambda x: -x['docs_per_mb']):
        print(f'{r["name"]:<15} {r["mem_delta"]:>10.1f} {r["docs_per_mb"]:>10.1f} {r["est_8gb"]:>12,}')

    # Markdown for README
    print(f'\n{"=" * 80}')
    print('MARKDOWN FOR README')
    print(f'{"=" * 80}')
    print('\n| Framework | Chunk Time | Recall@10 | T2S (ms) | Docs/MB | Est 8GB |')
    print('|---|---|---|---|---|---|')
    for r in sorted(results, key=lambda x: x['chunk_time']):
        print(f'| {r["name"]} | {r["chunk_time"]:.3f}s | {r["recall_10"]:.2f} | {r["t2s_ms"]:.1f} | {r["docs_per_mb"]:.1f} | {r["est_8gb"]:,} |')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory>')
        sys.exit(1)
    run(sys.argv[1])
