#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Shared chunker wrappers for all benchmarks.

Provides a unified interface for all 5 frameworks so every benchmark
can compare them consistently.

Each chunker takes a list of docs [{'content': str, 'id': int}]
and returns a list of chunks [{'text': str, 'doc_id': int}].
"""

import ctypes
import os
import pathlib
import platform
import re
from collections import defaultdict
from ctypes import POINTER, c_char_p, c_int32, c_uint32, c_uint64

# ---------------------------------------------------------------------------
# RocketRide C++ native chunker + indexer
# ---------------------------------------------------------------------------

_SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
_NATIVE_DIR = str(_SCRIPT_DIR.parent / 'nodes' / 'src' / 'nodes' / 'preprocessor_native')
_LIB_EXT = 'dylib' if platform.system() == 'Darwin' else 'so'

_native_available = False
_chunker_lib = None
_indexer_lib = None

try:
    _chunker_lib = ctypes.CDLL(os.path.join(_NATIVE_DIR, f'libnative_chunker.{_LIB_EXT}'))
    _chunker_lib.chunk_text.argtypes = [c_char_p, c_int32, c_int32, c_int32, POINTER(c_int32), c_int32]
    _chunker_lib.chunk_text.restype = c_int32

    _indexer_lib = ctypes.CDLL(os.path.join(_NATIVE_DIR, f'libnative_indexer.{_LIB_EXT}'))
    _indexer_lib.index_reset.argtypes = []
    _indexer_lib.index_reset.restype = None
    _indexer_lib.index_add_chunk.argtypes = [c_uint32, c_char_p, c_int32]
    _indexer_lib.index_add_chunk.restype = None
    _indexer_lib.index_finalize.argtypes = []
    _indexer_lib.index_finalize.restype = c_uint32
    _indexer_lib.index_term_count.argtypes = []
    _indexer_lib.index_term_count.restype = c_uint32
    _indexer_lib.index_search.argtypes = [c_char_p, c_int32, POINTER(c_uint32), c_int32]
    _indexer_lib.index_search.restype = c_int32
    _indexer_lib.index_memory_bytes.argtypes = []
    _indexer_lib.index_memory_bytes.restype = c_uint64
    _native_available = True
except OSError:
    pass


def native_chunk(text_bytes, chunk_size=512, overlap=50):
    """Chunk text using C++ native chunker. Return list of byte strings."""
    if not _native_available:
        raise RuntimeError('Native C++ libs not compiled')
    text_len = len(text_bytes)
    max_chunks = (text_len // max(1, chunk_size - overlap)) + 2
    offsets = (c_int32 * (max_chunks * 2))()
    n = _chunker_lib.chunk_text(text_bytes, text_len, chunk_size, overlap, offsets, max_chunks)
    chunks = []
    for i in range(n):
        start = offsets[i * 2]
        length = offsets[i * 2 + 1]
        chunks.append(text_bytes[start : start + length])
    return chunks


def native_index_reset():
    """Reset the C++ inverted index."""
    if _indexer_lib:
        _indexer_lib.index_reset()


def native_index_add(chunk_id, text_bytes):
    """Add a chunk to the C++ inverted index."""
    if _indexer_lib:
        _indexer_lib.index_add_chunk(c_uint32(chunk_id), text_bytes, len(text_bytes))


def native_index_finalize():
    """Finalize the C++ index. Return term count."""
    if _indexer_lib:
        return _indexer_lib.index_finalize()
    return 0


def native_search(query, max_results=100):
    """Search the C++ index. Return list of chunk IDs."""
    if not _indexer_lib:
        return []
    q_bytes = query.encode('utf-8')
    out_ids = (c_uint32 * max_results)()
    n = _indexer_lib.index_search(q_bytes, len(q_bytes), out_ids, max_results)
    return [out_ids[i] for i in range(n)]


# ---------------------------------------------------------------------------
# All chunkers — unified interface
# ---------------------------------------------------------------------------

CHUNKERS = {}


def chunk_rocketride(docs):
    """Chunk with RocketRide native C++ chunker (overlap=100 per Reddit best practices)."""
    if not _native_available:
        raise RuntimeError('Native C++ libs not compiled. Run: cd nodes/src/nodes/preprocessor_native && make')
    chunks = []
    for doc in docs:
        text_bytes = doc['content'].encode('utf-8')
        for piece in native_chunk(text_bytes, chunk_size=512, overlap=50):
            chunks.append({'text': piece.decode('utf-8', errors='replace'), 'doc_id': doc['id']})
    return chunks


CHUNKERS['RocketRide'] = chunk_rocketride


def chunk_langchain(docs):
    """Chunk with LangChain RecursiveCharacterTextSplitter."""
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    splitter = RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=50)
    chunks = []
    for doc in docs:
        for text in splitter.split_text(doc['content']):
            chunks.append({'text': text, 'doc_id': doc['id']})
    return chunks


CHUNKERS['LangChain'] = chunk_langchain


def chunk_chonkie(docs):
    """Chunk with Chonkie TokenChunker."""
    from chonkie import TokenChunker

    chunker = TokenChunker(chunk_size=512, chunk_overlap=50)
    chunks = []
    for doc in docs:
        for c in chunker.chunk(doc['content']):
            chunks.append({'text': c.text, 'doc_id': doc['id']})
    return chunks


CHUNKERS['Chonkie'] = chunk_chonkie


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


CHUNKERS['LlamaIndex'] = chunk_llamaindex


def chunk_haystack(docs):
    """Chunk with Haystack DocumentSplitter."""
    from haystack.components.preprocessors import DocumentSplitter
    from haystack import Document

    splitter = DocumentSplitter(split_by='word', split_length=100, split_overlap=10)
    hs_docs = [Document(content=doc['content'], meta={'doc_id': doc['id']}) for doc in docs]
    result = splitter.run(documents=hs_docs)
    return [{'text': d.content, 'doc_id': d.meta.get('doc_id', 0)} for d in result['documents']]


CHUNKERS['Haystack'] = chunk_haystack


# ---------------------------------------------------------------------------
# Shared index helpers
# ---------------------------------------------------------------------------


def build_inverted_index(chunks):
    """Build Python inverted index from chunks."""
    index = defaultdict(set)
    for i, chunk in enumerate(chunks):
        for w in set(re.findall(r'\w{2,}', chunk['text'].lower())):
            index[w].add(i)
    return dict(index)


def search_index(index, query, top_k=10):
    """Search inverted index with TF-IDF-like scoring."""
    words = re.findall(r'\w{2,}', query.lower())
    if not words:
        return []
    scores = defaultdict(float)
    total = max(1, max(max(v) for v in index.values() if v) + 1) if index else 1
    for w in words:
        posting = index.get(w, set())
        if posting:
            idf = 1.0 / (1.0 + len(posting) / total)
            for idx in posting:
                scores[idx] += idf
    return sorted(scores.keys(), key=lambda x: -scores[x])[:top_k]


# ---------------------------------------------------------------------------
# Enhanced indexing for RocketRide (stemming + stop words + BM25 tuning)
# Per Reddit best practices 2026
# ---------------------------------------------------------------------------

# Porter stemmer (simplified — handles common English suffixes)
_SUFFIX_RULES = [
    (r'ies$', 'i'),
    (r'ied$', 'i'),
    (r'ous$', ''),
    (r'ive$', ''),
    (r'ing$', ''),
    (r'tion$', 't'),
    (r'sion$', 's'),
    (r'ment$', ''),
    (r'ness$', ''),
    (r'able$', ''),
    (r'ible$', ''),
    (r'ful$', ''),
    (r'less$', ''),
    (r'ize$', ''),
    (r'ise$', ''),
    (r'ate$', ''),
    (r'ity$', ''),
    (r'ance$', ''),
    (r'ence$', ''),
    (r'ally$', ''),
    (r'erly$', ''),
    (r'edly$', ''),
    (r'ly$', ''),
    (r'er$', ''),
    (r'or$', ''),
    (r'es$', ''),
    (r'ed$', ''),
    (r's$', ''),
]
_COMPILED_RULES = [(re.compile(p), r) for p, r in _SUFFIX_RULES]

STOP_WORDS = frozenset(
    {
        'the',
        'is',
        'at',
        'which',
        'on',
        'a',
        'an',
        'and',
        'or',
        'but',
        'in',
        'with',
        'to',
        'for',
        'of',
        'not',
        'no',
        'can',
        'had',
        'has',
        'have',
        'it',
        'its',
        'that',
        'this',
        'was',
        'are',
        'be',
        'been',
        'being',
        'by',
        'do',
        'does',
        'did',
        'from',
        'he',
        'she',
        'they',
        'we',
        'you',
        'all',
        'each',
        'every',
        'both',
        'few',
        'more',
        'most',
        'other',
        'some',
        'such',
        'than',
        'too',
        'very',
        'just',
        'about',
        'also',
        'may',
        'will',
        'would',
        'should',
        'could',
        'into',
        'over',
        'after',
        'before',
        'between',
        'under',
        'above',
        'when',
        'where',
        'how',
        'what',
        'who',
        'whom',
        'why',
        'if',
        'then',
        'so',
        'up',
        'out',
        'as',
        'any',
        'only',
        'same',
        'here',
        'there',
        'these',
        'those',
        'through',
        'during',
        'while',
        'because',
        'until',
    }
)


def _stem(word):
    """Apply simplified Porter stemming."""
    if len(word) <= 3:
        return word
    for pattern, replacement in _COMPILED_RULES:
        new = pattern.sub(replacement, word)
        if new != word and len(new) >= 3:
            return new
    return word


def _tokenize_enhanced(text):
    """Tokenize with stemming and stop word removal."""
    words = re.findall(r'\w{2,}', text.lower())
    tokens = set()
    prev = None
    for w in words:
        if w in STOP_WORDS:
            prev = None
            continue
        stemmed = _stem(w)
        tokens.add(stemmed)
        # Add bi-grams
        if prev is not None:
            tokens.add(f'{prev}_{stemmed}')
        prev = stemmed
    return tokens


def build_enhanced_index(chunks):
    """Build enhanced inverted index with stemming, stop words, bi-grams."""
    index = defaultdict(set)
    doc_lengths = defaultdict(int)
    for i, chunk in enumerate(chunks):
        tokens = _tokenize_enhanced(chunk['text'])
        for t in tokens:
            index[t].add(i)
        doc_lengths[i] = len(tokens)
    avg_dl = sum(doc_lengths.values()) / max(1, len(doc_lengths))
    return dict(index), doc_lengths, avg_dl


def search_enhanced(index, query, doc_lengths, avg_dl, top_k=10, k1=0.9, b=0.1):
    """Search with BM25 scoring tuned for RAG chunks (Reddit 2026 params)."""
    tokens = _tokenize_enhanced(query)
    if not tokens:
        return []
    n_docs = max(1, max(max(v) for v in index.values() if v) + 1) if index else 1
    scores = defaultdict(float)
    for t in tokens:
        posting = index.get(t, set())
        if not posting:
            continue
        idf = max(0.0, (n_docs - len(posting) + 0.5) / (len(posting) + 0.5))
        import math

        idf = math.log(1 + idf)
        for doc_id in posting:
            dl = doc_lengths.get(doc_id, avg_dl)
            tf = 1.0  # binary TF for set-based index
            tf_norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avg_dl))
            scores[doc_id] += idf * tf_norm
    return sorted(scores.keys(), key=lambda x: -scores[x])[:top_k]
