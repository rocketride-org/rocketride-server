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
#define SID_MAX_SUB_AUTHORITIES 15

#include <sys/time.h>
#include "samba_includes/rpc_transport.h"
#include "samba_includes/rpc_client.h"
#include "samba_includes/credential_internal.h"

#ifndef __STRING
#define __STRING(x) #x
#endif

#ifndef __STRINGSTRING
#define __STRINGSTRING(x) __STRING(x)
#endif

#ifndef __LINESTR__
#define __LINESTR__ __STRINGSTRING(__LINE__)
#endif
#ifndef __location__
#define __location__ __FILE__ ":" __LINESTR__
#endif

struct cli_state;

struct smb_create_returns;
struct ndr_interface_table;
typedef void TALLOC_CTX;
enum lsa_SidType {
    SID_NAME_USE_NONE = (int)(0),
    SID_NAME_USER = (int)(1),
    SID_NAME_DOM_GRP = (int)(2),
    SID_NAME_DOMAIN = (int)(3),
    SID_NAME_ALIAS = (int)(4),
    SID_NAME_WKN_GRP = (int)(5),
    SID_NAME_DELETED = (int)(6),
    SID_NAME_INVALID = (int)(7),
    SID_NAME_UNKNOWN = (int)(8),
    SID_NAME_COMPUTER = (int)(9),
    SID_NAME_LABEL = (int)(10)
};
enum security_acl_revision {
    SECURITY_ACL_REVISION_NT4 = (int)(2),
    SECURITY_ACL_REVISION_ADS = (int)(4)
};
struct smbXcli_tcon {
    bool is_smb1;
    uint32_t fs_attributes;

    struct {
        uint16_t tcon_id;
        uint16_t optional_support;
        uint32_t maximal_access;
        uint32_t guest_maximal_access;
        char *service;
        char *fs_type;
    } smb1;

    struct {
        uint32_t tcon_id;
        uint8_t type;
        uint32_t flags;
        uint32_t capabilities;
        uint32_t maximal_access;
        bool should_sign;
        bool should_encrypt;
    } smb2;
};

union security_ace_object_type {
    struct sambc_GUID type; /* [case(SEC_ACE_OBJECT_TYPE_PRESENT)] */
} /* [nodiscriminant] */;

union security_ace_object_inherited_type {
    struct sambc_GUID
        inherited_type; /* [case(SEC_ACE_INHERITED_OBJECT_TYPE_PRESENT)] */
} /*[nodiscriminant,public] */;
struct security_ace_object {
    uint32_t flags;
    union security_ace_object_type
        type; /* [switch_is(flags&SEC_ACE_OBJECT_TYPE_PRESENT)] */
    union security_ace_object_inherited_type inherited_type; /* [switch_is(flags&SEC_ACE_INHERITED_OBJECT_TYPE_PRESENT)]
                                                              */
};

union security_ace_object_ctr {
    struct security_ace_object
        object; /* [case(SEC_ACE_TYPE_ACCESS_ALLOWED_OBJECT)] */
} /* [nodiscriminant,public] */;

enum security_ace_type {
    SEC_ACE_TYPE_ACCESS_ALLOWED = (int)(0),
    SEC_ACE_TYPE_ACCESS_DENIED = (int)(1),
    SEC_ACE_TYPE_SYSTEM_AUDIT = (int)(2),
    SEC_ACE_TYPE_SYSTEM_ALARM = (int)(3),
    SEC_ACE_TYPE_ALLOWED_COMPOUND = (int)(4),
    SEC_ACE_TYPE_ACCESS_ALLOWED_OBJECT = (int)(5),
    SEC_ACE_TYPE_ACCESS_DENIED_OBJECT = (int)(6),
    SEC_ACE_TYPE_SYSTEM_AUDIT_OBJECT = (int)(7),
    SEC_ACE_TYPE_SYSTEM_ALARM_OBJECT = (int)(8)
};

struct security_ace {
    enum security_ace_type type;
    uint8_t flags;
    uint16_t size; /* [value(ndr_size_security_ace(r,ndr->flags))] */
    uint32_t access_mask;
    union security_ace_object_ctr object; /* [switch_is(type)] */
    struct dom_sid trustee;
} /* [gensize,nopull,nosize,public] */;

struct security_id {
    uint8_t revision;                 // SID revision level
    uint8_t sub_authority_count;      // Number of sub-authorities
    uint8_t identifier_authority[6];  // Identifier authority
    uint32_t sub_authority[SID_MAX_SUB_AUTHORITIES];  // Sub-authorities
};

struct security_acl {
    enum security_acl_revision revision;
    uint16_t size;     /* [value(ndr_size_security_acl(r,ndr->flags))] */
    uint32_t num_aces; /* [range(0,2000)] */
    struct security_ace *aces;
} /* [gensize,nosize,public] */;
enum security_descriptor_revision { SECURITY_DESCRIPTOR_REVISION_1 = (int)(1) };
struct security_descriptor {
    enum security_descriptor_revision revision;
    uint16_t type;
    struct dom_sid *owner_sid; /* [relative] */
    struct dom_sid *group_sid; /* [relative] */
    struct security_acl *sacl; /* [relative] */
    struct security_acl *dacl; /* [relative] */
};
struct dcerpc_binding_handle {
    void *private_data;
    const struct dcerpc_binding_handle_ops *ops;
    const char *location;
    const struct sambc_GUID *object;
    const struct ndr_interface_table *table;
    struct tevent_context *sync_ev;
};

struct policy_handle {
    uint32_t handle_type;

    struct GUID {
        uint32_t time_low;
        uint16_t time_mid;
        uint16_t time_hi_and_version;
        uint8_t clock_seq[2];
        uint8_t node[6];
    } /* [nodiscriminant,public] */;
    struct GUID uuid = {};
} /* [public] */;

/// ndr
enum ndr_compression_alg {
    NDR_COMPRESSION_MSZIP_CAB = 1,
    NDR_COMPRESSION_MSZIP = 2,
    NDR_COMPRESSION_XPRESS = 3
};

struct ndr_compression_state {
    enum ndr_compression_alg type;
    union {
        struct {
            struct z_stream_s *z;
            uint8_t *dict;
            size_t dict_size;
        } mszip;
    } alg;
};
enum ndr_err_code {
    NDR_ERR_SUCCESS = 0,
    NDR_ERR_ARRAY_SIZE,
    NDR_ERR_BAD_SWITCH,
    NDR_ERR_OFFSET,
    NDR_ERR_RELATIVE,
    NDR_ERR_CHARCNV,
    NDR_ERR_LENGTH,
    NDR_ERR_SUBCONTEXT,
    NDR_ERR_COMPRESSION,
    NDR_ERR_STRING,
    NDR_ERR_VALIDATE,
    NDR_ERR_BUFSIZE,
    NDR_ERR_ALLOC,
    NDR_ERR_RANGE,
    NDR_ERR_TOKEN,
    NDR_ERR_IPV4ADDRESS,
    NDR_ERR_IPV6ADDRESS,
    NDR_ERR_INVALID_POINTER,
    NDR_ERR_UNREAD_BYTES,
    NDR_ERR_NDR64,
    NDR_ERR_FLAGS,
    NDR_ERR_INCOMPLETE_BUFFER
};

struct ndr_token {
    const void *key;
    uint32_t value;
};

struct ndr_token_list {
    struct ndr_token *tokens;
    uint32_t count;
};
struct ndr_pull {
    uint32_t flags; /* LIBNDR_FLAG_* */
    uint8_t *data;
    uint32_t data_size;
    uint32_t offset;

    uint32_t relative_highest_offset;
    uint32_t relative_base_offset;
    uint32_t relative_rap_convert;
    struct ndr_token_list relative_base_list;

    struct ndr_token_list relative_list;
    struct ndr_token_list array_size_list;
    struct ndr_token_list array_length_list;
    struct ndr_token_list switch_list;

    struct ndr_compression_state *cstate;

    TALLOC_CTX *current_mem_ctx;

    /* this is used to ensure we generate unique reference IDs
       between request and reply */
    uint32_t ptr_count;
};

/* structure passed to functions that generate NDR formatted data */
struct ndr_push {
    uint32_t flags; /* LIBNDR_FLAG_* */
    uint8_t *data;
    uint32_t alloc_size;
    uint32_t offset;
    bool fixed_buf_size;

    uint32_t relative_base_offset;
    uint32_t relative_end_offset;
    struct ndr_token_list relative_base_list;

    struct ndr_token_list switch_list;
    struct ndr_token_list relative_list;
    struct ndr_token_list relative_begin_list;
    struct ndr_token_list nbt_string_list;
    struct ndr_token_list dns_string_list;
    struct ndr_token_list full_ptr_list;

    struct ndr_compression_state *cstate;

    /* this is used to ensure we generate unique reference IDs */
    uint32_t ptr_count;
};
typedef enum ndr_err_code (*ndr_push_flags_fn_t)(struct ndr_push *,
                                                 int ndr_flags, const void *);
typedef enum ndr_err_code (*ndr_pull_flags_fn_t)(struct ndr_pull *,
                                                 int ndr_flags, void *);
typedef void (*ndr_print_fn_t)(struct ndr_print *, const char *, const void *);
typedef void (*ndr_print_function_t)(struct ndr_print *, const char *, int,
                                     const void *);
struct ndr_interface_call_pipe {
    const char *name;
    const char *chunk_struct_name;
    size_t chunk_struct_size;
    ndr_push_flags_fn_t ndr_push;
    ndr_pull_flags_fn_t ndr_pull;
    ndr_print_fn_t ndr_print;
};

struct ndr_interface_call_pipes {
    uint32_t num_pipes;
    const struct ndr_interface_call_pipe *pipes;
};

struct ndr_interface_call {
    const char *name;
    size_t struct_size;
    ndr_push_flags_fn_t ndr_push;
    ndr_pull_flags_fn_t ndr_pull;
    ndr_print_function_t ndr_print;
    struct ndr_interface_call_pipes in_pipes;
    struct ndr_interface_call_pipes out_pipes;
};

struct ndr_interface_public_struct {
    const char *name;
    size_t struct_size;
    ndr_push_flags_fn_t ndr_push;
    ndr_pull_flags_fn_t ndr_pull;
    ndr_print_function_t ndr_print;
};

struct ndr_interface_string_array {
    uint32_t count;
    const char *const *names;
};

struct ndr_interface_table {
    const char *name;
    struct ndr_syntax_id syntax_id;
    const char *helpstring;
    uint32_t num_calls;
    const struct ndr_interface_call *calls;
    uint32_t num_public_structs;
    const struct ndr_interface_public_struct *public_structs;
    const struct ndr_interface_string_array *endpoints;
    const struct ndr_interface_string_array *authservices;
};

namespace ap::file::smb {

///

// #define PERFORMANCE_TEST_SMB

#if defined(PERFORMANCE_TEST_SMB)
#define PERFORMANCE_TEST_SMB_GET_FULL_VARIABLE_NAME(VariableName) \
    VariableName##Impl
#define PERFORMANCE_TEST_SMB_DECLARE(VariableType, VariableName,            \
                                     FunctionSignature, FunctionParameters) \
    decltype(VariableType) VariableName##Impl = {};                         \
    mutable time::Duration VariableName##Duration = {};                     \
    mutable long long VariableName##Count = {};                             \
    auto VariableName FunctionSignature const noexcept {                    \
        auto start = time::now();                                           \
        auto returnValue = VariableName##Impl FunctionParameters;           \
        auto end = time::now();                                             \
        VariableName##Duration += end - start;                              \
        ++VariableName##Count;                                              \
        return returnValue;                                                 \
    }
#define PERFORMANCE_TEST_SMB_PRINT_STATISTICS(VariableName)        \
    LOG(Always, "Calls to {}: total number {}, total duration {}", \
        #VariableName, VariableName##Count, _ts(VariableName##Duration));
#else
#define PERFORMANCE_TEST_SMB_GET_FULL_VARIABLE_NAME(VariableName) VariableName
#define PERFORMANCE_TEST_SMB_DECLARE(VariableType, VariableName,            \
                                     FunctionSignature, FunctionParameters) \
    decltype(VariableType) VariableName = {};
#define PERFORMANCE_TEST_SMB_PRINT_STATISTICS(VariableName)
#endif

#define PERFORMANCE_TEST_SMB_INIT(VariableType, VariableName, FunctionName) \
    PERFORMANCE_TEST_SMB_GET_FULL_VARIABLE_NAME(VariableName) =             \
        *plat::dynamicBind<decltype(VariableType)>(libPath, FunctionName)
#define PERFORMANCE_TEST_SMB_INIT_OPTIONAL(VariableType, VariableName,        \
                                           FunctionName)                      \
    {                                                                         \
        auto function =                                                       \
            plat::dynamicBind<decltype(VariableType)>(libPath, FunctionName); \
        if (function.hasValue()) {                                            \
            PERFORMANCE_TEST_SMB_GET_FULL_VARIABLE_NAME(VariableName) =       \
                *function;                                                    \
            LOG(Smb, "Method {} detected", FunctionName);                     \
        } else {                                                              \
            LOG(Smb, "Method {} NOT detected", FunctionName);                 \
        }                                                                     \
    }

using Context = void;

// Declarations of SMB client library that have no native Unix correlate
namespace lib {
void authCallback(const char *server, const char *share, char *workgroup,
                  int workgroupLen, char *username, int usernameLen,
                  char *password, int passwordLen);

void authCallbackWithContext(Context *ctx, const char *server,
                             const char *share, char *workgroup,
                             int workgroupLen, char *username, int usernameLen,
                             char *password, int passwordLen);

void logCallback(void *userData, int level, const char *msg);

struct dirent {
    unsigned int type;
    unsigned int dirlen;
    unsigned int commentlen;
    char *comment;
    unsigned int namelen;
    char name[1];
};

/**@ingroup structure
 * Structure that represents all attributes of a directory entry.
 *
 */
struct libsmb_file_info {
    /**
     * Size of file
     */
    uint64_t size;
    /**
     * DOS attributes of file
     */
    uint16_t attrs;
    /**
     * User ID of file
     */
    uid_t uid;
    /**
     * Group ID of file
     */
    gid_t gid;
    /**
     * Birth/Create time of file (if supported by system)
     * Otherwise the value will be 0
     */
    struct timespec btime_ts;
    /**
     * Modified time for the file
     */
    struct timespec mtime_ts;
    /**
     * Access time for the file
     */
    struct timespec atime_ts;
    /**
     * Change time for the file
     */
    struct timespec ctime_ts;
    /**
     * Name of file
     */
    char *name;
    /**
     * Short name of file
     */
    char *short_name;
};

int init(decltype(&authCallback) callback, int debugLevel) noexcept;
const char *version() noexcept;

Context *new_context() noexcept;
int getxattr(const char *fname, const char *name, const void *value,
             size_t size);
int listxattr(const char *url, char *list, size_t size);
void gfree_all(void);

uint32_t cli_full_connection_creds(TALLOC_CTX *mem_ctx,
                                   struct cli_state **output_cli,
                                   const char *my_name, const char *dest_host,
                                   const struct sockaddr_storage *dest_ss,
                                   int port, const char *service,
                                   const char *service_type,
                                   struct cli_credentials *creds, int flags);

struct cli_credentials *cli_session_creds_init(
    TALLOC_CTX *mem_ctx, const char *username, const char *domain,
    const char *realm, const char *password, bool use_kerberos,
    bool fallback_after_kerberos, bool use_ccache, bool password_is_nt_hash);

uint32_t cli_ntcreate(struct cli_state *cli, const char *fname,
                      uint32_t CreatFlags, uint32_t DesiredAccess,
                      uint32_t FileAttributes, uint32_t ShareAccess,
                      uint32_t CreateDisposition, uint32_t CreateOptions,
                      uint8_t SecurityFlags, uint16_t *pfid,
                      struct smb_create_returns *cr);

uint32_t cli_query_security_descriptor(struct cli_state *cli, uint16_t fnum,
                                       uint32_t sec_info, TALLOC_CTX *mem_ctx,
                                       struct security_descriptor **sd);

TALLOC_CTX *_talloc_tos();
int _talloc_free(void *ptr, const char *location);
void *_talloc_move(const void *new_ctx, const void *pptr);
char *sid_to_fstring(char sidstr_out[256], const struct dom_sid *sid);
const char *lp_netbios_name();
const char *lp_workgroup();
uint32_t cli_close(struct cli_state *cli, uint16_t fnum);
uint32_t cli_tree_connect(struct cli_state *cli, const char *share,
                          const char *dev, const char *pass);
uint32_t cli_rpc_pipe_open_noauth(struct cli_state *cli,
                                  const struct ndr_interface_table *table,
                                  struct rpc_pipe_client **presult);
uint32_t rpccli_lsa_open_policy(struct rpc_pipe_client *cli,
                                TALLOC_CTX *mem_ctx, bool sec_qos,
                                uint32_t des_access, struct policy_handle *pol);

uint32_t rpccli_lsa_lookup_sids(struct rpc_pipe_client *cli,
                                TALLOC_CTX *mem_ctx, struct policy_handle *pol,
                                int num_sids, const struct dom_sid *sids,
                                char ***pdomains, char ***pnames,
                                enum lsa_SidType **ptypes);

TALLOC_CTX *_talloc_stackframe(const char *location);
bool cli_state_has_tcon(struct cli_state *cli);
void cli_state_save_tcon_share(struct cli_state *cli,
                               struct smbXcli_tcon **_tcon_ret,
                               char **_sharename_ret);
void cli_state_restore_tcon_share(struct cli_state *cli,
                                  struct smbXcli_tcon *tcon, char *share);
typedef struct ndr_interface_table ndr_interface_table_def;
typedef struct ndr_interface_call ndr_interface_call_def;
typedef struct ndr_interface_public_struct ndr_interface_public_struct_def;
typedef struct ndr_interface_string_array ndr_interface_string_array_def;
bool string_to_sid(struct dom_sid *sidout, const char *sidstr);
Context *init_context(Context *ctx) noexcept;
Context *set_context(Context *ctx) noexcept;
int free_context(Context *ctx, int shutdown_ctx) noexcept;

void setDebug(Context *ctx, int debug) noexcept;
void setLogCallback(Context *ctx, void *userData,
                    decltype(&logCallback) callback) noexcept;
void setFunctionAuthData(Context *ctx,
                         decltype(&authCallback) callback) noexcept;
void setFunctionAuthDataWithContext(
    Context *ctx, decltype(&authCallbackWithContext) callback) noexcept;
void setOptionUseKerberos(Context *ctx, int b) noexcept;
void setOptionFallbackAfterKerberos(Context *ctx, int b) noexcept;

int opendir(const char *url) noexcept;
int closedir(int hDir) noexcept;
dirent *readdir(int hDir) noexcept;
libsmb_file_info *readdirplus2(int hDir, struct ::stat *fs) noexcept;
}  // namespace lib

struct ClientApi {
    ClientApi(const file::Path &libPath) noexcept(false) {
        // General
        init = *plat::dynamicBind<decltype(lib::init)>(libPath, "smbc_init");
        version =
            *plat::dynamicBind<decltype(lib::version)>(libPath, "smbc_version");

        // Context management
        new_context = *plat::dynamicBind<decltype(lib::new_context)>(
            libPath, "smbc_new_context");
        init_context = *plat::dynamicBind<decltype(lib::init_context)>(
            libPath, "smbc_init_context");
        set_context = *plat::dynamicBind<decltype(lib::set_context)>(
            libPath, "smbc_set_context");
        free_context = *plat::dynamicBind<decltype(lib::free_context)>(
            libPath, "smbc_free_context");

        // Context configuration
        setDebug = *plat::dynamicBind<decltype(lib::setDebug)>(libPath,
                                                               "smbc_setDebug");
        setFunctionAuthData =
            *plat::dynamicBind<decltype(lib::setFunctionAuthData)>(
                libPath, "smbc_setFunctionAuthData");
        setFunctionAuthDataWithContext =
            *plat::dynamicBind<decltype(lib::setFunctionAuthDataWithContext)>(
                libPath, "smbc_setFunctionAuthDataWithContext");
        setOptionUseKerberos =
            *plat::dynamicBind<decltype(lib::setOptionUseKerberos)>(
                libPath, "smbc_setOptionUseKerberos");
        setOptionFallbackAfterKerberos =
            *plat::dynamicBind<decltype(lib::setOptionFallbackAfterKerberos)>(
                libPath, "smbc_setOptionFallbackAfterKerberos");
        // smbc_setLogCallback is not supported by version 4.3.8, which is the
        // default for Ubuntu 16
        setLogCallback = plat::dynamicBind<decltype(lib::setLogCallback)>(
            libPath, "smbc_setLogCallback");

        // Directory
        PERFORMANCE_TEST_SMB_INIT(lib::opendir, opendir, "smbc_opendir");
        PERFORMANCE_TEST_SMB_INIT(lib::closedir, closedir, "smbc_closedir");
        PERFORMANCE_TEST_SMB_INIT(lib::readdir, readdir, "smbc_readdir");
        PERFORMANCE_TEST_SMB_INIT_OPTIONAL(lib::readdirplus2, readdirplus2,
                                           "smbc_readdirplus2");

        mkdir = *plat::dynamicBind<decltype(::mkdir)>(libPath, "smbc_mkdir");
        rmdir = *plat::dynamicBind<decltype(::rmdir)>(libPath, "smbc_rmdir");

        // File
        fstat = *plat::dynamicBind<decltype(::fstat)>(libPath, "smbc_fstat");
        utimes = *plat::dynamicBind<decltype(::utimes)>(libPath, "smbc_utimes");
        open = *plat::dynamicBind<decltype(::open)>(libPath, "smbc_open");
        close = *plat::dynamicBind<decltype(::close)>(libPath, "smbc_close");
        read = *plat::dynamicBind<decltype(::read)>(libPath, "smbc_read");
        write = *plat::dynamicBind<decltype(::write)>(libPath, "smbc_write");
        lseek = *plat::dynamicBind<decltype(::lseek)>(libPath, "smbc_lseek");
        ftruncate = *plat::dynamicBind<decltype(::ftruncate)>(libPath,
                                                              "smbc_ftruncate");
        getxattr = *plat::dynamicBind<decltype(lib::getxattr)>(libPath,
                                                               "smbc_getxattr");
        listxattr = *plat::dynamicBind<decltype(lib::listxattr)>(
            libPath, "smbc_listxattr");
        // Either files or directories
        PERFORMANCE_TEST_SMB_INIT(::stat, stat, "smbc_stat");
        rename = *plat::dynamicBind<decltype(::rename)>(libPath, "smbc_rename");
        unlink = *plat::dynamicBind<decltype(::unlink)>(libPath, "smbc_unlink");
        chmod = *plat::dynamicBind<decltype(::chmod)>(libPath, "smbc_chmod");
        cli_full_connection_creds =
            *plat::dynamicBind<decltype(lib::cli_full_connection_creds)>(
                libPath, "cli_full_connection_creds");
        gfree_all =
            *plat::dynamicBind<decltype(lib::gfree_all)>(libPath, "gfree_all");
        cli_ntcreate = *plat::dynamicBind<decltype(lib::cli_ntcreate)>(
            libPath, "cli_ntcreate");
        cli_query_security_descriptor =
            *plat::dynamicBind<decltype(lib::cli_query_security_descriptor)>(
                libPath, "cli_query_security_descriptor");
        cli_close =
            *plat::dynamicBind<decltype(lib::cli_close)>(libPath, "cli_close");
        talloc_tos = *plat::dynamicBind<decltype(lib::_talloc_tos)>(
            libPath, "_talloc_tos");
        talloc_move = *plat::dynamicBind<decltype(lib::_talloc_move)>(
            libPath, "_talloc_move");
        talloc_free = *plat::dynamicBind<decltype(lib::_talloc_free)>(
            libPath, "_talloc_free");
        cli_tree_connect = *plat::dynamicBind<decltype(lib::cli_tree_connect)>(
            libPath, "cli_tree_connect");
        cli_rpc_pipe_open_noauth =
            *plat::dynamicBind<decltype(lib::cli_rpc_pipe_open_noauth)>(
                libPath, "cli_rpc_pipe_open_noauth");
        rpccli_lsa_open_policy =
            *plat::dynamicBind<decltype(lib::rpccli_lsa_open_policy)>(
                libPath, "rpccli_lsa_open_policy");
        rpccli_lsa_lookup_sids =
            *plat::dynamicBind<decltype(lib::rpccli_lsa_lookup_sids)>(
                libPath, "rpccli_lsa_lookup_sids");
        talloc_stackframe =
            *plat::dynamicBind<decltype(lib::_talloc_stackframe)>(
                libPath, "_talloc_stackframe");
        cli_state_has_tcon =
            *plat::dynamicBind<decltype(lib::cli_state_has_tcon)>(
                libPath, "cli_state_has_tcon");
        cli_state_save_tcon_share =
            *plat::dynamicBind<decltype(lib::cli_state_save_tcon_share)>(
                libPath, "cli_state_save_tcon_share");
        cli_state_restore_tcon_share =
            *plat::dynamicBind<decltype(lib::cli_state_restore_tcon_share)>(
                libPath, "cli_state_restore_tcon_share");
        ndr_table_lsarpc = plat::dynamicBind<lib::ndr_interface_table_def>(
            libPath, "ndr_table_lsarpc");
        string_to_sid = *plat::dynamicBind<decltype(lib::string_to_sid)>(
            libPath, "string_to_sid");

        sid_to_fstring = *plat::dynamicBind<decltype(lib::sid_to_fstring)>(
            libPath, "sid_to_fstring");
        lp_netbios_name = *plat::dynamicBind<decltype(lib::lp_netbios_name)>(
            libPath, "lp_netbios_name");
        lp_workgroup = *plat::dynamicBind<decltype(lib::lp_workgroup)>(
            libPath, "lp_netbios_name");
        cli_session_creds_init =
            *plat::dynamicBind<decltype(lib::cli_session_creds_init)>(
                libPath, "cli_session_creds_init");
    }
    ~ClientApi() noexcept {}

    void printStatistics() const noexcept {
#if defined(PERFORMANCE_TEST_SMB)
        PERFORMANCE_TEST_SMB_PRINT_STATISTICS(opendir);
        PERFORMANCE_TEST_SMB_PRINT_STATISTICS(closedir);
        PERFORMANCE_TEST_SMB_PRINT_STATISTICS(readdir);
        PERFORMANCE_TEST_SMB_PRINT_STATISTICS(readdirplus2);
        PERFORMANCE_TEST_SMB_PRINT_STATISTICS(stat);
#endif
    }

    bool hasReaddirplus2() const noexcept {
        return PERFORMANCE_TEST_SMB_GET_FULL_VARIABLE_NAME(readdirplus2) !=
               nullptr;
    }

    // General
    decltype(&lib::init) init = {};
    decltype(&lib::version) version = {};

    // Context management
    decltype(&lib::new_context) new_context = {};
    decltype(&lib::init_context) init_context = {};
    decltype(&lib::set_context) set_context = {};
    decltype(&lib::free_context) free_context = {};

    // Context configuration
    decltype(&lib::setDebug) setDebug = {};
    decltype(&lib::setFunctionAuthData) setFunctionAuthData = {};
    decltype(&lib::setFunctionAuthDataWithContext)
        setFunctionAuthDataWithContext = {};
    decltype(&lib::setOptionUseKerberos) setOptionUseKerberos = {};
    decltype(&lib::setOptionUseKerberos) setOptionFallbackAfterKerberos = {};
    ErrorOr<decltype(&lib::setLogCallback)> setLogCallback;

    // Directory
    PERFORMANCE_TEST_SMB_DECLARE(&lib::opendir, opendir, (const char *url),
                                 (url));
    PERFORMANCE_TEST_SMB_DECLARE(&lib::closedir, closedir, (int hDir), (hDir));
    PERFORMANCE_TEST_SMB_DECLARE(&lib::readdir, readdir, (int hDir), (hDir));
    PERFORMANCE_TEST_SMB_DECLARE(&lib::readdirplus2, readdirplus2,
                                 (int hDir, struct ::stat *st), (hDir, st));

    decltype(&::mkdir) mkdir = {};
    decltype(&::rmdir) rmdir = {};

    // File
    decltype(&::fstat) fstat = {};
    decltype(&::utimes) utimes = {};
    decltype(&::open) open = {};
    decltype(&::close) close = {};
    decltype(&::read) read = {};
    decltype(&::write) write = {};
    decltype(&::lseek) lseek = {};
    decltype(&::ftruncate) ftruncate = {};
    decltype(&lib::getxattr) getxattr = {};
    decltype(&lib::listxattr) listxattr = {};
    decltype(&lib::cli_full_connection_creds) cli_full_connection_creds = {};
    decltype(&lib::cli_ntcreate) cli_ntcreate = {};
    decltype(&lib::cli_query_security_descriptor)
        cli_query_security_descriptor = {};
    decltype(&lib::cli_close) cli_close = {};
    decltype(&lib::_talloc_tos) talloc_tos = {};
    decltype(&lib::_talloc_move) talloc_move = {};
    decltype(&lib::_talloc_free) talloc_free = {};
    decltype(&lib::sid_to_fstring) sid_to_fstring = {};
    decltype(&lib::lp_netbios_name) lp_netbios_name = {};
    decltype(&lib::lp_workgroup) lp_workgroup = {};
    decltype(&lib::cli_tree_connect) cli_tree_connect = {};
    decltype(&lib::cli_rpc_pipe_open_noauth) cli_rpc_pipe_open_noauth = {};
    decltype(&lib::rpccli_lsa_open_policy) rpccli_lsa_open_policy = {};
    decltype(&lib::rpccli_lsa_lookup_sids) rpccli_lsa_lookup_sids = {};
    decltype(&lib::_talloc_stackframe) talloc_stackframe = {};
    decltype(&lib::cli_state_has_tcon) cli_state_has_tcon = {};
    decltype(&lib::cli_state_save_tcon_share) cli_state_save_tcon_share = {};
    decltype(&lib::cli_state_restore_tcon_share) cli_state_restore_tcon_share =
        {};
    lib::ndr_interface_table_def *ndr_table_lsarpc = {};
    decltype(&lib::string_to_sid) string_to_sid = {};
    PERFORMANCE_TEST_SMB_DECLARE(&::stat, stat,
                                 (const char *url, struct stat *st), (url, st));
    decltype(&::rename) rename = {};
    decltype(&::unlink) unlink = {};
    decltype(&::chmod) chmod = {};
    decltype(&lib::cli_session_creds_init) cli_session_creds_init = {};
    decltype(&lib::gfree_all) gfree_all = {};
};

}  // namespace ap::file::smb
