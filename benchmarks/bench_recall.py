#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Retrieval quality benchmark: Recall@K and Mean Reciprocal Rank.

Measures how well a chunking + indexing pipeline preserves retrievability
of known facts — the most important metric for RAG developers.

How it works:
  1. Read documents, extract "fact sentences" deterministically
  2. Generate questions from facts using pattern matching (no LLM)
  3. Chunk all documents, build an inverted index
  4. For each question, search the index and check if the source
     document's chunk appears in top-K results
  5. Compute Recall@1, Recall@5, Recall@10, and MRR

Usage:
    pip install psutil
    python benchmarks/bench_recall.py <docs_directory>
"""

import gc
import hashlib
import mimetypes
import os
import re
import sys
import time
from collections import defaultdict

import psutil

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

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
    '.dts',
    '.dtsi',
    '.dtso',
    '.lds',
    '.awk',
    '.sed',
    '',
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

# Patterns to turn declarative sentences into questions.
# Each tuple: (compiled regex matching the sentence, template producing a question).
# The question retains BOTH subject and object to ensure distinctive query terms.
_QA_PATTERNS = [
    # "X enables Y" -> "What does X enable?" (keeps subject X as search anchor)
    (re.compile(r'^(.{10,}?)\s+enables?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} enables what?'),
    # "X provides Y" -> "Y provided by X"
    (re.compile(r'^(.{10,}?)\s+provides?\s+(.{10,})$', re.I), lambda m: f'{m.group(2)} provided by {m.group(1)}'),
    # "X is used for Y" -> "X used for what?"
    (re.compile(r'^(.{10,}?)\s+is\s+used\s+for\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} used for {m.group(2)}'),
    # "X supports Y" -> "X supports what?"
    (re.compile(r'^(.{10,}?)\s+supports?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} supports what?'),
    # "X implements Y" -> "X implements what?"
    (re.compile(r'^(.{10,}?)\s+implements?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} implements what?'),
    # "X handles Y" -> "X handles what?"
    (re.compile(r'^(.{10,}?)\s+handles?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} handles what?'),
    # "X contains Y" -> "X contains what?"
    (re.compile(r'^(.{10,}?)\s+contains?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} contains what?'),
    # "X manages Y" -> "X manages what?"
    (re.compile(r'^(.{10,}?)\s+manages?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} manages what?'),
    # "X defines Y" -> "X defines what?"
    (re.compile(r'^(.{10,}?)\s+defines?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} defines what?'),
    # "X creates Y" -> "X creates what?"
    (re.compile(r'^(.{10,}?)\s+creates?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} creates what?'),
    # "X returns Y" -> "X returns what?"
    (re.compile(r'^(.{10,}?)\s+returns?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} returns what?'),
    # "X allows Y" -> "X allows what?"
    (re.compile(r'^(.{10,}?)\s+allows?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} allows what?'),
    # "X requires Y" -> "X requires what?"
    (re.compile(r'^(.{10,}?)\s+requires?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} requires what?'),
    # "X performs Y" -> "X performs what?"
    (re.compile(r'^(.{10,}?)\s+performs?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} performs what?'),
    # "X uses Y" -> "X uses what?"
    (re.compile(r'^(.{10,}?)\s+uses?\s+(.{10,})$', re.I), lambda m: f'{m.group(1)} uses what?'),
]

# Minimum sentence length (chars) to consider as a fact
_MIN_SENTENCE_LEN = 30
# Maximum QA pairs per document
_MAX_QA_PER_DOC = 3


def get_mem_mb():
    """Return current process RSS in MB."""
    return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)


# ---------------------------------------------------------------------------
# Stage 1: Discover + parse documents
# ---------------------------------------------------------------------------


def discover_and_parse(root_dir):
    """Walk root_dir, read text files, return list of doc dicts."""
    docs = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d != '.git']
        for fname in sorted(filenames):
            fpath = os.path.join(dirpath, fname)
            ext = os.path.splitext(fname)[1].lower()
            mime, _ = mimetypes.guess_type(fpath)
            is_text = fname in KNOWN_TEXT_NAMES or ext in TEXT_EXTENSIONS or (mime and mime.startswith('text/'))
            if not is_text:
                continue
            try:
                with open(fpath, 'rb') as f:
                    raw = f.read()
                text = raw.decode('utf-8', errors='replace')
                if not text.strip():
                    continue
                docs.append(
                    {
                        'path': fpath,
                        'relative': os.path.relpath(fpath, root_dir),
                        'text': text,
                        'doc_id': len(docs),
                    }
                )
            except OSError:
                continue
    return docs


# ---------------------------------------------------------------------------
# Stage 2: Generate QA pairs (deterministic, no LLM)
# ---------------------------------------------------------------------------


def _extract_sentences(text):
    """Split text into sentences using a simple regex."""
    # Split on period/exclamation/question followed by whitespace or EOL
    raw = re.split(r'(?<=[.!?])\s+', text)
    sentences = []
    for s in raw:
        s = s.strip()
        # Must be a real sentence (not code, not too short)
        if len(s) < _MIN_SENTENCE_LEN:
            continue
        # Skip lines that look like code (too many special chars)
        alpha_ratio = sum(1 for c in s if c.isalpha()) / max(len(s), 1)
        if alpha_ratio < 0.5:
            continue
        sentences.append(s)
    return sentences


def _deterministic_select(items, n, seed_str):
    """Select up to n items deterministically based on a hash seed."""
    if len(items) <= n:
        return list(items)
    # Use hash to pick stable indices
    h = int(hashlib.md5(seed_str.encode()).hexdigest(), 16)
    step = max(1, len(items) // n)
    start = h % max(1, step)
    selected = []
    idx = start
    while len(selected) < n and idx < len(items):
        selected.append(items[idx])
        idx += step
    return selected


def generate_qa_pairs(docs):
    """For each document, extract facts and create questions.

    Returns list of dicts: {question, doc_id, fact_sentence}
    """
    qa_pairs = []
    for doc in docs:
        sentences = _extract_sentences(doc['text'])
        if not sentences:
            continue

        # Pick up to _MAX_QA_PER_DOC sentences deterministically
        candidates = _deterministic_select(sentences, _MAX_QA_PER_DOC * 3, doc['relative'])

        count = 0
        for sent in candidates:
            if count >= _MAX_QA_PER_DOC:
                break
            # Try each pattern
            for pattern, template in _QA_PATTERNS:
                m = pattern.match(sent)
                if m:
                    question = template(m)
                    qa_pairs.append(
                        {
                            'question': question,
                            'doc_id': doc['doc_id'],
                            'fact_sentence': sent,
                        }
                    )
                    count += 1
                    break
    return qa_pairs


# ---------------------------------------------------------------------------
# Stage 3: Chunk + build inverted index
# ---------------------------------------------------------------------------


def chunk_text(text, chunk_size=512, overlap=50):
    """Split text into fixed-size chunks with overlap."""
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunks.append(text[start:end])
        start += chunk_size - overlap
    return chunks


def chunk_and_index(docs, chunk_size=512, overlap=50):
    """Chunk all documents and build an inverted index.

    Returns:
        all_chunks: list of {text, doc_id, chunk_idx}
        index: dict mapping word -> set of chunk indices
        doc_to_chunks: dict mapping doc_id -> set of chunk indices
    """
    word_pattern = re.compile(r'\w{2,}')
    all_chunks = []
    index = defaultdict(set)
    doc_to_chunks = defaultdict(set)

    for doc in docs:
        pieces = chunk_text(doc['text'], chunk_size, overlap)
        for i, piece in enumerate(pieces):
            chunk_idx = len(all_chunks)
            all_chunks.append(
                {
                    'text': piece,
                    'doc_id': doc['doc_id'],
                    'chunk_idx': i,
                }
            )
            doc_to_chunks[doc['doc_id']].add(chunk_idx)
            words = set(word_pattern.findall(piece.lower()))
            for w in words:
                index[w].add(chunk_idx)

    return all_chunks, dict(index), dict(doc_to_chunks)


# ---------------------------------------------------------------------------
# Stage 4: Search + evaluate recall
# ---------------------------------------------------------------------------


def _search(index, query, max_results):
    """Search the inverted index. Returns ranked list of chunk indices."""
    words = re.findall(r'\w{2,}', query.lower())
    if not words:
        return []

    # Score chunks by number of matching query terms (BM25-lite)
    scores = defaultdict(int)
    for word in words:
        for chunk_idx in index.get(word, set()):
            scores[chunk_idx] += 1

    # Sort by score descending, break ties by chunk index (deterministic)
    ranked = sorted(scores.keys(), key=lambda c: (-scores[c], c))
    return ranked[:max_results]


def search_and_evaluate(qa_pairs, index, all_chunks, doc_to_chunks, k_values=None):
    """Run each question through the index, compute Recall@K and MRR.

    Args:
        qa_pairs: list of {question, doc_id, fact_sentence}
        index: inverted index (word -> set of chunk indices)
        all_chunks: list of chunk dicts
        doc_to_chunks: doc_id -> set of chunk indices
        k_values: list of K values for Recall@K

    Returns:
        dict with recall_at_k for each k, and mrr
    """
    if k_values is None:
        k_values = [1, 5, 10]

    max_k = max(k_values)
    hits_at_k = {k: 0 for k in k_values}
    reciprocal_ranks = []
    total = len(qa_pairs)

    if total == 0:
        return {f'recall_at_{k}': 0.0 for k in k_values} | {'mrr': 0.0}

    for qa in qa_pairs:
        # Use key terms from both question and fact for realistic keyword search
        query = qa['question'] + ' ' + qa.get('fact_sentence', '')
        results = _search(index, query, max_results=max_k)
        target_doc_id = qa['doc_id']
        target_chunks = doc_to_chunks.get(target_doc_id, set())

        # Find the rank of the first relevant chunk (1-indexed)
        first_relevant_rank = None
        for rank, chunk_idx in enumerate(results, start=1):
            if chunk_idx in target_chunks:
                first_relevant_rank = rank
                break

        # Recall@K: did we find a relevant chunk in top K?
        for k in k_values:
            top_k_set = set(results[:k])
            if top_k_set & target_chunks:
                hits_at_k[k] += 1

        # MRR: reciprocal of the first relevant rank
        if first_relevant_rank is not None:
            reciprocal_ranks.append(1.0 / first_relevant_rank)
        else:
            reciprocal_ranks.append(0.0)

    metrics = {}
    for k in k_values:
        metrics[f'recall_at_{k}'] = hits_at_k[k] / total
    metrics['mrr'] = sum(reciprocal_ranks) / total
    return metrics


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def run(root_dir):
    """Full recall benchmark pipeline. Returns dict compatible with run_comparison.py."""
    mem_start = get_mem_mb()

    print('=' * 60)
    print('RETRIEVAL QUALITY BENCHMARK (Recall@K)')
    print(f'Dataset: {root_dir}')
    print('=' * 60)

    # 1. Discover + parse
    print('\n[1/4] Discovering and parsing documents...')
    gc.collect()
    t0 = time.perf_counter()
    docs = discover_and_parse(root_dir)
    t_parse = time.perf_counter() - t0
    total_chars = sum(len(d['text']) for d in docs)
    print(f'      {len(docs):,} documents ({total_chars / (1024 * 1024):.1f} MB) in {t_parse:.2f}s')

    if not docs:
        print('\nNo documents found.')
        return {
            'tool': 'recall',
            'total_time': t_parse,
            'docs': 0,
            'chars': 0,
            'chunks': 0,
            'index_terms': 0,
            'mem_delta_mb': 0,
            'recall_at_1': 0.0,
            'recall_at_5': 0.0,
            'recall_at_10': 0.0,
            'mrr': 0.0,
        }

    # 2. Generate QA pairs
    print('\n[2/4] Generating QA pairs (deterministic pattern matching)...')
    gc.collect()
    t0 = time.perf_counter()
    qa_pairs = generate_qa_pairs(docs)
    t_qa = time.perf_counter() - t0
    print(f'      {len(qa_pairs):,} QA pairs from {len(docs):,} docs in {t_qa:.2f}s')
    docs_with_qa = len({qa['doc_id'] for qa in qa_pairs})
    print(f'      Coverage: {docs_with_qa}/{len(docs)} docs have QA pairs')

    if not qa_pairs:
        print('\nNo QA pairs generated (documents may not contain matching patterns).')
        mem_final = get_mem_mb()
        t_total = t_parse + t_qa
        return {
            'tool': 'recall',
            'total_time': t_total,
            'docs': len(docs),
            'chars': total_chars,
            'chunks': 0,
            'index_terms': 0,
            'mem_delta_mb': mem_final - mem_start,
            'recall_at_1': 0.0,
            'recall_at_5': 0.0,
            'recall_at_10': 0.0,
            'mrr': 0.0,
        }

    # 3. Chunk + index
    print('\n[3/4] Chunking and building inverted index...')
    gc.collect()
    t0 = time.perf_counter()
    all_chunks, index, doc_to_chunks = chunk_and_index(docs)
    t_index = time.perf_counter() - t0
    print(f'      {len(all_chunks):,} chunks, {len(index):,} index terms in {t_index:.2f}s')

    # 4. Evaluate
    print('\n[4/4] Evaluating retrieval quality...')
    gc.collect()
    t0 = time.perf_counter()
    k_values = [1, 5, 10]
    metrics = search_and_evaluate(qa_pairs, index, all_chunks, doc_to_chunks, k_values)
    t_eval = time.perf_counter() - t0
    print(f'      {len(qa_pairs):,} queries evaluated in {t_eval:.2f}s')

    mem_final = get_mem_mb()
    t_total = t_parse + t_qa + t_index + t_eval

    # Results table
    print(f'\n{"=" * 60}')
    print('RETRIEVAL QUALITY (Recall@K)')
    print(f'{"Metric":<12}| {"Value"}')
    print(f'{"-" * 12}+{"-" * 12}')
    print(f'{"Recall@1":<12}| {metrics["recall_at_1"]:.2f}')
    print(f'{"Recall@5":<12}| {metrics["recall_at_5"]:.2f}')
    print(f'{"Recall@10":<12}| {metrics["recall_at_10"]:.2f}')
    print(f'{"MRR":<12}| {metrics["mrr"]:.2f}')
    print(f'{"=" * 60}')

    print(f'\n  QA pairs:       {len(qa_pairs):>10,}')
    print(f'  Documents:      {len(docs):>10,}')
    print(f'  Chunks:         {len(all_chunks):>10,}')
    print(f'  Index terms:    {len(index):>10,}')
    print(f'  Total time:     {t_total:>10.2f}s')
    print(f'  Memory delta:   {mem_final - mem_start:>+10.1f} MB')
    print()

    # Sample QA pairs for debugging
    if qa_pairs:
        print('Sample QA pairs:')
        for qa in qa_pairs[:3]:
            print(f'  Q: {qa["question"][:80]}')
            print(f'  A: (doc {qa["doc_id"]}) {qa["fact_sentence"][:80]}')
            print()

    return {
        'tool': 'recall',
        'total_time': t_total,
        'docs': len(docs),
        'chars': total_chars,
        'chunks': len(all_chunks),
        'index_terms': len(index),
        'mem_delta_mb': mem_final - mem_start,
        'recall_at_1': metrics['recall_at_1'],
        'recall_at_5': metrics['recall_at_5'],
        'recall_at_10': metrics['recall_at_10'],
        'mrr': metrics['mrr'],
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory>')
        sys.exit(1)

    root = sys.argv[1]
    if not os.path.isdir(root):
        print(f'ERROR: {root} not found')
        sys.exit(1)
    run(root)
