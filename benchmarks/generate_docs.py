#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Generate synthetic test documents for benchmarking.

Usage:
    python benchmarks/generate_docs.py [count] [output_dir]

Defaults: 1000 docs in benchmarks/test_docs/
"""

import os
import random
import sys

PARAGRAPHS = [
    'Data processing pipelines are the backbone of modern AI systems. They transform raw data into structured formats suitable for machine learning models and analytics workloads.',
    'Vector databases enable semantic search by storing high-dimensional embeddings alongside metadata. This allows applications to find conceptually similar content rather than relying on keyword matching alone.',
    'Pipeline configuration requires careful attention to node ordering, error handling, and resource allocation. Each node in the pipeline processes data and passes results downstream.',
    'The embedding model converts text into dense vector representations. These vectors capture semantic meaning and enable similarity comparisons between documents.',
    'Chunking strategies significantly impact retrieval quality. Too large chunks lose specificity, while too small chunks lose context. Overlap between chunks helps maintain continuity.',
    'Machine learning workflows often involve data ingestion, preprocessing, feature extraction, model training, and inference. Each stage has distinct computational requirements.',
    'Error handling in distributed pipelines must account for network failures, timeout conditions, and partial results. Retry logic with exponential backoff is a common pattern.',
    'Memory management is critical when processing large document collections. Streaming approaches and batch processing help control resource consumption.',
    'The inverted index maps terms to document identifiers, enabling fast full-text search. Posting lists are typically sorted for efficient intersection operations.',
    'Authentication and authorization protect pipeline endpoints from unauthorized access. API keys, OAuth tokens, and role-based access control are common mechanisms.',
]


def generate_doc(doc_id, num_paragraphs=None):
    """Generate a synthetic document with realistic content."""
    if num_paragraphs is None:
        num_paragraphs = random.randint(3, 15)
    selected = [random.choice(PARAGRAPHS) for _ in range(num_paragraphs)]
    title = f'Document {doc_id}: {random.choice(["Analysis", "Report", "Guide", "Overview", "Tutorial", "Reference"])}'
    return f'# {title}\n\n' + '\n\n'.join(selected) + '\n'


def main():
    """Generate synthetic test documents."""
    random.seed(42)

    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    if count < 1:
        count = 1
    output_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), 'test_docs')

    os.makedirs(output_dir, exist_ok=True)

    total_chars = 0
    for i in range(count):
        content = generate_doc(i)
        total_chars += len(content)
        with open(os.path.join(output_dir, f'doc_{i:05d}.txt'), 'w') as f:
            f.write(content)

    print(f'Generated {count} docs ({total_chars:,} chars) in {output_dir}')


if __name__ == '__main__':
    main()
