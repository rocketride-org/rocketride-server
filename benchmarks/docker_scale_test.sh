#!/usr/bin/env bash
# =============================================================================
# Memory-constrained scale test via Docker
#
# Runs each framework in a separate Docker container with hard memory limit.
# Shows which framework survives longest before OOM kill.
#
# Usage:
#   chmod +x benchmarks/docker_scale_test.sh
#   ./benchmarks/docker_scale_test.sh [memory_limit] [max_docs]
#
# Examples:
#   ./benchmarks/docker_scale_test.sh 2g 500000   # 2GB limit, up to 500K docs
#   ./benchmarks/docker_scale_test.sh 4g 1000000  # 4GB limit, up to 1M docs
# =============================================================================

set -euo pipefail

MEM_LIMIT="${1:-2g}"
MAX_DOCS="${2:-500000}"
BATCH_SIZE=10000
IMAGE="python:3.12-slim"

echo "============================================================"
echo "DOCKER MEMORY-CONSTRAINED SCALE TEST"
echo "Memory limit: $MEM_LIMIT (swap disabled)"
echo "Max docs: $MAX_DOCS (batch size: $BATCH_SIZE)"
echo "============================================================"

# Install deps in a cached layer
echo ""
echo "Building test image..."
docker build -t bench-scale -f - . <<'DOCKERFILE'
FROM python:3.12-slim
WORKDIR /bench
RUN pip install --no-cache-dir psutil langchain-text-splitters chonkie llama-index-core haystack-ai
DOCKERFILE

# Python script that tests ONE framework with accumulating index
cat > /tmp/bench_one_framework.py <<'PYSCRIPT'
import gc
import os
import random
import sys
import time
from collections import defaultdict
import re

import psutil

FRAMEWORK = sys.argv[1]
MAX_DOCS = int(sys.argv[2])
BATCH_SIZE = int(sys.argv[3])

PARAGRAPHS = [
    'Data processing pipelines are the backbone of modern AI systems.',
    'Vector databases enable semantic search by storing embeddings.',
    'Pipeline configuration requires careful attention to node ordering.',
    'The embedding model converts text into dense vector representations.',
    'Chunking strategies significantly impact retrieval quality.',
    'Machine learning workflows involve data ingestion and preprocessing.',
    'Error handling must account for network failures and timeouts.',
    'Memory management is critical when processing large collections.',
    'The inverted index maps terms to document identifiers.',
    'Authentication protects pipeline endpoints from unauthorized access.',
]

def generate_batch(start_id, count):
    docs = []
    for i in range(count):
        doc_id = start_id + i
        random.seed(doc_id + 42)
        n = random.randint(3, 12)
        content = f'# Doc {doc_id}\n\n' + '\n\n'.join(random.choice(PARAGRAPHS) for _ in range(n))
        docs.append({'content': content, 'id': doc_id})
    return docs

def get_chunker(name):
    if name == 'LangChain':
        from langchain_text_splitters import RecursiveCharacterTextSplitter
        splitter = RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=50)
        def chunk(docs):
            chunks = []
            for d in docs:
                for t in splitter.split_text(d['content']):
                    chunks.append({'text': t, 'doc_id': d['id']})
            return chunks
        return chunk
    elif name == 'Chonkie':
        from chonkie import TokenChunker
        chunker = TokenChunker(chunk_size=512, chunk_overlap=50)
        def chunk(docs):
            chunks = []
            for d in docs:
                for c in chunker.chunk(d['content']):
                    chunks.append({'text': c.text, 'doc_id': d['id']})
            return chunks
        return chunk
    elif name == 'LlamaIndex':
        from llama_index.core.node_parser import SentenceSplitter
        from llama_index.core.schema import TextNode
        splitter = SentenceSplitter(chunk_size=512, chunk_overlap=50)
        def chunk(docs):
            chunks = []
            for d in docs:
                nodes = splitter.get_nodes_from_documents([TextNode(text=d['content'])])
                for n in nodes:
                    chunks.append({'text': n.text, 'doc_id': d['id']})
            return chunks
        return chunk
    elif name == 'Haystack':
        from haystack.components.preprocessors import DocumentSplitter
        from haystack import Document
        splitter = DocumentSplitter(split_by='word', split_length=100, split_overlap=10)
        def chunk(docs):
            hs_docs = [Document(content=d['content'], meta={'doc_id': d['id']}) for d in docs]
            result = splitter.run(documents=hs_docs)
            return [{'text': d.content, 'doc_id': d.meta.get('doc_id', 0)} for d in result['documents']]
        return chunk
    elif name == 'RocketRide':
        # Simple Python chunker simulating C++ behavior (C++ libs not in Docker)
        def chunk(docs):
            chunks = []
            for d in docs:
                text = d['content']
                pos = 0
                while pos < len(text):
                    end = min(pos + 512, len(text))
                    # Try sentence boundary
                    if end < len(text):
                        for i in range(end, max(pos + 256, 0), -1):
                            if i > 0 and text[i-1] in '.!?' and (i >= len(text) or text[i] in ' \n'):
                                end = i
                                break
                    chunks.append({'text': text[pos:end], 'doc_id': d['id']})
                    if end >= len(text):
                        break
                    pos = max(end - 50, pos + 1)
            return chunks
        return chunk

def get_mem_mb():
    return psutil.Process().memory_info().rss / (1024 * 1024)

print(f'FRAMEWORK: {FRAMEWORK}')
print(f'MAX_DOCS: {MAX_DOCS}, BATCH_SIZE: {BATCH_SIZE}')
print(f'PID: {os.getpid()}')

chunker = get_chunker(FRAMEWORK)
total_index = defaultdict(set)
total_docs = 0
total_chunks = 0

print(f'{"Batch":>6} {"Docs":>10} {"Chunks":>12} {"RSS MB":>10} {"Time":>8}')
print('-' * 50)

while total_docs < MAX_DOCS:
    batch = generate_batch(total_docs, BATCH_SIZE)
    t0 = time.perf_counter()

    chunks = chunker(batch)

    # ACCUMULATE index (this is what eats memory)
    for i, chunk in enumerate(chunks):
        chunk_id = total_chunks + i
        for w in set(re.findall(r'\w{2,}', chunk['text'].lower())):
            total_index[w].add(chunk_id)

    total_chunks += len(chunks)
    total_docs += BATCH_SIZE
    elapsed = time.perf_counter() - t0
    rss = get_mem_mb()

    print(f'{total_docs//BATCH_SIZE:>6} {total_docs:>10,} {total_chunks:>12,} {rss:>10.0f} {elapsed:>8.2f}')
    sys.stdout.flush()

print(f'\nSURVIVED: {total_docs:,} docs, {total_chunks:,} chunks, {get_mem_mb():.0f} MB')
PYSCRIPT

FRAMEWORKS="RocketRide LangChain Chonkie LlamaIndex Haystack"
SUMMARY=""

for fw in $FRAMEWORKS; do
    echo ""
    echo "============================================================"
    echo "Testing: $fw (limit: $MEM_LIMIT)"
    echo "============================================================"

    EXIT_CODE=0
    docker run --rm \
        --memory="$MEM_LIMIT" \
        --memory-swap="$MEM_LIMIT" \
        -v /tmp/bench_one_framework.py:/bench/test.py:ro \
        bench-scale \
        python /bench/test.py "$fw" "$MAX_DOCS" "$BATCH_SIZE" 2>&1 || EXIT_CODE=$?

    if [ $EXIT_CODE -eq 137 ]; then
        echo ">>> OOM KILLED (exit 137) <<<"
        SUMMARY="$SUMMARY  $fw: OOM KILLED\n"
    elif [ $EXIT_CODE -eq 0 ]; then
        echo ">>> SURVIVED <<<"
        SUMMARY="$SUMMARY  $fw: SURVIVED\n"
    else
        echo ">>> FAILED (exit $EXIT_CODE) <<<"
        SUMMARY="$SUMMARY  $fw: FAILED (exit $EXIT_CODE)\n"
    fi
done

echo ""
echo "============================================================"
echo "RESULTS SUMMARY (memory limit: $MEM_LIMIT)"
echo "============================================================"
echo -e "$SUMMARY"
