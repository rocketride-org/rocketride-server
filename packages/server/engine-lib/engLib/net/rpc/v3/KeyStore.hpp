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

namespace engine::net::rpc::v3::keystore {
/**
 * @brief Defines `get` command for the key store RPC
 */
struct GetParam {
    _const auto Name = "api.v3.keystore.get";

    struct Request {
        Text partition;
        Text key;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(partition, "partition", key, "key");
        }
    };

    struct Reply {
        Text value;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(value, "value");
        }
    };
};

using Get = net::rpc::Command<GetParam>;

/**
 * @brief Defines `set` command for the key store RPC
 */
struct SetParam {
    _const auto Name = "api.v3.keystore.set";

    struct Request {
        Text partition;
        Text key;
        Text value;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(partition, "partition", key, "key", value,
                                    "value");
        }
    };

    struct Reply {
        auto __toJson(json::Value &val) const noexcept {
            val = json::ValueType::objectValue;
        }
        static auto __fromJson(Reply &repl, const json::Value &val) noexcept {}
    };
};

using Set = net::rpc::Command<SetParam>;

/**
 * @brief Defines `delete` command for the key store RPC
 */
struct DeleteParam {
    _const auto Name = "api.v3.keystore.delete";

    struct Request {
        Text partition;
        Text key;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(partition, "partition", key, "key");
        }
    };

    struct Reply {
        auto __toJson(json::Value &val) const noexcept {
            val = json::ValueType::objectValue;
        }
        static auto __fromJson(Reply &repl, const json::Value &val) noexcept {}
    };
};

using Delete = net::rpc::Command<DeleteParam>;

/**
 * @brief Defines `deleteAll` command for the key store RPC
 */
struct DeleteAllParam {
    _const auto Name = "api.v3.keystore.deleteAll";

    struct Request {
        Text partition;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(partition, "partition");
        }
    };

    struct Reply {
        auto __toJson(json::Value &val) const noexcept {
            val = json::ValueType::objectValue;
        }
        static auto __fromJson(Reply &repl, const json::Value &val) noexcept {}
    };
};

using DeleteAll = net::rpc::Command<DeleteAllParam>;

/**
 * @brief Defines `getAll` command for the key store RPC
 */
struct GetAllParam {
    _const auto Name = "api.v3.keystore.getAll";

    struct Request {
        Text partition;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(partition, "partition");
        }
    };

    struct Reply {
        using Values = std::map<Text, Text>;
        Values values;

        auto __toJson(json::Value &val) const noexcept {
            val = json::ValueType::objectValue;
        }

        static auto __fromJson(Reply &repl, const json::Value &val) noexcept {
            Values values;
            for (Text key : val.getMemberNames()) {
                Text value = val[key].asString();
                values[_mv(key)] = _mv(value);
            }
            repl.values.swap(values);
        }
    };
};

using GetAll = net::rpc::Command<GetAllParam>;

/**
 * @brief Defines `copyAll` command for the key store RPC
 */
struct CopyAllParam {
    _const auto Name = "api.v3.keystore.copyAll";

    struct Request {
        Text srcPartition;
        Text destPartition;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(srcPartition, "srcPartition", destPartition,
                                    "destPartition");
        }
    };

    struct Reply {
        auto __toJson(json::Value &val) const noexcept {
            val = json::ValueType::objectValue;
        }
        static auto __fromJson(Reply &repl, const json::Value &val) noexcept {}
    };
};

using CopyAll = net::rpc::Command<CopyAllParam>;

/**
 * @brief Defines `moveAll` command for the key store RPC
 */
struct MoveAllParam {
    _const auto Name = "api.v3.keystore.moveAll";

    struct Request {
        Text srcPartition;
        Text destPartition;
        bool deleteDest;
        bool skipEmptySource;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(srcPartition, "srcPartition", destPartition,
                                    "destPartition", deleteDest, "deleteDest",
                                    skipEmptySource, "skipEmptySource");
        }
    };

    struct Reply {
        auto __toJson(json::Value &val) const noexcept {
            val = json::ValueType::objectValue;
        }
        static auto __fromJson(Reply &repl, const json::Value &val) noexcept {}
    };
};

using MoveAll = net::rpc::Command<MoveAllParam>;

}  // namespace engine::net::rpc::v3::keystore
