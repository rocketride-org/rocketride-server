#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Native retrieval benchmark — each framework uses its OWN retriever.

Fair comparison: every framework runs as-is, out of the box.
No shared index — each uses its built-in BM25/keyword retriever.

Measures: Recall@1, Recall@5, Recall@10, MRR, latency, memory.

Usage:
    python benchmarks/bench_native_retrieval.py <docs_dir>
"""

import gc
import os
import re
import sys
import time
from collections import defaultdict

import psutil

from chunkers import (
    build_enhanced_index,
    search_enhanced,
    native_chunk,
    _native_available,
)


def get_mem_mb():
    """Return current process RSS in MB."""
    return psutil.Process().memory_info().rss / (1024 * 1024)


def load_docs(root_dir):
    """Load text files from directory."""
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


def generate_queries(docs):
    """Generate test queries — extract distinctive phrases from docs."""
    queries = []
    for doc in docs:
        sentences = re.split(r'(?<=[.!?])\s+', doc['content'])
        for sent in sentences[:3]:
            words = re.findall(r'\w{4,}', sent)
            if len(words) >= 3:
                query_words = sorted(words, key=len, reverse=True)[:3]
                queries.append({'query': ' '.join(query_words), 'doc_id': doc['id']})
                break
    return queries


# ---------------------------------------------------------------------------
# Native retrievers for each framework
# ---------------------------------------------------------------------------


def _retrieve_rocketride(docs, queries, top_k=10):
    """RocketRide: C++ chunker + enhanced BM25 index (stemming, stop words, bi-grams)."""
    if not _native_available:
        raise RuntimeError('C++ libs not compiled')

    # Chunk with C++ native
    chunks = []
    doc_to_chunks = defaultdict(set)
    for doc in docs:
        text_bytes = doc['content'].encode('utf-8')
        for piece in native_chunk(text_bytes):
            idx = len(chunks)
            chunks.append({'text': piece.decode('utf-8', errors='replace'), 'doc_id': doc['id']})
            doc_to_chunks[doc['id']].add(idx)

    # Build enhanced index
    index, doc_lengths, avg_dl = build_enhanced_index(chunks)

    # Search
    results = []
    for q in queries:
        hits = search_enhanced(index, q['query'], doc_lengths, avg_dl, top_k=top_k)
        results.append(hits)

    return chunks, doc_to_chunks, results


def _retrieve_langchain(docs, queries, top_k=10):
    """LangChain: RecursiveCharacterTextSplitter + BM25Retriever."""
    from langchain_text_splitters import RecursiveCharacterTextSplitter
    from langchain_community.retrievers import BM25Retriever as LCBM25
    from langchain_core.documents import Document

    splitter = RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=50)
    lc_docs = []
    chunks = []
    doc_to_chunks = defaultdict(set)

    for doc in docs:
        for text in splitter.split_text(doc['content']):
            idx = len(chunks)
            chunks.append({'text': text, 'doc_id': doc['id']})
            doc_to_chunks[doc['id']].add(idx)
            lc_docs.append(Document(page_content=text, metadata={'chunk_idx': idx, 'doc_id': doc['id']}))

    retriever = LCBM25.from_documents(lc_docs, k=top_k)

    results = []
    for q in queries:
        hits = retriever.invoke(q['query'])
        result_indices = [h.metadata['chunk_idx'] for h in hits]
        results.append(result_indices)

    return chunks, doc_to_chunks, results


def _retrieve_haystack(docs, queries, top_k=10):
    """Haystack: DocumentSplitter + InMemoryBM25Retriever."""
    from haystack.components.preprocessors import DocumentSplitter
    from haystack.components.retrievers.in_memory import InMemoryBM25Retriever
    from haystack.document_stores.in_memory import InMemoryDocumentStore
    from haystack import Document

    splitter = DocumentSplitter(split_by='word', split_length=100, split_overlap=10)
    hs_docs = [Document(content=doc['content'], meta={'doc_id': doc['id']}) for doc in docs]
    split_result = splitter.run(documents=hs_docs)

    chunks = []
    doc_to_chunks = defaultdict(set)
    store = InMemoryDocumentStore()
    store_docs = []

    for d in split_result['documents']:
        idx = len(chunks)
        doc_id = d.meta.get('doc_id', 0)
        chunks.append({'text': d.content, 'doc_id': doc_id})
        doc_to_chunks[doc_id].add(idx)
        store_docs.append(Document(content=d.content, meta={'chunk_idx': idx, 'doc_id': doc_id}))

    store.write_documents(store_docs)
    retriever = InMemoryBM25Retriever(document_store=store, top_k=top_k)

    results = []
    for q in queries:
        hits = retriever.run(query=q['query'])
        result_indices = [h.meta['chunk_idx'] for h in hits['documents']]
        results.append(result_indices)

    return chunks, doc_to_chunks, results


def _retrieve_chonkie(docs, queries, top_k=10):
    """Chonkie: TokenChunker + basic inverted index (no native retriever)."""
    from chonkie import TokenChunker

    chunker = TokenChunker(chunk_size=512, chunk_overlap=50)
    chunks = []
    doc_to_chunks = defaultdict(set)

    for doc in docs:
        for c in chunker.chunk(doc['content']):
            idx = len(chunks)
            chunks.append({'text': c.text, 'doc_id': doc['id']})
            doc_to_chunks[doc['id']].add(idx)

    # Basic inverted index (chonkie has no retriever)
    index = defaultdict(set)
    for i, chunk in enumerate(chunks):
        for w in set(re.findall(r'\w{2,}', chunk['text'].lower())):
            index[w].add(i)

    results = []
    for q in queries:
        words = re.findall(r'\w{2,}', q['query'].lower())
        scores = defaultdict(int)
        for w in words:
            for idx in index.get(w, set()):
                scores[idx] += 1
        ranked = sorted(scores.keys(), key=lambda x: -scores[x])[:top_k]
        results.append(ranked)

    return chunks, doc_to_chunks, results


def _retrieve_llamaindex(docs, queries, top_k=10):
    """LlamaIndex: SentenceSplitter + BM25Retriever."""
    from llama_index.core.node_parser import SentenceSplitter
    from llama_index.core.schema import TextNode
    from llama_index.retrievers.bm25 import BM25Retriever as LIBM25

    splitter = SentenceSplitter(chunk_size=512, chunk_overlap=50)
    chunks = []
    doc_to_chunks = defaultdict(set)
    nodes = []

    for doc in docs:
        split_nodes = splitter.get_nodes_from_documents([TextNode(text=doc['content'])])
        for n in split_nodes:
            idx = len(chunks)
            n.metadata['chunk_idx'] = idx
            n.metadata['doc_id'] = doc['id']
            chunks.append({'text': n.text, 'doc_id': doc['id']})
            doc_to_chunks[doc['id']].add(idx)
            nodes.append(n)

    retriever = LIBM25.from_defaults(nodes=nodes, similarity_top_k=top_k)

    results = []
    for q in queries:
        hits = retriever.retrieve(q['query'])
        result_indices = [h.metadata.get('chunk_idx', -1) for h in hits]
        results.append(result_indices)

    return chunks, doc_to_chunks, results


RETRIEVERS = {
    'RocketRide': _retrieve_rocketride,
    'LangChain': _retrieve_langchain,
    'Haystack': _retrieve_haystack,
    'LlamaIndex': _retrieve_llamaindex,
    'Chonkie': _retrieve_chonkie,
}


def evaluate_recall(queries, doc_to_chunks, results, k_values=None):
    """Calculate Recall@K and MRR."""
    if k_values is None:
        k_values = [1, 5, 10]
    hits_at = {k: 0 for k in k_values}
    mrr_sum = 0.0
    total = len(queries)

    for i, q in enumerate(queries):
        target = doc_to_chunks.get(q['doc_id'], set())
        if i >= len(results):
            continue
        ranked = results[i]

        for k in k_values:
            if set(ranked[:k]) & target:
                hits_at[k] += 1

        for rank, idx in enumerate(ranked, 1):
            if idx in target:
                mrr_sum += 1.0 / rank
                break

    return {f'recall_{k}': hits_at[k] / max(1, total) for k in k_values} | {'mrr': mrr_sum / max(1, total)}


def run(root_dir):
    """Run native retrieval benchmark for all frameworks."""
    print('=' * 80)
    print('NATIVE RETRIEVAL BENCHMARK — each framework uses its OWN retriever')
    print(f'Dataset: {root_dir}')
    print('=' * 80)

    docs = load_docs(root_dir)
    if not docs:
        print('No docs found.')
        return

    queries = generate_queries(docs)
    total_chars = sum(len(d['content']) for d in docs)
    print(f'\n{len(docs)} docs, {total_chars:,} chars, {len(queries)} queries\n')

    all_results = []

    for name, retriever_func in RETRIEVERS.items():
        print(f'  {name}...', end=' ', flush=True)
        gc.collect()
        mem_before = get_mem_mb()
        t0 = time.perf_counter()

        try:
            chunks, doc_to_chunks, search_results = retriever_func(docs, queries, top_k=10)
        except Exception as e:
            print(f'SKIP ({e!s:.60})')
            continue

        elapsed = time.perf_counter() - t0
        mem_after = get_mem_mb()

        metrics = evaluate_recall(queries, doc_to_chunks, search_results)
        print(f'{elapsed:.2f}s, R@10={metrics["recall_10"]:.2f}, MRR={metrics["mrr"]:.2f}')

        all_results.append(
            {
                'name': name,
                'time': elapsed,
                'chunks': len(chunks),
                'mem_delta': mem_after - mem_before,
                **metrics,
            }
        )

    if not all_results:
        print('No frameworks completed.')
        return

    # Comparison table
    print(f'\n{"=" * 80}')
    print('NATIVE RETRIEVAL COMPARISON')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"R@1":>6} {"R@5":>6} {"R@10":>6} {"MRR":>6} {"Time":>8} {"Chunks":>8} {"Mem MB":>8}')
    print('-' * 70)
    for r in sorted(all_results, key=lambda x: -x['recall_10']):
        print(f'{r["name"]:<15} {r["recall_1"]:>6.2f} {r["recall_5"]:>6.2f} {r["recall_10"]:>6.2f} {r["mrr"]:>6.2f} {r["time"]:>8.2f} {r["chunks"]:>8} {r["mem_delta"]:>8.1f}')

    # Markdown
    print('\n| Framework | R@1 | R@5 | R@10 | MRR | Time | Chunks | Mem |')
    print('|---|---|---|---|---|---|---|---|')
    for r in sorted(all_results, key=lambda x: -x['recall_10']):
        print(f'| {r["name"]} | {r["recall_1"]:.2f} | {r["recall_5"]:.2f} | {r["recall_10"]:.2f} | {r["mrr"]:.2f} | {r["time"]:.2f}s | {r["chunks"]:,} | +{r["mem_delta"]:.0f} MB |')

    return {
        'tool': 'native_retrieval',
        'frameworks': all_results,
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory>')
        sys.exit(1)
    run(sys.argv[1])
