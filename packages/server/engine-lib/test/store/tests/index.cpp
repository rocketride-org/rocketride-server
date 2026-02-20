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

namespace {
auto indexConfig = R"(
		{
			"config": {
				"index": {
					"compress": true,
					"maxWordCount": 250000000,
					"batchId": 1,
					"indexOutput": "datafile://data/output-words-%BatchId%.dat"
				}
			}
		}
	)"_json;
}

TEST_CASE("store::index") {
    // Creates a small subset of words
    SECTION("write a few words") {
        IFilterTest filter({engine::store::filter::indexer::Type}, indexConfig);
        Error ccode;

        // Build and connect the endpoint
        REQUIRE_NO_ERROR(filter.connect());

        // Get a source pipe, open a dummy object on it
        auto pipe = filter.openObject("test.txt"_tv, Entry::FLAGS::INDEX);
        REQUIRE_NO_ERROR(pipe);

        WordVector words{"word1"_tv, "word2"_tv, "word4"_tv};

        REQUIRE_NO_ERROR(pipe->writeWords(words));

        REQUIRE_NO_ERROR(filter.closeObject(*pipe));
    }

    // Adds a huge number of unique words
    SECTION("write lots of words") {
        IFilterTest filter({engine::store::filter::indexer::Type}, indexConfig);
        Error ccode;

        // Build and connect the endpoint
        REQUIRE_NO_ERROR(filter.connect());

        // Get a source pipe, open a dummy object on it
        auto pipe = filter.openObject("test.txt"_tv, Entry::FLAGS::INDEX);
        REQUIRE_NO_ERROR(pipe);

        // Write out 1,000,000 words - non-duplicated
        _const int totalWords = 1'000'000;
        _const int numberOfWordsGroups = 10;
        _const int numberOfWordsInGroup = totalWords / numberOfWordsGroups;
        for (int groupId = 0; groupId < numberOfWordsGroups; groupId++) {
            WordVector words;

            LOG(Test, "Group {}", groupId);

            // Add in groups
            for (int wordId = 0; wordId < numberOfWordsInGroup; wordId++) {
                // Create the word
                Text word =
                    string::format("this.is.a.longer.phrase.{}",
                                   groupId * numberOfWordsInGroup + wordId);

                // Save it in the text list - we need to do this
                // since the writeWords takes a view
                words.push_back(_mv(word));
            }

            REQUIRE_NO_ERROR(pipe->writeWords(words));
        }

        // Close the object
        REQUIRE_NO_ERROR(filter.closeObject(*pipe));
    }
}
