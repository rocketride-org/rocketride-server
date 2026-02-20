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

namespace engine::perms {

struct Rights {
    Opt<bool> canRead;
    Opt<bool> canWrite;
    Opt<bool> canExecute;

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        // Are both bits set?
        if (canRead && canWrite) {
            // Do they match?
            if (*canRead == *canWrite)
                buff << (*canRead ? "+rw" : "-rw");
            else
                buff << (*canRead ? "+r-w" : "-r+w");
        } else if (canRead)
            buff << (*canRead ? "+r" : "-r");
        else if (canWrite)
            buff << (*canWrite ? "+w" : "-w");
    }

    template <typename Buffer>
    static Error __fromString(Rights& rights, const Buffer& buff) noexcept {
        auto string = buff.toView();
        if (string == "+rw") {
            rights.canRead = true;
            rights.canWrite = true;
        } else if (string == "-rw") {
            rights.canRead = false;
            rights.canWrite = false;
        } else if (string == "+r-w") {
            rights.canRead = true;
            rights.canWrite = false;
        } else if (string == "-r+w") {
            rights.canRead = false;
            rights.canWrite = true;
        } else if (string == "+r") {
            rights.canRead = true;
            rights.canWrite.reset();
        } else if (string == "-r") {
            rights.canRead = false;
            rights.canWrite.reset();
        } else if (string == "+w") {
            rights.canRead.reset();
            rights.canWrite = true;
        } else if (string == "-w") {
            rights.canRead.reset();
            rights.canWrite = false;
        } else if (string)
            return APERR(Ec::InvalidFormat, "Right string not recognized",
                         string);

        return {};
    }

    explicit operator bool() const noexcept { return canRead || canWrite; }

    bool operator<(const Rights& other) const noexcept {
        return canRead < other.canRead ||
               (!(other.canRead < canRead) && canWrite < other.canWrite);
    }

    bool operator==(const Rights& other) const noexcept {
        return canRead == other.canRead && canWrite == other.canWrite &&
               canExecute == other.canExecute;
    }
};

// Instance permissions objects
#if ROCKETRIDE_PLAT_WIN
struct UserRecord {
    Text id;
    bool local{};
    Utf16 authority;
    Utf16 name;
};

struct GroupRecord {
    Text id;
    bool local{};
    Utf16 authority;
    Utf16 name;
    std::vector<Text> memberIds;
};
#else
struct UserRecord {
    Text id;
    bool local{};
    Text authority;
    Text name;
};

struct GroupRecord {
    Text id;
    bool local{};
    Text authority;
    Text name;
    std::vector<Text> memberIds;
};
#endif

}  // namespace engine::perms
