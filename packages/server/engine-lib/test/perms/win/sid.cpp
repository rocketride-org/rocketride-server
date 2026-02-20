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

#define SID_LOCAL_SYSTEM_STR "S-1-5-18"

TEST_CASE("perms::sid") {
    using namespace engine::perms;

    BYTE SID_LOCAL_SYSTEM[] = {0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
                               0x00, 0x05, 0x12, 0x00, 0x00, 0x00};
    const auto localSystemSid = Sid::fromPtr(SID_LOCAL_SYSTEM);

    SECTION("Basic Sid operations") {
        Sid sid;
        REQUIRE_FALSE(sid);
        REQUIRE(!sid);
        REQUIRE_FALSE(_ts(sid));

        sid = localSystemSid;
        REQUIRE(sid);
        REQUIRE(sid);
        REQUIRE(_ts(sid));
    }

    SECTION("Sid conversion and comparison") {
        auto str = _ts(localSystemSid);
        auto sid = _fs<Sid>(str);
        REQUIRE(sid == localSystemSid);
    }

    SECTION("machineSid") { REQUIRE(machineSid()); }

    SECTION("isLocalSid") { REQUIRE(perms::isLocalSid(localSystemSid)); }

    SECTION("sidToWindowsIdentity") {
        auto identity = perms::sidToWindowsIdentity(localSystemSid, "");
        REQUIRE(identity);
        REQUIRE(identity->sid == localSystemSid);
        REQUIRE(identity->domain.equals(L"NT AUTHORITY", false));
        REQUIRE(identity->username.equals(L"SYSTEM", false));
        REQUIRE(identity->type == perms::WindowsIdentity::Type::typeLocal);
    }

    SECTION("Using Sid as a std::set key") {
        std::set<Sid> sids;
        sids.insert(localSystemSid);
        REQUIRE(sids.contains(localSystemSid));
        REQUIRE(sids.contains(Sid::fromPtr(SID_LOCAL_SYSTEM)));

        Sid copy = localSystemSid;
        REQUIRE(sids.contains(copy));

        REQUIRE_FALSE(sids.contains(machineSid()));

        sids.insert(machineSid());
        REQUIRE(sids.contains(machineSid()));
    }

    SECTION("Using Sid as a std::unordered_set key") {
        std::unordered_set<Sid> sids;
        sids.insert(localSystemSid);
        REQUIRE(sids.contains(localSystemSid));
        REQUIRE(sids.contains(Sid::fromPtr(SID_LOCAL_SYSTEM)));

        Sid copy = localSystemSid;
        REQUIRE(sids.contains(copy));

        REQUIRE_FALSE(sids.contains(machineSid()));

        sids.insert(machineSid());
        REQUIRE(sids.contains(machineSid()));
    }
}