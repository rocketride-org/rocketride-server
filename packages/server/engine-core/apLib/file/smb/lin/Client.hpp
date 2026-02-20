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

#include <pthread.h>
#include "samba_includes/rpc_client.h"

typedef void TALLOC_CTX;
typedef uint32_t NTSTATUS;

struct dcls {
    ap::Text ownerId;
    enum security_ace_type type;
    uint32_t mask;
};

struct sec_descriptor {
    ap::Text ownerId;
    ap::Text groupId;
    std::vector<struct dcls> dcls;
    struct dcls findId(ap::Text ownerId) const noexcept {
        for (auto const &dcl : dcls) {
            if (dcl.ownerId == ownerId) return dcl;
        }
        return {};
    };
    void removeDcl(ap::Text ownerId) noexcept {
        for (auto it = std::begin(dcls); it != std::end(dcls);) {
            if (it->ownerId == ownerId) {
                dcls.erase(it);
                break;
            }
        }
    }
};

// Enum for a USER or a GROUP
enum class idPermissionType { USER = 0, GROUP };

// Struct to store User name, authority and User type
struct smb_names {
    ap::Text name;
    ap::Text authority;
    idPermissionType type;
};

namespace ap::file::smb {
#define GENERIC_EXECUTE_ACCESS 0x20000000
#define SEC_MASK_GENERIC (0xF0000000)
#define SEC_MASK_FLAGS (0x0F000000)
#define SEC_MASK_STANDARD (0x00FF0000)
#define SEC_MASK_SPECIFIC (0x0000FFFF)
#define SEC_GENERIC_ALL (0x10000000)
#define SEC_GENERIC_EXECUTE (0x20000000)
#define SEC_GENERIC_WRITE (0x40000000)
#define SEC_GENERIC_READ (0x80000000)
#define SEC_FLAG_SYSTEM_SECURITY (0x01000000)
#define SEC_FLAG_MAXIMUM_ALLOWED (0x02000000)
#define SEC_STD_DELETE (0x00010000)
#define SEC_STD_READ_CONTROL (0x00020000)
#define SEC_STD_WRITE_DAC (0x00040000)
#define SEC_STD_WRITE_OWNER (0x00080000)
#define SEC_STD_SYNCHRONIZE (0x00100000)
#define SEC_STD_REQUIRED (0x000F0000)
#define SEC_STD_ALL (0x001F0000)
#define SEC_FILE_READ_DATA (0x00000001)
#define SEC_FILE_WRITE_DATA (0x00000002)
#define SEC_FILE_APPEND_DATA (0x00000004)
#define SEC_FILE_READ_EA (0x00000008)
#define SEC_FILE_WRITE_EA (0x00000010)
#define SEC_FILE_EXECUTE (0x00000020)
#define SEC_FILE_READ_ATTRIBUTE (0x00000080)
#define SEC_FILE_WRITE_ATTRIBUTE (0x00000100)
#define SEC_FILE_ALL (0x000001ff)
#define SEC_DIR_LIST (0x00000001)
#define SEC_DIR_ADD_FILE (0x00000002)
#define SEC_DIR_ADD_SUBDIR (0x00000004)
#define SEC_DIR_READ_EA (0x00000008)
#define SEC_DIR_WRITE_EA (0x00000010)
#define SEC_DIR_TRAVERSE (0x00000020)
#define SEC_DIR_DELETE_CHILD (0x00000040)
#define SEC_DIR_READ_ATTRIBUTE (0x00000080)
#define SEC_DIR_WRITE_ATTRIBUTE (0x00000100)
#define SEC_REG_QUERY_VALUE (0x00000001)
#define SEC_REG_SET_VALUE (0x00000002)
#define SEC_REG_CREATE_SUBKEY (0x00000004)
#define SEC_REG_ENUM_SUBKEYS (0x00000008)
#define SEC_REG_NOTIFY (0x00000010)
#define SEC_REG_CREATE_LINK (0x00000020)
#define SEC_ADS_CREATE_CHILD (0x00000001)
#define SEC_ADS_DELETE_CHILD (0x00000002)
#define SEC_ADS_LIST (0x00000004)
#define SEC_ADS_SELF_WRITE (0x00000008)
#define SEC_ADS_READ_PROP (0x00000010)
#define SEC_ADS_WRITE_PROP (0x00000020)
#define SEC_ADS_DELETE_TREE (0x00000040)
#define SEC_ADS_LIST_OBJECT (0x00000080)
#define SEC_ADS_CONTROL_ACCESS (0x00000100)
#define SEC_MASK_INVALID (0x0ce0fe00)
#define SEC_RIGHTS_FILE_READ                                           \
    (SEC_STD_READ_CONTROL | SEC_STD_SYNCHRONIZE | SEC_FILE_READ_DATA | \
     SEC_FILE_READ_ATTRIBUTE | SEC_FILE_READ_EA)
#define SEC_RIGHTS_FILE_WRITE                                           \
    (SEC_STD_READ_CONTROL | SEC_STD_SYNCHRONIZE | SEC_FILE_WRITE_DATA | \
     SEC_FILE_WRITE_ATTRIBUTE | SEC_FILE_WRITE_EA | SEC_FILE_APPEND_DATA)
#define SEC_RIGHTS_FILE_EXECUTE                                             \
    (SEC_STD_SYNCHRONIZE | SEC_STD_READ_CONTROL | SEC_FILE_READ_ATTRIBUTE | \
     SEC_FILE_EXECUTE)
#define SEC_RIGHTS_FILE_ALL (SEC_STD_ALL | SEC_FILE_ALL)
#define SEC_RIGHTS_DIR_READ (SEC_RIGHTS_FILE_READ)
#define SEC_RIGHTS_DIR_WRITE (SEC_RIGHTS_FILE_WRITE)
#define SEC_RIGHTS_DIR_EXECUTE (SEC_RIGHTS_FILE_EXECUTE)
#define SEC_RIGHTS_DIR_ALL (SEC_RIGHTS_FILE_ALL)
#define SEC_RIGHTS_PRIV_BACKUP                                                \
    (SEC_STD_READ_CONTROL | SEC_FLAG_SYSTEM_SECURITY | SEC_RIGHTS_FILE_READ | \
     SEC_DIR_TRAVERSE)
#define SEC_RIGHTS_PRIV_RESTORE                                           \
    (SEC_STD_WRITE_DAC | SEC_STD_WRITE_OWNER | SEC_FLAG_SYSTEM_SECURITY | \
     SEC_RIGHTS_FILE_WRITE | SEC_DIR_ADD_FILE | SEC_DIR_ADD_SUBDIR |      \
     SEC_STD_DELETE)
#define STANDARD_RIGHTS_ALL_ACCESS (SEC_STD_ALL)
#define STANDARD_RIGHTS_MODIFY_ACCESS (SEC_STD_READ_CONTROL)
#define STANDARD_RIGHTS_EXECUTE_ACCESS (SEC_STD_READ_CONTROL)
#define STANDARD_RIGHTS_READ_ACCESS (SEC_STD_READ_CONTROL)
#define STANDARD_RIGHTS_WRITE_ACCESS \
    ((SEC_STD_WRITE_OWNER | SEC_STD_WRITE_DAC | SEC_STD_DELETE))
#define STANDARD_RIGHTS_REQUIRED_ACCESS                           \
    ((SEC_STD_DELETE | SEC_STD_READ_CONTROL | SEC_STD_WRITE_DAC | \
      SEC_STD_WRITE_OWNER))
#define SEC_ADS_GENERIC_ALL_DS                                            \
    ((SEC_STD_DELETE | SEC_STD_WRITE_DAC | SEC_STD_WRITE_OWNER |          \
      SEC_ADS_CREATE_CHILD | SEC_ADS_DELETE_CHILD | SEC_ADS_DELETE_TREE | \
      SEC_ADS_CONTROL_ACCESS))
#define SEC_ADS_GENERIC_EXECUTE (SEC_STD_READ_CONTROL | SEC_ADS_LIST)
#define SEC_ADS_GENERIC_WRITE \
    ((SEC_STD_READ_CONTROL | SEC_ADS_SELF_WRITE | SEC_ADS_WRITE_PROP))
#define SEC_ADS_GENERIC_READ                                    \
    ((SEC_STD_READ_CONTROL | SEC_ADS_LIST | SEC_ADS_READ_PROP | \
      SEC_ADS_LIST_OBJECT))
#define SEC_ADS_GENERIC_ALL                                                    \
    ((SEC_ADS_GENERIC_EXECUTE | SEC_ADS_GENERIC_WRITE | SEC_ADS_GENERIC_READ | \
      SEC_ADS_GENERIC_ALL_DS))

/* ShareAccess field. */
#define FILE_SHARE_NONE 0 /* Cannot be used in bitmask. */
#define FILE_SHARE_READ 1
#define FILE_SHARE_WRITE 2
#define FILE_SHARE_DELETE 4

/* CreateDisposition field. */
#define FILE_SUPERSEDE \
    0 /* File exists overwrite/supersede. File not exist create. */
#define FILE_OPEN 1         /* File exists open. File not exist fail. */
#define FILE_CREATE 2       /* File exists fail. File not exist create. */
#define FILE_OPEN_IF 3      /* File exists open. File not exist create. */
#define FILE_OVERWRITE 4    /* File exists overwrite. File not exist fail. */
#define FILE_OVERWRITE_IF 5 /* File exists overwrite. File not exist create. \
                             */

struct perm_value {
    const char *perm;
    uint32_t mask;
};
static const struct perm_value standard_values[] = {
    {"READ", SEC_RIGHTS_DIR_READ | SEC_DIR_TRAVERSE},
    {"CHANGE", SEC_RIGHTS_DIR_READ | SEC_STD_DELETE | SEC_RIGHTS_DIR_WRITE |
                   SEC_DIR_TRAVERSE},
    {"FULL", SEC_RIGHTS_DIR_ALL},
    {NULL, 0},
};

// Not used on Linux
struct MountCtx {};

// Wrapper to dynamically load libsmbclient to avoid GPL poisoning
class Client : public Singleton<Client> {
public:
    _const auto LogLevel = Lvl::Smb;

    ~Client() noexcept {
        talloc_free(m_frame);
        if (m_ctx) m_api->free_context(m_ctx, 1);
    }

    // Hash function for dom_sid
    struct dom_sid_hash {
        size_t operator()(const dom_sid &sid) const {
            uint64_t randomNumber = 0x9e3779b9;
            size_t hash_value = std::hash<uint8_t>{}(sid.sid_rev_num);
            hash_value ^= std::hash<int8_t>{}(sid.num_auths);
            for (int i = 0; i < 6; ++i)
                hash_value ^= std::hash<uint8_t>{}(sid.id_auth[i]) +
                              randomNumber + (hash_value << 6) +
                              (hash_value >> 2);
            for (int i = 0; i < sid.num_auths; ++i)
                hash_value ^= std::hash<uint32_t>{}(sid.sub_auths[i]) +
                              randomNumber + (hash_value << 6) +
                              (hash_value >> 2);
            return hash_value;
        }
    };

    Error init(const Text &username, const Text &password) noexcept;
    ErrorOr<std::vector<MountCtx>> mount(const Share &share) noexcept;
    ErrorOr<std::vector<Text>> enumShares(const Share &share,
                                          TextView originalShareName) noexcept;

    void talloc_free(void *ctx) {
        if (ctx) {
            m_api->talloc_free(ctx, __location__);
            ctx = NULL;
        }
    }

    void printStatistics() noexcept {
        if (checkInitialized()) return;
        m_api->printStatistics();
    }

    const auto &mountedShares() const noexcept { return m_mountedShares; }

    ErrorOr<int> openDirectory(const file::Path &path) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;
        if (auto ccode = checkPath(path)) return ccode;

        const auto url = renderSmbUrlEncoded(path);
        auto lock = m_lock.lock();
        if (auto hDirectory = m_api->opendir(url); hDirectory >= 0) {
            LOGT("Opened directory", url, "=>", hDirectory);
            return hDirectory;
        }

        return APERRT(errno, "Failed to open directory", url);
    }

    Error closeDirectory(int hDirectory) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        auto lock = m_lock.lock();
        LOGT("Closing directory", hDirectory);
        if (m_api->closedir(hDirectory))
            return APERRT(errno, "Failed to close directory", hDirectory);
        return {};
    }

    ErrorOr<Text> readDirectory(int hDirectory) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        auto lock = m_lock.lock();
        if (auto dirent = m_api->readdir(hDirectory))
            return dirent->name;
        else if (errno)
            return APERRT(errno, "Failed to read directory", hDirectory);
        else
            return APERRT(Ec::End, "smb::Client::readDirectory");
    }

    bool hasReadplus2Directory() const noexcept {
        return m_api->hasReaddirplus2();
    }

    ErrorOr<Text> readplus2Directory(int hDirectory,
                                     PlatStatInfo &statInfo) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        auto lock = m_lock.lock();
        if (auto result = m_api->readdirplus2(hDirectory, &statInfo))
            return result->name;
        else if (errno)
            return APERRT(errno, "Failed to read directory", hDirectory);
        else
            return APERRT(Ec::End, "smb::Client::readDirectoryPlus2");
    }

    Error createDirectory(const file::Path &path) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;
        if (auto ccode = checkPath(path)) return ccode;

        const auto url = renderSmbUrlEncoded(path);
        auto lock = m_lock.lock();
        if (m_api->mkdir(url, S_IRWXU))
            return APERRT(errno, "Failed to create directory", path);
        return {};
    }

    Error removeDirectory(const file::Path &path) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;
        if (auto ccode = checkPath(path)) return ccode;

        const auto url = renderSmbUrlEncoded(path);
        auto lock = m_lock.lock();
        // Treat ENOENT (i.e. "No such file or directory") as success
        if (m_api->rmdir(url) && errno != ENOENT)
            return APERRT(errno, "Failed to remove directory", path);
        return {};
    }

    ErrorOr<PlatStatInfo> fstat(int hFile) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        PlatStatInfo stats;
        auto lock = m_lock.lock();
        if (m_api->fstat(hFile, &stats))
            return APERRT(errno, "Failed to stat file by handle", hFile);
        return stats;
    }

    Error utimes(const file::Path &path,
                 const struct timeval times[2]) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        const auto url = renderSmbUrlEncoded(path);
        auto lock = m_lock.lock();
        if (m_api->utimes(url, times))
            return APERRT(errno, "Failed to update times", url);
        return {};
    }

    ErrorOr<int> openFile(const file::Path &path, int flags,
                          mode_t mode) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;
        if (auto ccode = checkPath(path)) return ccode;

        const auto url = renderSmbUrlEncoded(path);
        auto lock = m_lock.lock();
        if (auto hFile = m_api->open(url, flags, mode); hFile >= 0) {
            LOGT("Opened file", path, "=>", hFile);
            return hFile;
        }

        return APERRT(errno, "Failed to open file", url);
    }

    Error getCliState(struct cli_state **state, struct cli_credentials *creds,
                      const char *servername, const char *sharename) noexcept {
        uint32_t nt_status;
        uint32_t flags = 0;

        nt_status = m_api->cli_full_connection_creds(
            state, m_api->lp_netbios_name(), servername, NULL, 0, sharename,
            "?????", creds, flags, 0);

        if (nt_status != 0) {
            return APERRT(Ec::Warning, "Error connecting to smb server",
                          servername, nt_status);
        }
        return {};
    }

    ErrorOr<struct sec_descriptor> getAcl(
        std::unordered_map<Text, struct smb_names> &names,
        const char *servername, const char *sharename,
        const char *filename) noexcept {
        struct cli_state *m_cli_state = NULL;
        bool use_kerberos = false;
        bool fallback_after_kerberos = false;
        bool use_ccache = false;
        bool pw_nt_hash = false;
        struct sec_descriptor sec_desc;
        struct security_descriptor *sd;
        struct cli_credentials *creds = NULL;
        // simultaneous connection is not possible
        auto lock = m_lock.lock();
        {
            if (m_frame == NULL) {
                m_frame = m_api->talloc_stackframe(__location__);
            }

            creds = m_api->cli_session_creds_init(
                m_frame, m_username, m_api->lp_workgroup(),
                NULL, /* realm (use default) */
                m_password, use_kerberos, fallback_after_kerberos, use_ccache,
                pw_nt_hash);

            if (creds == NULL) {
                return APERRT(Ec::Warning,
                              "Error connecting to smb server creds",
                              servername);
            }

            auto ccode =
                getCliState(&m_cli_state, creds, servername, sharename);
            if (ccode) {
                return APERRT(Ec::Warning, "Error connecting to smb server",
                              ccode);
            }

            int ret;
            sd = get_secdesc(m_cli_state, filename);
            if (sd == NULL) {
                return APERRT(Ec::Warning, "Couldn't find security descriptor",
                              filename);
            }
        }

        // max id can be 256 char
        Text id;
        auto it = m_domSidNames.find(*sd->owner_sid);
        if (it == m_domSidNames.end()) {
            char t_id[256];
            m_api->sid_to_fstring(t_id, sd->owner_sid);
            id = Text(t_id);
            m_domSidNames.insert({*sd->owner_sid, id});
        } else {
            id = it->second;
        }

        sec_desc.ownerId = id;
        char **username = NULL;
        char **authority = NULL;

        auto getPermissionType = [](int type,
                                    int SID_NAME_USER) -> idPermissionType {
            return (type == SID_NAME_USER) ? idPermissionType::USER
                                           : idPermissionType::GROUP;
        };

        if (names.find(id) == names.end()) {
            char *user = NULL;
            char *domain = NULL;
            username = &user;
            authority = &domain;
            enum lsa_SidType type;
            // get the display names
            getNameFromSid(m_cli_state, authority, username, sd->owner_sid,
                           false, type);
            names.insert({id,
                          {.name = *username ? *username : "",
                           .authority = *authority ? *authority : "",
                           .type = getPermissionType(type, SID_NAME_USER)}});
        }

        id.clear();
        it = m_domSidNames.find(*sd->group_sid);
        if (it == m_domSidNames.end()) {
            char t_id[256];
            m_api->sid_to_fstring(t_id, sd->group_sid);
            id = Text(t_id);
            m_domSidNames.insert({*sd->group_sid, id});
        } else {
            id = it->second;
        }

        sec_desc.groupId = Text(id);
        if (names.find(id) == names.end()) {
            char *user = NULL;
            char *domain = NULL;
            username = &user;
            authority = &domain;
            enum lsa_SidType type;
            getNameFromSid(m_cli_state, authority, username, sd->group_sid,
                           false, type);
            names.insert({id,
                          {.name = *username ? *username : "",
                           .authority = *authority ? *authority : "",
                           .type = getPermissionType(type, SID_NAME_USER)}});
        }

        for (int i = 0; sd->dacl && i < sd->dacl->num_aces; i++) {
            // get security_aces
            struct security_ace *ace = &sd->dacl->aces[i];
            struct dcls dcls;
            // get dcls access mask
            dcls.mask = ace->access_mask;
            // get type
            dcls.type = ace->type;
            id.clear();
            it = m_domSidNames.find(ace->trustee);
            if (it == m_domSidNames.end()) {
                char t_id[256];
                m_api->sid_to_fstring(t_id, &ace->trustee);
                id = Text(t_id);
                m_domSidNames.insert({ace->trustee, id});
            } else {
                id = it->second;
            }

            dcls.ownerId = Text(id);
            if (names.find(id) == names.end()) {
                char *user = NULL;
                char *domain = NULL;
                enum lsa_SidType type;
                username = &user;
                authority = &domain;
                getNameFromSid(m_cli_state, authority, username, &ace->trustee,
                               false, type);
                names.insert(
                    {id,
                     {.name = *username ? *username : "",
                      .authority = *authority ? *authority : "",
                      .type = getPermissionType(type, SID_NAME_USER)}});
            }
            sec_desc.dcls.push_back(dcls);
        }

        talloc_free(m_cli_state);
        return sec_desc;
    }

    ErrorOr<bool> convertStringToSid(const char *str, struct dom_sid *domSid) {
        return m_api->string_to_sid(domSid, str);
    }

    /* Open cli connection and policy handle */
    uint32_t cli_lsa_lookup_sid(struct cli_state *cli,
                                const struct dom_sid *sid, TALLOC_CTX *mem_ctx,
                                enum lsa_SidType *type, char **domain,
                                char **name) noexcept {
        struct smbXcli_tcon *orig_tcon = NULL;
        char *orig_share = NULL;
        struct rpc_pipe_client *rpc_pipe = NULL;

        struct policy_handle handle = {};
        uint32_t status;

        enum lsa_SidType *types;
        char **domains;
        char **names;

        do {
            if (m_api->cli_state_has_tcon(cli)) {
                if (m_api->cli_state_save_tcon) {
                    orig_tcon = m_api->cli_state_save_tcon(cli);
                    if (orig_tcon == NULL) {
                        status = -1;
                        break;
                        ;
                    }
                } else {
                    m_api->cli_state_save_tcon_share(cli, &orig_tcon,
                                                     &orig_share);
                }
            }

            status = m_api->cli_tree_connect(cli, "IPC$", "?????", NULL);
            if (status != 0) {
                break;
            }

            status = m_api->cli_rpc_pipe_open_noauth(
                cli, m_api->ndr_table_lsarpc, &rpc_pipe);
            if (status != 0) {
                break;
            }
            status = m_api->rpccli_lsa_open_policy(
                rpc_pipe, m_api->talloc_tos(), true, GENERIC_EXECUTE_ACCESS,
                &handle);
            if (status != 0) {
                break;
            }

            status = m_api->rpccli_lsa_lookup_sids(
                rpc_pipe, m_api->talloc_tos(), &handle, 1, sid, &domains,
                &names, &types);
            if (status != 0) {
                break;
            }

            *type = types[0];
            if (*domains)
                *domain = (char *)m_api->talloc_move(mem_ctx, &domains[0]);
            *name = (char *)m_api->talloc_move(mem_ctx, &names[0]);

            status = 0;
        } while (false);
        if (m_api->cli_state_restore_tcon_share) {
            talloc_free(rpc_pipe);
            m_api->cli_state_restore_tcon_share(cli, orig_tcon, orig_share);
        }
        return status;
    }

    Error getNameFromSid(struct cli_state *cli, char **domain, char **name,
                         const struct dom_sid *sid, bool numeric,
                         enum lsa_SidType &type) {
        uint32_t status;

        status = cli_lsa_lookup_sid(cli, sid, m_api->talloc_tos(), &type,
                                    domain, name);

        if (status != 0) {
            return {};
        }

        return {};
    }

    struct security_descriptor *get_secdesc(struct cli_state *cli,
                                            const char *filename) noexcept {
        uint16_t fnum = (uint16_t)-1;
        struct security_descriptor *sd;
        uint32_t status;
        uint32_t sec_info;
        uint32_t desired_access = 0;
        uint32_t SECINFO_OWNER1 = 0x00000001;
        uint32_t SECINFO_GROUP1 = 0x00000002;
        uint32_t SECINFO_DACL1 = 0x00000004;
        uint32_t SECINFO_SACL1 = 0x00000008;
        uint32_t SECINFO_LABEL1 = 0x00000010;
        uint32_t SECINFO_ATTRIBUTE1 = 0x00000020;
        uint32_t SECINFO_SCOPE1 = 0x00000040;
        uint32_t SECINFO_BACKUP1 = 0x00010000;
        uint32_t SECINFO_UNPROTECTED_SACL1 = 0x10000000;
        uint32_t SECINFO_UNPROTECTED_DACL1 = 0x20000000;
        uint32_t SECINFO_PROTECTED_SACL1 = 0x40000000;
        uint32_t SECINFO_PROTECTED_DACL1 = 0x80000000;

        const int SEC_STD_DELETE1 = 0x00010000;
        const int SEC_STD_READ_CONTROL1 = 0x00020000;
        const int SEC_STD_WRITE_DAC1 = 0x00040000;
        const int SEC_STD_WRITE_OWNER1 = 0x00080000;
        const int SEC_STD_SYNCHRONIZE1 = 0x00100000;
        const int SEC_STD_REQUIRED1 = 0x000F0000;
        const int SEC_STD_ALL1 = 0x001F0000;
        const int SEC_MASK_GENERIC1 = 0xF0000000;
        const int SEC_MASK_FLAGS1 = 0x0F000000;
        const int SEC_MASK_STANDARD1 = 0x00FF0000;
        const int SEC_MASK_SPECIFIC1 = 0x0000FFFF;

        /* generic bits */
        const int SEC_GENERIC_ALL1 = 0x10000000;
        const int SEC_GENERIC_EXECUTE1 = 0x20000000;
        const int SEC_GENERIC_WRITE1 = 0x40000000;
        const int SEC_GENERIC_READ1 = 0x80000000;

        /* flag bits */
        const int SEC_FLAG_SYSTEM_SECURITY1 = 0x01000000;
        const int SEC_FLAG_MAXIMUM_ALLOWED1 = 0x02000000;
        sec_info = SECINFO_OWNER1 | SECINFO_GROUP1 | SECINFO_DACL1;

        if (sec_info & (SECINFO_OWNER1 | SECINFO_GROUP1 | SECINFO_DACL1)) {
            desired_access |= SEC_STD_READ_CONTROL1;
        }
        if (sec_info & SECINFO_SACL1) {
            desired_access |= SEC_FLAG_SYSTEM_SECURITY1;
        }

        if (desired_access == 0) {
            desired_access |= SEC_STD_READ_CONTROL1;
        }

        status = m_api->cli_ntcreate(cli, filename, 0, desired_access, 0,
                                     FILE_SHARE_READ | FILE_SHARE_WRITE,
                                     FILE_OPEN, 0x0, 0x0, &fnum, NULL);
        if (status != 0) {
            return NULL;
        }

        status = m_api->cli_query_security_descriptor(cli, fnum, sec_info,
                                                      m_api->talloc_tos(), &sd);

        m_api->cli_close(cli, fnum);

        if (status != 0) {
            return NULL;
        }
        return sd;
    }

    Error closeFile(int hFile) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        auto lock = m_lock.lock();
        LOGT("Closing file", hFile);
        if (m_api->close(hFile)) return APERRT(errno, "Failed to close file");
        return {};
    }

    ErrorOr<size_t> readFile(int hFile, OutputData data) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        auto lock = m_lock.lock();
        const size_t read = m_api->read(hFile, data, data.size());
        if (read == -1)
            return APERRT(errno, "Failed to read file", hFile, data.size());
        return _cast<size_t>(read);
    }

    Error writeFile(int hFile, InputData data) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        auto lock = m_lock.lock();
        size_t written = m_api->write(hFile, data, data.size());
        if (written == -1)
            return APERRT(errno, "Failed to write file", hFile, data.size());
        else if (written != data.size())
            return APERRT(Ec::Write, "Partial write", data.size());
        return {};
    }

    ErrorOr<size_t> seekFile(int hFile, size_t offset,
                             int whence) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        auto lock = m_lock.lock();
        off_t pos = m_api->lseek(hFile, offset, whence);
        if (pos == -1)
            return APERRT(errno, "Failed to seek file", hFile, offset);
        return _cast<size_t>(pos);
    }

    Error truncateFile(int hFile, uint64_t offset) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        auto lock = m_lock.lock();
        if (m_api->ftruncate(hFile, offset))
            return APERRT(errno, "Failed to truncate at offset", hFile, offset);
        return {};
    }

    ErrorOr<PlatStatInfo> stat(const file::Path &path) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;
        if (auto ccode = checkPath(path)) return ccode;

        auto url = renderSmbUrlEncoded(path);
        PlatStatInfo stats;
        auto lock = m_lock.lock();
        if (m_api->stat(url, &stats))
            return APERRT(errno, "Failed to stat URL", url);
        return stats;
    }

    Error rename(const file::Path &sourcePath,
                 const file::Path &destPath) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;
        if (auto ccode = checkPath(sourcePath) || checkPath(destPath))
            return ccode;

        const auto sourceUrl = renderSmbUrlEncoded(sourcePath);
        const auto destUrl = renderSmbUrlEncoded(destPath);
        auto lock = m_lock.lock();
        if (m_api->rename(sourceUrl, destUrl))
            return APERRT(errno, "Failed to rename", sourcePath, "=>",
                          destPath);
        return {};
    }

    Error remove(const file::Path &path) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;
        if (auto ccode = checkPath(path)) return ccode;

        const auto url = renderSmbUrlEncoded(path);
        auto lock = m_lock.lock();
        // Treat ENOENT (i.e. "No such file or directory") as success
        if (m_api->unlink(url) && errno != ENOENT)
            return APERRT(errno, "Failed to remove", path);
        return {};
    }

    Error chmod(const file::Path &path, mode_t mode) const noexcept {
        if (auto ccode = checkInitialized()) return ccode;

        const auto url = renderSmbUrlEncoded(path);
        auto lock = m_lock.lock();
        if (m_api->chmod(url, mode) && errno != ENOENT)
            return APERRT(errno, "Failed to chmod", path, mode);
        return {};
    }

protected:
    ErrorOr<ClientApi> load(const file::Path &libPath) noexcept {
        try {
            return ClientApi(libPath);
        } catch (const Error &e) {
            LOG(Always, "Failed to load SMB client library", libPath, e);
            return e;
        }
    }

    ErrorOr<ClientApi> load() noexcept {
        // Try the soname first, then the versionless name
        if (auto api = load(plat::renderSoname("libsmbclient", 0))) return api;
        return load(plat::renderSoname("libsmbclient"));
    }

    Error checkInitialized() const noexcept {
        // Check for whether init has been called (any libsmbclient call will
        // crash with SIGSEGV otherwise)
        if (!m_api)
            return APERRT(Ec::InvalidState,
                          "SMB client library not initialized");

        // If no shares are mounted (i.e. no credentials available), any Samba
        // operation will fail
        if (m_mountedShares.empty())
            return APERRT(Ec::InvalidState, "No SMB shares mounted");

        // Clear errno (libsmbclient doesn't)
        errno = 0;

        return {};
    }

protected:
    mutable async::MutexLock m_lock;
    Opt<ClientApi> m_api;
    Context *m_ctx = {};
    TALLOC_CTX *m_frame = NULL;
    Text m_username;
    Text m_password;
    std::vector<std::pair<TextView, TextView>> m_mountedShares;
    std::unordered_map<struct dom_sid, Text, struct dom_sid_hash> m_domSidNames;
};

inline Client &client() noexcept { return Client::get(); }

}  // namespace ap::file::smb
