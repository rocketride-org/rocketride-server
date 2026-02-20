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

namespace engine::net::rpc::v3::file {

// File open
struct OpenParam {
    _const auto Name = "api.v3.file.open";

    struct Request {
        ap::file::Path directory;
        ap::file::Path filename;
        Text mode = "w+";
        Text nodeId = config::nodeId();

        auto __jsonSchema() const noexcept {
            return json::makeSchema(directory, "directory", filename,
                                    "filename", mode, "mode", nodeId, "nodeId");
        }
    };

    struct Reply {
        Text hFile;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(hFile, "hFile");
        }
    };
};

using Open = Command<OpenParam>;

// File write
struct WriteParam {
    _const auto Name = "api.v3.file.write";

    struct Request {
        Text hFile;
        size_t length;
        uint64_t position;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(hFile, "hFile", length, "length", position,
                                    "position");
        }
    };

    struct Reply {
        size_t length;
        uint64_t position;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(length, "length", position, "position");
        }
    };
};

using Write = Command<WriteParam>;

// File length
struct LengthParam {
    _const auto Name = "api.v3.file.length";

    struct Request {
        Text hFile;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(hFile, "hFile");
        }
    };

    struct Reply {
        uint64_t size;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(size, "size");
        }
    };
};

using Length = Command<LengthParam>;

// File remove
struct RemoveParam {
    _const auto Name = "api.v3.file.remove";

    struct Request {
        Text directory;
        Text filename;
        Text nodeId = config::nodeId();

        auto __jsonSchema() const noexcept {
            return json::makeSchema(directory, "directory", filename,
                                    "filename", nodeId, "nodeId");
        }
    };

    struct Reply {
        auto __toJson(json::Value &val) const noexcept {
            val = json::ValueType::objectValue;
        }
        static auto __fromJson(Reply &, const json::Value &) noexcept {}
    };
};

using Remove = Command<RemoveParam>;

// File read
struct ReadParam {
    _const auto Name = "api.v3.file.read";

    struct Request {
        Text hFile;
        size_t length;
        uint64_t position;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(hFile, "hFile", length, "length", position,
                                    "position");
        }
    };

    struct Reply {
        size_t length;
        uint64_t position;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(length, "length", position, "position");
        }
    };
};

using Read = Command<ReadParam>;

// File close
struct CloseParam {
    _const auto Name = "api.v3.file.close";

    struct Request {
        Text hFile;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(hFile, "hFile");
        }
    };

    struct Reply {
        auto __toJson(json::Value &val) const noexcept {
            val = json::ValueType::objectValue;
        }
        static auto __fromJson(Reply &, const json::Value &) noexcept {}
    };
};

using Close = Command<CloseParam>;

}  // namespace engine::net::rpc::v3::file
