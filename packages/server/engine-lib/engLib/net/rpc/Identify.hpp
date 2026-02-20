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

#pragma once

namespace engine::net::rpc {

// Identify exchanges information about the peer and the
// client, nodeName/nodeId, its the lowest level handshake
// between two connected peers
struct IdentifyParam {
    _const auto Name = "network.identify";

    // Identify has the same request and reply layout
    // so just declare a Payload then forward the types
    struct Payload {
        Text nodeName;
        Text nodeClassId;
        Text nodeId;

        static auto __fromJson(Payload& rqu, const json::Value& val) noexcept {
            return val.lookupAssign("nodeName", rqu.nodeName) ||
                   val.lookupAssign("nodeClassid", rqu.nodeClassId) ||
                   val.lookupAssign("nodeId", rqu.nodeId);
        }

        auto __toJson(json::Value& val) const noexcept {
            val["nodeName"] = nodeName;
            val["nodeClassId"] = nodeClassId;
            val["nodeId"] = nodeId;
        }

        template <typename Buffer>
        auto __toString(Buffer& buff) const noexcept {
            buff << "nodeName:" << nodeName << "nodeClassId:" << nodeClassId
                 << "nodeId:" << nodeId;
        }
    };

    using Reply = Payload;
    using Request = Payload;
};

// Now declare identify as a wrapped command, this adds the standard
// logical command fields on top of this param
using Identify = Command<IdentifyParam>;

}  // namespace engine::net::rpc
