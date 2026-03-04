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
#include <apLib/memory/HandleTable.hpp>

struct MyAwesomeClass {
    MyAwesomeClass(int &_destructCount) : destructCount(_destructCount) {}

    ~MyAwesomeClass() {
        LOG(Test, "Destruct");
        destructCount.get()++;
    }

    MyAwesomeClass(const MyAwesomeClass &awesome) = delete;
    MyAwesomeClass &operator=(const MyAwesomeClass &) = delete;
    MyAwesomeClass(MyAwesomeClass &&awesome) = delete;
    MyAwesomeClass &operator=(MyAwesomeClass &&awesome) = delete;

    int val1 = 0;
    int val2 = 1234;
    Text name = "Stuff";
    Ref<int> destructCount;
};

using TestTable = memory::HandleTable<MyAwesomeClass>;

TEST_CASE("memory::HandleTable") {
    SECTION("Basic") {
        int destructCount = 0;

        auto awesome = *TestTable::get().allocate(_location, destructCount);
        REQUIRE(awesome.refCount() == 1);

        REQUIRE(destructCount == 0);

        // Should be valid
        REQUIRE(awesome);
        REQUIRE(awesome->val1 == 0);
        REQUIRE(awesome->val2 == 1234);
        REQUIRE(awesome->name == "Stuff");
        REQUIRE(awesome->destructCount.get() == destructCount);
        REQUIRE(awesome.refCount() == 1);

        REQUIRE(destructCount == 0);

        // Now put it
        awesome.reset();
        REQUIRE(!awesome);

        // Should've destructed
        REQUIRE(destructCount == 1);

        // Should now be invalid
        REQUIRE(!awesome);

        // Allocate another
        awesome = *TestTable::get().allocate(_location, destructCount);

        // Should be valid
        REQUIRE(awesome);
        REQUIRE(awesome->val1 == 0);
        REQUIRE(awesome->val2 == 1234);
        REQUIRE(awesome->name == "Stuff");
        REQUIRE(awesome->destructCount.get() == destructCount);
        REQUIRE(awesome.refCount() == 1);

        // Verify the ref was properly forwarded
        destructCount++;
        REQUIRE(awesome->destructCount.get() == destructCount);
        destructCount--;

        REQUIRE(destructCount == 1);

        // Test some gets puts then verify the count
        for (auto i = 0; i < 10; i++) auto awesome2 = awesome;
        REQUIRE(awesome.refCount() == 1);

        // Clone it
        auto awesome2 = awesome;

        REQUIRE(destructCount == 1);

        // And mark it not ready
        REQUIRE(awesome.setNotReady());

        // Still shouldn't have destructed as it is holding a ref
        REQUIRE(destructCount == 1);
        REQUIRE(awesome);
        REQUIRE(awesome->val1 == 0);
        REQUIRE(awesome->val2 == 1234);
        REQUIRE(awesome->name == "Stuff");
        REQUIRE(awesome->destructCount.get() == destructCount);
        REQUIRE(awesome.refCount() == 2);

        // Awesome2 should refuse to clone now
        REQUIRE(awesome2);
        auto awesome3 = awesome2;
        REQUIRE(!awesome3);

        // And it should be not ready
        REQUIRE(!awesome2.isReady());

        // As should awesome
        REQUIRE(!awesome.isReady());

        // But the values should should still be ok
        REQUIRE(awesome->val1 == 0);
        REQUIRE(awesome->val2 == 1234);
        REQUIRE(awesome->name == "Stuff");
        REQUIRE(awesome->destructCount.get() == destructCount);

        REQUIRE(awesome2->val1 == 0);
        REQUIRE(awesome2->val2 == 1234);
        REQUIRE(awesome2->name == "Stuff");
        REQUIRE(awesome2->destructCount.get() == destructCount);

        // Still not a new destruction
        REQUIRE(destructCount == 1);

        // Put it, should still not destruct, shared
        awesome.reset();

        REQUIRE(destructCount == 1);
        REQUIRE(awesome2.refCount() == 1);

        // Now the other
        awesome2.reset();

        // Finally should've destructed
        REQUIRE(destructCount == 2);
    }

    SECTION("Threaded") {
        async::work::Group tasks;

        int destructCount = 0;

        auto awesome = *TestTable::get().allocate(_location, destructCount);

        // Verify the ref was properly forwarded
        destructCount++;
        REQUIRE(awesome->destructCount.get() == destructCount);
        destructCount--;

        auto getPutLoop = [&, awesome]() mutable {
            while (awesome.isReady()) {
                auto awesome2 = awesome;
            }
        };

        tasks << async::work::submit(_location, "Get/put loop 1", getPutLoop);
        tasks << async::work::submit(_location, "Get/put loop 2", getPutLoop);
        tasks << async::work::submit(_location, "Get/put loop 3", getPutLoop);
        tasks << async::work::submit(_location, "Get/put loop 4",
                                     _mv(getPutLoop));

        // Let them churn a bit
        async::sleep(.5s);

        REQUIRE(destructCount == 0);

        // Now try to force them to stop by setting the handle not ready
        REQUIRE(awesome.setNotReady());

        REQUIRE(destructCount == 0);

        // They should all be dead now with noexception
        REQUIRE(!tasks.join());

        REQUIRE(destructCount == 0);
        REQUIRE(awesome.refCount() == 1);

        // And we still should be able to access it
        REQUIRE(awesome);
        REQUIRE(awesome->val1 == 0);
        REQUIRE(awesome->val2 == 1234);
        REQUIRE(awesome->name == "Stuff");

        REQUIRE(destructCount == 0);

        // Now when we put it it should destruct
        awesome.reset();

        REQUIRE(destructCount == 1);
    }
}
