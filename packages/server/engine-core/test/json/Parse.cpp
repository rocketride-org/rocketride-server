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

TEST_CASE("json::parse") {
    SECTION("Vars") {
        auto testStr = R"({
			"vars": { "addr": "&host=10.0.0.81&port=9745" },
			"output": "dataNet://index_rqu/data/index_rqu%addr%"
		})"_tv;

        auto val = json::parse(testStr);
        auto res = val->lookup<Text>("output");

        REQUIRE(res ==
                "dataNet://index_rqu/data/index_rqu&host=10.0.0.81&port=9745");
    }

    SECTION("Envs") {
#if ROCKETRIDE_PLAT_WIN
        // May be running without a login shell
        if (plat::env("HOMEDRIVE")) {
            auto testStr = R"({
				"vars": { "home": "$ENV[HOMEDRIVE,HOMEPATH]" },
				"include": ["%home%"]
			})"_tv;

            auto res =
                json::parse(testStr)->lookup<std::vector<Text>>("include");
            ;
            REQUIRE(res == std::vector{plat::env("HOMEDRIVE") +
                                       plat::env("HOMEPATH")});
        }
#else
        auto testStr = R"({
			"vars": { "home": "$ENV[HOME]" },
			"include": ["%home%"]
		})"_tv;

        auto res = json::parse(testStr)->lookup<std::vector<Text>>("include");
        ;
        REQUIRE(res == std::vector{plat::env("HOME")});
#endif
    }

    SECTION("Envs-Trailing") {
#if ROCKETRIDE_PLAT_WIN
        // May be running without a login shell
        if (plat::env("HOMEDRIVE")) {
            auto testStr = R"({
				"vars": { "home": "$ENV[HOMEDRIVE,HOMEPATH]/bobo" },
				"include": ["%home%"]
			})"_tv;

            auto res =
                json::parse(testStr)->lookup<std::vector<Text>>("include");
            ;
            REQUIRE(res == std::vector<Text>{plat::env("HOMEDRIVE") +
                                             plat::env("HOMEPATH") + "/bobo"});
        }
#else
        auto testStr = R"({
			"vars": { "home": "$ENV[HOME]/bobo" },
			"include": ["%home%"]
		})"_tv;

        auto res = json::parse(testStr)->lookup<std::vector<Text>>("include");
        ;
        REQUIRE(res == std::vector<Text>{plat::env("HOME") + "/bobo"});
#endif
    }

    SECTION("Writers") {
        json::Value doc;

        JSONCPP_STRING sourceStr = R"({
			"arrMultiLine": [
				2, 
				3, 
				{ "object": "inside" }
			],
			"arrSingleLine": [2, 3, 10],
			"boolTrue": true,
			"empty": null,
			"number": 555,
			"object": {
				"emptyArr": [],
				"emptyObj": {},
				"emptyStr": "",
				"inner": "I'm an inner value"
			},
			"real": 2.5,
			"size": "1MB",
			//Comment_before_value
			"text": "Hello World",
			"uintVal": 222
		})";

        REQUIRE(!doc.parse(sourceStr));

        // Include a UInt value
        doc["uintVal"] = json::UInt(222);

        auto cleanSpaces = [](JSONCPP_STRING& str) {
            str.remove("\n", "\r", "\t");
            str.erase(std::remove_if(str.begin(), str.end(),
                                     [skip = false](auto strChar) mutable {
                                         if (strChar == '"') {
                                             skip = !skip;
                                         }

                                         return !skip && strChar == ' ';
                                     }),
                      str.end());
        };

        cleanSpaces(sourceStr);

        // Test FastWriter
        {
            json::FastWriter fastWriter;
            auto fastStr = fastWriter.write(doc);

            // Create src copy and remove comment
            auto srcCpy = sourceStr;

            // FastWriter doesn't collect comments
            REQUIRE_FALSE(fastStr == srcCpy);
            srcCpy.remove("//Comment_before_value");

            // FastWriter appends jump line at the end
            fastStr.remove("\n");
            REQUIRE(fastStr == srcCpy);

            fastWriter.omitEndingLineFeed();
            fastStr = fastWriter.write(doc);
            // We shouldn't need to pop last '\n' now
            REQUIRE(fastStr == srcCpy);
        }

        // Test StyledWriter
        {
            auto styledStr = doc.toStyledString();

            REQUIRE_FALSE(styledStr == sourceStr);
            cleanSpaces(styledStr);
            REQUIRE(styledStr == sourceStr);
        }

        // Test BuiltStyledStreamWriter
        {
            JSONCPP_OSTRINGSTREAM os;
            os << doc;
            auto builtStyledStreamStr = JSONCPP_STRING(os.str());
            REQUIRE_FALSE(builtStyledStreamStr == sourceStr);
            cleanSpaces(builtStyledStreamStr);
            REQUIRE(builtStyledStreamStr == sourceStr);
        }

        // Test StyledStreamWriter
        {
            JSONCPP_OSTRINGSTREAM os;
            json::StyledStreamWriter styledStreamWriter;
            styledStreamWriter.write(os, doc);
            auto styledStreamStr = JSONCPP_STRING(os.str());
            REQUIRE_FALSE(styledStreamStr == sourceStr);
            cleanSpaces(styledStreamStr);
            REQUIRE(styledStreamStr == sourceStr);
        }
    }

    auto testSimpleInput = [](auto readCallback) {
        JSONCPP_ISTRINGSTREAM input{
            R"({
				//This is just a comment
				"text": "Hello World",
				"boolTrue": true,
				"boolFalse": false,
				/*This is just another comment*/
				"number": 88,
				"number2": "0x055",
				"size": "1MB",
				"empty": null
			})"};

        json::Value doc;

        readCallback(doc, input);

        REQUIRE(doc.lookup<Text>("text") == "Hello World");

        REQUIRE(doc.lookup<bool>("boolTrue") == true);

        REQUIRE(doc.lookup<bool>("boolFalse") == false);

        REQUIRE(doc.lookup<uint64_t>("number") == 88);

        REQUIRE(doc.lookup<uint64_t>("number2") == 0x55);

        REQUIRE(doc.lookup<Size>("size") == 1_mb);

        auto emptyItem = doc.get("empty", json::Value(777));

        REQUIRE(emptyItem.isNull());
    };

    SECTION("JSONCPP_ISTRINGSTREAM Read") {
        // Test >> operator to parse document from stringstream

        testSimpleInput([](json::Value& doc, JSONCPP_ISTRINGSTREAM& in) {
            REQUIRE_NOTHROW(in >> doc);
        });

        json::Value doc;

        JSONCPP_ISTRINGSTREAM invalidInput{
            R"({
				"text": "He
			})"};

        REQUIRE_THROWS(invalidInput >> doc);
    }

    SECTION("json::Reader") {
        json::Reader regularReader;
        testSimpleInput(
            [&regularReader](json::Value& doc, JSONCPP_ISTRINGSTREAM& in) {
                REQUIRE(regularReader.parse(in, doc));
                REQUIRE(regularReader.getFormattedErrorMessages().empty());
            });

        json::Reader strictReader(json::Features::strictMode());
        // Check data is read correctly in strict mode
        testSimpleInput(
            [&strictReader](json::Value& doc, JSONCPP_ISTRINGSTREAM& in) {
                REQUIRE(strictReader.parse(in, doc));
                REQUIRE(strictReader.getFormattedErrorMessages().empty());
            });

        // Strict mode requires root
        auto withoutRoot = JSONCPP_STRING(R"(
			//This is a simple comment
			"textItem": "Hello World",
			"numberItem": 9012, /*This is another comment*/
			"emptyItem": null
		)");

        auto withRoot =
            JSONCPP_STRING("{" + withoutRoot + "}\n//Complete object");

        json::Value doc;

        REQUIRE(regularReader.parse(withoutRoot, doc));
        REQUIRE_FALSE(strictReader.parse(withoutRoot, doc));
        REQUIRE_FALSE(strictReader.getFormattedErrorMessages().empty());

        // Test no root error collection
        auto errors = strictReader.getStructuredErrors();
        auto noRootError =
            "A valid JSON document must be either an array or an object value.";

        REQUIRE(std::any_of(errors.begin(), errors.end(),
                            [&noRootError](const auto& error) {
                                return noRootError == error.message;
                            }));

        // Check comments are collected in regular mode
        REQUIRE(regularReader.parse(withRoot, doc));

        auto textItem = doc.get("textItem", json::Value{});

        REQUIRE(textItem.hasComment(json::commentBefore));
        REQUIRE(
            textItem.getComment(json::commentBefore).remove("\n", "\r", "\n") ==
            "//This is a simple comment");

        auto numberItem = doc.get("numberItem", json::Value{});

        REQUIRE(numberItem.hasComment(json::commentAfterOnSameLine));
        REQUIRE(numberItem.getComment(json::commentAfterOnSameLine)
                    .remove("\n", "\r", "\n") == "/*This is another comment*/");

        REQUIRE(doc.hasComment(json::commentAfter));
        REQUIRE(doc.getComment(json::commentAfter).remove("\n", "\r", "\n") ==
                "//Complete object");

        // Check dropped null placeholders error
        withRoot.remove("null");

        auto features = json::Features::all();
        // Enable dropping null placeholders so we can do stuff like { "abc": }
        // instead of { "abc": null }
        features.allowDroppedNullPlaceholders_ = true;
        regularReader = json::Reader(features);

        REQUIRE(regularReader.parse(withRoot, doc));
        REQUIRE_FALSE(strictReader.parse(withRoot, doc));

        // Test no root error collection
        errors = strictReader.getStructuredErrors();
        auto noNullError = "Syntax error: value, object or array expected.";

        REQUIRE_FALSE(errors.empty());
        REQUIRE(errors.size() == 1);
        REQUIRE(errors.back().message == noNullError);
    }

    SECTION("json::CharReaderBuilder") {
        // Test validate works for both default and strict modes
        json::CharReaderBuilder builder;
        json::Value inv;

        REQUIRE(builder.validate(&inv));
        REQUIRE(inv.isNull());

        json::CharReaderBuilder::strictMode(&builder.settings_);

        REQUIRE(builder.validate(&inv));
        REQUIRE(inv.isNull());

        // Reset settings and add random settings, validate should return false
        builder.settings_ = json::Value{};
        builder.settings_["notASetting"] = 99;
        builder.settings_["notASettingNeither"] = "Hello";
        builder.settings_["defNotASetting"] = true;
        REQUIRE_FALSE(builder.validate(&inv));
        REQUIRE(inv.isObject());
        REQUIRE(inv.size() == 3);
    }
}
