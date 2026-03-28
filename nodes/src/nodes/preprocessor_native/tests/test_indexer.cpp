#include "indexer.h"

#include <cassert>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

static int tests_passed = 0;
static int tests_failed = 0;

#define RUN_TEST(fn)                                                                               \
    do {                                                                                           \
        std::printf("  %-40s", #fn);                                                               \
        try {                                                                                      \
            fn();                                                                                  \
            std::printf("PASS\n");                                                                 \
            ++tests_passed;                                                                        \
        } catch (const std::exception& e) {                                                        \
            std::printf("FAIL: %s\n", e.what());                                                   \
            ++tests_failed;                                                                        \
        } catch (...) {                                                                            \
            std::printf("FAIL: unknown exception\n");                                              \
            ++tests_failed;                                                                        \
        }                                                                                          \
    } while (0)

#define ASSERT_EQ(a, b)                                                                            \
    do {                                                                                           \
        if ((a) != (b)) {                                                                          \
            char buf[256];                                                                         \
            std::snprintf(buf, sizeof(buf), "line %d: %d != %d", __LINE__,                         \
                          static_cast<int>(a), static_cast<int>(b));                               \
            throw std::runtime_error(buf);                                                         \
        }                                                                                          \
    } while (0)

#define ASSERT_TRUE(cond)                                                                          \
    do {                                                                                           \
        if (!(cond)) {                                                                             \
            char buf[128];                                                                         \
            std::snprintf(buf, sizeof(buf), "line %d: assertion failed", __LINE__);                \
            throw std::runtime_error(buf);                                                         \
        }                                                                                          \
    } while (0)

void test_basic_index_and_search() {
    rr::Indexer idx;
    idx.add(0, "the quick brown fox jumps over the lazy dog");
    idx.add(1, "the quick brown cat sits on the mat");
    idx.add(2, "a fast red fox runs through the forest");

    ASSERT_EQ(idx.doc_count(), 3);
    ASSERT_TRUE(idx.term_count() > 0);

    auto results = idx.search("quick brown fox");
    ASSERT_TRUE(!results.empty());

    // Doc 0 has all three query terms, should rank first
    ASSERT_EQ(results[0].chunk_id, 0);
    ASSERT_TRUE(results[0].score > 0.0f);

    // Doc 2 has "fox" but not "quick" or "brown" — should appear
    bool found_doc2 = false;
    for (auto& r : results) {
        if (r.chunk_id == 2) found_doc2 = true;
    }
    ASSERT_TRUE(found_doc2);
}

void test_bm25_ranking() {
    rr::Indexer idx;
    // Short doc with high TF for "rocket"
    idx.add(0, "rocket rocket rocket launch");
    // Long doc with low TF for "rocket"
    idx.add(1,
            "the space shuttle program was a remarkable achievement in human spaceflight "
            "engineering and rocket science that spanned decades of research and development");

    auto results = idx.search("rocket");
    ASSERT_TRUE(results.size() == 2);
    // Short doc with repeated "rocket" should rank higher due to BM25 TF saturation + length norm
    ASSERT_EQ(results[0].chunk_id, 0);
    ASSERT_TRUE(results[0].score > results[1].score);
}

void test_thread_safety() {
    rr::Indexer idx;
    constexpr int num_writers = 4;
    constexpr int docs_per_writer = 100;
    constexpr int num_readers = 4;
    constexpr int searches_per_reader = 100;

    std::vector<std::thread> threads;

    // Writer threads
    for (int w = 0; w < num_writers; ++w) {
        threads.emplace_back([&idx, w]() {
            for (int i = 0; i < docs_per_writer; ++i) {
                uint32_t id = static_cast<uint32_t>(w * docs_per_writer + i);
                std::string text = "document number " + std::to_string(id) + " with some searchable content";
                idx.add(id, text);
            }
        });
    }

    // Reader threads (concurrent with writers)
    for (int r = 0; r < num_readers; ++r) {
        threads.emplace_back([&idx]() {
            for (int i = 0; i < searches_per_reader; ++i) {
                auto results = idx.search("document searchable content");
                (void)results; // just checking it doesn't crash
            }
        });
    }

    for (auto& t : threads) {
        t.join();
    }

    ASSERT_EQ(idx.doc_count(), num_writers * docs_per_writer);
}

void test_empty_queries() {
    rr::Indexer idx;
    idx.add(0, "hello world");

    // Empty string
    auto r1 = idx.search("");
    ASSERT_TRUE(r1.empty());

    // Single char (below min_token_len=2)
    auto r2 = idx.search("x");
    ASSERT_TRUE(r2.empty());

    // Non-existent term
    auto r3 = idx.search("zzzznonexistent");
    ASSERT_TRUE(r3.empty());
}

void test_reset() {
    rr::Indexer idx;
    idx.add(0, "alpha bravo charlie");
    idx.add(1, "delta echo foxtrot");

    ASSERT_EQ(idx.doc_count(), 2);
    ASSERT_TRUE(idx.term_count() > 0);
    ASSERT_TRUE(idx.memory_bytes() > 0);

    idx.reset();

    ASSERT_EQ(idx.doc_count(), 0);
    ASSERT_EQ(idx.term_count(), 0);

    auto results = idx.search("alpha");
    ASSERT_TRUE(results.empty());
}

void test_batch_add() {
    rr::Indexer idx;
    std::vector<std::pair<uint32_t, std::string_view>> batch = {
        {10, "the cat sat on the mat"},
        {20, "the dog chased the cat around the yard"},
        {30, "a bird flew over the mountain"},
    };

    idx.add_batch(batch);
    ASSERT_EQ(idx.doc_count(), 3);

    auto results = idx.search("cat");
    // "cat" appears in doc 10 and doc 20, not 30
    ASSERT_EQ(results.size(), 2);

    bool found_10 = false;
    bool found_20 = false;
    for (auto& r : results) {
        if (r.chunk_id == 10) found_10 = true;
        if (r.chunk_id == 20) found_20 = true;
    }
    ASSERT_TRUE(found_10);
    ASSERT_TRUE(found_20);
}

int main() {
    std::printf("test_indexer\n");
    RUN_TEST(test_basic_index_and_search);
    RUN_TEST(test_bm25_ranking);
    RUN_TEST(test_thread_safety);
    RUN_TEST(test_empty_queries);
    RUN_TEST(test_reset);
    RUN_TEST(test_batch_add);
    std::printf("\n%d passed, %d failed\n", tests_passed, tests_failed);
    return tests_failed > 0 ? 1 : 0;
}
