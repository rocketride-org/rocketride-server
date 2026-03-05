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

#pragma once

namespace engine::net::rpc {

// A command extends a packet and adds some logical fields on top
// of the inner custom type
template <typename DataT>
struct CommandRequest {
    using RequestType = typename DataT::Request;

    _const auto commandId = DataT::Name;

    Text connectionId;
    Text executeBy;
    Text executeOn;

    RequestType data;

    static Error __fromJson(CommandRequest &hdr,
                            const json::Value &val) noexcept {
        hdr.executeOn = val["executeOn"].asString();
        hdr.executeBy = val["executeBy"].asString();
        hdr.connectionId = val["connectionId"].asString();

        if (val["commandId"].asString() != commandId)
            return APERR(Ec::InvalidRpc, "Command id mismatch", hdr.commandId,
                         val["commandId"]);

        auto data = _fjc<RequestType>(val.lookup("data"));
        if (!data) return data.ccode();
        hdr.data = _mv(*data);
        return {};
    }

    auto __toJson(json::Value &val) const noexcept {
        val["executeOn"] = executeOn;
        val["executeBy"] = executeBy;
        val["connectionId"] = connectionId;
        val["commandId"] = commandId;
        val["data"] = _tj(data);
        val["route"] = json::ValueType::arrayValue;
    }
};

template <typename DataT>
struct CommandReply {
    using ReplyType = typename DataT::Reply;

    json::Value status;

    ReplyType data;

    static Error __fromJson(CommandReply &hdr,
                            const json::Value &val) noexcept {
        hdr.status = val["status"];

        auto data = _fjc<ReplyType>(val.lookup("data"));
        if (!data) return data.ccode();

        hdr.data = _mv(*data);
        return {};
    }

    auto __toJson(json::Value &val) const noexcept {
        val["status"] = status;
        val["data"] = _tj(data);
    }
};

// Front end factory template for instantiating a wrapped
// command request and reply
template <typename T>
class Command {
public:
    using Request = CommandRequest<T>;
    using Reply = CommandReply<T>;
};

}  // namespace engine::net::rpc