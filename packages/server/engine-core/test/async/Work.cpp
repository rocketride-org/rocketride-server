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

using namespace async;

TEST_CASE("async::work") {
    SECTION("Basic") {
        auto logScope = enableTestLogging(Lvl::Work, Lvl::WorkExec);
        std::vector<int> stuff;
        auto item = work::submit(_location, "Do stuff", [&]() noexcept {
            for (auto i : util::makeRange<0, 10>()) stuff.push_back(i);
        });
        REQUIRE(!item->join());
        REQUIRE(stuff.size() == 10);
    }

    SECTION("Work") {
        struct AddWork {
            uint32_t ticketId;
            bool completed = false;
        };

        auto logScope = enableTestLogging(Lvl::Work, Lvl::WorkExec);
#if ROCKETRIDE_BUILD_DEBUG
        std::vector<AddWork> items(100);
#else
        std::vector<AddWork> items(5000);
#endif
        std::vector<work::Item> tasks;

        auto doWork = [&items](uint32_t workTicket) noexcept {
            LOG(Work, "Completing Worker #{}", workTicket);
            ASSERTD(items[workTicket].completed == false);
            ASSERTD(workTicket == items[workTicket].ticketId);
            items[workTicket].completed = true;
        };

        for (auto i = 0; i < items.size(); i++) {
            items[i].ticketId = i;
            tasks.emplace_back(
                *work::submit(_location, _ts("Worker #", i), doWork, i));
        }

        _forEach(tasks, [&](auto &task) noexcept {
            LOG(Work, "Joining on work item {}", task);
            REQUIRE(!task->join());
        });
        _forEach(items, [&](auto &item) noexcept {
            LOG(Work, "Checking on work ticket #{}", item.ticketId);
            REQUIRE(item.completed);
        });
    }

    SECTION("DestructJoin") {
        auto logScope = enableTestLogging(Lvl::Work, Lvl::WorkExec);
        auto ptr = makeShared<int>(5);
        auto scopedCall = [&] {
            async::sleep(1s);
            *ptr = 6;
        };

        work::Item workItem = work::submit(_location, "Do stuff", scopedCall);
    }

    SECTION("Results") {
        std::vector<async::work::Item> tasks;
        for (auto i = 0; i < 500; i++) {
            tasks.emplace_back(*async::work::submit(
                _location, "Hi", [&, i] { return _fmt("Yo{}!", i); }));
        }

        auto i = 0;
        for (auto &task : tasks) {
            auto res = task->result<Text>();
            REQUIRE(*res == _fmt("Yo{}!", i++));
        }
    }

    SECTION("Error propagation") {
        SUBSECTION("Callback returns void") {
            // Base case
            _using(auto item = async::work::submit(_location, "Test",
                                                   []() noexcept { ; })) {
                REQUIRE_NOTHROW(*item->join());
            }

            // Callback throws
            _using(auto item = async::work::submit(_location, "Test", []() {
                       APERR_THROW(Ec::Unexpected);
                   })) {
                REQUIRE(item->join() == Ec::Unexpected);
            }
        }

        SUBSECTION("Callback returns Error") {
            // Base case
            _using(
                auto item = async::work::submit(
                    _location, "Test", []() noexcept -> Error { return {}; })) {
                REQUIRE_NOTHROW(*item->join());
            }

            // Callback returns Error
            _using(auto item = async::work::submit(
                       _location, "Test", []() noexcept -> Error {
                           return APERR(Ec::Unexpected);
                       })) {
                REQUIRE(item->join() == Ec::Unexpected);
            }

            // Callback throws
            _using(auto item = async::work::submit(
                       _location, "Test",
                       []() -> Error { APERR_THROW(Ec::Unexpected); })) {
                REQUIRE(item->join() == Ec::Unexpected);
            }
        }

#if 0
		SUBSECTION("Callback returns ErrorOr") {
			// Base case
			_using (auto item = async::work::submit(_location, "Test", []() noexcept -> ErrorOr<int> { return 0; })) {
				REQUIRE_NOTHROW(*item->join());
			}

			// Callback returns Error
			_using (auto item = async::work::submit(_location, "Test", []() noexcept -> ErrorOr<int> { return APERR(Ec::Unexpected); })) {
				REQUIRE(item->join() == Ec::Unexpected);
			}

			// Callback throws
			_using (auto item = async::work::submit(_location, "Test", []() -> ErrorOr<int> { APERR_THROW(Ec::Unexpected); })) {
				REQUIRE(item->join() == Ec::Unexpected);
			}		
		}
#endif
    }
}
