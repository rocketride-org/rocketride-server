"""
Benchmark: ONNX Runtime embedding vs Python sentence-transformers.

Measures the same embedding operation with:
1. Python sentence-transformers (PyTorch backend) — baseline
2. ONNX Runtime (optimized, FP32)
3. ONNX Runtime (INT8 quantized)

Usage:
    python bench_embedding.py [num_chunks]
"""

import gc
import os
import sys
import time

import numpy as np
import psutil


def get_mem_mb():
    """Return current RSS in MB."""
    return psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024


# Generate test chunks (realistic 512-char text fragments)
def generate_chunks(n):
    """Generate n synthetic text chunks."""
    base = (
        'The field of artificial intelligence has seen remarkable growth. '
        'Researchers have found that transformer models can be applied to '
        'solve complex problems in healthcare, finance, and engineering. '
        'One key challenge is scaling algorithms to handle large datasets. '
        'Recent papers propose novel approaches achieving state of the art. '
    )
    chunks = []
    for i in range(n):
        chunks.append(f'Document {i}: {base} Section {i % 100} discusses advanced topics.')
    return chunks


# ---------------------------------------------------------------------------
# Method 1: sentence-transformers (PyTorch)
# ---------------------------------------------------------------------------
def bench_sentence_transformers(chunks, batch_size=64):
    """Baseline: Python sentence-transformers."""
    from sentence_transformers import SentenceTransformer

    gc.collect()
    mem_before = get_mem_mb()

    t_load = time.perf_counter()
    model = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')
    t_load = time.perf_counter() - t_load

    gc.collect()
    t_embed = time.perf_counter()
    embeddings = model.encode(
        chunks,
        batch_size=batch_size,
        show_progress_bar=False,
        normalize_embeddings=True,
    )
    t_embed = time.perf_counter() - t_embed

    mem_after = get_mem_mb()
    return {
        'method': 'sentence-transformers (PyTorch)',
        'load_time': t_load,
        'embed_time': t_embed,
        'throughput': len(chunks) / t_embed,
        'memory_delta': mem_after - mem_before,
        'embedding_shape': embeddings.shape,
        'sample': embeddings[0][:5].tolist(),
    }


# ---------------------------------------------------------------------------
# Method 2: ONNX Runtime FP32
# ---------------------------------------------------------------------------
def bench_onnx_fp32(chunks, model_dir='/tmp/minilm-onnx', batch_size=64):
    """ONNX Runtime with FP32 model."""
    import onnxruntime as ort
    from transformers import AutoTokenizer

    gc.collect()
    mem_before = get_mem_mb()

    t_load = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(model_dir)
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_options.intra_op_num_threads = os.cpu_count()
    session = ort.InferenceSession(
        os.path.join(model_dir, 'model.onnx'),
        sess_options,
        providers=['CPUExecutionProvider'],
    )
    t_load = time.perf_counter() - t_load

    gc.collect()
    t_embed = time.perf_counter()
    all_embeddings = []

    for i in range(0, len(chunks), batch_size):
        batch = chunks[i : i + batch_size]
        encoded = tokenizer(
            batch,
            padding=True,
            truncation=True,
            max_length=128,
            return_tensors='np',
        )
        input_names = [inp.name for inp in session.get_inputs()]
        feed = {
            'input_ids': encoded['input_ids'].astype(np.int64),
            'attention_mask': encoded['attention_mask'].astype(np.int64),
        }
        if 'token_type_ids' in input_names:
            feed['token_type_ids'] = encoded.get('token_type_ids', np.zeros_like(encoded['input_ids'])).astype(np.int64)
        outputs = session.run(None, feed)
        # Mean pooling with attention mask
        hidden = outputs[0]  # [batch, seq_len, hidden_dim]
        mask = encoded['attention_mask'][:, :, np.newaxis].astype(np.float32)
        pooled = (hidden * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1e-12)

        # L2 normalize
        norms = np.linalg.norm(pooled, axis=1, keepdims=True).clip(min=1e-12)
        normalized = pooled / norms
        all_embeddings.append(normalized)

    t_embed = time.perf_counter() - t_embed
    embeddings = np.vstack(all_embeddings)
    mem_after = get_mem_mb()

    return {
        'method': 'ONNX Runtime (FP32)',
        'load_time': t_load,
        'embed_time': t_embed,
        'throughput': len(chunks) / t_embed,
        'memory_delta': mem_after - mem_before,
        'embedding_shape': embeddings.shape,
        'sample': embeddings[0][:5].tolist(),
    }


# ---------------------------------------------------------------------------
# Method 3: ONNX Runtime INT8
# ---------------------------------------------------------------------------
def bench_onnx_int8(chunks, model_dir='/tmp/minilm-onnx', batch_size=64):
    """ONNX Runtime with INT8 quantized model."""
    import onnxruntime as ort
    from transformers import AutoTokenizer

    int8_path = os.path.join(model_dir, 'model_int8.onnx')
    if not os.path.exists(int8_path):
        return {'method': 'ONNX Runtime (INT8)', 'error': 'model_int8.onnx not found'}

    gc.collect()
    mem_before = get_mem_mb()

    t_load = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(model_dir)
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_options.intra_op_num_threads = os.cpu_count()
    session = ort.InferenceSession(
        int8_path,
        sess_options,
        providers=['CPUExecutionProvider'],
    )
    t_load = time.perf_counter() - t_load

    gc.collect()
    t_embed = time.perf_counter()
    all_embeddings = []

    for i in range(0, len(chunks), batch_size):
        batch = chunks[i : i + batch_size]
        encoded = tokenizer(
            batch,
            padding=True,
            truncation=True,
            max_length=128,
            return_tensors='np',
        )
        input_names = [inp.name for inp in session.get_inputs()]
        feed = {
            'input_ids': encoded['input_ids'].astype(np.int64),
            'attention_mask': encoded['attention_mask'].astype(np.int64),
        }
        if 'token_type_ids' in input_names:
            feed['token_type_ids'] = encoded.get('token_type_ids', np.zeros_like(encoded['input_ids'])).astype(np.int64)
        outputs = session.run(None, feed)
        hidden = outputs[0]
        mask = encoded['attention_mask'][:, :, np.newaxis].astype(np.float32)
        pooled = (hidden * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1e-12)
        norms = np.linalg.norm(pooled, axis=1, keepdims=True).clip(min=1e-12)
        normalized = pooled / norms
        all_embeddings.append(normalized)

    t_embed = time.perf_counter() - t_embed
    embeddings = np.vstack(all_embeddings)
    mem_after = get_mem_mb()

    return {
        'method': 'ONNX Runtime (INT8)',
        'load_time': t_load,
        'embed_time': t_embed,
        'throughput': len(chunks) / t_embed,
        'memory_delta': mem_after - mem_before,
        'embedding_shape': embeddings.shape,
        'sample': embeddings[0][:5].tolist(),
    }


# ---------------------------------------------------------------------------
# Cosine similarity check
# ---------------------------------------------------------------------------
def cosine_similarity(a, b):
    """Compute cosine similarity between two vectors."""
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def run(n_chunks):
    """Run all benchmarks."""
    print(f'Generating {n_chunks:,} test chunks...')
    chunks = generate_chunks(n_chunks)

    print(f'\n{"=" * 70}')
    print(f'  EMBEDDING BENCHMARK: {n_chunks:,} chunks (MiniLM-L6-v2)')
    print(f'  Hardware: {os.cpu_count()} CPU cores')
    print(f'{"=" * 70}')

    results = []

    # Warm up and test sentence-transformers
    print('\n[1/3] sentence-transformers (PyTorch)...')
    r1 = bench_sentence_transformers(chunks, batch_size=64)
    results.append(r1)
    print(f'      Load: {r1["load_time"]:.2f}s | Embed: {r1["embed_time"]:.2f}s | {r1["throughput"]:.0f} chunks/sec | +{r1["memory_delta"]:.0f} MB')

    # ONNX FP32
    print('\n[2/3] ONNX Runtime (FP32, optimized)...')
    r2 = bench_onnx_fp32(chunks, batch_size=64)
    results.append(r2)
    if 'error' not in r2:
        print(f'      Load: {r2["load_time"]:.2f}s | Embed: {r2["embed_time"]:.2f}s | {r2["throughput"]:.0f} chunks/sec | +{r2["memory_delta"]:.0f} MB')

    # ONNX INT8
    print('\n[3/3] ONNX Runtime (INT8 quantized)...')
    r3 = bench_onnx_int8(chunks, batch_size=64)
    results.append(r3)
    if 'error' not in r3:
        print(f'      Load: {r3["load_time"]:.2f}s | Embed: {r3["embed_time"]:.2f}s | {r3["throughput"]:.0f} chunks/sec | +{r3["memory_delta"]:.0f} MB')

    # Quality check
    if all('sample' in r for r in results):
        sim_fp32 = cosine_similarity(
            np.array(r1['sample']),
            np.array(r2['sample']),
        )
        sim_int8 = cosine_similarity(
            np.array(r1['sample']),
            np.array(r3['sample']),
        )
        print('\n  Quality check (cosine sim vs PyTorch):')
        print(f'    ONNX FP32: {sim_fp32:.6f}')
        print(f'    ONNX INT8: {sim_int8:.6f}')

    # Summary
    baseline = r1['embed_time']
    print(f'\n{"=" * 70}')
    print(f'  RESULTS: {n_chunks:,} chunks')
    print(f'{"=" * 70}')
    print(f'  {"Method":<35} {"Time":>8} {"Chunks/s":>10} {"Speedup":>8} {"Mem":>8}')
    print(f'  {"-" * 69}')
    for r in results:
        if 'error' in r:
            print(f'  {r["method"]:<35} {"ERROR":>8}')
            continue
        speedup = baseline / r['embed_time']
        print(f'  {r["method"]:<35} {r["embed_time"]:>7.2f}s {r["throughput"]:>9.0f} {speedup:>7.1f}x {r["memory_delta"]:>+7.0f} MB')
    print()


if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10000
    run(n)


# ---------------------------------------------------------------------------
# Method 4: MLX (Apple Silicon native)
# ---------------------------------------------------------------------------
def bench_mlx(chunks, batch_size=256):
    """MLX embedding using unified memory GPU on Apple Silicon."""
    try:
        from mlx_embedding_models.embedding import EmbeddingModel
    except ImportError:
        return {'method': 'MLX (Apple Silicon)', 'error': 'mlx-embedding-models not installed'}

    gc.collect()
    mem_before = get_mem_mb()

    t_load = time.perf_counter()
    model = EmbeddingModel.from_registry('minilm-l6')
    _ = model.encode(['warmup'])
    t_load = time.perf_counter() - t_load

    gc.collect()
    t_embed = time.perf_counter()
    embeddings = model.encode(chunks, batch_size=batch_size)
    t_embed = time.perf_counter() - t_embed

    mem_after = get_mem_mb()
    emb_array = np.array(embeddings)
    return {
        'method': 'MLX (Apple Silicon)',
        'load_time': t_load,
        'embed_time': t_embed,
        'throughput': len(chunks) / t_embed,
        'memory_delta': mem_after - mem_before,
        'embedding_shape': emb_array.shape,
        'sample': emb_array[0][:5].tolist(),
    }
