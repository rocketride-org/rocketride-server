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

namespace {

_const size_t TOTAL_ENTRIES_TO_RECHECK = 100;
_const size_t MAX_NEW_ENTRIES_SINCE_FULL_SCAN = 100;
_const size_t FILE_CREATE_SIZE_IN_BYTES = 4_kb;
_const size_t CREATE_TOTAL_NEW_FILES = 10;

}  // namespace

TEST_CASE("usn::UsnWalker::full", "[.]") {
    SECTION("ScanFullUSN") {
        using namespace ap::plat;
        using namespace ap::file;

        if (!application::elevated()) {
            LOG(Test,
                "Skipping USN tests (requires administrative privileges)");
            return;
        }

        UsnWalker walker;

        REQUIRE_FALSE(walker.open("C:/"));

        auto entry = walker.next();
        REQUIRE(entry);
        REQUIRE(*entry);
        REQUIRE(!((*entry)->path.empty()));

        auto token = walker.token();
        REQUIRE(token);

        LOG(Test, "Current token", token);

        size_t count{};
        size_t skipped{};

        std::vector<Path> recheckEntries;
        recheckEntries.reserve(TOTAL_ENTRIES_TO_RECHECK);

        LOG(Test, "Reading entire journal...");
        _forever() {
            auto entry = walker.next();
            if (!entry) break;

            if (!(*entry)) {
                LOG(Test, "Done reading all entries");
                break;
            }

            if (recheckEntries.size() < TOTAL_ENTRIES_TO_RECHECK)
                recheckEntries.push_back((*entry)->path);

            LOG(Test, "Read entry, path:", (*entry)->path,
                "reason:", (*entry)->reason, "skipped:", (*entry)->skipped,
                "token:", walker.token());
            ++count;
            skipped += (*entry)->skipped;
        }

        auto lastToken = walker.token();

        LOG(Test, "count:", count, "skipped:", skipped,
            "starting token:", token, "ending token:", lastToken);

        REQUIRE(lastToken);
        REQUIRE(token != lastToken);

        REQUIRE(count > 10);  // You should have at least 10 USN entries

        walker.seekLast();

        count = 0;
        _forever() {
            auto entry = walker.next();
            if (!entry) break;

            if (!(*entry)) {
                LOG(Test, "Done reading all entries");
                break;
            }

            ++count;
            LOG(Test, "Post scan found additional entry, path:", (*entry)->path,
                "reason:", (*entry)->reason, "skipped:", (*entry)->skipped,
                "token:", walker.token());
        }
        REQUIRE(count < MAX_NEW_ENTRIES_SINCE_FULL_SCAN);
    }
}

TEST_CASE("usn::UsnWalker", "[.]") {
    SECTION("ScanAgainCheckForSameEntries") {
        using namespace ap::plat;
        using namespace ap::file;

        if (!application::elevated()) {
            LOG(Test,
                "Skipping USN tests (requires administrative privileges)");
            return;
        }

        size_t count{};

        std::vector<Path> recheckEntries;
        recheckEntries.reserve(TOTAL_ENTRIES_TO_RECHECK);

        UsnWalker walker;

        REQUIRE(!walker.open("C:/"));

        while (recheckEntries.size() < TOTAL_ENTRIES_TO_RECHECK) {
            auto entry = walker.next();
            REQUIRE(entry);
            REQUIRE(*entry);

            recheckEntries.push_back((*entry)->path);
            LOG(Test, "Capturing path:", (*entry)->path,
                "reason:", (*entry)->reason, "skipped:", (*entry)->skipped,
                "token:", walker.token());
        }

        walker.seekFirst();

        count = 0;
        for (size_t index = 0; index < recheckEntries.size();
             ++index, ++count) {
            auto entry = walker.next();
            REQUIRE(entry);
            REQUIRE(*entry);

            REQUIRE(recheckEntries[index] == (*entry)->path);
            LOG(Test, "Verifying path:", (*entry)->path,
                "reason:", (*entry)->reason, "skipped:", (*entry)->skipped,
                "token:", walker.token());
        }

        REQUIRE(count == recheckEntries.size());
    }

    SECTION("FastForwardMakeChangesScanRewindAndScan") {
        using namespace ap::plat;
        using namespace ap::file;

        if (!application::elevated()) {
            LOG(Test,
                "Skipping USN tests (requires administrative privileges)");
            return;
        }

        auto root = testPath();
        auto usnFolder = root / "usn";

        Path rootDrive{root[0]};

        LOG(Test, "Found root folder", root, "root drive:", rootDrive);

        UsnWalker walker;

        REQUIRE(!walker.open(rootDrive));

        struct UniqueRecord {
            Uuid id;
            Text fileId;
            Path path;
            bool foundNewFile{};
            bool foundDeletedFile{};
        };

        std::vector<UniqueRecord> uniqueFiles;
        std::map<Text, UniqueRecord&> fileIdToUniqueFiles;
        uniqueFiles.reserve(CREATE_TOTAL_NEW_FILES);

        while (uniqueFiles.size() < CREATE_TOTAL_NEW_FILES) {
            UniqueRecord entry{.id = Uuid::create(), .fileId = _ts(entry.id)};

            entry.path = usnFolder / (entry.fileId + ".bin");
            uniqueFiles.push_back(entry);
        }

        Text token;

        // create new file
        {
            REQUIRE(!walker.seekLast());
            token = walker.token();

            for (auto& uniqueFile : uniqueFiles) {
                Buffer rawData(FILE_CREATE_SIZE_IN_BYTES);
                for (size_t count = 0; count < rawData.size(); ++count)
                    rawData[count] = crypto::randomNumber<uint8_t>();

                put(uniqueFile.path, rawData);

                LOG(Test, "New file created:", uniqueFile.path);
            }

            size_t totalFound{};
            while (totalFound < uniqueFiles.size()) {
                auto entry = walker.next();
                REQUIRE(entry);
                if (!(*entry)) break;

                LOG(Test, "Found new path:", (*entry)->path,
                    "reason:", (*entry)->reason, "skipped:", (*entry)->skipped,
                    "token:", walker.token(),
                    "file id:", crypto::hexEncode(entry->fileDescriptorId()));

                auto foundName = (*entry)->path.fileName(true);

                auto found = std::find_if(
                    begin(uniqueFiles), end(uniqueFiles),
                    [&foundName](const UniqueRecord& comp) noexcept -> bool {
                        return foundName == comp.fileId;
                    });

                if (found != end(uniqueFiles)) {
                    auto& record = *found;
                    if (!record.foundNewFile) {
                        REQUIRE((*entry)->reason ==
                                UsnWalker::Reason::ContentsAdded);
                        record.foundNewFile = true;

                        fileIdToUniqueFiles.insert_or_assign(
                            crypto::hexEncode(entry->fileDescriptorId()),
                            record);
                        ++totalFound;
                    }
                }
            }
            REQUIRE(totalFound == uniqueFiles.size());
        }

        // Delete all the created files to create new entries
        for (auto& entry : uniqueFiles) {
            REQUIRE(::DeleteFileW(entry.path.str()) != 0);
        }

        // scan for previously deleted files
        {
            REQUIRE(!walker.seek(token));

            size_t totalFound{};
            while (totalFound < uniqueFiles.size()) {
                auto entry = walker.next(true);
                REQUIRE(entry);
                if (!(*entry)) break;

                Text key;
                if ((*entry)->path.empty())
                    key = crypto::hexEncode(entry->fileDescriptorId());

                LOG(Test, "Found entry:",
                    (*entry)->path.empty() ? key : Text{(*entry)->path},
                    "reason:", (*entry)->reason, "skipped:", (*entry)->skipped,
                    "token:", walker.token());
                if ((*entry)->reason == UsnWalker::Reason::ContentsRemoved) {
                    auto found = fileIdToUniqueFiles.find(key);
                    if (found != end(fileIdToUniqueFiles)) {
                        auto& record = (*found).second;
                        LOG(Test, "Found removed path:", record.path,
                            "reason:", (*entry)->reason,
                            "skipped:", (*entry)->skipped,
                            "token:", walker.token());
                        if (!record.foundDeletedFile) {
                            record.foundDeletedFile = true;
                            ++totalFound;
                        }
                    }
                }
            }
            REQUIRE(totalFound == uniqueFiles.size());
        }
    }
}
