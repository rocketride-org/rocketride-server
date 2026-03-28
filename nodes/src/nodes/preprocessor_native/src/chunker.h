#pragma once
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace rr {

enum class SplitMode {
    icu,        // ICU BreakIterator — correct Unicode sentence detection
    fast,       // Manual scan for .!? + whitespace — sentence-based
    recursive,  // Recursive character splitter — matches LangChain's algorithm
};

struct Chunk {
    int32_t doc_id;
    int32_t offset; // byte offset in original text
    int32_t length; // byte length
};

struct ChunkerConfig {
    int32_t target_size = 512;      // target chunk size in characters
    int32_t overlap = 50;           // overlap in characters
    std::string locale = "en_US";   // ICU locale (only used in icu mode)
    SplitMode mode = SplitMode::recursive; // default matches LangChain's algorithm
};

class Chunker {
public:
    explicit Chunker(ChunkerConfig config = {});
    ~Chunker();

    std::vector<Chunk> chunk(std::string_view text, int32_t doc_id = 0) const;
    std::vector<Chunk> chunk_batch(const std::vector<std::string_view>& texts) const;

private:
    ChunkerConfig config_;
    std::vector<int32_t> sentence_boundaries_icu(std::string_view text) const;
    std::vector<int32_t> sentence_boundaries_fast(std::string_view text) const;
    std::vector<Chunk> chunk_recursive(std::string_view text, int32_t doc_id) const;
};

} // namespace rr
