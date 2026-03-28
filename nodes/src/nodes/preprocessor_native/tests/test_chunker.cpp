#include "chunker.h"

#include <cassert>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>

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

static std::string extract(std::string_view text, const rr::Chunk& c) {
    return std::string(text.substr(c.offset, c.length));
}

void test_empty_input() {
    rr::Chunker chunker;
    auto chunks = chunker.chunk("", 0);
    ASSERT_EQ(chunks.size(), 0);
}

void test_basic_chunking() {
    std::string text =
        "The quick brown fox jumps over the lazy dog. "
        "Pack my box with five dozen liquor jugs. "
        "How vexingly quick daft zebras jump. "
        "The five boxing wizards jump quickly. "
        "Bright vixens jump; dozy fowl quack.";

    rr::ChunkerConfig cfg;
    cfg.mode = rr::SplitMode::icu;
    cfg.target_size = 50;
    cfg.overlap = 0;
    rr::Chunker chunker(cfg);

    auto chunks = chunker.chunk(text, 7);
    ASSERT_TRUE(chunks.size() > 1);

    // Verify doc_id propagated
    for (auto& c : chunks) {
        ASSERT_EQ(c.doc_id, 7);
    }

    // Verify first chunk starts at 0
    ASSERT_EQ(chunks.front().offset, 0);

    // Verify last chunk covers the end of text
    auto& last = chunks.back();
    ASSERT_EQ(last.offset + last.length, static_cast<int32_t>(text.size()));

    // Verify no gaps: with overlap=0, each chunk starts where the previous ended
    for (size_t i = 1; i < chunks.size(); ++i) {
        ASSERT_EQ(chunks[i].offset, chunks[i - 1].offset + chunks[i - 1].length);
    }

    // Verify every chunk extracts valid text
    for (auto& c : chunks) {
        auto s = extract(text, c);
        ASSERT_TRUE(!s.empty());
    }
}

void test_sentence_boundaries() {
    // ICU should not split "U.S.A." at the inner periods
    std::string text = "He visited the U.S.A. last summer. It was a great trip.";

    rr::ChunkerConfig cfg;
    cfg.mode = rr::SplitMode::icu;
    cfg.target_size = 50; // small enough that two sentences would be split
    cfg.overlap = 0;
    rr::Chunker chunker(cfg);

    auto chunks = chunker.chunk(text);
    ASSERT_TRUE(chunks.size() >= 1);

    // The first chunk must contain the full "U.S.A." -- ICU must not split at internal periods
    auto first = extract(text, chunks[0]);
    ASSERT_TRUE(first.find("U.S.A.") != std::string::npos);
}

void test_unicode() {
    // Russian text — multi-byte UTF-8
    std::string russian = "Привет мир. Это тест. Юникод работает.";

    rr::ChunkerConfig cfg;
    cfg.mode = rr::SplitMode::icu;
    cfg.target_size = 15;
    cfg.overlap = 0;
    cfg.locale = "ru_RU";
    rr::Chunker chunker(cfg);

    auto chunks = chunker.chunk(russian);
    ASSERT_TRUE(chunks.size() >= 1);

    // Verify we can extract every chunk and reconstruct without mid-codepoint splits
    for (auto& c : chunks) {
        auto s = extract(russian, c);
        ASSERT_TRUE(!s.empty());
        // Verify the extracted text is valid UTF-8 by round-tripping through std::string
        // A truncated codepoint would produce garbled output
        for (size_t i = 0; i < s.size();) {
            unsigned char byte = static_cast<unsigned char>(s[i]);
            int expected_len = 0;
            if (byte < 0x80)
                expected_len = 1;
            else if ((byte & 0xE0) == 0xC0)
                expected_len = 2;
            else if ((byte & 0xF0) == 0xE0)
                expected_len = 3;
            else if ((byte & 0xF8) == 0xF0)
                expected_len = 4;
            else
                throw std::runtime_error("invalid UTF-8 lead byte");
            ASSERT_TRUE(i + expected_len <= s.size());
            i += expected_len;
        }
    }

    // Chinese text
    std::string chinese = "\xe4\xbb\x8a\xe5\xa4\xa9\xe5\xa4\xa9\xe6\xb0\x94\xe5\xbe\x88\xe5\xa5\xbd\xe3\x80\x82\xe6\x88\x91\xe4\xbb\xac\xe5\x8e\xbb\xe5\x85\xac\xe5\x9b\xad\xe3\x80\x82"; // 今天天气很好。我们去公园。

    rr::ChunkerConfig cfg2;
    cfg2.target_size = 5;
    cfg2.overlap = 0;
    cfg2.locale = "zh_CN";
    rr::Chunker chunker2(cfg2);

    auto chunks2 = chunker2.chunk(chinese);
    ASSERT_TRUE(chunks2.size() >= 1);
    for (auto& c : chunks2) {
        ASSERT_TRUE(c.length > 0);
    }
}

void test_overlap() {
    // Use short sentences so overlap (in chars) can cover at least one full sentence
    std::string text = "Hi there. Go now. Do it. OK then. Be good. Run far. Sit down. Get up.";

    rr::ChunkerConfig cfg;
    cfg.mode = rr::SplitMode::icu;
    cfg.target_size = 20;
    cfg.overlap = 15;
    rr::Chunker chunker(cfg);

    auto chunks = chunker.chunk(text);
    ASSERT_TRUE(chunks.size() >= 2);

    // With overlap, chunk N+1 should start before the end of chunk N
    bool found_overlap = false;
    for (size_t i = 1; i < chunks.size(); ++i) {
        int32_t prev_end = chunks[i - 1].offset + chunks[i - 1].length;
        if (chunks[i].offset < prev_end) {
            found_overlap = true;
        }
    }
    ASSERT_TRUE(found_overlap);
}

void test_batch() {
    std::string text1 = "Hello world. How are you.";
    std::string text2 = "Goodbye world. See you later.";

    rr::ChunkerConfig cfg;
    cfg.mode = rr::SplitMode::icu;
    cfg.target_size = 1000;
    cfg.overlap = 0;
    rr::Chunker chunker(cfg);

    std::vector<std::string_view> texts = {text1, text2};
    auto chunks = chunker.chunk_batch(texts);

    ASSERT_TRUE(chunks.size() >= 2);

    bool has_doc0 = false;
    bool has_doc1 = false;
    for (auto& c : chunks) {
        if (c.doc_id == 0) has_doc0 = true;
        if (c.doc_id == 1) has_doc1 = true;
    }
    ASSERT_TRUE(has_doc0);
    ASSERT_TRUE(has_doc1);
}

int main() {
    std::printf("test_chunker\n");
    RUN_TEST(test_empty_input);
    RUN_TEST(test_basic_chunking);
    RUN_TEST(test_sentence_boundaries);
    RUN_TEST(test_unicode);
    RUN_TEST(test_overlap);
    RUN_TEST(test_batch);
    std::printf("\n%d passed, %d failed\n", tests_passed, tests_failed);
    return tests_failed > 0 ? 1 : 0;
}
