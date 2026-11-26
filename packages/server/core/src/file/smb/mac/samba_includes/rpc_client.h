// Only forward declarations

/*
 *  Unix SMB/CIFS implementation.
 *
 *  RPC Pipe client routines
 *
 *  Copyright (c) 2005      Jeremy Allison
 *  Copyright (c) 2010      Simo Sorce
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program; if not, see <http://www.gnu.org/licenses/>.
 */

#ifndef _RPC_CLIENT_H
#define _RPC_CLIENT_H
#include "rpc_client.h"
#include "rpc_common.h"
struct ndr_syntax_id {
    struct sambc_GUID uuid;
    uint32_t if_version;
} /* [public] */;
struct dcerpc_binding_handle;
///// gensec
#define NUM_CHARSETS 7

#ifndef __GENSEC_INTERNAL_H__
#define __GENSEC_INTERNAL_H__

struct gensec_security;

enum gensec_priority {
    GENSEC_SPNEGO = 90,
    GENSEC_GSSAPI = 80,
    GENSEC_KRB5 = 70,
    GENSEC_SCHANNEL = 60,
    GENSEC_NTLMSSP = 50,
    GENSEC_SASL = 20,
    GENSEC_OTHER = 10,
    GENSEC_EXTERNAL = 0
};
struct gensec_security;

enum gensec_role { GENSEC_SERVER, GENSEC_CLIENT };
struct gensec_security_ops {
    const char *name;
    const char *sasl_name;
    uint8_t auth_type; /* 0 if not offered on DCE-RPC */
    const char **oid;  /* NULL if not offered by SPNEGO */
    NTSTATUS (*client_start)(struct gensec_security *gensec_security);
    NTSTATUS (*server_start)(struct gensec_security *gensec_security);
    /**
       Determine if a packet has the right 'magic' for this mechanism
    */
    NTSTATUS (*magic)(struct gensec_security *gensec_security,
                      const DATA_BLOB *first_packet);
    struct tevent_req *(*update_send)(TALLOC_CTX *mem_ctx,
                                      struct tevent_context *ev,
                                      struct gensec_security *gensec_security,
                                      const DATA_BLOB in);
    NTSTATUS (*update_recv)(struct tevent_req *req, TALLOC_CTX *out_mem_ctx,
                            DATA_BLOB *out);
    NTSTATUS (*may_reset_crypto)(struct gensec_security *gensec_security,
                                 bool full_reset);
    NTSTATUS (*seal_packet)(struct gensec_security *gensec_security,
                            TALLOC_CTX *sig_mem_ctx, uint8_t *data,
                            size_t length, const uint8_t *whole_pdu,
                            size_t pdu_length, DATA_BLOB *sig);
    NTSTATUS (*sign_packet)(struct gensec_security *gensec_security,
                            TALLOC_CTX *sig_mem_ctx, const uint8_t *data,
                            size_t length, const uint8_t *whole_pdu,
                            size_t pdu_length, DATA_BLOB *sig);
    size_t (*sig_size)(struct gensec_security *gensec_security,
                       size_t data_size);
    size_t (*max_input_size)(struct gensec_security *gensec_security);
    size_t (*max_wrapped_size)(struct gensec_security *gensec_security);
    NTSTATUS (*check_packet)(struct gensec_security *gensec_security,
                             const uint8_t *data, size_t length,
                             const uint8_t *whole_pdu, size_t pdu_length,
                             const DATA_BLOB *sig);
    NTSTATUS (*unseal_packet)(struct gensec_security *gensec_security,
                              uint8_t *data, size_t length,
                              const uint8_t *whole_pdu, size_t pdu_length,
                              const DATA_BLOB *sig);
    NTSTATUS (*wrap)(struct gensec_security *gensec_security,
                     TALLOC_CTX *mem_ctx, const DATA_BLOB *in, DATA_BLOB *out);
    NTSTATUS (*unwrap)(struct gensec_security *gensec_security,
                       TALLOC_CTX *mem_ctx, const DATA_BLOB *in,
                       DATA_BLOB *out);
    NTSTATUS (*session_key)(struct gensec_security *gensec_security,
                            TALLOC_CTX *mem_ctx, DATA_BLOB *session_key);
    NTSTATUS (*session_info)(struct gensec_security *gensec_security,
                             TALLOC_CTX *mem_ctx,
                             struct auth_session_info **session_info);
    void (*want_feature)(struct gensec_security *gensec_security,
                         uint32_t feature);
    bool (*have_feature)(struct gensec_security *gensec_security,
                         uint32_t feature);
    NTTIME (*expire_time)(struct gensec_security *gensec_security);
    const char *(*final_auth_type)(struct gensec_security *gensec_security);
    bool enabled;
    bool kerberos;
    enum gensec_priority priority;
    bool glue;
};
struct gensec_target {
    const char *principal;
    const char *hostname;
    const char *service;
    const char *service_description;
};

struct parmlist_entry {
    struct parmlist_entry *prev, *next;
    char *key;
    char *value;
    char *
        *list; /* For the source3 parametric options, to save the parsed list */
    int priority;
};

struct loadparm_global {
    TALLOC_CTX *ctx; /* Context for talloced members */
    char *abort_shutdown_script;
    char *add_group_script;
    const char **additional_dns_hostnames;
    char *add_machine_script;
    char *addport_command;
    char *addprinter_command;
    char *add_share_command;
    char *add_user_script;
    char *add_user_to_group_script;
    int afs_token_lifetime;
    char *afs_username_map;
    int aio_max_threads;
    int algorithmic_rid_base;
    bool allow_dcerpc_auth_level_connect;
    int allow_dns_updates;
    bool allow_insecure_wide_links;
    bool allow_nt4_crypto;
    bool allow_trusted_domains;
    bool allow_unsafe_cluster_upgrade;
    bool apply_group_policies;
    bool async_smb_echo_handler;
    bool auth_event_notification;
    char *auto_services;
    char *binddns_dir;
    bool bind_interfaces_only;
    bool browse_list;
    char *cache_directory;
    bool change_notify;
    char *change_share_command;
    char *check_password_script;
    int cldap_port;
    int _client_ipc_max_protocol;
    int _client_ipc_min_protocol;
    int _client_ipc_signing;
    bool client_lanman_auth;
    int client_ldap_sasl_wrapping;
    int _client_max_protocol;
    int client_min_protocol;
    bool client_ntlmv2_auth;
    bool client_plaintext_auth;
    int client_schannel;
    int client_signing;
    bool client_use_spnego_principal;
    bool client_use_spnego;
    const char **cluster_addresses;
    bool clustering;
    int config_backend;
    char *next_configfile;
    bool create_krb5_conf;
    char *_ctdbd_socket;
    int ctdb_locktime_warn_threshold;
    int ctdb_timeout;
    int cups_connection_timeout;
    int cups_encrypt;
    char *cups_server;
    const char **dcerpc_endpoint_servers;
    int deadtime;
    bool debug_class;
    bool debug_encryption;
    bool debug_hires_timestamp;
    bool debug_pid;
    bool debug_prefix_timestamp;
    bool debug_uid;
    char *dedicated_keytab_file;
    char *defaultservice;
    bool defer_sharing_violations;
    char *delete_group_script;
    char *deleteprinter_command;
    char *delete_share_command;
    char *delete_user_from_group_script;
    char *delete_user_script;
    int dgram_port;
    bool disable_netbios;
    bool _disable_spoolss;
    const char **dns_forwarder;
    bool wins_dns_proxy;
    const char **dns_update_command;
    bool dns_zone_scavenging;
    bool _domain_logons;
    int _domain_master;
    char *dos_charset;
    bool dsdb_event_notification;
    bool dsdb_group_change_notification;
    bool dsdb_password_event_notification;
    bool enable_asu_support;
    bool enable_core_files;
    bool enable_privileges;
    bool encrypt_passwords;
    bool enhanced_browsing;
    char *enumports_command;
    const char **eventlog_list;
    char *get_quota_command;
    bool getwd_cache;
    const char **gpo_update_command;
    char *guest_account;
    char *homedir_map;
    bool host_msdfs;
    bool hostname_lookups;
    char *idmap_backend;
    int idmap_cache_time;
    char *idmap_gid;
    int idmap_negative_cache_time;
    char *idmap_uid;
    bool include_system_krb5_conf;
    int init_logon_delay;
    const char **init_logon_delayed_hosts;
    const char **interfaces;
    char *iprint_server;
    int keepalive;
    int kerberos_encryption_types;
    int kerberos_method;
    bool kernel_change_notify;
    int kpasswd_port;
    int krb5_port;
    bool _lanman_auth;
    bool large_readwrite;
    char *ldap_admin_dn;
    int ldap_connection_timeout;
    int ldap_debug_level;
    int ldap_debug_threshold;
    bool ldap_delete_dn;
    int ldap_deref;
    int ldap_follow_referral;
    char *_ldap_group_suffix;
    char *_ldap_idmap_suffix;
    char *_ldap_machine_suffix;
    int ldap_max_anonymous_request_size;
    int ldap_max_authenticated_request_size;
    int ldap_max_search_request_size;
    int ldap_page_size;
    int ldap_passwd_sync;
    int ldap_replication_sleep;
    int ldap_server_require_strong_auth;
    int ldap_ssl;
    bool ldap_ssl_ads;
    char *ldap_suffix;
    int ldap_timeout;
    char *_ldap_user_suffix;
    int lm_announce;
    int lm_interval;
    bool load_printers;
    bool local_master;
    char *lock_directory;
    int lock_spin_time;
    char *logfile;
    char *logging;
    char *log_level;
    char *log_nt_token_command;
    char *logon_drive;
    char *logon_home;
    char *logon_path;
    char *logon_script;
    bool log_writeable_files_on_exit;
    int lpq_cache_time;
    bool lsa_over_netlogon;
    int machine_password_timeout;
    int mangle_prefix;
    char *mangling_method;
    int map_to_guest;
    int max_disk_size;
    int max_log_size;
    int max_mux;
    int max_open_files;
    int max_smbd_processes;
    int max_stat_cache_size;
    int max_ttl;
    int max_wins_ttl;
    int max_xmit;
    int mdns_name;
    char *message_command;
    int min_receivefile_size;
    int min_wins_ttl;
    const char **mit_kdc_command;
    bool multicast_dns_register;
    int name_cache_timeout;
    const char **name_resolve_order;
    char *nbt_client_socket_address;
    int nbt_port;
    char *ncalrpc_dir;
    const char **netbios_aliases;
    char *netbios_name;
    char *netbios_scope;
    bool neutralize_nt4_emulation;
    bool nis_homedir;
    bool nmbd_bind_explicit_broadcast;
    const char **nsupdate_command;
    int ntlm_auth;
    bool nt_pipe_support;
    char *ntp_signd_socket_directory;
    bool nt_status_support;
    bool null_passwords;
    bool obey_pam_restrictions;
    int old_password_allowed_period;
    int oplock_break_wait_time;
    char *os2_driver_map;
    int os_level;
    bool pam_password_change;
    char *panic_action;
    char *passdb_backend;
    bool passdb_expand_explicit;
    char *passwd_chat;
    bool passwd_chat_debug;
    int passwd_chat_timeout;
    char *passwd_program;
    const char **password_hash_gpg_key_ids;
    const char **password_hash_userpassword_schemes;
    char *password_server;
    char *perfcount_module;
    char *pid_directory;
    int _preferred_master;
    int prefork_backoff_increment;
    int prefork_children;
    int prefork_maximum_backoff;
    const char **preload_modules;
    int printcap_cache_time;
    char *printcap_name;
    char *private_dir;
    bool raw_ntlmv2_auth;
    bool read_raw;
    char *realm;
    bool registry_shares;
    bool reject_md5_clients;
    bool reject_md5_servers;
    char *remote_announce;
    char *remote_browse_sync;
    char *rename_user_script;
    bool require_strong_key;
    bool reset_on_zero_vc;
    int restrict_anonymous;
    const char **rndc_command;
    char *root_directory;
    bool rpc_big_endian;
    char *rpc_server_dynamic_port_range;
    int rpc_server_port;
    const char **samba_kcc_command;
    int _security;
    int server_max_protocol;
    int server_min_protocol;
    bool server_multi_channel_support;
    int _server_role;
    int server_schannel;
    const char **server_services;
    int server_signing;
    char *server_string;
    char *set_primary_group_script;
    char *set_quota_command;
    char *share_backend;
    bool show_add_printer_wizard;
    char *shutdown_script;
    bool smb2_leases;
    int smb2_max_credits;
    int smb2_max_read;
    int smb2_max_trans;
    int smb2_max_write;
    int smbd_profiling_level;
    char *smb_passwd_file;
    const char **smb_ports;
    char *socket_options;
    const char **spn_update_command;
    bool stat_cache;
    char *state_directory;
    const char **svcctl_list;
    int syslog;
    bool syslog_only;
    char *template_homedir;
    char *template_shell;
    bool time_server;
    bool timestamp_logs;
    char *_tls_cafile;
    char *_tls_certfile;
    char *_tls_crlfile;
    char *_tls_dhpfile;
    bool tls_enabled;
    char *_tls_keyfile;
    char *tls_priority;
    int tls_verify_peer;
    bool unicode;
    char *unix_charset;
    bool unix_extensions;
    bool unix_password_sync;
    bool use_mmap;
    int username_level;
    char *username_map;
    int username_map_cache_time;
    char *username_map_script;
    bool usershare_allow_guests;
    int usershare_max_shares;
    bool usershare_owner_only;
    char *usershare_path;
    const char **usershare_prefix_allow_list;
    const char **usershare_prefix_deny_list;
    char *usershare_template_share;
    bool utmp;
    char *utmp_directory;
    int winbind_cache_time;
    char *winbindd_socket_directory;
    bool winbind_enum_groups;
    bool winbind_enum_users;
    int winbind_expand_groups;
    int winbind_max_clients;
    int _winbind_max_domain_connections;
    bool winbind_nested_groups;
    bool winbind_normalize_names;
    const char **winbind_nss_info;
    bool winbind_offline_logon;
    int winbind_reconnect_delay;
    bool winbind_refresh_tickets;
    int winbind_request_timeout;
    bool winbind_rpc_only;
    bool winbind_scan_trusted_domains;
    bool winbind_sealed_pipes;
    char *winbind_separator;
    bool winbind_use_default_domain;
    bool winbind_use_krb5_enterprise_principals;
    char *wins_hook;
    bool wins_proxy;
    const char **wins_server_list;
    bool we_are_a_wins_server;
    char *workgroup;
    bool write_raw;
    char *wtmp_directory;
    struct parmlist_entry *param_opt;
    char *dnsdomain;
    int rpc_low_port;
    int rpc_high_port;
};

struct bitmap {
    unsigned int n;
    uint32_t b[1]; /* We allocate more */
};
struct loadparm_service {
    bool autoloaded;
    bool access_based_share_enum;
    bool acl_allow_execute_always;
    bool acl_check_permissions;
    bool acl_group_control;
    bool acl_map_full_control;
    bool administrative_share;
    const char **admin_users;
    bool afs_share;
    int aio_read_size;
    char *aio_write_behind;
    int aio_write_size;
    int allocation_roundup_size;
    bool available;
    bool blocking_locks;
    int block_size;
    bool browseable;
    int case_sensitive;
    bool check_parent_directory_delete_on_close;
    char *comment;
    char *copy;
    int create_mask;
    int csc_policy;
    char *cups_options;
    int default_case;
    bool default_devmode;
    bool delete_readonly;
    bool delete_veto_files;
    int dfree_cache_time;
    char *dfree_command;
    int directory_mask;
    int directory_name_cache_size;
    bool dmapi_support;
    char *dont_descend;
    bool dos_filemode;
    bool dos_filetime_resolution;
    bool dos_filetimes;
    bool durable_handles;
    bool ea_support;
    bool fake_directory_create_times;
    bool fake_oplocks;
    bool follow_symlinks;
    int force_create_mode;
    int force_directory_mode;
    char *force_group;
    bool force_printername;
    bool force_unknown_acl_user;
    char *force_user;
    char *fstype;
    bool guest_ok;
    bool guest_only;
    bool hide_dot_files;
    char *hide_files;
    int hide_new_files_timeout;
    bool hide_special_files;
    bool hide_unreadable;
    bool hide_unwriteable_files;
    const char **hosts_allow;
    const char **hosts_deny;
    char *include;
    bool inherit_acls;
    int inherit_owner;
    bool inherit_permissions;
    const char **invalid_users;
    bool kernel_oplocks;
    bool kernel_share_modes;
    bool level2_oplocks;
    bool locking;
    char *lppause_command;
    char *lpq_command;
    char *lpresume_command;
    char *lprm_command;
    char *magic_output;
    char *magic_script;
    int mangled_names;
    char mangling_char;
    bool map_acl_inherit;
    bool map_archive;
    bool map_hidden;
    int map_readonly;
    bool map_system;
    int max_connections;
    int max_print_jobs;
    int max_reported_print_jobs;
    int min_print_space;
    char *msdfs_proxy;
    bool msdfs_root;
    bool msdfs_shuffle_referrals;
    bool nt_acl_support;
    const char **ntvfs_handler;
    bool oplocks;
    char *path;
    bool posix_locking;
    char *postexec;
    char *preexec;
    bool preexec_close;
    bool preserve_case;
    bool printable;
    char *print_command;
    char *_printername;
    int printing;
    char *printjob_username;
    bool print_notify_backchannel;
    char *queuepause_command;
    char *queueresume_command;
    const char **read_list;
    bool read_only;
    char *root_postexec;
    char *root_preexec;
    bool root_preexec_close;
    bool short_preserve_case;
    bool smbd_async_dosmode;
    bool smbd_getinfo_ask_sharemode;
    int smbd_max_async_dosmode;
    bool smbd_search_ask_sharemode;
    int smb_encrypt;
    bool spotlight;
    bool store_dos_attributes;
    bool strict_allocate;
    int strict_locking;
    bool strict_rename;
    bool strict_sync;
    bool sync_always;
    bool use_client_driver;
    bool _use_sendfile;
    bool valid;
    const char **valid_users;
    char *veto_files;
    char *veto_oplock_files;
    const char **vfs_objects;
    char *volume;
    bool wide_links;
    int write_cache_size;
    const char **write_list;
    int usershare;
    struct timespec usershare_last_mod;
    char *szService;
    struct parmlist_entry *param_opt;
    struct bitmap *copymap;
    char dummy[3]; /* for alignment */
};
typedef struct smb_iconv_s {
    size_t (*direct)(void *cd, const char **inbuf, size_t *inbytesleft,
                     char **outbuf, size_t *outbytesleft);
    size_t (*pull)(void *cd, const char **inbuf, size_t *inbytesleft,
                   char **outbuf, size_t *outbytesleft);
    size_t (*push)(void *cd, const char **inbuf, size_t *inbytesleft,
                   char **outbuf, size_t *outbytesleft);
    void *cd_direct, *cd_pull, *cd_push;
    char *from_name, *to_name;
} *smb_iconv_t;

struct smb_iconv_handle {
    TALLOC_CTX *child_ctx;
    const char *unix_charset;
    const char *dos_charset;
    const char *display_charset;
    bool use_builtin_handlers;
    smb_iconv_t conv_handles[NUM_CHARSETS][NUM_CHARSETS];
};
struct file_lists {
    struct file_lists *next;
    char *name;
    char *subfname;
    time_t modtime;
};

struct loadparm_context {
    const char *szConfigFile;
    struct loadparm_global *globals;
    struct loadparm_service **services;
    struct loadparm_service *sDefault;
    struct smb_iconv_handle *iconv_handle;
    int iNumServices;
    struct loadparm_service *currentService;
    bool bInGlobalSection;
    struct file_lists *file_lists;
    unsigned int *flags;
    bool loaded;
    bool refuse_free;
    bool global; /* Is this the global context, which may set
                  * global variables such as debug level etc? */
    const struct loadparm_s3_helpers *s3_fns;
};

struct gensec_settings {
    struct loadparm_context *lp_ctx;
    const char *target_hostname;

    /* this allows callers to specify a specific set of ops that
     * should be used, rather than those loaded by the plugin
     * mechanism */
    const struct gensec_security_ops *const *backends;

    /* To fill in our own name in the NTLMSSP server */
    const char *server_dns_domain;
    const char *server_dns_name;
    const char *server_netbios_domain;
    const char *server_netbios_name;
};

struct gensec_security {
    const struct gensec_security_ops *ops;
    void *private_data;
    struct cli_credentials *credentials;
    struct gensec_target target;
    enum gensec_role gensec_role;
    bool subcontext;
    uint32_t want_features;
    uint32_t max_update_size;
    uint8_t dcerpc_auth_level;
    struct tsocket_address *local_addr, *remote_addr;
    struct gensec_settings *settings;

    /* When we are a server, this may be filled in to provide an
     * NTLM authentication backend, and user lookup (such as if no
     * PAC is found) */
    struct auth4_context *auth_context;

    struct gensec_security *parent_security;
    struct gensec_security *child_security;

    /*
     * This is used to mark the context as being
     * busy in an async gensec_update_send().
     */
    struct gensec_security **update_busy_ptr;
};

/* this structure is used by backends to determine the size of some critical
 * types */
struct gensec_critical_sizes {
    int interface_version;
    int sizeof_gensec_security_ops;
    int sizeof_gensec_security;
};
#endif /* __GENSEC_H__ */

//// gensec

struct pipe_auth_data {
    enum dcerpc_AuthType auth_type;
    enum dcerpc_AuthLevel auth_level;
    uint32_t auth_context_id;
    bool client_hdr_signing;
    bool hdr_signing;
    bool verified_bitmask1;

    struct gensec_security *auth_ctx;

    /* Only the client code uses this for now */
    DATA_BLOB transport_session_key;
};
struct rpc_pipe_client {
    struct rpc_pipe_client *prev, *next;

    struct rpc_cli_transport *transport;
    struct dcerpc_binding_handle *binding_handle;

    struct ndr_syntax_id abstract_syntax;
    struct ndr_syntax_id transfer_syntax;
    bool verified_pcontext;

    char *desthost;
    char *srv_name_slash;

    uint16_t max_xmit_frag;

    struct pipe_auth_data *auth;
};

#endif /* _RPC_CLIENT_H */
