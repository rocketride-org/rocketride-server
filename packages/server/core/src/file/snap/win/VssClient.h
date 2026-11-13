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

namespace ap::file::snap {

class VssClient {
public:
    _const auto LogLevel = Lvl::Snap;
    _const auto PersistedType = VSS_CTX_BACKUP | VSS_CTX_NAS_ROLLBACK;
    _const auto TempType = VSS_CTX_BACKUP | VSS_CTX_FILE_SHARE_BACKUP;

    VssClient() noexcept = default;

    VssClient(const VssClient&) = delete;
    VssClient& operator=(const VssClient&) = delete;

    VssClient(VssClient&& client) noexcept { move(_mv(client)); }

    decltype(auto) operator=(VssClient&& client) noexcept {
        return move(_mv(client));
    }

    ~VssClient() noexcept;
    Error init(bool persist) noexcept;
    Error startSnapset() noexcept;
    Error add(const file::Path& vol) noexcept;
    Error doSnapshot() noexcept;
    ErrorOr<PathMap> list() const noexcept;
    Error destroy() noexcept;

    auto type() const noexcept { return m_type; }

    auto detach() noexcept {
        if (m_backup) m_backup.Release();
        m_setId.reset();
        ASSERT(!m_backup);
    }

    auto attached() const noexcept { return m_setId.has_value(); }

    static Error destroy(const SnapMap& snaps) noexcept;

private:
    VssClient& move(VssClient&& client) noexcept {
        if (&client == this) return *this;
        m_type = _exch(client.m_type, {});
        m_backup = _mv(client.m_backup);
        ASSERT(!client.m_backup);
        m_setId = _mvOpt(client.m_setId);
        ASSERT(!client.m_setId);
        return *this;
    }

    VSS_SNAPSHOT_CONTEXT m_type = {};
    CComPtr<IVssBackupComponents> m_backup;
    Opt<VSS_ID> m_setId;
};

}  // namespace ap::file::snap