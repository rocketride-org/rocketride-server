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

TEST_CASE("memory::adapter::InputOutput") {
    _const auto Payload =
        "Your time is limited, so don't waste it living someone else's life. Don't be trapped by dogma which is living with the results of other people's thinking. - Steve Jobs"_tv;

    auto root = testPath();

    auto write = [&](auto &&output) {
        auto adapter = memory::adapter::makeOutput(output);
        adapter.write(Payload);
    };

    auto read = [&](const auto &data) {
        Text result;
        result.resize(Payload.size());
        auto adapter = memory::adapter::makeInput(data);
        auto len = adapter.read(result);
        REQUIRE(len == result.size());
        REQUIRE(result == Payload);
    };

    SECTION("file::FileStream") {
        auto path = root / "out.dat";
        write(file::FileStream{path, file::Mode::WRITE});
        read(file::FileStream{path, file::Mode::READ});
    }

    SECTION("Text") {
        Text data;
        write(data);
        read(data);
    }

    SECTION("std::vector<char>") {
        std::vector<char> data;
        write(data);
        read(data);
    }

    SECTION("copyString") {
        Text source = "Hi my name is John", dest;

        auto in = memory::adapter::makeInput(source);
        auto out = memory::adapter::makeOutput(dest);

        out << in;

        REQUIRE(dest == "Hi my name is John");
    }

    SECTION("backupFile") {
        // open source/target

        // create pipeline
        // <enc> <comp> <hdr> <hash>

        // target << source
    }

    SECTION("copyFile") {
        {
            file::FileStream source(root / "copySource.dat", file::Mode::WRITE);
            for (auto i = 0; i < 10; i++)
                *source.write(string::repeat(_ts(i), 1_mb));
        }

        file::FileStream source(root / "copySource.dat", file::Mode::READ);
        file::FileStream dest(root / "copyTarget.dat", file::Mode::WRITE);

        crypto::Sha512 hasher;

        auto in = memory::adapter::makeInput(source);
        auto out = memory::adapter::makeOutput(dest);

        hasher << in;
        out << in;

        REQUIRE(*source.size() == *dest.size());

        source.close();
        dest.close();

        auto sourceHash = *file::hash<crypto::Sha512>(root / "copySource.dat");
        auto destHash = *file::hash<crypto::Sha512>(root / "copyTarget.dat");
        REQUIRE(sourceHash == destHash);
        REQUIRE(sourceHash == hasher.finalize());
    }
}
