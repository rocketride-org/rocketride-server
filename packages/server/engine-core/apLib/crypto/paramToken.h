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

#pragma once

namespace ap::crypto {

// Environment variable holding the deployment secret for parameter tokens
// (the secureParameters.token of a pipeline component). When it is set, new
// tokens are encrypted with a key derived from it.
_const auto ParamTokenSecretEnv = "RR_PARAM_TOKEN_SECRET"_tv;

// A token encrypted with a key derived from the deployment secret starts with
// this header, "RRPT" and the format version, then the key ID and the IV.
// A token in the original format starts with the engine key ID and the IV;
// the first byte of that key ID is not 'R', so no token matches both formats.
_const auto ParamTokenHeader = "RRPT\x02"_tv;

// HKDF-SHA256 info labels that derive the token key and its key ID from the
// deployment secret
_const auto ParamTokenKeyLabel = "rocketride parameter token key v2"_tv;
_const auto ParamTokenKeyIdLabel = "rocketride parameter token key id v2"_tv;

// Length of the key ID derived from the deployment secret
_const size_t ParamTokenKeyIdLength = 16;

// The key a parameter token is encrypted with, and the bytes written ahead of
// the IV: the engine key ID, or the header and the derived key ID
struct ParamTokenKey {
    Key key;
    Buffer prefix;
};

// Read the deployment secret for parameter tokens from the environment
Text paramTokenSecret() noexcept;

// Get the key for parameter tokens. Without a secret this is the engine key
// and the original token format; with one, a key derived from it and the
// versioned token format.
ErrorOr<ParamTokenKey> paramTokenKey(TextView secret) noexcept;

// Whether a token is in the versioned format
bool isVersionedParamToken(InputData token) noexcept;

// Encrypt parameters into a token with the key for the given secret
ErrorOr<Buffer> paramTokenEncrypt(InputData plaintext,
                                  TextView secret) noexcept;

// Decrypt a token in either format. A token in the original format always
// uses the engine key; a versioned token needs the secret it was encrypted
// with.
ErrorOr<Buffer> paramTokenDecrypt(InputData token, TextView secret) noexcept;

// Encrypt parameters with the secret configured for this deployment
inline ErrorOr<Buffer> paramTokenEncrypt(InputData plaintext) noexcept {
    return paramTokenEncrypt(plaintext, paramTokenSecret());
}

// Decrypt a token with the secret configured for this deployment
inline ErrorOr<Buffer> paramTokenDecrypt(InputData token) noexcept {
    return paramTokenDecrypt(token, paramTokenSecret());
}

}  // namespace ap::crypto
