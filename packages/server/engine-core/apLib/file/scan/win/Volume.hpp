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

namespace wil {
// Typedef the FindVolume smart handle (requires special close function)
typedef unique_any_handle_invalid<decltype(&::FindVolumeClose),
                                  ::FindVolumeClose>
    unique_hfindvolume;
}  // namespace wil

namespace ap::file::scan {

// Windows version of the os directory enumerator
template <typename ChrT = Utf8Chr, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::Volume>
class Volume {
public:
    // Null entry type
    using EntryType = void;

    using PathType = FilePath<ChrT, AllocT>;
    using StrType = typename PathType::StrType;
    using ArrayName = Array<WCHAR, MAX_PATH + 1>;

    _const auto LogLevel = LevelT;

    // Initiate a find from the start of the dir
    Error open(const StrType &) noexcept {
        // Close the last one if started already
        close();

        // Start a new find operation
        ArrayName name;
        m_hFind.reset(
            ::FindFirstVolumeW(&name.front(), _cast<DWORD>(name.size())));
        if (!m_hFind)
            return APERRT(::GetLastError(), "Failed to find a first volume");

        // Stash first for later
        m_firstVol = name;
        return {};
    }

    // Reads another vol for the volume info scan, no entry
    // type is declared for volumes as no additional info is
    // given to us at scan time
    Error read(StrType &name) noexcept {
        if (m_firstVol) {
            name = &_mvOpt(m_firstVol).front();
            return {};
        }

        ArrayName nextName;
        if (::FindNextVolumeW(m_hFind.get(), &nextName.front(),
                              _cast<DWORD>(nextName.size()))) {
            name = &nextName.front();
            return {};
        }

        return APERRT(::GetLastError(), "End of find");
    }

    // Reset closes the find handle if it isn't already closed
    void close() noexcept { m_hFind.reset(); }

private:
    Opt<ArrayName> m_firstVol;
    wil::unique_hfindvolume m_hFind;
};

}  // namespace ap::file::scan
