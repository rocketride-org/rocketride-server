#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Cost-efficiency benchmark — throughput-per-dollar for each framework.

Answers: "How much does it cost to process 1M documents?"

For each framework:
  1. Run chunking + indexing pipeline on the test docs
  2. Measure wall time, CPU time (time.process_time), peak memory
  3. Calculate costs for deployment scenarios:
     - AWS t3.medium ($0.0416/hr): LangChain, Haystack, LlamaIndex, Chonkie
     - AWS t3.small  ($0.0208/hr): RocketRide C++ (lower resource needs)
     - AWS g5.xlarge ($1.006/hr):  GPU for embedding generation
  4. Extrapolate to 1M docs based on measured throughput
  5. Print $/1M docs for each framework + deployment

Usage:
    pip install -r benchmarks/requirements.txt
    python benchmarks/bench_cost_efficiency.py <docs_dir>
"""

import gc
import os
import re
import sys
import time
from collections import defaultdict

import psutil

# ---------------------------------------------------------------------------
# AWS pricing ($/hr, on-demand, us-east-1, 2026)
# ---------------------------------------------------------------------------

INSTANCE_PRICING = {
    't3.small': 0.0208,
    't3.medium': 0.0416,
    'g5.xlarge': 1.006,
}

# Framework -> which instance it realistically needs
FRAMEWORK_INSTANCES = {
    'LangChain': ['t3.medium'],
    'Chonkie': ['t3.medium'],
    'LlamaIndex': ['t3.medium'],
    'Haystack': ['t3.medium'],
    'RocketRide': ['t3.medium', 't3.small'],
}

TARGET_DOCS = 1_000_000

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def get_mem_mb():
    """Return current process RSS in MB."""
    return psutil.Process().memory_info().rss / (1024 * 1024)


def peak_mem_mb():
    """Return peak RSS via psutil (platform-dependent)."""
    proc = psutil.Process()
    try:
        # Linux: ru_maxrss in KB
        import resource

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except (ImportError, AttributeError):
        return proc.memory_info().rss / (1024 * 1024)


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
    """Build inverted index from chunk texts."""
    index = defaultdict(set)
    for i, chunk in enumerate(chunks):
        words = set(re.findall(r'\w{2,}', chunk['text'].lower()))
        for w in words:
            index[w].add(i)
    return dict(index)


# ---------------------------------------------------------------------------
# Chunker wrappers (same as bench_comparative.py)
# ---------------------------------------------------------------------------

CHUNKERS = {}


def register_chunker(name):
    def decorator(func):
        CHUNKERS[name] = func
        return func

    return decorator


try:
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    @register_chunker('LangChain')
    def chunk_langchain(docs):
        splitter = RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=50)
        chunks = []
        for doc in docs:
            for text in splitter.split_text(doc['content']):
                chunks.append({'text': text, 'doc_id': doc['id']})
        return chunks

except ImportError:
    pass


try:
    from chonkie import TokenChunker

    @register_chunker('Chonkie')
    def chunk_chonkie(docs):
        chunker = TokenChunker(chunk_size=512, chunk_overlap=50)
        chunks = []
        for doc in docs:
            for c in chunker.chunk(doc['content']):
                chunks.append({'text': c.text, 'doc_id': doc['id']})
        return chunks

except ImportError:
    pass


try:
    from llama_index.core.node_parser import SentenceSplitter
    from llama_index.core.schema import TextNode

    @register_chunker('LlamaIndex')
    def chunk_llamaindex(docs):
        splitter = SentenceSplitter(chunk_size=512, chunk_overlap=50)
        chunks = []
        for doc in docs:
            nodes = splitter.get_nodes_from_documents([TextNode(text=doc['content'])])
            for n in nodes:
                chunks.append({'text': n.text, 'doc_id': doc['id']})
        return chunks

except ImportError:
    pass


try:
    from haystack import Document
    from haystack.components.preprocessors import DocumentSplitter

    @register_chunker('Haystack')
    def chunk_haystack(docs):
        splitter = DocumentSplitter(split_by='word', split_length=100, split_overlap=10)
        hs_docs = [Document(content=doc['content'], meta={'doc_id': doc['id']}) for doc in docs]
        result = splitter.run(documents=hs_docs)
        chunks = []
        for d in result['documents']:
            chunks.append({'text': d.content, 'doc_id': d.meta.get('doc_id', 0)})
        return chunks

except ImportError:
    pass


# RocketRide native C++ chunker (optional — skip if libs not built)
try:
    import ctypes
    import pathlib
    import platform

    _SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
    _NATIVE_DIR = str(_SCRIPT_DIR.parent / 'nodes' / 'src' / 'nodes' / 'preprocessor_native')
    _LIB_EXT = 'dylib' if platform.system() == 'Darwin' else 'so'

    _chunker_lib = ctypes.CDLL(os.path.join(_NATIVE_DIR, f'libnative_chunker.{_LIB_EXT}'))
    _chunker_lib.chunk_text.argtypes = [
        ctypes.c_char_p,
        ctypes.c_int32,
        ctypes.c_int32,
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int32),
        ctypes.c_int32,
    ]
    _chunker_lib.chunk_text.restype = ctypes.c_int32

    _indexer_lib = ctypes.CDLL(os.path.join(_NATIVE_DIR, f'libnative_indexer.{_LIB_EXT}'))
    _indexer_lib.index_reset.argtypes = []
    _indexer_lib.index_reset.restype = None
    _indexer_lib.index_add_chunk.argtypes = [ctypes.c_uint32, ctypes.c_char_p, ctypes.c_int32]
    _indexer_lib.index_add_chunk.restype = None
    _indexer_lib.index_finalize.argtypes = []
    _indexer_lib.index_finalize.restype = ctypes.c_uint32

    def _native_chunk_text(text_bytes, chunk_size=512, overlap=50):
        text_len = len(text_bytes)
        max_chunks = (text_len // max(1, chunk_size - overlap)) + 2
        offsets = (ctypes.c_int32 * (max_chunks * 2))()
        n = _chunker_lib.chunk_text(text_bytes, text_len, chunk_size, overlap, offsets, max_chunks)
        chunks = []
        for i in range(n):
            start = offsets[i * 2]
            length = offsets[i * 2 + 1]
            chunks.append(text_bytes[start : start + length])
        return chunks

    @register_chunker('RocketRide')
    def chunk_rocketride(docs):
        _indexer_lib.index_reset()
        chunks = []
        chunk_id = 0
        for doc in docs:
            text_bytes = doc['content'].encode('utf-8')
            raw_chunks = _native_chunk_text(text_bytes, chunk_size=512, overlap=50)
            for raw in raw_chunks:
                _indexer_lib.index_add_chunk(chunk_id, raw, len(raw))
                chunks.append({'text': raw.decode('utf-8', errors='replace'), 'doc_id': doc['id']})
                chunk_id += 1
        _indexer_lib.index_finalize()
        return chunks

except (OSError, AttributeError):
    pass


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------


def benchmark_framework(name, chunker_func, docs):
    """Run chunking + indexing pipeline, measure wall time, CPU time, peak memory."""
    gc.collect()

    mem_before = get_mem_mb()
    cpu_before = time.process_time()
    wall_before = time.perf_counter()

    try:
        chunks = chunker_func(docs)
    except Exception as e:
        return {'name': name, 'error': str(e)}

    # For non-RocketRide frameworks, also build an inverted index
    if name != 'RocketRide':
        build_inverted_index(chunks)

    wall_time = time.perf_counter() - wall_before
    cpu_time = time.process_time() - cpu_before
    mem_after = get_mem_mb()
    mem_peak = peak_mem_mb()

    num_docs = len(docs)
    time_per_1k = (wall_time / max(1, num_docs)) * 1000

    # Extrapolate to 1M docs
    time_for_1m = (wall_time / max(1, num_docs)) * TARGET_DOCS
    hours_for_1m = time_for_1m / 3600

    # Cost per instance type
    costs = {}
    for instance in FRAMEWORK_INSTANCES.get(name, ['t3.medium']):
        hourly_rate = INSTANCE_PRICING[instance]
        costs[instance] = hours_for_1m * hourly_rate

    # GPU embedding cost (applies to all frameworks equally)
    gpu_hours = hours_for_1m * 0.1  # assume embedding is ~10% of pipeline wall time
    gpu_cost = gpu_hours * INSTANCE_PRICING['g5.xlarge']

    return {
        'name': name,
        'num_docs': num_docs,
        'num_chunks': len(chunks),
        'wall_time': wall_time,
        'cpu_time': cpu_time,
        'mem_before': mem_before,
        'mem_after': mem_after,
        'mem_delta': mem_after - mem_before,
        'mem_peak': mem_peak,
        'time_per_1k': time_per_1k,
        'hours_for_1m': hours_for_1m,
        'costs': costs,
        'gpu_cost': gpu_cost,
    }


def run(root_dir):
    """Run cost-efficiency benchmark across all frameworks."""
    print('=' * 80)
    print('COST-EFFICIENCY BENCHMARK — THROUGHPUT-PER-DOLLAR')
    print(f'Dataset: {root_dir}')
    print(f'Target: {TARGET_DOCS:,} documents')
    print('=' * 80)

    docs = load_docs(root_dir)
    if not docs:
        print('No documents found.')
        sys.exit(1)

    total_chars = sum(len(d['content']) for d in docs)
    print(f'\n{len(docs)} docs, {total_chars:,} chars\n')

    results = []
    for name, func in CHUNKERS.items():
        print(f'  Benchmarking {name}...', end=' ', flush=True)
        r = benchmark_framework(name, func, docs)
        if 'error' in r:
            print(f'SKIP ({r["error"][:60]})')
        else:
            print(f'{r["wall_time"]:.3f}s wall, {r["cpu_time"]:.3f}s CPU, {r["mem_delta"]:.1f} MB')
            results.append(r)

    if not results:
        print('\nNo frameworks completed successfully.')
        return {}

    # --- Timing details ---
    print(f'\n{"=" * 80}')
    print('PIPELINE TIMING')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"Wall (s)":>10} {"CPU (s)":>10} {"Time/1K docs":>14} {"Chunks":>10}')
    print('-' * 62)
    for r in sorted(results, key=lambda x: x['wall_time']):
        print(f'{r["name"]:<15} {r["wall_time"]:>10.3f} {r["cpu_time"]:>10.3f} {r["time_per_1k"]:>13.3f}s {r["num_chunks"]:>10,}')

    # --- Memory ---
    print(f'\n{"=" * 80}')
    print('MEMORY USAGE')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"Delta (MB)":>12} {"Peak (MB)":>12}')
    print('-' * 42)
    for r in sorted(results, key=lambda x: x['mem_delta']):
        print(f'{r["name"]:<15} {r["mem_delta"]:>12.1f} {r["mem_peak"]:>12.1f}')

    # --- Cost projection ---
    print(f'\n{"=" * 80}')
    print(f'COST EFFICIENCY (projected to {TARGET_DOCS:,} documents)')
    print(f'{"=" * 80}')
    print(f'{"Framework":<15} {"Time/1K docs":>14} {"$/1M (t3.medium)":>18} {"$/1M (t3.small)":>17} {"$/1M (+GPU emb)":>17}')
    print('-' * 84)

    for r in sorted(results, key=lambda x: x['wall_time']):
        t3_med = r['costs'].get('t3.medium')
        t3_sm = r['costs'].get('t3.small')
        gpu_total = (t3_med or t3_sm or 0) + r['gpu_cost']

        med_str = f'${t3_med:.2f}' if t3_med is not None else 'N/A'
        sm_str = f'${t3_sm:.2f}' if t3_sm is not None else 'N/A'
        gpu_str = f'${gpu_total:.2f}'

        print(f'{r["name"]:<15} {r["time_per_1k"]:>13.2f}s {med_str:>18} {sm_str:>17} {gpu_str:>17}')

    # --- Speedup vs slowest ---
    slowest = max(r['wall_time'] for r in results)
    fastest = min(results, key=lambda x: x['wall_time'])
    cheapest_cost = min(min(r['costs'].values()) for r in results if r['costs'])
    most_expensive = max(max(r['costs'].values()) for r in results if r['costs'])

    print(f'\n{"=" * 80}')
    print('SUMMARY')
    print(f'{"=" * 80}')
    print(f'  Fastest framework:  {fastest["name"]} ({fastest["wall_time"]:.3f}s)')
    print(f'  Speedup vs slowest: {slowest / fastest["wall_time"]:.1f}x')
    print(f'  Cheapest $/1M docs: ${cheapest_cost:.2f}')
    print(f'  Most expensive:     ${most_expensive:.2f}')
    if most_expensive > 0:
        print(f'  Cost ratio:         {most_expensive / max(0.01, cheapest_cost):.1f}x')

    return {
        'tool': 'cost_efficiency',
        'target_docs': TARGET_DOCS,
        'num_docs_tested': len(docs),
        'total_chars': total_chars,
        'frameworks': [
            {
                'name': r['name'],
                'wall_time': r['wall_time'],
                'cpu_time': r['cpu_time'],
                'mem_delta_mb': r['mem_delta'],
                'mem_peak_mb': r['mem_peak'],
                'time_per_1k_docs': r['time_per_1k'],
                'hours_for_1m': r['hours_for_1m'],
                'costs': r['costs'],
                'gpu_cost': r['gpu_cost'],
                'num_chunks': r['num_chunks'],
            }
            for r in results
        ],
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory>')
        sys.exit(1)
    run(sys.argv[1])
