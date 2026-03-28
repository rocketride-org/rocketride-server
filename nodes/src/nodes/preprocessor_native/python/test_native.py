# ruff: noqa: D103
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'build'))
import rr_native


def test_chunker_basic():
    chunker = rr_native.Chunker()
    chunks = chunker.chunk('Hello world. This is a test. Another sentence.', 0)
    assert len(chunks) >= 1
    for c in chunks:
        assert c.length > 0
        assert c.offset >= 0


def test_chunker_config():
    config = rr_native.ChunkerConfig()
    config.target_size = 30
    config.overlap = 5
    chunker = rr_native.Chunker(config)
    chunks = chunker.chunk('First sentence. Second sentence. Third sentence.', 0)
    assert len(chunks) >= 1


def test_chunker_unicode():
    config = rr_native.ChunkerConfig()
    config.target_size = 30
    chunker = rr_native.Chunker(config)
    chunks = chunker.chunk('Привет мир. Это тест.', 0)
    assert len(chunks) >= 1


def test_indexer_bm25():
    idx = rr_native.Indexer()
    idx.add(0, 'the quick brown fox')
    idx.add(1, 'the lazy brown dog')
    idx.add(2, 'a cat on a mat')
    results = idx.search('brown fox', 10)
    assert len(results) >= 1
    assert results[0].chunk_id in (0, 1)
    assert results[0].score > 0


def test_indexer_reset():
    idx = rr_native.Indexer()
    idx.add(0, 'hello world')
    assert idx.doc_count() == 1
    idx.reset()
    assert idx.doc_count() == 0


def test_indexer_batch():
    idx = rr_native.Indexer()
    idx.add_batch([(0, 'cats are great'), (1, 'dogs are great'), (2, 'cats and dogs')])
    results = idx.search('cats', 10)
    assert len(results) >= 1


if __name__ == '__main__':
    test_chunker_basic()
    test_chunker_config()
    test_chunker_unicode()
    test_indexer_bm25()
    test_indexer_reset()
    test_indexer_batch()
    print('\nAll Python integration tests passed!')
