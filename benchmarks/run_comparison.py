#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Comparative benchmark runner.

Runs all available chunking benchmarks on the same dataset and outputs
a comparison table. Used for README and Product Hunt launch materials.

Usage:
    pip install langchain-text-splitters chonkie psutil
    python benchmarks/run_comparison.py <docs_dir>

For C++ benchmark, build native libs first:
    cd nodes/src/nodes/preprocessor_native && make
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
            results.append(result)

    if not results:
        print('\nNo benchmarks completed.')
        sys.exit(1)

    # Comparison table
    print('\n')
    print('=' * 70)
    print('COMPARISON TABLE')
    print('=' * 70)

    header = f'{"Tool":<25} {"Time (s)":>10} {"Chunks":>10} {"Memory (MB)":>12} {"Speedup":>10}'
    print(header)
    print('-' * 70)

    # Use first result (LangChain) as baseline
    baseline_time = results[0]['total_time'] if results else 1

    for r in results:
        speedup = baseline_time / r['total_time'] if r['total_time'] > 0 else 0
        speedup_str = f'{speedup:.1f}x' if r['label'] != results[0]['label'] else 'baseline'
        print(f'{r["label"]:<25} {r["total_time"]:>10.3f} {r["chunks"]:>10} {r["mem_delta_mb"]:>12.1f} {speedup_str:>10}')

    print('=' * 70)

    # Save JSON for programmatic use
    output_path = os.path.join(bench_dir, 'results.json')
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)
    print(f'\nResults saved to {output_path}')


if __name__ == '__main__':
    main()
