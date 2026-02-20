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

namespace ap::file::scan {

// Windows version of the os directory enumerator
template <typename ChrT = Utf8Chr, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::Volume>
class DriveLetter {
public:
    // Null entry type
    using EntryType = void;

    using PathType = FilePath<ChrT, AllocT>;
    using StrType = typename PathType::StrType;
    using ArrayName = Array<WCHAR, MAX_PATH + 1>;

    _const auto LogLevel = LevelT;

    // Close on destruct
    ~DriveLetter() noexcept { close(); }

    // Initiate a find from the start of the dir
    Error open(const StrType &) noexcept {
        // Close the last one if started already
        close();
        m_driveMap = getDriveMap();
        m_nextDrive = 'A';
        return {};
    }

    // Reads another vol for the volume info scan, no entry
    // type is declared for volumes as no additional info is
    // given to us at scan time
    Error read(StrType &name) noexcept {
        if (!(name = nextDrive())) return APERRT(Ec::End, "End of scan");

        if (::GetDriveTypeW(name) == DRIVE_FIXED) return {};

        return read(name);
    }

    // Reset closes the find handle if it isn't already closed
    void close() noexcept {}

    template <typename Buffer>
    auto __toString(Buffer &buff) const noexcept {
        buff << "DriveLetterScanner";
    }

private:
    StrType nextDrive() noexcept {
        if (m_nextDrive > 'Z') return {};

        auto next = m_nextDrive++;

        while (!(BIT((next - 'A')) & m_driveMap) && next <= 'Z')
            next = m_nextDrive++;

        if (next > 'Z') return {};

        return _ts(next, ":\\");
    }
    uint32_t m_driveMap = {};
    TextChr m_nextDrive;
};

}  // namespace ap::file::scan
