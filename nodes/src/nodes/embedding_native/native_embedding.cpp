/**
 * Native C++ embedding node using ONNX Runtime.
 *
 * Performs tokenization + inference + mean pooling + L2 normalization
 * entirely in C++ with zero Python overhead.
 *
 * Callable from Python via ctypes for RocketRide node integration.
 *
 * Build:
 *   macOS:  clang++ -std=c++17 -O2 -shared -fPIC native_embedding.cpp -o libnative_embedding.dylib -lonnxruntime
 *   Linux:  g++ -std=c++17 -O2 -shared -fPIC native_embedding.cpp -o libnative_embedding.so -lonnxruntime
 *
 * Requires: ONNX Runtime C API headers + shared library
 */

#include <cstdint>
#include <cstring>
#include <cmath>
#include <cstdlib>
#include <vector>
#include <string>
#include <algorithm>
#include <numeric>

#include <onnxruntime_c_api.h>

// Global state
static const OrtApi* g_ort = nullptr;
static OrtEnv* g_env = nullptr;
static OrtSession* g_session = nullptr;
static OrtSessionOptions* g_session_options = nullptr;
static OrtMemoryInfo* g_memory_info = nullptr;
static int32_t g_embedding_dim = 0;
static bool g_initialized = false;

// Simple WordPiece tokenizer state
static std::vector<std::string> g_vocab;
static std::unordered_map<std::string, int32_t> g_vocab_map;
static int32_t g_cls_id = 101;  // [CLS]
static int32_t g_sep_id = 102;  // [SEP]
static int32_t g_unk_id = 100;  // [UNK]
static int32_t g_pad_id = 0;    // [PAD]
static int32_t g_max_length = 128;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
static void load_vocab(const char* vocab_path) {
    g_vocab.clear();
    g_vocab_map.clear();

    FILE* f = fopen(vocab_path, "r");
    if (!f) return;

    char line[4096];
    int32_t idx = 0;
    while (fgets(line, sizeof(line), f)) {
        // Strip newline
        size_t len = strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r'))
            line[--len] = '\0';
        std::string word(line, len);
        g_vocab.push_back(word);
        g_vocab_map[word] = idx++;
    }
    fclose(f);

    // Cache special token IDs
    auto find_id = [](const char* token, int32_t default_id) -> int32_t {
        auto it = g_vocab_map.find(token);
        return (it != g_vocab_map.end()) ? it->second : default_id;
    };
    g_cls_id = find_id("[CLS]", 101);
    g_sep_id = find_id("[SEP]", 102);
    g_unk_id = find_id("[UNK]", 100);
    g_pad_id = find_id("[PAD]", 0);
}

static std::vector<int32_t> wordpiece_tokenize(const char* text, int32_t text_len) {
    std::vector<int32_t> tokens;
    tokens.push_back(g_cls_id);

    // Simple lowercase + split on whitespace + WordPiece
    std::string input(text, text_len);

    // Lowercase
    for (auto& c : input) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));

    // Split on whitespace/punctuation
    std::vector<std::string> words;
    std::string current;
    for (char c : input) {
        if (std::isspace(static_cast<unsigned char>(c)) ||
            std::ispunct(static_cast<unsigned char>(c))) {
            if (!current.empty()) {
                words.push_back(current);
                current.clear();
            }
            if (std::ispunct(static_cast<unsigned char>(c))) {
                words.push_back(std::string(1, c));
            }
        } else {
            current += c;
        }
    }
    if (!current.empty()) words.push_back(current);

    // WordPiece each word
    for (const auto& word : words) {
        if (tokens.size() >= static_cast<size_t>(g_max_length - 1)) break;

        // Try full word first
        auto it = g_vocab_map.find(word);
        if (it != g_vocab_map.end()) {
            tokens.push_back(it->second);
            continue;
        }

        // WordPiece subword tokenization
        size_t start = 0;
        bool found_all = true;
        while (start < word.size()) {
            size_t end = word.size();
            bool found = false;
            while (start < end) {
                std::string substr;
                if (start > 0)
                    substr = "##" + word.substr(start, end - start);
                else
                    substr = word.substr(start, end - start);

                auto it2 = g_vocab_map.find(substr);
                if (it2 != g_vocab_map.end()) {
                    tokens.push_back(it2->second);
                    start = end;
                    found = true;
                    break;
                }
                end--;
            }
            if (!found) {
                tokens.push_back(g_unk_id);
                found_all = false;
                break;
            }
        }
    }

    // Truncate to max_length - 1 (for [SEP])
    if (tokens.size() > static_cast<size_t>(g_max_length - 1))
        tokens.resize(g_max_length - 1);

    tokens.push_back(g_sep_id);
    return tokens;
}

// ---------------------------------------------------------------------------
// ONNX Runtime Embedding
// ---------------------------------------------------------------------------
extern "C" {

/**
 * Initialize the embedding engine.
 * model_path: path to .onnx model file
 * vocab_path: path to vocab.txt file
 * embedding_dim: output embedding dimension (e.g. 384 for MiniLM)
 * max_length: max token sequence length
 * num_threads: intra-op parallelism (0 = default)
 * Returns: 0 on success, -1 on error.
 */
int32_t embedding_init(
    const char* model_path,
    const char* vocab_path,
    int32_t embedding_dim,
    int32_t max_length,
    int32_t num_threads
) {
    if (g_initialized) return 0;

    g_ort = OrtGetApiBase()->GetApi(ORT_API_VERSION);
    if (!g_ort) return -1;

    g_embedding_dim = embedding_dim;
    g_max_length = max_length > 0 ? max_length : 128;

    // Load vocab
    load_vocab(vocab_path);
    if (g_vocab.empty()) return -1;

    // Create environment
    if (g_ort->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "embedding", &g_env) != nullptr)
        return -1;

    // Create session options
    if (g_ort->CreateSessionOptions(&g_session_options) != nullptr)
        return -1;

    if (num_threads > 0)
        g_ort->SetIntraOpNumThreads(g_session_options, num_threads);

    g_ort->SetSessionGraphOptimizationLevel(g_session_options, ORT_ENABLE_ALL);

    // Enable memory mapping for faster cold start
    g_ort->AddSessionConfigEntry(g_session_options,
        "session.use_env_allocators", "1");

    // Create session
    if (g_ort->CreateSession(g_env, model_path, g_session_options, &g_session) != nullptr)
        return -1;

    // Create memory info
    if (g_ort->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &g_memory_info) != nullptr)
        return -1;

    g_initialized = true;
    return 0;
}

/**
 * Embed a batch of texts.
 * texts: array of text pointers
 * text_lens: array of text lengths
 * n_texts: number of texts
 * output: pre-allocated float array of size n_texts * embedding_dim
 * Returns: number of embeddings computed, or -1 on error.
 */
int32_t embedding_batch(
    const char** texts,
    const int32_t* text_lens,
    int32_t n_texts,
    float* output
) {
    if (!g_initialized || !texts || !text_lens || n_texts <= 0 || !output)
        return -1;

    // Tokenize all texts
    int32_t batch_max_len = 0;
    std::vector<std::vector<int32_t>> all_tokens;
    all_tokens.reserve(n_texts);

    for (int32_t i = 0; i < n_texts; i++) {
        auto tokens = wordpiece_tokenize(texts[i], text_lens[i]);
        if (static_cast<int32_t>(tokens.size()) > batch_max_len)
            batch_max_len = static_cast<int32_t>(tokens.size());
        all_tokens.push_back(std::move(tokens));
    }

    // Pad and create input tensors
    std::vector<int64_t> input_ids(n_texts * batch_max_len, g_pad_id);
    std::vector<int64_t> attention_mask(n_texts * batch_max_len, 0);
    std::vector<int64_t> token_type_ids(n_texts * batch_max_len, 0);

    for (int32_t i = 0; i < n_texts; i++) {
        for (size_t j = 0; j < all_tokens[i].size(); j++) {
            input_ids[i * batch_max_len + j] = all_tokens[i][j];
            attention_mask[i * batch_max_len + j] = 1;
        }
    }

    // Create ORT tensors
    int64_t input_shape[2] = {n_texts, batch_max_len};

    OrtValue* input_ids_tensor = nullptr;
    OrtValue* attention_mask_tensor = nullptr;
    OrtValue* token_type_ids_tensor = nullptr;

    g_ort->CreateTensorWithDataAsOrtValue(
        g_memory_info, input_ids.data(), input_ids.size() * sizeof(int64_t),
        input_shape, 2, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, &input_ids_tensor);

    g_ort->CreateTensorWithDataAsOrtValue(
        g_memory_info, attention_mask.data(), attention_mask.size() * sizeof(int64_t),
        input_shape, 2, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, &attention_mask_tensor);

    g_ort->CreateTensorWithDataAsOrtValue(
        g_memory_info, token_type_ids.data(), token_type_ids.size() * sizeof(int64_t),
        input_shape, 2, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, &token_type_ids_tensor);

    // Run inference
    const char* input_names[] = {"input_ids", "attention_mask", "token_type_ids"};
    const char* output_names[] = {"last_hidden_state"};
    OrtValue* input_tensors[] = {input_ids_tensor, attention_mask_tensor, token_type_ids_tensor};
    OrtValue* output_tensor = nullptr;

    OrtStatus* status = g_ort->Run(
        g_session, nullptr,
        input_names, (const OrtValue* const*)input_tensors, 3,
        output_names, 1, &output_tensor);

    if (status != nullptr) {
        g_ort->ReleaseStatus(status);
        g_ort->ReleaseValue(input_ids_tensor);
        g_ort->ReleaseValue(attention_mask_tensor);
        g_ort->ReleaseValue(token_type_ids_tensor);
        return -1;
    }

    // Get output data (shape: [batch, seq_len, hidden_dim])
    float* hidden_states = nullptr;
    g_ort->GetTensorMutableData(output_tensor, (void**)&hidden_states);

    // Mean pooling with attention mask (CRITICAL: must mask padding!)
    for (int32_t i = 0; i < n_texts; i++) {
        float* emb = output + i * g_embedding_dim;
        std::fill(emb, emb + g_embedding_dim, 0.0f);
        float mask_sum = 0.0f;

        for (int32_t j = 0; j < batch_max_len; j++) {
            float mask_val = static_cast<float>(attention_mask[i * batch_max_len + j]);
            if (mask_val > 0.0f) {
                const float* hidden = hidden_states +
                    (i * batch_max_len + j) * g_embedding_dim;
                for (int32_t k = 0; k < g_embedding_dim; k++) {
                    emb[k] += hidden[k] * mask_val;
                }
                mask_sum += mask_val;
            }
        }

        // Average
        if (mask_sum > 0.0f) {
            for (int32_t k = 0; k < g_embedding_dim; k++) {
                emb[k] /= mask_sum;
            }
        }

        // L2 normalize (epsilon = 1e-12 to match PyTorch)
        float norm = 0.0f;
        for (int32_t k = 0; k < g_embedding_dim; k++) {
            norm += emb[k] * emb[k];
        }
        norm = std::sqrt(norm + 1e-12f);
        for (int32_t k = 0; k < g_embedding_dim; k++) {
            emb[k] /= norm;
        }
    }

    // Cleanup
    g_ort->ReleaseValue(output_tensor);
    g_ort->ReleaseValue(input_ids_tensor);
    g_ort->ReleaseValue(attention_mask_tensor);
    g_ort->ReleaseValue(token_type_ids_tensor);

    return n_texts;
}

/**
 * Get the embedding dimension.
 */
int32_t embedding_dim() {
    return g_embedding_dim;
}

/**
 * Cleanup and release all resources.
 */
void embedding_cleanup() {
    if (g_session) { g_ort->ReleaseSession(g_session); g_session = nullptr; }
    if (g_session_options) { g_ort->ReleaseSessionOptions(g_session_options); g_session_options = nullptr; }
    if (g_memory_info) { g_ort->ReleaseMemoryInfo(g_memory_info); g_memory_info = nullptr; }
    if (g_env) { g_ort->ReleaseEnv(g_env); g_env = nullptr; }
    g_initialized = false;
}

} // extern "C"
