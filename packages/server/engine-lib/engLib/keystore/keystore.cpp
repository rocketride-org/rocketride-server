// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

#include <engLib/eng.h>

namespace engine::keystore {

ErrorOr<Text> KeyStore::getValue(TextView key) noexcept {
    return getValue(PARTITION_DEFAULT, key);
}

Error KeyStore::setValue(TextView key, TextView value) noexcept {
    return setValue(PARTITION_DEFAULT, key, value);
}

ErrorOr<Text> KeyStore::getSecureValue(TextView key) noexcept {
    // Get the value from the storage
    auto encodedValue = getValue(key);
    if (encodedValue.hasCcode()) return encodedValue.ccode();

    // Decode the value
    auto encodedBytes = crypto::base64Decode(*encodedValue);
    if (!encodedBytes) return encodedBytes.ccode();

    // Decrypt the value
    auto decodedBytes = crypto::engineDecrypt(*encodedBytes);
    if (!decodedBytes) return decodedBytes.ccode();

    // Cast the value to text
    return decodedBytes->toTextView();
}

Error KeyStore::setSecureValue(TextView key, TextView value) noexcept {
    // Encrypt the value
    auto encodedBytes = crypto::engineEncrypt(value);
    if (!encodedBytes) return encodedBytes.ccode();

    // Encode the value
    auto encodedValue = crypto::base64Encode(*encodedBytes);

    // Set the value to the storage
    if (auto ccode = setValue(key, encodedValue)) return ccode;

    return {};
}

Error KeyStore::deleteKey(TextView key) noexcept {
    return deleteKey(PARTITION_DEFAULT, key);
}

Error KeyStore::deleteAll() noexcept { return deleteAll(PARTITION_DEFAULT); }

}  // namespace engine::keystore
