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

namespace ap::file::scan {

// Windows version of the os directory enumerator
template <typename ChrT = Utf8Chr, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::Volume>
class VolumeMountPoint {
public:
    // Null entry type
    using EntryType = void;

    using PathType = FilePath<ChrT, AllocT>;
    using StrType = typename PathType::StrType;
    using ViewType = typename PathType::ViewType;
    using PathArray = Array<WCHAR, MAX_PATH + 1>;

    using Prefix = PathPrefixList<ViewType>;
    using Prefix16 = PathPrefixList<Utf16View>;

    _const auto LogLevel = LevelT;

    // Close on destruct
    ~VolumeMountPoint() noexcept { close(); }

    // Initiate a find from the start of the dir
    Error open(StrType path) noexcept {
        // Close the last one if started already
        close();

        auto closeGuard = util::Guard{[&] { close(); }};

        if (!path.endsWith(Prefix::SepPlat)) path.append(Prefix::SepPlat);

        // We may need to resize so start with a default
        m_names.resize(MAX_PATH + 1);
        _forever() {
            // Volume path names wants a path prefix, and trailing sep
            DWORD len;
            if (!::GetVolumePathNamesForVolumeNameW(
                    path, m_names.data(), _cast<DWORD>(m_names.size()), &len)) {
                if (::GetLastError() == ERROR_MORE_DATA) {
                    m_names.resize(len);
                    continue;
                }
                return APERRT(::GetLastError(), "Could not query path names",
                              path);
            }

            m_names.resize(len);

            break;
        }

        closeGuard.cancel();

        return {};
    }

    Error read(StrType& name) noexcept {
        if (!m_next) {
            if (!m_names) return APERRT(Ec::End, "End of scan");
        } else {
            if (m_next == string::npos || m_next + 2 >= m_names.size())
                return APERRT(Ec::End, "End of scan");
            m_next++;
        }

        auto next = m_names.find_first_of(L'\0', m_next);
        name = m_names.substr(m_next, next);
        m_next = next;

        if (!name) return APERRT(Ec::End, "End of scan");

        return {};
    }

    // Reset closes the find handle if it isn't already closed
    void close() noexcept {
        m_names.clear();
        m_next = {};
    }

    template <typename Buffer>
    auto __toString(Buffer& buff) const noexcept {
        buff << "VolumeMountPointScanner";
    }

private:
    Utf16 m_names;
    size_t m_next = {};
};

}  // namespace ap::file::scan
