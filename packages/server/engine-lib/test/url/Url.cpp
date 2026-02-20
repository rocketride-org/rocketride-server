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

#include "test.h"

TEST_CASE("url::url") {
    SECTION("DataFile") {
        // Relative will assume first comp is symbolic dir path
        auto url = Url{"datafile://control/file.dat"};
        REQUIRE(url.fullpath() == "control/file.dat");
        REQUIRE(url.authority() == "control");
    }

    SECTION("expand") {
        auto url = "datafile://control"_url;
        url = url.expand("control", "bobo");
        REQUIRE(_ts(url) == "datafile://control");
        url = "datafile://control/%Macro%?%Macro%=value"_url;
        url = url.expand("Macro", "Result");
        REQUIRE(_ts(url) == "datafile://control/Result?%Macro%=value");
    }

    SECTION("trailing?") {
        auto url = "datafile://control"_url;
        url = url / "file.dat";
        REQUIRE(_ts(url) == "datafile://control/file.dat");
        url = url.parent();
        REQUIRE(_ts(url) == "datafile://control");
        url = url.setPath("bobo");
        REQUIRE(_ts(url) == "datafile://bobo");
    }

    SECTION("://") {
        SECTION("Protocol with query") {
            auto url = Url{"datafile://john/smith?hi there!"};
            REQUIRE(url.protocol() == "datafile");
            REQUIRE(url.protocol() == "DATAFILE");
            REQUIRE(url.fullpath() == "john/smith");
            REQUIRE(url.queryString() == "hi there!");
        }

        SECTION("Protocol no query") {
            auto url = Url{"datanet://john/smith"};
            REQUIRE(url.protocol() == "datanet");
            REQUIRE(url.protocol() == "DATANET");
            REQUIRE(url.fullpath() == "john/smith");
            REQUIRE(!url.queryString());
        }

        SECTION("Copy") {
            auto url = Url{"datafile://john/smith?hi there!"};
            auto url2 = url;
            REQUIRE(url2.protocol() == "datafile");
            REQUIRE(url2.protocol() == "DATAFILE");
            REQUIRE(url2.fullpath() == "john/smith");
            REQUIRE(url2.queryString() == "hi there!");
            REQUIRE(url.protocol() == "DATAfile");
            REQUIRE(url.fullpath() == "john/smith");
            REQUIRE(url.queryString() == "hi there!");
        }

        SECTION("Move") {
            auto url = Url{"bobo://john/smith?hi there!"};
            auto url2 = _mv(url);
            REQUIRE(url2.protocol() == "bobo");
            REQUIRE(url2.protocol() == "BOBO");
            REQUIRE(url2.fullpath() == "john/smith");
            REQUIRE(url2.queryString() == "hi there!");
        }

        SECTION("encoded tls bobo query") {
            auto url = Url{
                "bobo://localhost.rocketride.com:9545/"
                "pipe.6c499452-root-4553-8eb9-6b26179dd55b.00000000.scan?"
                "bufferSize=10MB&maxIoSize=256KB&secure=true&tlsCaFile=C%3A%"
                "5Ccode%5Crocketride%5Crocketride-app%5Cbuild%5Crocketride%"
                "5Cdebug%5Capp%5Cserver%5Ccertificates%5Clocal-ca.pem&"
                "tlsKeyFile=C%3A%5Ccode%5Crocketride%5Crocketride-app%5Cbuild%"
                "5Crocketride%5Cdebug%5Capp%5Cserver%5Ccertificates%"
                "5Clocalhost-key.pem&tlsCertFile=C%3A%5Ccode%5Crocketride%"
                "5Crocketride-app%5Cbuild%5Crocketride%5Cdebug%5Capp%5Cserver%"
                "5Ccertificates%5Clocalhost-cert.pem"};
            REQUIRE(url.valid());
            REQUIRE(url.lookup("bufferSize") == "10MB");
            REQUIRE(url.lookup("maxIoSize") == "256KB");
            LOG(Test, url.host());
            LOG(Test, url.fullpath());
            REQUIRE(url.host() == "localhost.rocketride.com");
            REQUIRE(url.port() == 9545);

            auto a = url.lookup("tlsKeyFile");
            auto b = url.lookup("tlsCertFile");
            auto c = url.lookup("tlsCaFile");

            REQUIRE(a ==
                    "C:\\code\\rocketride\\rocketride-"
                    "app\\build\\rocketride\\debug\\app\\server\\certificates\\"
                    "localhost-key.pem");
            REQUIRE(b ==
                    "C:\\code\\rocketride\\rocketride-"
                    "app\\build\\rocketride\\debug\\app\\server\\certificates\\"
                    "localhost-cert.pem");
            REQUIRE(c ==
                    "C:\\code\\rocketride\\rocketride-"
                    "app\\build\\rocketride\\debug\\app\\server\\certificates\\"
                    "local-ca.pem");
            auto str = _ts(url);
            REQUIRE(
                str ==
                "bobo://localhost.rocketride.com:9545/"
                "pipe.6c499452-root-4553-8eb9-6b26179dd55b.00000000.scan?"
                "bufferSize=10MB&maxIoSize=256KB&secure=true&tlsCaFile=C%3A%"
                "5Ccode%5Crocketride%5Crocketride-app%5Cbuild%5Crocketride%"
                "5Cdebug%5Capp%5Cserver%5Ccertificates%5Clocal-ca.pem&"
                "tlsKeyFile=C%3A%5Ccode%5Crocketride%5Crocketride-app%5Cbuild%"
                "5Crocketride%5Cdebug%5Capp%5Cserver%5Ccertificates%"
                "5Clocalhost-key.pem&tlsCertFile=C%3A%5Ccode%5Crocketride%"
                "5Crocketride-app%5Cbuild%5Crocketride%5Cdebug%5Capp%5Cserver%"
                "5Ccertificates%5Clocalhost-cert.pem");
        }
    }
    SECTION("://") {
        SECTION("Protocol with query") {
            auto url = Url{"bobo://john/smith?hi there!"};
            REQUIRE(url.protocol() == "bobo");
            REQUIRE(url.protocol() == "BOBO");
            REQUIRE(url.fullpath() == "john/smith");
            REQUIRE(url.queryString() == "hi there!");
        }

        SECTION("Protocol no query") {
            auto url = Url{"bobo://john/smith"};
            REQUIRE(url.protocol() == "bobo");
            REQUIRE(url.protocol() == "BOBO");
            REQUIRE(url.fullpath() == "john/smith");
            REQUIRE(!url.queryString());
        }

        SECTION("Invalid") {
            auto url = Url{"john/smith"};
            REQUIRE(!url.protocol());
            REQUIRE(!url.fullpath());
            REQUIRE(!url.queryString());
            REQUIRE(!url.valid());
            REQUIRE(!url);
        }

        SECTION("Copy") {
            auto url = Url{"bobo://john/smith?hi there!"};
            auto url2 = url;
            REQUIRE(url2.protocol() == "bobo");
            REQUIRE(url2.protocol() == "BOBO");
            REQUIRE(url2.fullpath() == "john/smith");
            REQUIRE(url2.queryString() == "hi there!");
            REQUIRE(url.protocol() == "bobo");
            REQUIRE(url.fullpath() == "john/smith");
            REQUIRE(url.queryString() == "hi there!");
        }

        SECTION("Move") {
            auto url = Url{"bobo://john/smith?hi there!"};
            auto url2 = _mv(url);
            REQUIRE(url2.protocol() == "bobo");
            REQUIRE(url2.protocol() == "BOBO");
            REQUIRE(url2.fullpath() == "john/smith");
            REQUIRE(url2.queryString() == "hi there!");
        }

        SECTION("operator /") {
            auto url = Url{"bobo://john/smith?hi there!"};
            auto url2 = url / "bobo";
            REQUIRE(url2.protocol() == "bobo");
            REQUIRE(url2.protocol() == "BOBO");
            REQUIRE(url2.fullpath() == "john/smith/bobo");
            REQUIRE(url2.queryString() == "hi there!");
        }
    }
}

/// @brief Temp test case for APPLAT-6781
/// @todo Fix APPLAT-6781 and run this test case successfully.
///       Extend the test case with extra sections covering
///       the use cases with special characters.
///       Merge this test case to url::url.
TEST_CASE("url::url/APPLAT-6771", "[.]") {
    SECTION("special characters") {
        SECTION("ctor") {
            auto url = Url{"bobo", "john/smith/?-in-folder-name/?-in-file-name",
                           "key1=value1&key2=value2"};
            REQUIRE(_ts(url) ==
                    "bobo://john/smith/%3F-in-folder-name/"
                    "%3F-in-file-name?key1=value1&key2=value2");
            REQUIRE(url.fullpath() ==
                    "john/smith/?-in-folder-name/?-in-file-name");
            REQUIRE(url.queryString() == "key1=value1&key2=value2");
        }

        SECTION("setPath") {
            auto url =
                Url{"bobo", "john/smith/bobo", "key1=value1&key2=value2"};
            url = url.setPath("john/smith/?-in-folder-name/?-in-file-name");
            REQUIRE(_ts(url) ==
                    "bobo://john/smith/%3F-in-folder-name/"
                    "%3F-in-file-name?key1=value1&key2=value2");
            REQUIRE(url.fullpath() ==
                    "john/smith/?-in-folder-name/?-in-file-name");
            REQUIRE(url.queryString() == "key1=value1&key2=value2");
        }

        SECTION("setFileName") {
            auto url =
                Url{"bobo", "john/smith/bobo", "key1=value1&key2=value2"};
            url = url.setFileName("?-in-file-name");
            REQUIRE(_ts(url) == "bobo://john/smith/%3F-in-file-name");
            REQUIRE(url.fullpath() == "john/smith/?-in-file-name");
            REQUIRE(url.queryString() == "key1=value1&key2=value2");
        }

        SECTION("operator /") {
            auto url = Url{"bobo", "john/smith", "key1=value1&key2=value2"};
            url = url / "?-in-folder-name" / "?-in-file-name";
            REQUIRE(_ts(url) ==
                    "bobo://john/smith/%3F-in-folder-name/"
                    "%3F-in-file-name?key1=value1&key2=value2");
            REQUIRE(url.fullpath() ==
                    "john/smith/?-in-folder-name/?-in-file-name");
            REQUIRE(url.queryString() == "key1=value1&key2=value2");
        }

        SECTION("parent") {
            auto url = Url{"bobo", "john/smith/?-in-folder-name/?-in-file-name",
                           "key1=value1&key2=value2"};
            url = url.parent();
            REQUIRE(
                _ts(url) ==
                "bobo://john/smith/%3F-in-folder-name?key1=value1&key2=value2");
            REQUIRE(url.fullpath() == "john/smith/?-in-folder-name");
            REQUIRE(url.queryString() == "key1=value1&key2=value2");
        }
    }
}
