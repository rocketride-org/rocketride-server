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

#include "../store.h"

TEST_CASE("store::hash") {
    //-----------------------------------------------------------------
    // Text section
    //-----------------------------------------------------------------
    SECTION("text") {
        IFilterTest filter({engine::store::filter::hash::Type});

        auto text = "Lorem ipsum"_tv;

        // An expected data by the input text to calculate SHA512:
        //   5441472d5342474e0000000019000000 TAG-SBGN........
        //   01000000080000000000000000000000 ................
        //   000000000000000000               .........
        //   5441472d53444154000000000b000000 TAG-SDAT........
        //   4c6f72656d20697073756d           Lorem ipsum
        //   5441472d53454e440000000000000000 TAG-SEND........
        // An expected hash calculated with an external tool:
        // https://emn178.github.io/online-tools/sha512.html
        auto expectedHash = _fs<crypto::Sha512Hash>(
            "e2e9cdde07e34612b5a6a81aa41e065fbc8ba5c6dbfd637314b9f2349263dc4a30"
            "37bad914f766075e423b5061538adc9650ca25a318c323d9bef4c8940498a4");

        REQUIRE_NO_ERROR(filter.writeTagData("test.txt"_tv, text,
                                             IFilterTest::DefaultFlags));

        const auto &entry = filter.getEntry();

        REQUIRE(entry.componentId);
        REQUIRE(entry.componentId.hash() == expectedHash);
    }

    //-----------------------------------------------------------------
    // Text section
    //-----------------------------------------------------------------
    SECTION("partitioned text") {
        IFilterTest filter({engine::store::filter::hash::Type});

        auto text = {
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit, "_tv,
            "sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. "_tv,
            "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. "_tv,
            "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. "_tv,
            "Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum."_tv,
        };

        // An expected data by the input text to calculate SHA512:
        //   5441472d5342474e0000000019000000 TAG-SBGN........
        //   01000000080000000000000000000000 ................
        //   000000000000000000               .........
        //   5441472d534441540000000039000000 TAG-SDAT....9...
        //   4c6f72656d20697073756d20646f6c6f Lorem ipsum dolo
        //   722073697420616d65742c20636f6e73 r sit amet, cons
        //   65637465747572206164697069736369 ectetur adipisci
        //   6e6720656c69742c20               ng elit,
        //   5441472d534441540000000043000000 TAG-SDAT....C...
        //   73656420646f20656975736d6f642074 sed do eiusmod t
        //   656d706f7220696e6369646964756e74 empor incididunt
        //   207574206c61626f726520657420646f  ut labore et do
        //   6c6f7265206d61676e6120616c697175 lore magna aliqu
        //   612e20                           a.
        //   5441472d53444154000000006c000000 TAG-SDAT....l...
        //   557420656e696d206164206d696e696d Ut enim ad minim
        //   2076656e69616d2c2071756973206e6f  veniam, quis no
        //   73747275642065786572636974617469 strud exercitati
        //   6f6e20756c6c616d636f206c61626f72 on ullamco labor
        //   6973206e69736920757420616c697175 is nisi ut aliqu
        //   697020657820656120636f6d6d6f646f ip ex ea commodo
        //   20636f6e7365717561742e20          consequat.
        //   5441472d534441540000000067000000 TAG-SDAT....g...
        //   44756973206175746520697275726520 Duis aute irure
        //   646f6c6f7220696e2072657072656865 dolor in repreh
        //   6e646572697420696e20766f6c757074 enderit in volu
        //   6174652076656c697420657373652063 ptate velit ess
        //   696c6c756d20646f6c6f726520657520 e cillum dolore
        //   667567696174206e756c6c6120706172  eu fugiat null
        //   69617475722e20                   a pariatur.
        //   5441472d53444154000000006e000000 TAG-SDAT....n...
        //   4578636570746575722073696e74206f Excepteur sint o
        //   63636165636174206375706964617461 ccaecat cupidata
        //   74206e6f6e2070726f6964656e742c20 t non proident,
        //   73756e7420696e2063756c7061207175 sunt in culpa qu
        //   69206f66666963696120646573657275 i officia deseru
        //   6e74206d6f6c6c697420616e696d2069 nt mollit anim i
        //   6420657374206c61626f72756d2e     d est laborum.
        //   5441472d53454e440000000000000000 TAG-SEND........
        // An expected hash calculated with an external tool:
        // https://emn178.github.io/online-tools/sha512.html
        auto expectedHash = _fs<crypto::Sha512Hash>(
            "8ba760cac29cb2b2ce66858ead169174057aa1298ccd581514e6db6dee3285280e"
            "e6e3a54c9319071dc8165ff061d77783100d449c937ff1fb4cd1bb516a69b9");

        REQUIRE_NO_ERROR(filter.writeTagData("test.txt"_tv, text,
                                             IFilterTest::DefaultFlags));

        const auto &entry = filter.getEntry();

        REQUIRE(entry.componentId);
        REQUIRE(entry.componentId.hash() == expectedHash);
    }

    //-----------------------------------------------------------------
    // Text section
    //-----------------------------------------------------------------
    SECTION("partitioned text vs full text") {
        IFilterTest filter({engine::store::filter::hash::Type});

        // APPLAT-4352 SHA-512 Signature Change changes the way of computing
        // hash. now it is computed only from data part but not from tags. So if
        // we send pure data or data split with tags the result should be the
        // same

        auto partText = {
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit, "_tv,
            "sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. "_tv,
            "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. "_tv,
            "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. "_tv,
            "Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum."_tv,
        };

        auto fullText =
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit, "
            "sed do eiusmod tempor incididunt ut labore et dolore magna "
            "aliqua. "
            "Ut enim ad minim veniam, quis nostrud exercitation ullamco "
            "laboris nisi ut aliquip ex ea commodo consequat. "
            "Duis aute irure dolor in reprehenderit in voluptate velit esse "
            "cillum dolore eu fugiat nulla pariatur. "
            "Excepteur sint occaecat cupidatat non proident, sunt in culpa qui "
            "officia deserunt mollit anim id est laborum.";

        const auto &entry = filter.getEntry();

        REQUIRE_NO_ERROR(filter.writeTagData("test.txt"_tv, partText,
                                             IFilterTest::DefaultFlags));
        REQUIRE(entry.componentId);
        auto partTextHash = entry.componentId.hash();

        REQUIRE_NO_ERROR(filter.writeTagData("test.txt"_tv, fullText,
                                             IFilterTest::DefaultFlags));
        REQUIRE(entry.componentId);
        auto fullTextHash = entry.componentId.hash();

        REQUIRE(partTextHash == fullTextHash);
    }

    //-----------------------------------------------------------------
    // Text section
    //-----------------------------------------------------------------
    SECTION("file") {
        IFilterTest filter({engine::store::filter::hash::Type});

        auto file = "ocr.bmp"_tv;

        // An expected data by the input text to calculate SHA512:
        //   5441472d5342474e0000000019000000 TAG-SBGN........
        //   01000000080000000000000000000000 ................
        //   000000000000000000               .........
        //   5441472d534441540000000000000400 TAG-SDAT........
        //   <256k (MAX_IOSIZE) part of file>
        //   5441472d5344415400000000665b0300 TAG-SDAT....f[..
        //   <rest part of file>
        //   5441472d53454e440000000000000000 TAG-SEND........
        // An expected hash calculated with an external tool:
        // https://emn178.github.io/online-tools/sha512_file_hash.html
        auto expectedHash = _fs<crypto::Sha512Hash>(
            "2cef34b4cd0d487008cca7c8b7ab814a11b9cc352503d0c3603860b21c31efc294"
            "8287c8894a6c1ed0549e63835cc0a751f57fc9d4c0f8312c45a846a8e587eb");

        REQUIRE_NO_ERROR(filter.sendFile(file));

        const auto &entry = filter.getEntry();

        REQUIRE(entry.componentId);
        REQUIRE(entry.componentId.hash() == expectedHash);
    }
}
