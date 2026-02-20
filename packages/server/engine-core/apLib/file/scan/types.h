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

namespace ap::file {

// Provide helpers for when you need speed and want to customize
// the encoding and type, or use a custom allocator within the
// scan namespace, for regular day to day usage declare
// a TextChr version in the root file namespace, best of both
// worlds
namespace scan {
template <typename ChrT, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::File>
using FileScanner = Scanner<ChrT, AllocT, LevelT, File>;

#if ROCKETRIDE_PLAT_WIN
template <typename ChrT, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::Volume>
using VolumeScanner = Scanner<ChrT, AllocT, LevelT, Volume>;
template <typename ChrT, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::Volume>
using VolumeMountPointScanner = Scanner<ChrT, AllocT, LevelT, VolumeMountPoint>;
template <typename ChrT, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::Volume>
using DriveLetterScanner = Scanner<ChrT, AllocT, LevelT, DriveLetter>;
#else
template <typename ChrT, typename AllocT = std::allocator<ChrT>,
          Lvl LevelT = Lvl::Volume>
using MountPointScanner = Scanner<ChrT, AllocT, LevelT, MountPoint>;
#endif
}  // namespace scan

using FileScanner = scan::FileScanner<TextChr>;
#if ROCKETRIDE_PLAT_WIN
using VolumeScanner = scan::VolumeScanner<TextChr>;
using VolumeMountPointScanner = scan::VolumeMountPointScanner<TextChr>;
using DriveLetterScanner = scan::DriveLetterScanner<TextChr>;
#else
using MountPointScanner = scan::MountPointScanner<TextChr>;
#endif

}  // namespace ap::file
