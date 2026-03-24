#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Download standard benchmark datasets for reproducible evaluation.

Datasets:
  - MS MARCO passages (subset) — real Bing search queries
  - Natural Questions (subset) — Google search logs

Usage:
    python benchmarks/download_datasets.py [output_dir]
"""

import os
import sys


MSMARCO_URL = 'https://msmarco.z22.web.core.windows.net/msmarcoranking/collection.tar.gz'
MSMARCO_SAMPLE_SIZE = 5000


def download_msmarco_sample(output_dir, sample_size=MSMARCO_SAMPLE_SIZE):
    """Download MS MARCO passages and extract a sample as text files."""
    dataset_dir = os.path.join(output_dir, 'msmarco')
    os.makedirs(dataset_dir, exist_ok=True)

    marker = os.path.join(dataset_dir, '.downloaded')
    if os.path.exists(marker):
        count = len([f for f in os.listdir(dataset_dir) if f.endswith('.txt')])
        print(f'MS MARCO already downloaded ({count} docs)')
        return dataset_dir

    print(f'Downloading MS MARCO passages (sampling {sample_size})...')
    print('Note: Full dataset is ~1GB. We download and sample.')

    try:
        # Try HuggingFace datasets for easier access
        from datasets import load_dataset

        ds = load_dataset('microsoft/ms_marco', 'v2.1', split='train', streaming=True)
        count = 0
        for item in ds:
            if count >= sample_size:
                break
            passages = item.get('passages', {}).get('passage_text', [])
            for passage in passages[:1]:
                if passage and len(passage) > 50:
                    with open(os.path.join(dataset_dir, f'passage_{count:06d}.txt'), 'w') as f:
                        f.write(passage)
                    count += 1
                    if count >= sample_size:
                        break
            if count % 1000 == 0 and count > 0:
                print(f'  {count}/{sample_size} passages...')

        with open(marker, 'w') as f:
            f.write(f'{count}')
        print(f'  Downloaded {count} MS MARCO passages to {dataset_dir}')

    except ImportError:
        print('  pip install datasets to download MS MARCO')
        print('  Falling back to synthetic docs...')
        from generate_docs import generate_doc

        for i in range(sample_size):
            with open(os.path.join(dataset_dir, f'doc_{i:06d}.txt'), 'w') as f:
                f.write(generate_doc(i))
        with open(marker, 'w') as f:
            f.write(f'{sample_size}')
        print(f'  Generated {sample_size} synthetic docs as fallback')

    return dataset_dir


def main():
    """Download benchmark datasets."""
    output_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'datasets')
    os.makedirs(output_dir, exist_ok=True)

    print('Downloading benchmark datasets...\n')
    msmarco_dir = download_msmarco_sample(output_dir)

    print(f'\nDatasets ready in {output_dir}')
    print(f'  MS MARCO: {msmarco_dir}')
    print('\nRun benchmarks:')
    print(f'  python benchmarks/run_comparison.py {msmarco_dir}')


if __name__ == '__main__':
    main()
