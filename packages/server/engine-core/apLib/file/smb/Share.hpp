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

namespace ap::file::smb {

// Represents an SMB share
struct Share {
    Text server;
    Text originalName;
    Text username;
    Text password;
    std::vector<Text> names;

    auto __jsonSchema() const noexcept {
        return json::makeSchema(server, "server", originalName, "name",
                                username, "username", password, "password");
    }

    bool valid() const noexcept {
        return server.length() >= 3 &&
               server.length() <
                   255;  // (63 letters).(63 letters).(63 letters).(62 letters)
    }

    bool validUserName() const noexcept {
        if (username && username.count('\\') != 1) return false;
        return true;
    }

    explicit operator bool() const noexcept { return valid(); }

    Text getSystemName() const noexcept {
        auto splitted = username.split('\\');
        if (splitted.size() > 0) return splitted[0];
        return "";
    }

    file::Path path() const noexcept {
        if (!originalName.empty())
            return string::format("//{}/{}", server, originalName);
        return string::format("//{}", server);
    }

    operator file::Path() const noexcept { return path(); }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << path();
    }

    bool operator==(const Share& other) const noexcept {
        return server == other.server && originalName == other.originalName &&
               username == other.username && password == other.password;
    }

    bool operator!=(const Share& other) const noexcept {
        return !operator==(other);
    }
};

}  // namespace ap::file::smb