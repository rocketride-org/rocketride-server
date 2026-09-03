"""
Manual reproducer for shared-model SentenceTransformer failures.

This script is intended for GPU environments where the production model is available.
It runs the same shared model instance in sequential and/or concurrent modes and logs
the token lengths observed per batch.

Example:
  PYTHONPATH=engine/packages/ai/src python \
    engine/packages/ai/tests/ai/common/models/transformers/reproduce_sentence_transformer_origin.py \
    --model nomic-ai/nomic-embed-text-v1.5 --device cuda:0 --threads 3 --iterations 30 --mode both
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import logging
import threading
from typing import List

from ai.common.models import SentenceTransformer


LOGGER = logging.getLogger('sentence_transformer_reproducer')


def _build_text(prefix: str, token_hint: int, label: str) -> str:
    # token_hint is intentionally large to create variable sequence lengths.
    payload = ' '.join([f'{label}_token'] * token_hint)
    return f'{prefix}{payload}'


def _build_batches(document_prefix: str) -> List[List[str]]:
    return [
        [
            _build_text(document_prefix, 409, 'sample_a'),
            _build_text(document_prefix, 756, 'sample_b'),
        ],
        [
            _build_text(document_prefix, 947, 'sample_c'),
            _build_text(document_prefix, 756, 'sample_d'),
        ],
        [
            _build_text(document_prefix, 512, 'sample_e'),
            _build_text(document_prefix, 409, 'sample_f'),
        ],
    ]


def _token_lengths(model: SentenceTransformer, sentences: List[str]) -> List[int]:
    tokenizer = model._model.tokenizer
    encoded = tokenizer(
        sentences,
        padding=True,
        truncation=True,
        return_tensors='pt',
        max_length=model.max_seq_length,
    )
    attention_mask = encoded['attention_mask']
    lengths = attention_mask.sum(dim=1).tolist()
    return [int(length) for length in lengths]


def _run_single_batch(model: SentenceTransformer, batch: List[str], mode: str, round_idx: int, worker_id: int) -> None:
    lengths = _token_lengths(model, batch)
    LOGGER.info(
        'encoding_start mode=%s round=%d worker=%d thread=%s token_lengths=%s',
        mode,
        round_idx,
        worker_id,
        threading.get_ident(),
        lengths,
    )
    model.encode(batch, batch_size=len(batch), show_progress_bar=False)
    LOGGER.info(
        'encoding_done mode=%s round=%d worker=%d thread=%s',
        mode,
        round_idx,
        worker_id,
        threading.get_ident(),
    )


def _run_sequential(model: SentenceTransformer, batches: List[List[str]], iterations: int) -> None:
    for round_idx in range(iterations):
        batch = batches[round_idx % len(batches)]
        _run_single_batch(model, batch, mode='sequential', round_idx=round_idx, worker_id=0)


def _run_concurrent(model: SentenceTransformer, batches: List[List[str]], iterations: int, threads: int) -> None:
    with ThreadPoolExecutor(max_workers=threads) as executor:
        for round_idx in range(iterations):
            futures = []
            for worker_id in range(threads):
                batch = batches[(round_idx + worker_id) % len(batches)]
                futures.append(
                    executor.submit(
                        _run_single_batch,
                        model,
                        batch,
                        'concurrent',
                        round_idx,
                        worker_id,
                    )
                )
            for future in futures:
                future.result()


def main() -> None:
    parser = argparse.ArgumentParser(description='Reproduce shared-model sentence transformer failures.')
    parser.add_argument('--model', default='nomic-ai/nomic-embed-text-v1.5')
    parser.add_argument('--device', default='cuda:0')
    parser.add_argument('--threads', type=int, default=3)
    parser.add_argument('--iterations', type=int, default=20)
    parser.add_argument('--mode', choices=['sequential', 'concurrent', 'both'], default='both')
    parser.add_argument('--truncate-dim', type=int, default=768)
    parser.add_argument('--document-prefix', default='search_document: ')
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(name)s %(message)s',
    )

    LOGGER.info(
        'loading_model model=%s device=%s threads=%d iterations=%d truncate_dim=%d',
        args.model,
        args.device,
        args.threads,
        args.iterations,
        args.truncate_dim,
    )
    model = SentenceTransformer(
        model_name_or_path=args.model,
        device=args.device,
        trust_remote_code=True,
        truncate_dim=args.truncate_dim,
    )
    LOGGER.info(
        'model_loaded model=%s max_seq_length=%d embedding_dim=%d proxy_mode=%s',
        args.model,
        model.max_seq_length,
        model.get_sentence_embedding_dimension(),
        model._proxy_mode,
    )

    batches = _build_batches(args.document_prefix)

    if args.mode in ('sequential', 'both'):
        LOGGER.info('start_mode mode=sequential')
        _run_sequential(model, batches, args.iterations)

    if args.mode in ('concurrent', 'both'):
        LOGGER.info('start_mode mode=concurrent')
        _run_concurrent(model, batches, args.iterations, args.threads)

    LOGGER.info('reproducer_complete mode=%s', args.mode)


if __name__ == '__main__':
    main()
