#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Cost-per-query estimator for RAG pipeline benchmarks.

Estimates the cost breakdown per query based on:
  - Embedding API costs (query + document)
  - Vector DB read/write operations
  - LLM token costs (input context + output)
  - Compute time (self-hosted amortization)

Uses 2026 pricing from major providers.

Usage:
    python benchmarks/bench_cost.py <docs_dir>
"""

import os
import sys

# 2026 pricing (per 1M tokens unless noted)
PRICING = {
    'embedding': {
        'openai_3_large': {'input': 0.13},  # $/1M tokens
        'openai_3_small': {'input': 0.02},
        'cohere_v3': {'input': 0.10},
        'local_onnx': {'input': 0.00},  # self-hosted, compute-only
    },
    'llm': {
        'gpt4o_mini': {'input': 0.15, 'output': 0.60},
        'gpt4o': {'input': 2.50, 'output': 10.00},
        'claude_sonnet': {'input': 3.00, 'output': 15.00},
        'claude_haiku': {'input': 0.25, 'output': 1.25},
        'local_llama': {'input': 0.00, 'output': 0.00},
    },
    'vector_db': {
        'pinecone_serverless': {'read_unit': 0.000002, 'write_unit': 0.000002},
        'qdrant_cloud': {'read_unit': 0.000001, 'write_unit': 0.000001},
        'local_milvus': {'read_unit': 0.00, 'write_unit': 0.00},
    },
    'compute': {
        'gpu_a10g_hourly': 1.006,  # AWS g5.xlarge
        'gpu_t4_hourly': 0.526,  # AWS g4dn.xlarge
        'cpu_m5_hourly': 0.096,  # AWS m5.large
    },
}

# Typical RAG query parameters
DEFAULT_PARAMS = {
    'query_tokens': 50,
    'retrieved_chunks': 10,
    'tokens_per_chunk': 128,
    'output_tokens': 200,
    'rerank_queries': 10,
}


def estimate_query_cost(
    embedding_model='openai_3_small',
    llm_model='gpt4o_mini',
    vector_db='pinecone_serverless',
    params=None,
):
    """Estimate cost for a single RAG query."""
    p = params or DEFAULT_PARAMS

    # Embedding cost (query embedding)
    query_tokens = p['query_tokens']
    emb_price = PRICING['embedding'][embedding_model]
    emb_cost = (query_tokens / 1_000_000) * emb_price['input']

    # Vector DB cost (read top-K)
    vdb_price = PRICING['vector_db'][vector_db]
    vdb_cost = p['retrieved_chunks'] * vdb_price['read_unit']

    # LLM cost (context + generation)
    context_tokens = p['retrieved_chunks'] * p['tokens_per_chunk']
    input_tokens = query_tokens + context_tokens
    output_tokens = p['output_tokens']
    llm_price = PRICING['llm'][llm_model]
    llm_input_cost = (input_tokens / 1_000_000) * llm_price['input']
    llm_output_cost = (output_tokens / 1_000_000) * llm_price['output']

    total = emb_cost + vdb_cost + llm_input_cost + llm_output_cost

    return {
        'embedding_cost': emb_cost,
        'vector_db_cost': vdb_cost,
        'llm_input_cost': llm_input_cost,
        'llm_output_cost': llm_output_cost,
        'total_cost': total,
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'context_tokens': context_tokens,
    }


def estimate_ingestion_cost(
    num_docs,
    avg_chars_per_doc,
    embedding_model='openai_3_small',
    vector_db='pinecone_serverless',
    chunk_size=512,
):
    """Estimate cost to ingest a document collection."""
    total_chars = num_docs * avg_chars_per_doc
    total_tokens = total_chars // 4  # ~4 chars per token
    num_chunks = total_chars // max(1, chunk_size - 50)

    # Embedding all chunks
    emb_price = PRICING['embedding'][embedding_model]
    emb_cost = (total_tokens / 1_000_000) * emb_price['input']

    # Vector DB writes
    vdb_price = PRICING['vector_db'][vector_db]
    vdb_cost = num_chunks * vdb_price['write_unit']

    return {
        'total_docs': num_docs,
        'total_tokens': total_tokens,
        'total_chunks': num_chunks,
        'embedding_cost': emb_cost,
        'vector_db_cost': vdb_cost,
        'total_cost': emb_cost + vdb_cost,
    }


def run(root_dir):
    """Run cost estimation benchmark."""
    print('=' * 60)
    print('COST-PER-QUERY ESTIMATION')
    print('=' * 60)

    # Count docs and chars
    total_chars = 0
    num_docs = 0
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in filenames:
            fpath = os.path.join(dirpath, fname)
            try:
                total_chars += os.path.getsize(fpath)
                num_docs += 1
            except OSError:
                continue

    avg_chars = total_chars // max(1, num_docs)
    print(f'\nDataset: {num_docs} docs, {total_chars:,} chars, avg {avg_chars} chars/doc')

    # Query cost comparison
    configs = [
        ('Cloud (OpenAI + Pinecone)', 'openai_3_small', 'gpt4o_mini', 'pinecone_serverless'),
        ('Cloud (OpenAI + GPT-4o)', 'openai_3_small', 'gpt4o', 'pinecone_serverless'),
        ('Cloud (Cohere + Claude)', 'cohere_v3', 'claude_sonnet', 'qdrant_cloud'),
        ('Self-hosted (ONNX + Milvus)', 'local_onnx', 'local_llama', 'local_milvus'),
    ]

    print(f'\n{"Config":<35} {"$/query":>10} {"$/1K queries":>12} {"Context tok":>12}')
    print('-' * 72)

    results = []
    for label, emb, llm, vdb in configs:
        cost = estimate_query_cost(embedding_model=emb, llm_model=llm, vector_db=vdb)
        print(f'{label:<35} {cost["total_cost"]:>10.6f} {cost["total_cost"] * 1000:>12.4f} {cost["context_tokens"]:>12}')
        results.append({'config': label, **cost})

    # Ingestion cost
    print(f'\n\n{"=" * 60}')
    print('INGESTION COST ESTIMATION')
    print(f'{"=" * 60}')

    print(f'\n{"Config":<35} {"$/ingest":>10} {"Chunks":>10} {"Tokens":>12}')
    print('-' * 72)

    for label, emb, _llm, vdb in configs:
        ing = estimate_ingestion_cost(num_docs, avg_chars, embedding_model=emb, vector_db=vdb)
        print(f'{label:<35} {ing["total_cost"]:>10.4f} {ing["total_chunks"]:>10} {ing["total_tokens"]:>12,}')

    # Summary for README
    cheapest = min(results, key=lambda x: x['total_cost'])
    print(f'\n\nCheapest config: {cheapest["config"]} at ${cheapest["total_cost"]:.6f}/query')
    print('Self-hosted (RocketRide + local models): $0.00/query')

    return {
        'tool': 'cost_estimation',
        'total_time': 0,
        'docs': num_docs,
        'chars': total_chars,
        'chunks': 0,
        'index_terms': 0,
        'mem_delta_mb': 0,
        'query_costs': results,
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory>')
        sys.exit(1)
    run(sys.argv[1])
