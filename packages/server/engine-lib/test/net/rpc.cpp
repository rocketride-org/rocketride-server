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

using namespace engine::net::rpc;

struct MyCommandParams {
    _const auto Name = "myCommand";

    struct Request {
        Text arg1;
        Size arg2;

        static auto __fromJson(Request& rqu, const json::Value& val) noexcept {
            rqu.arg1 = _fj<decltype(rqu.arg1)>(val["arg1"]);
            rqu.arg2 = _fj<decltype(rqu.arg2)>(val["arg2"]);
        }

        auto __toJson(json::Value& val) const noexcept {
            val["arg1"] = _tj(arg1);
            val["arg2"] = _tj(arg2);
        }
    };

    struct Reply {
        Text arg1;
        Size arg2;

        static auto __fromJson(Reply& rpl, const json::Value& val) noexcept {
            rpl.arg1 = _fj<decltype(rpl.arg1)>(val["arg1"]);
            rpl.arg2 = _fj<decltype(arg2)>(val["arg2"]);
        }

        auto __toJson(json::Value& val) const noexcept {
            val["arg1"] = _tj(arg1);
            val["arg2"] = _tj(arg2);
        }
    };
};

using MyCommand = Command<MyCommandParams>;

TEST_CASE("net::rpc") {
    SECTION("Packet") {
        SECTION("PacketHdr") {
            SECTION("RQU") {
                PacketHdr<Type::RQU> header{10, 10, 1};
                REQUIRE(_ts(header) == "@PDU:RQU:00000001:0000000a:0000000a@");
                header = {};
                header = _fs<decltype(header)>(
                    "@PDU:RQU:00000001:0000000a:0000000a@");
                REQUIRE(header.type == Type::RQU);
                REQUIRE(header.id == 1);
                REQUIRE(header.length == 10);
                REQUIRE(header.dataLength == 10);
            }

            SECTION("RPL") {
                PacketHdr<Type::RPL> header{10, 10, 1};
                REQUIRE(_ts(header) == "@PDU:RPL:00000001:0000000a:0000000a@");
                header = {};
                header = _fs<decltype(header)>(
                    "@PDU:RPL:00000001:0000000a:0000000a@");
                REQUIRE(header.type == Type::RPL);
                REQUIRE(header.id == 1);
                REQUIRE(header.length == 10);
                REQUIRE(header.dataLength == 10);
            }
        }

        SECTION("RquPacket") {
            RquPacket<MyCommand> rqu;
            rqu->data.arg1 = "fu";
            rqu->data.arg2 = 13_mb;
            auto [hdr, payload, data] = _mv(*rqu.marshal());
            REQUIRE(hdr.id != 0);

            auto rqu2 = _mv(*RquPacket<MyCommand>::parse(
                {payload.size(), 0, hdr.id}, payload));
            REQUIRE(rqu2.id == hdr.id);
            REQUIRE(rqu2->data.arg1 == "fu");
            REQUIRE(rqu2->data.arg2 == 13_mb);
        }

        SECTION("RplPacket") {
            RplPacket<MyCommand> rpl;
            rpl->data.arg1 = "bobo";
            rpl->data.arg2 = 1_gb;
            auto [hdr, payload, data] = _mv(*rpl.marshal());
            REQUIRE(hdr.id != 0);

            auto rpl2 = _mv(*RplPacket<MyCommand>::parse(
                {payload.size(), 0, hdr.id}, payload));
            REQUIRE(rpl2.id == hdr.id);
            REQUIRE(rpl2->data.arg1 == "bobo");
            REQUIRE(rpl2->data.arg2 == 1_gb);
        }
    }
}
