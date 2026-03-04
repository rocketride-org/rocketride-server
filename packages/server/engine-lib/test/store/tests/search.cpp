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

#include "../store.h"

namespace {
// Write out 10,000 words - non-duplicated
_const int searchTotalWords = 1'000;
_const int searchNumberOfWordsGroups = 10;
_const int searchNumberOfWordsInGroup =
    searchTotalWords / searchNumberOfWordsGroups;
std::vector<std::tuple<Text, Text, Text>> emptyValues = {};
Text wordNotExist1;
Text wordNotExist2;
Text wordNotExist3;
std::vector<Text> words;

auto searchConfigStandard = R"(
        {
            "type": "searchBatch",
            "config": {
                "searchId": "SEARCH::fa6b215c-57f9-47ea-adfd-08d0d90ccf3f",
                "opCodes": [{
                        "opCode": "engine.load",
                        "params": {},
                        "comment": ""
                    }, {
                        "opCode": "engine.any",
                        "params": {
                            "words": ["rocketlib"],
                            "expr": [{
                                    "type": "STRING",
                                    "value": "rocketlib"
                                }
                            ]
                        },
                        "comment": ""
                    }, {
                        "opCode": "engine.done",
                        "params": {},
                        "comment": ""
                    }
                ],
                "objectLimit": 9999999,
                "wantsContext": true,
                "contextWords": 10,
                "contextCount": 5,
                "indexInput": "datafile://data/output-words-1.dat"
            }
        }
    )"_json;

auto searchConfigTemplate = R"(
        {
            "type": "searchBatch",
            "config": {
                "searchId": "SEARCH::fa6b215c-57f9-47ea-adfd-08d0d90ccf3f",
                "opCodes": [{
                        "opCode": "engine.load",
                        "params": {},
                        "comment": ""
                    }, {
                        "opCode": "engine.any",
                        "params": {
                            "words": [],
                            "expr": [{
                                    "type": "STRING",
                                    "value": "rocketlib"
                                }
                            ]
                        },
                        "comment": ""
                    }, {
                        "opCode": "engine.done",
                        "params": {},
                        "comment": ""
                    }
                ],
                "objectLimit": 9999999,
                "wantsContext": true,
                "contextWords": 10,
                "contextCount": 5,
                "indexInput": "datafile://data/output-words-1.dat"
            }
        }
    )"_json;

auto searchConfigNegativeTemplate = R"(
        {
            "type": "searchBatch",
            "config": {
                "searchId": "SEARCH::fa6b215c-57f9-47ea-adfd-08d0d90ccf3f",
                "opCodes": [{
                        "opCode": "engine.load",
                        "params": {},
                        "comment": ""
                    }, {
                        "opCode": "engine.any",
                        "params": {
                            "words": [],
                            "expr": [{
                                    "type": "STRING",
                                    "value": "rocketlib"
                                }
                            ]
                        },
                        "comment": ""
                    }, {
                        "opCode": "engine.not",
                        "params": {},
                        "comment": ""
                    }, {
                        "opCode": "engine.done",
                        "params": {},
                        "comment": ""
                    }
                ],
                "objectLimit": 9999999,
                "wantsContext": true,
                "contextWords": 10,
                "contextCount": 5,
                "indexInput": "datafile://data/output-words-1.dat"
            }
        }
    )"_json;

inline Text getExistentWord(int id) { return string::format("word{}", id); }

inline Text getNotExistentWord(int id) {
    return string::format("notWord{}", id);
}
inline Text calculateContext(int startingIndex, int count) {
    Text result = {};
    for (int index = 0; index < count; ++index) {
        if (!result.empty()) result += " ";
        result += getExistentWord(startingIndex + index);
    }
    return result;
}
inline bool documentExist(Text& docId) { return !!docId; }
inline bool documentNotExist(Text& docId) { return !docId; }
void initWords() {
    // Init words
    wordNotExist1 = getNotExistentWord(1);
    wordNotExist2 = getNotExistentWord(2);
    wordNotExist3 = getNotExistentWord(3);
    if (words.size() != searchTotalWords) {
        words.reserve(searchTotalWords);
        for (int i = 0; i < searchTotalWords; ++i)
            words.emplace_back(getExistentWord(i));
    }
}

void testSearch3Words(
    json::Value configVariable, TextView searchType, TextView word1,
    TextView word2, TextView word3, std::function<bool(Text&)> condition,
    const std::vector<std::tuple<Text, Text, Text>>& expectedValuesVector) {
    auto config = configVariable;
    /* prepare config */
    config["config"]["opCodes"][1]["opCode"] = searchType;
    config["config"]["opCodes"][1]["params"]["words"][0] = word1;
    config["config"]["opCodes"][1]["params"]["words"][1] = word2;
    config["config"]["opCodes"][1]["params"]["words"][2] = word3;
    /* create search task */
    file::Path path;
    auto job = Factory::make<engine::task::ITask>(_location, path, config);
    REQUIRE_NO_ERROR(job);
    /* execute task */
    auto executionResult = job->execute();
    REQUIRE_NO_ERROR(executionResult);
    /* get monitor */
    auto searchResult = ::engine::config::monitor()->info();

    LOG(Test, "Result is: {}", _ts(searchResult));

    auto docHash = searchResult.lookup<Text>("docHash");
    REQUIRE(condition(docHash));

    if (docHash && condition(docHash)) {
        auto context = searchResult.lookup<json::Value>("context");
        LOG(Test, "Context is: {}", context);
        REQUIRE(expectedValuesVector.size() == context.size());
        for (int index = 0; index < expectedValuesVector.size(); ++index) {
            const auto& expectedValues = expectedValuesVector[index];
            const auto& expectedLeading = std::get<0>(expectedValues);
            const auto& expectedMatch = std::get<1>(expectedValues);
            const auto& expectedTrailing = std::get<2>(expectedValues);
            Text actualLeading = context[index][0].asString();
            Text actualMatch = context[index][1].asString();
            Text actualTrailing = context[index][2].asString();
            REQUIRE(expectedLeading == actualLeading);
            REQUIRE(expectedMatch == actualMatch);
            REQUIRE(expectedTrailing == actualTrailing);
        }
    }
}
}  // namespace

#define TEST_SEARCH_EXECUTE_JOB_AND_COMPARE_CONTEXT(condition)              \
    /* create search task */                                                \
    file::Path path;                                                        \
    auto job = Factory::make<engine::task::ITask>(_location, path, config); \
    REQUIRE_NO_ERROR(job);                                                  \
    /* execute task */                                                      \
    auto executionResult = job->execute();                                  \
    REQUIRE_NO_ERROR(executionResult);                                      \
    /* get monitor */                                                       \
    auto searchResult = ::engine::config::monitor()->info();                \
    LOG(Test, "Result is: {}", _ts(searchResult));                          \
    auto docHash = searchResult.lookup<Text>("docHash");                    \
    REQUIRE(condition);                                                     \
    if (docHash && (condition)) {                                           \
        auto context = searchResult.lookup<json::Value>("context");         \
        LOG(Test, "Context is: {}", context);                               \
        REQUIRE(expectedValuesVector.size() == context.size());             \
        for (int index = 0; index < expectedValuesVector.size(); ++index) { \
            const auto& expectedValues = expectedValuesVector[index];       \
            const Text& expectedLeading = std::get<0>(expectedValues);      \
            const Text& expectedMatch = std::get<1>(expectedValues);        \
            const Text& expectedTrailing = std::get<2>(expectedValues);     \
            Text actualLeading = context[index][0].asString();              \
            Text actualMatch = context[index][1].asString();                \
            Text actualTrailing = context[index][2].asString();             \
            REQUIRE(expectedLeading == actualLeading);                      \
            REQUIRE(expectedMatch == actualMatch);                          \
            REQUIRE(expectedTrailing == actualTrailing);                    \
        }                                                                   \
    }

#define TEST_SEARCH_1_WORD(configVariable, searchType, word1, condition, \
                           expectedValuesVectorParam)                    \
    {                                                                    \
        auto config = configVariable;                                    \
        auto expectedValuesVector = expectedValuesVectorParam;           \
        /* prepare config */                                             \
        config["config"]["opCodes"][1]["opCode"] = searchType;           \
        config["config"]["opCodes"][1]["params"]["words"][0] = word1;    \
        TEST_SEARCH_EXECUTE_JOB_AND_COMPARE_CONTEXT(condition);          \
    }

#define TEST_SEARCH_2_WORDS(configVariable, searchType, word1, word2, \
                            condition, expectedValuesVectorParam)     \
    {                                                                 \
        auto config = configVariable;                                 \
        auto expectedValuesVector = expectedValuesVectorParam;        \
        /* prepare config */                                          \
        config["config"]["opCodes"][1]["opCode"] = searchType;        \
        config["config"]["opCodes"][1]["params"]["words"][0] = word1; \
        config["config"]["opCodes"][1]["params"]["words"][1] = word2; \
        TEST_SEARCH_EXECUTE_JOB_AND_COMPARE_CONTEXT(condition);       \
    }

#define TEST_SEARCH_3_WORDS(configVariable, searchType, word1, word2, word3, \
                            condition, expectedValuesVectorParam)            \
    {                                                                        \
        auto config = configVariable;                                        \
        auto expectedValuesVector = expectedValuesVectorParam;               \
        /* prepare config */                                                 \
        config["config"]["opCodes"][1]["opCode"] = searchType;               \
        config["config"]["opCodes"][1]["params"]["words"][0] = word1;        \
        config["config"]["opCodes"][1]["params"]["words"][1] = word2;        \
        config["config"]["opCodes"][1]["params"]["words"][2] = word3;        \
        TEST_SEARCH_EXECUTE_JOB_AND_COMPARE_CONTEXT(condition);              \
    }

TEST_CASE("store::search::prepare", "[.]") {
    initWords();
    auto logScope = enableTestLogging(Lvl::Search);

    // Prepare words for search
    SECTION("prepare dictionary for search") {
        IFilterTest filter({engine::store::filter::indexer::Type}, indexConfig);
        Error ccode;

        // Build and connect the endpoint
        REQUIRE_NO_ERROR(filter.connect());

        // Get a source pipe, open a dummy object on it
        auto pipe = filter.openObject("test.txt"_tv, Entry::FLAGS::INDEX);
        REQUIRE_NO_ERROR(pipe);

        for (int groupId = 0; groupId < searchNumberOfWordsGroups; groupId++) {
            Text text;

            LOG(Test, "Group {}", groupId);

            // Add in groups
            for (int wordId = 0; wordId < searchNumberOfWordsInGroup;
                 wordId++) {
                // Create the word
                Text word = getExistentWord(
                    groupId * searchNumberOfWordsInGroup + wordId);

                text.append(word).append(" ");
            }

            REQUIRE_NO_ERROR(pipe->writeText(_tr<Utf16>(text)));
        }

        // Close the object
        REQUIRE_NO_ERROR(filter.closeObject(*pipe));
    }
};

TEST_CASE("store::search::general", "[.]") {
    initWords();
    auto logScope = enableTestLogging(Lvl::Search);

    // Lookup each of the written words
    SECTION("search each of written words") {
        // Search for each from 10,000 words
        for (int groupId = 0; groupId < searchNumberOfWordsGroups; groupId++) {
            for (int wordId = 0; wordId < searchNumberOfWordsInGroup;
                 wordId++) {
                // Create the word
                Text word = getExistentWord(
                    groupId * searchNumberOfWordsInGroup + wordId);

                // prepare config
                searchConfigStandard["config"]["opCodes"][1]["params"]["words"]
                                    [0] = word;
                searchConfigStandard["config"]["opCodes"][1]["params"]["expr"]
                                    [0]["value"] = word;

                // create search task
                file::Path path;
                auto job = Factory::make<engine::task::ITask>(
                    _location, path, searchConfigStandard);
                REQUIRE_NO_ERROR(job);

                // execute
                auto executionResult = job->execute();
                REQUIRE_NO_ERROR(executionResult);

                // get monitor
                auto searchResult = ::engine::config::monitor()->info();
                auto docHash = searchResult.lookup<Text>("docHash");
                REQUIRE(docHash);
            }
        }
    }

    // Lookup non-existent word
    SECTION("search non-existent word") {
        // Create the word
        Text word = getNotExistentWord(1);

        // prepare config
        searchConfigStandard["config"]["opCodes"][1]["params"]["words"][0] =
            word;
        searchConfigStandard["config"]["opCodes"][1]["params"]["expr"][0]
                            ["value"] = word;

        // create search task
        file::Path path;
        auto job = Factory::make<engine::task::ITask>(_location, path,
                                                      searchConfigStandard);
        REQUIRE_NO_ERROR(job);

        // execute
        auto executionResult = job->execute();
        REQUIRE_NO_ERROR(executionResult);

        // get monitor
        auto searchResult = ::engine::config::monitor()->info();
        auto docHash = searchResult.lookup<Text>("docHash");
        REQUIRE(!docHash);
    }
};

TEST_CASE("store::search::any", "[.]") {
    initWords();
    auto logScope = enableTestLogging(Lvl::Search);

    // Lookup any word from words
    SECTION("search any of these words") {
        // 1 word scenario
        TEST_SEARCH_1_WORD(searchConfigTemplate, "engine.any", wordNotExist1,
                           !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigTemplate, "engine.any", words[1],
                           docHash,
                           (std::vector{std::make_tuple<Text, Text, Text>(
                               calculateContext(0, 1), calculateContext(1, 1),
                               calculateContext(2, 10))}));

        // 3 words scenario
        // case 1: no words
        // testSearch3Words(searchConfigTemplate, "engine.any", wordNotExist1,
        // wordNotExist2, wordNotExist3, documentNotExist, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.any", wordNotExist1,
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);

        // case 2: exists just one word
        // testSearch3Words(searchConfigTemplate, "engine.any", words[1],
        // wordNotExist2, wordNotExist3, documentExist,
        //    (std::vector{ std::make_tuple<Text, Text,
        //    Text>(calculateContext(0, 1), calculateContext(1, 1),
        //    calculateContext(2, 10)) }));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", words[100], wordNotExist2,
            wordNotExist3, docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(100 - 10, 10), calculateContext(100, 1),
                calculateContext(100 + 1, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", wordNotExist1, words[100],
            wordNotExist3, docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(100 - 10, 10), calculateContext(100, 1),
                calculateContext(100 + 1, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", wordNotExist1, wordNotExist2,
            words[100], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(100 - 10, 10), calculateContext(100, 1),
                calculateContext(100 + 1, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.any", words[0],
                            wordNotExist2, wordNotExist3, docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 1),
                                calculateContext(0 + 1, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.any", wordNotExist1,
                            words[0], wordNotExist3, docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 1),
                                calculateContext(0 + 1, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.any", wordNotExist1,
                            wordNotExist2, words[0], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 1),
                                calculateContext(0 + 1, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", words[999], wordNotExist2,
            wordNotExist3, docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(999 - 10, 10), calculateContext(999, 1),
                calculateContext(999 + 1, 0))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", wordNotExist1, words[999],
            wordNotExist3, docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(999 - 10, 10), calculateContext(999, 1),
                calculateContext(999 + 1, 0))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", wordNotExist1, wordNotExist2,
            words[999], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(999 - 10, 10), calculateContext(999, 1),
                calculateContext(999 + 1, 0))}));

        // case 3: two of three words exist
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", words[1], words[100],
            wordNotExist3, docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 1),
                                                  calculateContext(1, 1),
                                                  calculateContext(2, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(100 - 10, 10), calculateContext(100, 1),
                    calculateContext(100 + 1, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", wordNotExist3, words[1],
            words[100], docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 1),
                                                  calculateContext(1, 1),
                                                  calculateContext(2, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(100 - 10, 10), calculateContext(100, 1),
                    calculateContext(100 + 1, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", words[1], wordNotExist3,
            words[100], docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 1),
                                                  calculateContext(1, 1),
                                                  calculateContext(2, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(100 - 10, 10), calculateContext(100, 1),
                    calculateContext(100 + 1, 10))}));

        // case 4: all exist; output order -> from the beginning to the end
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", words[1], words[100],
            words[200], docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 1),
                                                  calculateContext(1, 1),
                                                  calculateContext(2, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(100 - 10, 10), calculateContext(100, 1),
                    calculateContext(100 + 1, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(200 - 10, 10), calculateContext(200, 1),
                    calculateContext(200 + 1, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", words[100], words[200],
            words[1], docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 1),
                                                  calculateContext(1, 1),
                                                  calculateContext(2, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(100 - 10, 10), calculateContext(100, 1),
                    calculateContext(100 + 1, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(200 - 10, 10), calculateContext(200, 1),
                    calculateContext(200 + 1, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", words[200], words[100],
            words[1], docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 1),
                                                  calculateContext(1, 1),
                                                  calculateContext(2, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(100 - 10, 10), calculateContext(100, 1),
                    calculateContext(100 + 1, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(200 - 10, 10), calculateContext(200, 1),
                    calculateContext(200 + 1, 10))}));

        // case 5: edges
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.any", words[0], words[500],
            words[999], docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 0),
                                                  calculateContext(0, 1),
                                                  calculateContext(1, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(500 - 10, 10), calculateContext(500, 1),
                    calculateContext(500 + 1, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(999 - 10, 10), calculateContext(999, 1),
                    calculateContext(999 + 1, 0))}));
    }
}

TEST_CASE("store::search::all", "[.]") {
    initWords();
    auto logScope = enableTestLogging(Lvl::Search);

    // Lookup all of these words
    SECTION("search all of these words") {
        // 1 word scenario
        TEST_SEARCH_1_WORD(searchConfigTemplate, "engine.in", wordNotExist1,
                           !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigTemplate, "engine.in", words[1], docHash,
                           (std::vector{std::make_tuple<Text, Text, Text>(
                               calculateContext(0, 1), calculateContext(1, 1),
                               calculateContext(2, 10))}));

        // 3 words scenario
        // case 1: exists just one word
        // testSearch3Words(searchConfigTemplate, "engine.in", words[1],
        // wordNotExist2, wordNotExist3, documentExist,
        //    (std::vector{ std::make_tuple<Text, Text,
        //    Text>(calculateContext(0, 1), calculateContext(1, 1),
        //    calculateContext(2, 10)) }));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", words[100],
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", wordNotExist1,
                            words[100], wordNotExist3, !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", wordNotExist1,
                            wordNotExist2, words[100], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", words[0],
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", wordNotExist1,
                            words[0], wordNotExist3, !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", wordNotExist1,
                            wordNotExist2, words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", words[999],
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", wordNotExist1,
                            words[999], wordNotExist3, !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", wordNotExist1,
                            wordNotExist2, words[999], !docHash, emptyValues);

        // case 2: two of three words exist
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", words[1],
                            words[100], wordNotExist3, !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", wordNotExist3,
                            words[1], words[100], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.in", words[1],
                            wordNotExist3, words[100], !docHash, emptyValues);

        // case 3: all exist; output order -> from the beginning to the end
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.in", words[1], words[100], words[200],
            docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 1),
                                                  calculateContext(1, 1),
                                                  calculateContext(2, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(100 - 10, 10), calculateContext(100, 1),
                    calculateContext(100 + 1, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(200 - 10, 10), calculateContext(200, 1),
                    calculateContext(200 + 1, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.in", words[100], words[200], words[1],
            docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 1),
                                                  calculateContext(1, 1),
                                                  calculateContext(2, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(100 - 10, 10), calculateContext(100, 1),
                    calculateContext(100 + 1, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(200 - 10, 10), calculateContext(200, 1),
                    calculateContext(200 + 1, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.in", words[200], words[100], words[1],
            docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 1),
                                                  calculateContext(1, 1),
                                                  calculateContext(2, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(100 - 10, 10), calculateContext(100, 1),
                    calculateContext(100 + 1, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(200 - 10, 10), calculateContext(200, 1),
                    calculateContext(200 + 1, 10))}));

        // case 4: edges
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.in", words[0], words[500], words[999],
            docHash,
            (std::vector{
                std::make_tuple<Text, Text, Text>(calculateContext(0, 0),
                                                  calculateContext(0, 1),
                                                  calculateContext(1, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(500 - 10, 10), calculateContext(500, 1),
                    calculateContext(500 + 1, 10)),
                std::make_tuple<Text, Text, Text>(
                    calculateContext(999 - 10, 10), calculateContext(999, 1),
                    calculateContext(999 + 1, 0))}));
    }
}

TEST_CASE("store::search::near", "[.]") {
    initWords();
    auto logScope = enableTestLogging(Lvl::Search);

    // Lookup of these words near each other: one word
    SECTION("search these words near each other (1 word)") {
        // 1 word scenario
        TEST_SEARCH_1_WORD(searchConfigTemplate, "engine.near", wordNotExist1,
                           !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigTemplate, "engine.near", words[0],
                           docHash,
                           (std::vector{std::make_tuple<Text, Text, Text>(
                               calculateContext(0, 0), calculateContext(0, 1),
                               calculateContext(1, 10))}));
        TEST_SEARCH_1_WORD(searchConfigTemplate, "engine.near", words[1],
                           docHash,
                           (std::vector{std::make_tuple<Text, Text, Text>(
                               calculateContext(0, 1), calculateContext(1, 1),
                               calculateContext(2, 10))}));
        TEST_SEARCH_1_WORD(
            searchConfigTemplate, "engine.near", words[100], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(100 - 10, 10), calculateContext(100, 1),
                calculateContext(100 + 1, 10))}));
        TEST_SEARCH_1_WORD(
            searchConfigTemplate, "engine.near", words[999], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(999 - 10, 10), calculateContext(999, 1),
                calculateContext(999, 0))}));
    }

    // Lookup of these words near each other: two words
    SECTION("search these words near each other (2 words)") {
        // 2 words scenario
        // case 1: at least one word does not exist
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            wordNotExist2, !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[100],
                            wordNotExist2, !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            words[100], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[0],
                            wordNotExist2, !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            words[0], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[999],
                            wordNotExist2, !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            words[999], !docHash, emptyValues);

        // case 2.1: words exists one after another in the middle, order is not
        // important
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[99], words[100], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(99 - 10, 10), calculateContext(99, 2),
                calculateContext(99 + 2, 10))}));
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[100], words[99], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(99 - 10, 10), calculateContext(99, 2),
                calculateContext(99 + 2, 10))}));
        // case 2.2: words exists one after another at the beginning, order is
        // not important
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[1], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 2),
                                calculateContext(0 + 2, 10))}));
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[1],
                            words[0], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 2),
                                calculateContext(0 + 2, 10))}));
        // case 2.3: words exists one after another at the end, order is not
        // important
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[998], words[999],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(998 - 10, 10), calculateContext(998, 2),
                calculateContext(998 + 2, 0))}));
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[998], words[999],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(998 - 10, 10), calculateContext(998, 2),
                calculateContext(998 + 2, 0))}));
        // case 2.4: words exists within acceptable distance from each other in
        // the middle, order is not important
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[100], words[105],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(100 - 10, 10), calculateContext(100, 6),
                calculateContext(100 + 6, 10))}));
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[105], words[100],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(100 - 10, 10), calculateContext(100, 6),
                calculateContext(100 + 6, 10))}));
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[100], words[110],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(100 - 10, 10), calculateContext(100, 11),
                calculateContext(100 + 11, 10))}));
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[110], words[100],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(100 - 10, 10), calculateContext(100, 11),
                calculateContext(100 + 11, 10))}));
        // case 2.5: words exists within acceptable distance from each other at
        // the beginning, order is not important
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[5], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 6),
                                calculateContext(0 + 6, 10))}));
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[5],
                            words[0], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 6),
                                calculateContext(0 + 6, 10))}));
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[10], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 11),
                                calculateContext(0 + 11, 10))}));
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[10],
                            words[0], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 11),
                                calculateContext(0 + 11, 10))}));
        // case 2.6: words exists within acceptable distance from each other at
        // the end, order is not important
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[999], words[995],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(995 - 10, 10), calculateContext(995, 5),
                calculateContext(995 + 5 + 0, 0))}));
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[995], words[999],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(995 - 10, 10), calculateContext(995, 5),
                calculateContext(995 + 5 + 0, 0))}));
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[989], words[999],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(989 - 10, 10), calculateContext(989, 11),
                calculateContext(989 + 11, 0))}));
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.near", words[999], words[989],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(989 - 10, 10), calculateContext(989, 11),
                calculateContext(989 + 11, 0))}));
        // case 2.7: words exists however not inside acceptable distance from
        // each other no matter where, order is not important
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[100],
                            words[111], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[111],
                            words[100], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[100],
                            words[115], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[115],
                            words[100], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[15], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[15],
                            words[0], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[11], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[11],
                            words[0], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[999],
                            words[975], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[975],
                            words[999], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[999],
                            words[988], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.near", words[988],
                            words[999], !docHash, emptyValues);
    }

    // Lookup of these words near each other: three words
    SECTION("search these words near each other (3 words)") {
        // case 1: exists just one word
        // testSearch3Words(searchConfigTemplate, "engine.near", words[1],
        // wordNotExist2, wordNotExist3, documentExist,
        //    (std::vector{ std::make_tuple<Text, Text,
        //    Text>(calculateContext(0, 1), calculateContext(1, 1),
        //    calculateContext(2, 10)) }));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100],
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            words[100], wordNotExist3, !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            wordNotExist2, words[100], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[0],
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            words[0], wordNotExist3, !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            wordNotExist2, words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[999],
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            words[999], wordNotExist3, !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", wordNotExist1,
                            wordNotExist2, words[999], !docHash, emptyValues);

        // case 2: two of three words exist
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[1],
                            words[100], wordNotExist3, !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", wordNotExist3,
                            words[1], words[100], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[1],
                            wordNotExist3, words[100], !docHash, emptyValues);

        // case 3.1: words exists one after another in the middle, order IS
        // IMPORTANT in NEAR order is important consider these words: word1
        // word2 .... word100
        //  'word1' 'word11' 'word21' -> result is returned
        //  'word11' 'word1' 'word21' -> no result, because the distance between
        //  'word1' and 'word21' is higher than the threshold
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[99], words[100],
            words[101], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(99 - 10, 10), calculateContext(99, 3),
                calculateContext(99 + 3, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[100], words[101],
            words[99], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(99 - 10, 10), calculateContext(99, 3),
                calculateContext(99 + 3, 10))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[101], words[99],
            words[100], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(99 - 10, 10), calculateContext(99, 3),
                calculateContext(99 + 3, 10))}));
        // case 3.2: words exists one after another at the beginning, order IS
        // IMPORTANT
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[1], words[2], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 3),
                                calculateContext(0 + 3, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[1],
                            words[2], words[0], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 3),
                                calculateContext(0 + 3, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[2],
                            words[0], words[1], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 3),
                                calculateContext(0 + 3, 10))}));
        // case 3.3: words exists one after another at the end, order IS
        // IMPORTANT
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[997], words[998],
            words[999], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(997 - 10, 10), calculateContext(997, 3),
                calculateContext(997 + 3, 0))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[998], words[999],
            words[997], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(997 - 10, 10), calculateContext(997, 3),
                calculateContext(997 + 3, 0))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[999], words[997],
            words[998], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(997 - 10, 10), calculateContext(997, 3),
                calculateContext(997 + 3, 0))}));

        // case 3.4: words exists within acceptable distance from each other in
        // the middle, order IS IMPORTANT case 3.4.1 -> everything is found
        // because inside the threshold
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100 - 5],
                            words[100], words[100 + 5], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(100 - 5 - 10, 10),
                                calculateContext(100 - 5, 11),
                                calculateContext(100 - 5 + 11, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100],
                            words[100 - 5], words[100 + 5], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(100 - 5 - 10, 10),
                                calculateContext(100 - 5, 11),
                                calculateContext(100 - 5 + 11, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100 + 5],
                            words[100], words[100 - 5], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(100 - 5 - 10, 10),
                                calculateContext(100 - 5, 11),
                                calculateContext(100 - 5 + 11, 10))}));
        // case 3.4.2 -> not everything is found because there is a combination
        // when distance is over threshold
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100 - 6],
                            words[100], words[100 + 6], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(100 - 6 - 10, 10),
                                calculateContext(100 - 6, 13),
                                calculateContext(100 - 6 + 13, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100 - 6],
                            words[100 + 6], words[100], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100],
                            words[100 + 6], words[100 - 6], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100],
                            words[100 - 6], words[100 + 6], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100 + 6],
                            words[100 - 6], words[100], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100 + 6],
                            words[100], words[100 - 6], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(100 - 6 - 10, 10),
                                calculateContext(100 - 6, 13),
                                calculateContext(100 - 6 + 13, 10))}));
        // case 3.4.3 -> not everything is found because there is a combination
        // when distance is over threshold
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near",
                            words[100 - 10], words[100], words[100 + 10],
                            docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(100 - 10 - 10, 10),
                                calculateContext(100 - 10, 21),
                                calculateContext(100 - 10 + 21, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near",
                            words[100 - 10], words[100 + 10], words[100],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100],
                            words[100 - 10], words[100 + 10], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100],
                            words[100 + 10], words[100 - 10], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near",
                            words[100 + 10], words[100 - 10], words[100],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near",
                            words[100 + 10], words[100], words[100 - 10],
                            docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(100 - 10 - 10, 10),
                                calculateContext(100 - 10, 21),
                                calculateContext(100 - 10 + 21, 10))}));

        // case 3.5: words exists within acceptable distance from each other at
        // the beginning, order IS IMPORTANT case 3.5.1: all words are within
        // acceptable distance
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[5], words[10], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 11),
                                calculateContext(0 + 11, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[10], words[5], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 11),
                                calculateContext(0 + 11, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[5],
                            words[0], words[10], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 11),
                                calculateContext(0 + 11, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[5],
                            words[10], words[0], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 11),
                                calculateContext(0 + 11, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[10],
                            words[0], words[5], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 11),
                                calculateContext(0 + 11, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[10],
                            words[5], words[0], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 11),
                                calculateContext(0 + 11, 10))}));
        // case 3.5.2 -> not everything is found because there is a combination
        // when distance is over threshold
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[6], words[11], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 12),
                                calculateContext(0 + 12, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[11], words[6], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[6],
                            words[0], words[11], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[6],
                            words[11], words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[11],
                            words[0], words[6], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[11],
                            words[6], words[0], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 12),
                                calculateContext(0 + 12, 10))}));
        // case 3.5.3 -> not everything is found because there is a combination
        // when distance is over threshold
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[10], words[20], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 21),
                                calculateContext(0 + 21, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[0],
                            words[20], words[10], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[10],
                            words[0], words[20], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[10],
                            words[20], words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[20],
                            words[0], words[10], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[20],
                            words[10], words[0], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 21),
                                calculateContext(0 + 21, 10))}));

        // case 3.6: words exists within acceptable distance from each other at
        // the end, order IS IMPORTANT case 3.6.1: all words are within
        // acceptable distance
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[999], words[994],
            words[989], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(989 - 10, 10), calculateContext(989, 11),
                calculateContext(989 + 11, 0))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[999], words[989],
            words[994], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(989 - 10, 10), calculateContext(989, 11),
                calculateContext(989 + 11, 0))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[994], words[999],
            words[989], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(989 - 10, 10), calculateContext(989, 11),
                calculateContext(989 + 11, 0))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[994], words[989],
            words[999], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(989 - 10, 10), calculateContext(989, 11),
                calculateContext(989 + 11, 0))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[989], words[999],
            words[994], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(989 - 10, 10), calculateContext(989, 11),
                calculateContext(989 + 11, 0))}));
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[989], words[994],
            words[999], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(989 - 10, 10), calculateContext(989, 11),
                calculateContext(989 + 11, 0))}));
        // case 3.6.2 -> not everything is found because there is a combination
        // when distance is over threshold
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[999], words[993],
            words[988], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(988 - 10, 10), calculateContext(988, 12),
                calculateContext(988 + 12, 0))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[999],
                            words[988], words[993], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[993],
                            words[999], words[988], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[993],
                            words[988], words[999], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[988],
                            words[999], words[993], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[988], words[993],
            words[999], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(988 - 10, 10), calculateContext(988, 12),
                calculateContext(988 + 12, 0))}));
        // case 3.6.3 -> not everything is found because there is a combination
        // when distance is over threshold
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[999], words[989],
            words[979], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(979 - 10, 10), calculateContext(979, 21),
                calculateContext(979 + 21, 0))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[999],
                            words[979], words[989], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[989],
                            words[999], words[979], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[989],
                            words[979], words[999], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[979],
                            words[999], words[989], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.near", words[979], words[989],
            words[999], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(979 - 10, 10), calculateContext(979, 21),
                calculateContext(979 + 21, 0))}));

        // case 3.7: words exists however not inside acceptable distance from
        // each other no matter where, order IS IMPORTANT
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near",
                            words[100 - 11], words[100], words[100 + 11],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near",
                            words[100 - 11], words[100 + 11], words[100],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100],
                            words[100 - 11], words[100 + 11], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near", words[100],
                            words[100 + 11], words[100 - 11], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near",
                            words[100 + 11], words[100 - 11], words[100],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.near",
                            words[100 + 11], words[100], words[100 - 11],
                            !docHash, emptyValues);
    }
}

TEST_CASE("store::search::phrase", "[.]") {
    initWords();
    auto logScope = enableTestLogging(Lvl::Search);

    // Lookup this phrase: one word
    SECTION("search this phrase (1 word)") {
        // 1 word scenario
        TEST_SEARCH_1_WORD(searchConfigTemplate, "engine.phrase", wordNotExist1,
                           !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigTemplate, "engine.phrase", words[0],
                           docHash,
                           (std::vector{std::make_tuple<Text, Text, Text>(
                               calculateContext(0, 0), calculateContext(0, 1),
                               calculateContext(1, 10))}));
        TEST_SEARCH_1_WORD(searchConfigTemplate, "engine.phrase", words[1],
                           docHash,
                           (std::vector{std::make_tuple<Text, Text, Text>(
                               calculateContext(0, 1), calculateContext(1, 1),
                               calculateContext(2, 10))}));
        TEST_SEARCH_1_WORD(
            searchConfigTemplate, "engine.phrase", words[100], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(100 - 10, 10), calculateContext(100, 1),
                calculateContext(100 + 1, 10))}));
        TEST_SEARCH_1_WORD(
            searchConfigTemplate, "engine.phrase", words[999], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(999 - 10, 10), calculateContext(999, 1),
                calculateContext(999, 0))}));
    }

    // Lookup this phrase: two words
    SECTION("search this phrase (2 words)") {
        // case 1: exists just one word from the phrase
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, wordNotExist2, !docHash,
                            emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            wordNotExist2, !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, words[100], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            wordNotExist2, !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, words[0], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            wordNotExist2, !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, words[999], !docHash, emptyValues);

        // case 2.1: both words exists, order is important -> phrase should be
        // found just in case when words are in specific order
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.phrase", words[99], words[100],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(99 - 10, 10), calculateContext(99, 2),
                calculateContext(99 + 2, 10))}));
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[99], !docHash, emptyValues);
        // case 2.2: both words exists at the beginning, order is important ->
        // phrase should be found just in case when words are in specific order
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[1], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 2),
                                calculateContext(0 + 2, 10))}));
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[1],
                            words[0], !docHash, emptyValues);
        // case 2.3: both words exists, order is important at the end -> phrase
        // should be found just in case when words are in specific order
        TEST_SEARCH_2_WORDS(
            searchConfigTemplate, "engine.phrase", words[998], words[999],
            docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(998 - 10, 10), calculateContext(998, 2),
                calculateContext(998 + 2, 0))}));
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[998], !docHash, emptyValues);
        // case 2.4: words exists with a distance between them -> nothing should
        // be found
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[105], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[105],
                            words[100], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[110], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[110],
                            words[100], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[6], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[6],
                            words[0], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[10], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[10],
                            words[0], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[995], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[995],
                            words[999], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[989],
                            words[999], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[989], !docHash, emptyValues);
        // case 2.5: words exists however with a big distance between them ->
        // nothing should be found
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[111], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[111],
                            words[100], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[115], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[115],
                            words[100], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[15], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[15],
                            words[0], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[11], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[11],
                            words[0], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[975], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[975],
                            words[999], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[988], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigTemplate, "engine.phrase", words[988],
                            words[999], !docHash, emptyValues);
    }

    // Lookup this phrase: three words
    SECTION("search these words near each other (3 words)") {
        // case 1: exists max one word from the phrase
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, wordNotExist2, wordNotExist3,
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, words[100], wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, wordNotExist2, words[100], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, words[0], wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, wordNotExist2, words[0], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, words[999], wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist1, wordNotExist2, words[999], !docHash,
                            emptyValues);

        // case 2: two of three words exist
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[1],
                            words[100], wordNotExist3, !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            wordNotExist3, words[1], words[100], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[1],
                            wordNotExist3, words[100], !docHash, emptyValues);

        // case 3.1: word from phrase exist, and phrase should be found only
        // when words are one after another
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.phrase", words[99], words[100],
            words[101], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(99 - 10, 10), calculateContext(99, 3),
                calculateContext(99 + 3, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[101], words[99], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[101],
                            words[99], words[100], !docHash, emptyValues);
        // case 3.2: the same at the beginning of the document
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[1], words[2], docHash,
                            (std::vector{std::make_tuple<Text, Text, Text>(
                                calculateContext(0, 0), calculateContext(0, 3),
                                calculateContext(0 + 3, 10))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[1],
                            words[2], words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[2],
                            words[0], words[1], !docHash, emptyValues);
        // case 3.3: the same at the end of the document
        TEST_SEARCH_3_WORDS(
            searchConfigTemplate, "engine.phrase", words[997], words[998],
            words[999], docHash,
            (std::vector{std::make_tuple<Text, Text, Text>(
                calculateContext(997 - 10, 10), calculateContext(997, 3),
                calculateContext(997 + 3, 0))}));
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[998],
                            words[999], words[997], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[997], words[998], !docHash, emptyValues);

        // case 3.4: there is a distance between words in the document ->
        // nothing should be found
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 - 5], words[100], words[100 + 5],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[100 - 5], words[100 + 5], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 + 5], words[100], words[100 - 5],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 - 6], words[100], words[100 + 6],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 - 6], words[100 + 6], words[100],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[100 + 6], words[100 - 6], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[100 - 6], words[100 + 6], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 + 6], words[100 - 6], words[100],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 + 6], words[100], words[100 - 6],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 - 10], words[100], words[100 + 10],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 - 10], words[100 + 10], words[100],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[100 - 10], words[100 + 10], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[100 + 10], words[100 - 10], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 + 10], words[100 - 10], words[100],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 + 10], words[100], words[100 - 10],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[5], words[10], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[10], words[5], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[5],
                            words[0], words[10], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[5],
                            words[10], words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[10],
                            words[0], words[5], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[10],
                            words[5], words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[6], words[11], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[11], words[6], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[6],
                            words[0], words[11], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[6],
                            words[11], words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[11],
                            words[0], words[6], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[11],
                            words[6], words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[10], words[20], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[0],
                            words[20], words[10], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[10],
                            words[0], words[20], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[10],
                            words[20], words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[20],
                            words[0], words[10], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[20],
                            words[10], words[0], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[994], words[989], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[989], words[994], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[994],
                            words[999], words[989], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[994],
                            words[989], words[999], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[989],
                            words[999], words[994], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[989],
                            words[994], words[999], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[993], words[988], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[988], words[993], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[993],
                            words[999], words[988], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[993],
                            words[988], words[999], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[988],
                            words[999], words[993], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[988],
                            words[993], words[999], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[989], words[979], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[999],
                            words[979], words[989], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[989],
                            words[999], words[979], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[989],
                            words[979], words[999], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[979],
                            words[999], words[989], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[979],
                            words[989], words[999], !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 - 11], words[100], words[100 + 11],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 - 11], words[100 + 11], words[100],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[100 - 11], words[100 + 11], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase", words[100],
                            words[100 + 11], words[100 - 11], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 + 11], words[100 - 11], words[100],
                            !docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigTemplate, "engine.phrase",
                            words[100 + 11], words[100], words[100 - 11],
                            !docHash, emptyValues);
    }
}

// Lookup not any word from words
TEST_CASE("store::search::not-any", "[.]") {
    initWords();
    auto logScope = enableTestLogging(Lvl::Search);

    // 1 word scenario
    SECTION("search not any of these words (1 word)") {
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.any",
                           wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.any", words[0],
                           !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.any",
                           words[500], !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.any",
                           words[999], !docHash, emptyValues);
    }

    // 2 words scenario
    SECTION("search not any of these words (2 words)") {
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, wordNotExist2, docHash, emptyValues);
        // at the beginning
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, words[1], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[0], wordNotExist1, !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[0], words[1], !docHash, emptyValues);
        // in the middle
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, words[500], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[499], wordNotExist1, !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[499], words[500], !docHash, emptyValues);
        // in the end
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, words[999], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[998], wordNotExist1, !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[998], words[999], !docHash, emptyValues);
    }

    // 3 words scenario
    SECTION("search not any of these words (3 words)") {
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, wordNotExist2, wordNotExist3,
                            docHash, emptyValues);
        // at the beginning
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, words[1], words[2], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[0], wordNotExist2, words[2], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[0], words[1], wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, wordNotExist2, words[2], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[0], wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, words[1], wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[0], words[1], words[2], !docHash,
                            emptyValues);
        // in the middle
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, words[500], words[501], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[499], wordNotExist2, words[501], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[499], words[500], wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, wordNotExist2, words[501], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[499], wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, words[500], wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[499], words[500], words[501], !docHash,
                            emptyValues);
        // in the end
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, words[998], words[999], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[997], wordNotExist2, words[999], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[997], words[998], wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, wordNotExist2, words[999], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[997], wordNotExist2, wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            wordNotExist1, words[998], wordNotExist3, !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.any",
                            words[997], words[998], words[999], !docHash,
                            emptyValues);
    }
}

// Lookup not all of these words
TEST_CASE("store::search::not-all", "[.]") {
    initWords();
    auto logScope = enableTestLogging(Lvl::Search);

    // 1 word scenario
    SECTION("search not all of these words (1 word)") {
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.in",
                           wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.in", words[0],
                           !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.in",
                           words[500], !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.in",
                           words[999], !docHash, emptyValues);
    }

    // 2 words scenario
    SECTION("search not all of these words (2 words)") {
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, wordNotExist2, docHash, emptyValues);
        // at the beginning
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, words[1], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.in", words[0],
                            wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.in", words[0],
                            words[1], !docHash, emptyValues);
        // in the middle
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, words[500], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[499], wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[499], words[500], !docHash, emptyValues);
        // in the end
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, words[999], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[998], wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[998], words[999], !docHash, emptyValues);
    }

    // 3 words scenario
    SECTION("search not all of these words (3 words)") {
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, wordNotExist2, wordNotExist3,
                            docHash, emptyValues);
        // at the beginning
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, words[1], words[2], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in", words[0],
                            wordNotExist2, words[2], docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in", words[0],
                            words[1], wordNotExist3, docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, wordNotExist2, words[2], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in", words[0],
                            wordNotExist2, wordNotExist3, docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, words[1], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in", words[0],
                            words[1], words[2], !docHash, emptyValues);
        // in the middle
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, words[500], words[501], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[499], wordNotExist2, words[501], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[499], words[500], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, wordNotExist2, words[501], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[499], wordNotExist2, wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, words[500], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[499], words[500], words[501], !docHash,
                            emptyValues);
        // in the end
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, words[998], words[999], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[997], wordNotExist2, words[999], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[997], words[998], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, wordNotExist2, words[999], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[997], wordNotExist2, wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            wordNotExist1, words[998], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.in",
                            words[997], words[998], words[999], !docHash,
                            emptyValues);
    }
}

// Lookup not near of these words
TEST_CASE("store::search::not-near", "[.]") {
    initWords();
    auto logScope = enableTestLogging(Lvl::Search);

    // 1 word scenario
    SECTION("search not near of these words (1 word)") {
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.near",
                           wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.near",
                           words[0], !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.near",
                           words[500], !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.near",
                           words[999], !docHash, emptyValues);
    }

    // 2 words scenario
    SECTION("search not near of these words (2 words)") {
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, wordNotExist2, docHash, emptyValues);
        // at the beginning
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, words[5], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], words[5], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], words[9], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], words[10], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], words[11], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], words[15], docHash, emptyValues);
        // in the middle
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, words[500], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[495], wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[495], words[500], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[489], words[500], docHash, emptyValues);
        // in the end
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, words[999], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[995], wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[995], words[999], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[988], words[999], docHash, emptyValues);
    }

    // 3 words scenario
    SECTION("search not near of these words (3 words)") {
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, wordNotExist2, wordNotExist3,
                            docHash, emptyValues);
        // at the beginning
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, words[4], words[9], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], wordNotExist2, words[9], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], words[4], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, wordNotExist2, words[9], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], wordNotExist2, wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, words[4], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], words[4], words[9], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[0], words[4], words[15], docHash,
                            emptyValues);
        // in the middle
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, words[500], words[504], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[495], wordNotExist2, words[504], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[495], words[500], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, wordNotExist2, words[504], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[495], wordNotExist2, wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, words[500], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[495], words[500], words[504], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[489], words[500], words[504], docHash,
                            emptyValues);
        // in the end
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, words[995], words[999], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[991], wordNotExist2, words[999], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[991], words[995], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, wordNotExist2, words[999], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[991], wordNotExist2, wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            wordNotExist1, words[995], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[991], words[995], words[999], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[988], words[995], words[999], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.near",
                            words[984], words[995], words[999], docHash,
                            emptyValues);
    }
}

// Lookup not phrase of these words
TEST_CASE("store::search::not-phrase", "[.]") {
    initWords();
    auto logScope = enableTestLogging(Lvl::Search);

    // 1 word scenario
    SECTION("search not all of these words (1 word)") {
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.phrase",
                           wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.phrase",
                           words[0], !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.phrase",
                           words[500], !docHash, emptyValues);
        TEST_SEARCH_1_WORD(searchConfigNegativeTemplate, "engine.phrase",
                           words[999], !docHash, emptyValues);
    }

    // 2 words scenario
    SECTION("search not all of these words (2 words)") {
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, wordNotExist2, docHash, emptyValues);
        // at the beginning
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, words[1], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[0], wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[0], words[1], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[0], words[2], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[1], words[0], docHash, emptyValues);
        // in the middle
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, words[500], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[499], wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[499], words[500], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[499], words[501], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[501], words[500], docHash, emptyValues);
        // in the end
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, words[999], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[998], wordNotExist1, docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[998], words[999], !docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[997], words[999], docHash, emptyValues);
        TEST_SEARCH_2_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[999], words[998], docHash, emptyValues);
    }

    // 3 words scenario
    SECTION("search not all of these words (3 words)") {
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, wordNotExist2, wordNotExist3,
                            docHash, emptyValues);
        // at the beginning
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, words[1], words[2], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[0], wordNotExist2, words[2], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[0], words[1], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, wordNotExist2, words[2], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[0], wordNotExist2, wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, words[1], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[0], words[1], words[2], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[0], words[1], words[3], docHash, emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[0], words[2], words[1], docHash, emptyValues);
        // in the middle
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, words[500], words[501], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[499], wordNotExist2, words[501], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[499], words[500], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, wordNotExist2, words[501], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[499], wordNotExist2, wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, words[500], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[499], words[500], words[501], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[499], words[500], words[502], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[499], words[501], words[500], docHash,
                            emptyValues);
        // in the end
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, words[998], words[999], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[997], wordNotExist2, words[999], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[997], words[998], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, wordNotExist2, words[999], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[997], wordNotExist2, wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            wordNotExist1, words[998], wordNotExist3, docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[997], words[998], words[999], !docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[996], words[998], words[999], docHash,
                            emptyValues);
        TEST_SEARCH_3_WORDS(searchConfigNegativeTemplate, "engine.phrase",
                            words[997], words[999], words[998], docHash,
                            emptyValues);
    }
}
