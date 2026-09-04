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

#include "test.h"

TEST_CASE("crypto::hex/base64 benchmark", "[.]") {
    // A SHA-512 digest is the real per-document payload for the hex paths; a
    // short message stands in for object-store / block ids on the base64 path.
    _const auto Message = "The quick brown fox jumps over the lazy dog."_tv;
    auto digest = crypto::Sha512::make(memory::viewCast<uint8_t>(Message));
    auto digestHex = _ts(digest);  // 128 lowercase hex characters
    auto base64Text = crypto::base64Encode(memory::viewCast<uint8_t>(Message));

    auto hexEncode = [&] {
        auto out = crypto::hexEncode(digest);
        ASSERTD(out.size() == digestHex.size());
    };

    // The previous implementation: string::format once per byte. Kept inline so
    // a single run shows the before/after side by side.
    auto hexEncodeOld = [&] {
        Text out;
        out.reserve(digest.data.size() * 2);
        for (auto byte : digest.data)
            out += string::format("{,X`,2}", _cast<uint8_t>(byte));
        ASSERTD(out.size() == digestHex.size());
    };

    auto hexDecode = [&] {
        auto out = crypto::hexDecode(digestHex);
        ASSERTD(out.size() == crypto::Sha512Hash::DigestLen);
    };

    // The previous implementation: parse each two-character field with _fsh.
    auto hexDecodeOld = [&] {
        Buffer out;
        out.resize(digestHex.length() / 2);
        auto buf = _reCast<uint8_t *>(out.data());
        for (size_t pos = 0; pos < digestHex.length(); pos += 2)
            buf[pos >> 1] = _fsh<uint8_t>(digestHex.substr(pos, 2));
        ASSERTD(out.size() == crypto::Sha512Hash::DigestLen);
    };

    auto hashToString = [&] {
        auto out = _ts(digest);
        ASSERTD(out.size() == crypto::Sha512Hash::DigestLen * 2);
    };

    auto base64Encode = [&] {
        auto out = crypto::base64Encode(memory::viewCast<uint8_t>(Message));
        ASSERTD(out.size() == base64Text.size());
    };

    auto base64Decode = [&] {
        auto out = crypto::base64Decode(base64Text);
        ASSERTD(out);
    };

    // The previous implementation: two linear scans of the 64-character
    // alphabet (find_first_of) per input character.
    auto base64DecodeOld = [&] {
        auto &table = crypto::Base64Table;
        int i = 0;
        unsigned char chr4[4], chr3[3];
        Buffer out;
        TextView input = base64Text;
        while (input && *input != '=' &&
               (table.find_first_of(*input)) != string::npos) {
            chr4[i++] = *input++;
            if (i == 4) {
                for (i = 0; i < 4; i++)
                    chr4[i] = _cast<char>(table.find_first_of(chr4[i]));
                chr3[0] = (chr4[0] << 2) + ((chr4[1] & 0x30) >> 4);
                chr3[1] = ((chr4[1] & 0xf) << 4) + ((chr4[2] & 0x3c) >> 2);
                chr3[2] = ((chr4[2] & 0x3) << 6) + chr4[3];
                for (i = 0; i < 3; i++) out.push_back(chr3[i]);
                i = 0;
            }
        }
        ASSERTD(!out.empty());
    };

    auto bench = [&](std::function<void()> task,
                     size_t bytes) -> util::Throughput::Stats {
        util::Throughput rate;
        rate.start();
        auto start = time::now();
        while (time::now() - start < 10s) {
            task();
            rate.report(bytes);
        }
        rate.stop();
        return rate.stats();
    };

    _const size_t digestBytes = crypto::Sha512Hash::DigestLen;
    auto hexEncodeTask = std::async(std::launch::async, bench, hexEncode,
                                    digestBytes);
    auto hexEncodeOldTask = std::async(std::launch::async, bench, hexEncodeOld,
                                       digestBytes);
    auto hexDecodeTask = std::async(std::launch::async, bench, hexDecode,
                                    digestHex.size());
    auto hexDecodeOldTask = std::async(std::launch::async, bench, hexDecodeOld,
                                       digestHex.size());
    auto hashToStringTask = std::async(std::launch::async, bench, hashToString,
                                       digestBytes);
    auto base64EncodeTask = std::async(std::launch::async, bench, base64Encode,
                                       Message.size());
    auto base64DecodeTask = std::async(std::launch::async, bench, base64Decode,
                                       base64Text.size());
    auto base64DecodeOldTask = std::async(std::launch::async, bench,
                                          base64DecodeOld, base64Text.size());

    hexEncodeTask.wait();

    LOG(Test, "crypto codec bench results:");
    LOG(Test, "   hexEncode (table):        ", hexEncodeTask.get());
    LOG(Test, "   hexEncode (old format):   ", hexEncodeOldTask.get());
    LOG(Test, "   hexDecode (table):        ", hexDecodeTask.get());
    LOG(Test, "   hexDecode (old _fsh):     ", hexDecodeOldTask.get());
    LOG(Test, "   Hash::toString (Sha512):  ", hashToStringTask.get());
    LOG(Test, "   base64Encode:             ", base64EncodeTask.get());
    LOG(Test, "   base64Decode (table):     ", base64DecodeTask.get());
    LOG(Test, "   base64Decode (old scan):  ", base64DecodeOldTask.get());
}
