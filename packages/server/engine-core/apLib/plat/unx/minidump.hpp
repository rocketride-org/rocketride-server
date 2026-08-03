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

// Include from exactly one cpp: keeps crashpad/mini_chromium headers out of the
// rest of the codebase.
#ifndef AP_PLAT_MINIDUMP_CPP_PRIVATE_INCLUDE
#error Must only be included from another cpp
#endif

#undef AP_PLAT_MINIDUMP_CPP_PRIVATE_INCLUDE

#include <sys/stat.h>
#include <unistd.h>
#include <cerrno>
#include <cstdio>
#include <filesystem>
#include <map>
#include <string>
#include <vector>

// mini_chromium's base defines a stream-style LOG macro; shield the engine's.
#pragma push_macro("LOG")
#undef LOG
#include <base/files/file_path.h>
#include <client/crash_report_database.h>
#include <client/crashpad_client.h>
#include <client/settings.h>
#pragma pop_macro("LOG")

namespace ap::plat {

namespace internal {

inline base::FilePath toFilePath(const file::Path &path) noexcept {
    return base::FilePath{std::string{_ts(path).c_str()}};
}

// Create `dir` 0700 and confirm it is really ours. Linux temp is world-writable,
// so a predictable name lets any local user pre-create the directory -- or leave
// a symlink there -- and quietly divert minidumps, which carry process memory.
// lstat, not stat, is what rejects the symlink.
inline bool ensurePrivateDir(const std::filesystem::path &dir) noexcept {
    if (::mkdir(dir.c_str(), 0700) != 0 && errno != EEXIST) return false;

    struct ::stat st {};
    if (::lstat(dir.c_str(), &st) != 0) return false;

    return S_ISDIR(st.st_mode) && st.st_uid == ::geteuid()
           && (st.st_mode & (S_IRWXG | S_IRWXO)) == 0;
}

inline std::filesystem::path computeCrashDbDir() noexcept {
    std::filesystem::path dir;

    if (auto env = plat::env("ROCKETRIDE_CRASHDB_DIR")) {
        dir = std::filesystem::path{_ts(_cast<file::Path>(env)).c_str()};
    } else {
        std::error_code ec;
        auto base = std::filesystem::temp_directory_path(ec);
        if (ec) {
            LOG(Error, "No usable temp dir; crash reporting disabled",
                ec.message());
            return {};
        }

        // Scoped by uid so another user cannot pre-empt or read the database,
        // and by the executable so two installs on one box stay apart. Never by
        // pid: the next startup has to find the previous run's dumps.
        //
        // Read /proc/self/exe rather than application::execPath(): we run from
        // plat::init(), and linmain only resolves the real exec path *after*
        // that, so execPath() would still be argv[0] -- which varies with how
        // the engine was launched and would send each run to a different
        // database. Empty on macOS (no /proc), whose temp is per-user anyway.
        std::error_code exeEc;
        auto exe =
            std::filesystem::read_symlink("/proc/self/exe", exeEc).string();
        auto tag = crypto::crc32({_reCast<const uint8_t *>(exe.data()),
                                  exe.size() * sizeof(exe.data()[0])});

        char suffix[48];
        std::snprintf(suffix, sizeof suffix, "rocketride-crashdb-%u-%08x",
                      static_cast<unsigned>(::geteuid()),
                      static_cast<unsigned>(tag));
        dir = base / suffix;
    }

    std::error_code ec;
    std::filesystem::create_directories(dir.parent_path(), ec);

    if (!ensurePrivateDir(dir)) {
        LOG(Error,
            "Crash DB dir is not private (wrong owner, wrong mode, or a "
            "symlink); crash reporting disabled",
            dir.string());
        return {};
    }
    return dir;
}

// Stable, writable Crashpad database (settings.dat / pending / completed). Kept
// separate from crashDumpLocation(), which is re-pointed per task and may sit in
// a read-only install dir; temp is writable in every deployment. Resolved once
// so the ownership check, and its error log, happen a single time per process.
inline const std::filesystem::path &crashDbDir() noexcept {
    static const std::filesystem::path dir = computeCrashDbDir();
    return dir;
}

// Move a dump out of the DB into crashDumpLocation() with the app's canonical
// name, then notify. rename() with copy+remove fallback for cross-filesystem.
inline void relocateAndNotify(const std::filesystem::path &src) noexcept {
    auto target = dev::createCrashDumpPath("dmp"_tv);
    std::filesystem::path targetFs{_ts(target).c_str()};

    std::error_code ec;
    std::filesystem::rename(src, targetFs, ec);
    if (ec) {
        ec.clear();
        std::filesystem::copy_file(
            src, targetFs, std::filesystem::copy_options::overwrite_existing,
            ec);
        if (ec) {
            LOG(Error, "Failed to relocate minidump", src.string(),
                ec.message());
            return;
        }
        std::filesystem::remove(src, ec);
    }

    LOG(Error, "Minidump recovered:", target);
    if (dev::crashDumpCreatedCallback()) dev::crashDumpCreatedCallback()(target);
}

// crashpad_handler writes dumps out-of-process after the app is gone, so the
// crashDumpCreatedCallback cannot fire at crash time. We instead recover a
// previous run's dumps on the next startup -- notification is deferred one run.
inline void sweepPreviousDumps(const std::filesystem::path &dbDir) noexcept {
    if (dbDir.empty()) return;  // crash reporting is off; nothing to recover

    for (const char *sub : {"pending", "completed"}) {
        auto dir = dbDir / sub;
        std::error_code ec;
        if (!std::filesystem::exists(dir, ec)) continue;

        std::filesystem::directory_iterator it{dir, ec}, end;
        for (; !ec && it != end; it.increment(ec)) {
            const auto &p = it->path();
            if (p.extension() == ".dmp") relocateAndNotify(p);
        }
    }
}

}  // namespace internal

// Owns the Crashpad client for the process lifetime. Construction starts the
// out-of-process handler; there is no clean stop API.
class Minidump {
public:
    Minidump() noexcept {
        // Handler ships next to the engine binary in dist/server; an env var
        // overrides for relocated installs / CI.
        file::Path handlerPath;
        if (auto env = plat::env("ROCKETRIDE_CRASHPAD_HANDLER"))
            handlerPath = _cast<file::Path>(env);
        else
            handlerPath = application::execDir() / "crashpad_handler";

        if (!file::exists(handlerPath)) {
            LOG(Error, "crashpad_handler not found; crash reporting disabled",
                handlerPath);
            return;
        }

        const auto &dbDir = internal::crashDbDir();
        if (dbDir.empty()) return;  // computeCrashDbDir() logged the reason

        auto database = crashpad::CrashReportDatabase::Initialize(
            base::FilePath{std::string{dbDir.string()}});
        if (!database)
            // StartHandler below still reports success, so without this the
            // failure is indistinguishable from a healthy start.
            LOG(Error, "Crashpad database unusable; dumps will not be recorded",
                dbDir.string());
        else if (database->GetSettings())
            database->GetSettings()->SetUploadsEnabled(false);

        // Static process context; per-task id is applied to the recovered dump
        // name at sweep time.
        auto str = [](auto &&v) { return std::string{_ts(v).c_str()}; };
        std::map<std::string, std::string> annotations;
        annotations["exe"] = str(application::execPath().fileName(true));
        if (auto version = application::projectVersion())
            annotations["version"] = str(version);
        if (auto hash = application::buildHash()) annotations["build"] = str(hash);
        annotations["host"] = str(plat::hostName());

        // More memory: Crashpad has no full-memory flag; nominate ranges via
        // CrashpadInfo::set_extra_memory_ranges() (gated on Heap/IsDebug like
        // plat/win/minidump.hpp) when a buffer worth capturing exists.

        bool ok = m_client.StartHandler(
            internal::toFilePath(handlerPath),
            base::FilePath{std::string{dbDir.string()}},
            /*metrics_dir=*/base::FilePath{},
            /*url=*/std::string{}, annotations,
            /*arguments=*/std::vector<std::string>{},
            /*restartable=*/true,
            /*asynchronous_start=*/false);

        if (ok)
            LOG(Dev, "Crashpad handler started", handlerPath);
        else
            LOG(Error, "Failed to start Crashpad handler", handlerPath);
    }

    ~Minidump() noexcept = default;

private:
    crashpad::CrashpadClient m_client;
};

}  // namespace ap::plat
