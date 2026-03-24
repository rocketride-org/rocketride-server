#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Comparative benchmark runner.

Runs all available chunking benchmarks on the same dataset and outputs
a comparison table with industry-standard metrics.

Metrics:
  - Throughput: tokens/sec and MB/sec
  - Latency: P50, P95, P99 for search queries
  - Memory: peak RSS delta
  - Chunk count and index terms

Usage:
    pip install -r benchmarks/requirements.txt
    python benchmarks/generate_docs.py 1000
    python benchmarks/run_comparison.py benchmarks/test_docs
"""

import json
import os
import sys


def run_benchmark(name, module_path, docs_dir):
    """Import and run a benchmark module, return results dict."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(name, module_path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
        return mod.run(docs_dir)
    except Exception as e:
        print(f'\n  SKIP {name}: {e}\n')
        return None


def estimate_tokens(chars):
    """Estimate token count from character count (~4 chars per token)."""
    return chars // 4


def main():
    """Run all benchmarks and output comparison table."""
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory>')
        sys.exit(1)

    docs_dir = sys.argv[1]
    bench_dir = os.path.dirname(os.path.abspath(__file__))

    benchmarks = [
        ('LangChain (Python)', os.path.join(bench_dir, 'bench_langchain.py')),
        ('Chonkie (SIMD)', os.path.join(bench_dir, 'bench_chonkie.py')),
        ('LlamaIndex', os.path.join(bench_dir, 'bench_llamaindex.py')),
        ('Haystack', os.path.join(bench_dir, 'bench_haystack.py')),
        ('RocketRide (C++)', os.path.join(bench_dir, 'bench_rocketride.py')),
    ]

    results = []
    for name, path in benchmarks:
        if not os.path.exists(path):
            print(f'\nSKIP {name}: {path} not found')
            continue
        print(f'\n{"#" * 60}')
        print(f'# Running: {name}')
        print(f'{"#" * 60}')
        result = run_benchmark(name, path, docs_dir)
        if result:
            result['label'] = name
            # Add token-based metrics
            chars = result.get('chars', 0)
            total_time = result.get('total_time', 1)
            tokens = estimate_tokens(chars)
            result['tokens'] = tokens
            result['tokens_per_sec'] = tokens / total_time if total_time > 0 else 0
            result['mb_per_sec'] = (chars / (1024 * 1024)) / total_time if total_time > 0 else 0
            results.append(result)

    if not results:
        print('\nNo benchmarks completed.')
        sys.exit(1)

    # Comparison table
    print('\n')
    print('=' * 90)
    print('COMPARISON TABLE')
    print('=' * 90)

    header = f'{"Tool":<22} {"Time":>7} {"Chunks":>8} {"Mem MB":>8} {"tok/s":>10} {"MB/s":>7} {"Speedup":>8}'
    print(header)
    print('-' * 90)

    baseline_time = results[0]['total_time'] if results else 1

    for r in results:
        speedup = baseline_time / r['total_time'] if r['total_time'] > 0 else 0
        speedup_str = f'{speedup:.1f}x' if r['label'] != results[0]['label'] else 'baseline'
        print(f'{r["label"]:<22} {r["total_time"]:>7.3f} {r["chunks"]:>8} {r["mem_delta_mb"]:>8.1f} {r["tokens_per_sec"]:>10,.0f} {r["mb_per_sec"]:>7.1f} {speedup_str:>8}')

    print('=' * 90)

    # Markdown table for README
    print('\n### Markdown for README:\n')
    print('| Tool | Time (s) | Chunks | Memory | Tokens/sec | Speedup |')
    print('|------|----------|--------|--------|------------|---------|')
    for r in results:
        speedup = baseline_time / r['total_time'] if r['total_time'] > 0 else 0
        speedup_str = f'{speedup:.1f}x' if r['label'] != results[0]['label'] else 'baseline'
        print(f'| {r["label"]} | {r["total_time"]:.3f} | {r["chunks"]:,} | {r["mem_delta_mb"]:.0f} MB | {r["tokens_per_sec"]:,.0f} | {speedup_str} |')

    # Save JSON
    output_path = os.path.join(bench_dir, 'results.json')
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)
    print(f'\nResults saved to {output_path}')


if __name__ == '__main__':
    main()
