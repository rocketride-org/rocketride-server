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

// A scanner takes a generic type that implements a scan of something
template <
    typename ChrT, typename AllocT, Lvl LevelT,
    template <typename ChrTT, typename AlocTT, Lvl LevelTT> typename ScannerT>
class Scanner final {
public:
    using ScannerType = ScannerT<ChrT, AllocT, LevelT>;
    using PathType = FilePath<ChrT, AllocT>;
    using StrType = typename PathType::StrType;
    using EntryType = typename ScannerType::EntryType;
    _const auto LogLevel = ScannerType::LogLevel;

    // Declare an attribute so we can toggle result types based on
    // whether EntryType in the scanSner is void or not
    _const auto HasEntry = !std::is_void_v<EntryType>;

    Scanner(PathType path = {}, const AllocT &allocator = {}) noexcept
        : m_path(_mv(path), allocator) {}

    // Initiate a find from the start of the dir
    template <typename... Args>
    Error open(Args &&...args) noexcept {
        // Start a new find operation
        LOGT("Open", m_path);
        return m_enum.open(m_path.plat(), std::forward<Args>(args)...);
    }

    // Read the next scanned item, if we have an entry type
    // defined it will return a Pair<StrType, EntryType>, otherwise
    // just a StrType (both wrapped in an ErrorOr)
    auto next() noexcept -> ErrorOr<
        std::conditional_t<HasEntry, Pair<StrType, EntryType>, StrType>> {
        if constexpr (HasEntry) {
            StrType name{m_path.get_allocator()};
            EntryType entry;
            if (auto ccode = m_enum.read(name, entry)) return ccode;

            LOGT("Next {} isDir", name, entry.isDir);

            return makePair(_mv(name), _mv(entry));
        } else {
            StrType name{m_path.get_allocator()};

            if (auto ccode = m_enum.read(name)) return ccode;

            LOGT("Next", name);

            return name;
        }
    }

    // Reset closes the find handle if it isn't already closed
    void close() noexcept { m_enum.close(); }

    decltype(auto) path() const noexcept { return m_path; }

    // Return absolute path of scanned name (will fail to compile if unsupported
    // by scanner API)
    PathType pathOf(const StrType &name) noexcept {
        return m_enum.pathOf(name);
    }

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "Scan[" << m_path << "]";
    }

private:
    PathType m_path;
    ScannerType m_enum;
};

}  // namespace ap::file::scan
