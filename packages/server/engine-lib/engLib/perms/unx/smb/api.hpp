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
#define FILE_READ_DATA (0x00000001)
#define FILE_WRITE_DATA (0x00000002)
#define FILE_APPEND_DATA (0x00000004)
#define FILE_READ_EA (0x00000008)
#define FILE_WRITE_EA (0x00000010)
#define FILE_EXECUTE (0x00000020)
#define FILE_READ_ATTRIBUTE (0x00000080)
#define FILE_WRITE_ATTRIBUTE (0x00000100)
namespace engine::smb::perms {
using namespace engine::perms;

inline Rights makeRights_smb(uint32_t mode,
                             enum security_ace_type type) noexcept {
    Rights rights;
    bool allowed = true;
    switch (type) {
        case SEC_ACE_TYPE_ACCESS_ALLOWED:
        case SEC_ACE_TYPE_ACCESS_ALLOWED_OBJECT:
            allowed = true;
            break;
        case SEC_ACE_TYPE_ACCESS_DENIED:
        case SEC_ACE_TYPE_ACCESS_DENIED_OBJECT:
            allowed = false;
            break;
        default:
            allowed = false;
            MONERR(warning, Ec::Warning, "Unknown type of access", type);
    }
    if (mode & (FILE_READ_DATA | FILE_READ_ATTRIBUTE)) rights.canRead = allowed;
    if (mode & (FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_ATTRIBUTE))
        rights.canWrite = allowed;
    if (mode & (FILE_EXECUTE)) rights.canExecute = allowed;

    // if no value set
    if (!rights.canRead.has_value() && !rights.canWrite.has_value() &&
        !rights.canExecute.has_value()) {
        rights.canExecute = false;
        rights.canWrite = false;
        rights.canRead = false;
    }
    return rights;
}

}  // namespace engine::smb::perms
