/*
   samba -- Unix SMB/CIFS implementation.

   Client credentials structure

   Copyright (C) Jelmer Vernooij 2004-2006
   Copyright (C) Andrew Bartlett <abartlet@samba.org> 2005

   This program is free software; you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation; either version 3 of the License, or
   (at your option) any later version.

   This program is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
#ifndef __CREDENTIALS_INTERNAL_H__
#define __CREDENTIALS_INTERNAL_H__

struct samr_Password;
struct ccache_container;
struct gssapi_creds_container;
struct keytab_container;
struct gssapi_creds_container;
struct smb_krb5_context;
struct netlogon_creds_CredentialState;
struct smb_krb5_context;
struct loadparm_contex;

enum netr_SchannelType {
    SEC_CHAN_NULL = (int)(0),
    SEC_CHAN_LOCAL = (int)(1),
    SEC_CHAN_WKSTA = (int)(2),
    SEC_CHAN_DNS_DOMAIN = (int)(3),
    SEC_CHAN_DOMAIN = (int)(4),
    SEC_CHAN_LANMAN = (int)(5),
    SEC_CHAN_BDC = (int)(6),
    SEC_CHAN_RODC = (int)(7)
};
/* In order of priority */
enum credentials_obtained {
    CRED_UNINITIALISED = 0, /* We don't even have a guess yet */
    CRED_CALLBACK,          /* Callback should be used to obtain value */
    CRED_GUESS_ENV,  /* Current value should be used, which was guessed */
    CRED_GUESS_FILE, /* A guess from a file (or file pointed at in env variable)
                      */
    CRED_CALLBACK_RESULT, /* Value was obtained from a callback */
    CRED_SPECIFIED        /* Was explicitly specified on the command-line */
};
enum credentials_use_kerberos {
    CRED_AUTO_USE_KERBEROS = 0, /* Default, we try kerberos if available */
    CRED_DONT_USE_KERBEROS, /* Sometimes trying kerberos just does 'bad things',
                               so don't */
    CRED_MUST_USE_KERBEROS  /* Sometimes administrators are parinoid, so always
                               do kerberos */
};

enum credentials_krb_forwardable {
    CRED_AUTO_KRB_FORWARDABLE = 0, /* Default, follow library defaults */
    CRED_NO_KRB_FORWARDABLE,       /* not forwardable */
    CRED_FORCE_KRB_FORWARDABLE     /* forwardable */
};

struct cli_credentials {
    enum credentials_obtained workstation_obtained;
    enum credentials_obtained username_obtained;
    enum credentials_obtained password_obtained;
    enum credentials_obtained domain_obtained;
    enum credentials_obtained realm_obtained;
    enum credentials_obtained ccache_obtained;
    enum credentials_obtained client_gss_creds_obtained;
    enum credentials_obtained principal_obtained;
    enum credentials_obtained keytab_obtained;
    enum credentials_obtained server_gss_creds_obtained;

    /* Threshold values (essentially a MAX() over a number of the
     * above) for the ccache and GSS credentials, to ensure we
     * regenerate/pick correctly */

    enum credentials_obtained ccache_threshold;
    enum credentials_obtained client_gss_creds_threshold;

    const char *workstation;
    const char *username;
    const char *password;
    const char *old_password;
    const char *domain;
    const char *realm;
    const char *principal;
    char *salt_principal;
    char *impersonate_principal;
    char *self_service;
    char *target_service;

    const char *bind_dn;

    /* Allows authentication from a keytab or similar */
    struct samr_Password *nt_hash;
    struct samr_Password *old_nt_hash;

    /* Allows NTLM pass-though authentication */
    DATA_BLOB lm_response;
    DATA_BLOB nt_response;

    struct ccache_container *ccache;
    struct gssapi_creds_container *client_gss_creds;
    struct keytab_container *keytab;
    struct gssapi_creds_container *server_gss_creds;

    const char *(*workstation_cb)(struct cli_credentials *);
    const char *(*password_cb)(struct cli_credentials *);
    const char *(*username_cb)(struct cli_credentials *);
    const char *(*domain_cb)(struct cli_credentials *);
    const char *(*realm_cb)(struct cli_credentials *);
    const char *(*principal_cb)(struct cli_credentials *);

    /* Private handle for the callback routines to use */
    void *priv_data;

    struct netlogon_creds_CredentialState *netlogon_creds;
    enum netr_SchannelType secure_channel_type;
    int kvno;
    time_t password_last_changed_time;

    struct smb_krb5_context *smb_krb5_context;

    /* We are flagged to get machine account details from the
     * secrets.ldb when we are asked for a username or password */
    bool machine_account_pending;
    struct loadparm_context *machine_account_pending_lp_ctx;

    /* Is this a machine account? */
    bool machine_account;

    /* Should we be trying to use kerberos? */
    enum credentials_use_kerberos use_kerberos;

    /* Should we get a forwardable ticket? */
    enum credentials_krb_forwardable krb_forwardable;

    /* Forced SASL mechansim */
    char *forced_sasl_mech;

    /* gensec features which should be used for connections */
    uint32_t gensec_features;

    /* Number of retries left before bailing out */
    uint32_t password_tries;

    /* Whether any callback is currently running */
    bool callback_running;

    char winbind_separator;

    bool password_will_be_nt_hash;
};

#endif /* __CREDENTIALS_INTERNAL_H__ */
