// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

#include <apLib/ap.h>

namespace ap::crypto {

// Track global init calls, only one call is allowed
static auto g_cryptoInitialized = false;

// Initialize the ciphers
void init() noexcept {
    std::string str;
    ASSERT(g_cryptoInitialized == false);
    ERR_load_crypto_strings();
    OpenSSL_add_all_algorithms();
    g_cryptoInitialized = true;
}

// Deinitialize the ciphers
void deinit() noexcept {
    if (!_exch(g_cryptoInitialized, false)) return;

    ERR_free_strings();
    EVP_cleanup();
    CONF_modules_free();
}

// Render last OpenSSL error
Text lastError() noexcept {
    auto error = ERR_get_error();
    if (!error) return "Unknown OpenSSL error"_tv;

    // Allocate 1kb buffer and set initial character to the null character so we
    // can tell if it's written to
    Text errorStr;
    errorStr.resize(1_kb);
    errorStr[0] = '\0';

    // Use ERR_error_string_n; ERR_error_string is not thread-safe
    ERR_error_string_n(error, errorStr.data(), errorStr.length());

    // If nothing was written, return a generic error that includes the error
    // code
    auto length = std::strlen(errorStr);
    if (!length) return _fmt("Unknown OpenSSL error ({})", error);

    // Adjust the buffer length
    errorStr.resize(length);
    return errorStr;
}

ImmutableKeyId immutableKeyId(InputData key) noexcept {
    // Use the SHA3-224 hash of the key as the immutable key ID
    ASSERT(key);
    return Sha224::make(key);
}

// The default path to the CA file on Unix systems
file::Path commonCertPath() noexcept {
    return application::execDir() / "cacert.pem";
}

// Get the cipher, key, and embedded key ID used by the engine to encrypt user
// data
const Cipher &engineCipher() noexcept {
    static const Cipher cipher(EngineCipherName);
    return cipher;
}

const Key &engineKey() noexcept {
    static const Key engineKey(engineCipher(), EngineKey);
    return engineKey;
}

InputData engineKeyId() noexcept {
    static const auto engineKeyId = hexDecode(EngineKeyId);
    return engineKeyId;
}

}  // namespace ap::crypto
