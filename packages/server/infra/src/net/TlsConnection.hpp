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

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/conf.h>

namespace engine::net {

// This class implements a client side TLS socket connection and validation.
class TlsConnection final {
protected:
    struct ErrorCategory;
    using ErrorCategorySingleton = Singleton<ErrorCategory>;

public:
    _const auto LogLevel = Lvl::Tls;
    _const char *const PreferredCiphers{
        "TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256"};

    struct Options {
        file::Path caFile;
        file::Path certFile;
        file::Path keyFile;

        auto __jsonSchema() const noexcept {
            return json::makeSchema(caFile, "tlsCaFile", certFile,
                                    "tlsCertFile", keyFile, "tlsKeyFile");
        }
    };

    TlsConnection() noexcept : m_initalizer(Singleton<Initializer>::get()) {}

    ~TlsConnection() noexcept { close(); }

    // open a TLs socket
    Error connect(const Text &address, uint16_t port,
                  const Options opts = {}) const noexcept {
        LOGT("TLS connecting to: {}:{}", address, port);

        ASSERT(!m_method);

        LOGT("Loading values", opts);

        m_method = SSLv23_method();
        if (!m_method) return fromLastError("TLS_method");

        m_ctx = SSL_CTX_new(m_method);
        if (!m_ctx) return fromLastError("TLS_method");

        if (!opts.caFile) {
            auto store = m_initalizer.loadStore();
            if (store) {
                SSL_CTX_set_cert_store(m_ctx, store);
                LOGT("Applying TlsCa store");
            }
        }

        SSL_CTX_set_verify(m_ctx, SSL_VERIFY_PEER, verifyCallback);

        SSL_CTX_set_verify_depth(m_ctx, 5);

        if (opts.caFile) {
            if (!SSL_CTX_load_verify_locations(m_ctx, opts.caFile.gen(),
                                               nullptr))
                return fromLastError("SSL_CTX_load_verify_locations");
        }

        if (opts.certFile) {
            if (SSL_CTX_use_certificate_file(m_ctx, opts.certFile.gen(),
                                             SSL_FILETYPE_PEM) != 1) {
                return fromLastError("SSL_CTX_use_certificate_file");
            }
        }
        if (opts.keyFile) {
            if (SSL_CTX_use_PrivateKey_file(m_ctx, opts.keyFile.gen(),
                                            SSL_FILETYPE_PEM) != 1) {
                return fromLastError("SSL_CTX_use_PrivateKey_file");
            }
            if (opts.certFile) {
                if (SSL_CTX_check_private_key(m_ctx) != 1) {
                    return fromLastError("SSL_CTX_check_private_key");
                }
            }
        }

        // Remove the most egregious. Because SSLv2 and SSLv3 have been
        // removed, a TLSv1.3 handshake is used. The client accepts TLSv1.3
        // and above. An added benefit of TLS 1.3 and above are TLS
        // extensions like Server Name Indicator (SNI).
        const auto flags = SSL_OP_ALL | SSL_OP_NO_SSLv2 | SSL_OP_NO_SSLv3 |
                           SSL_OP_NO_COMPRESSION | SSL_OP_NO_TLSv1 |
                           SSL_OP_NO_DTLSv1 | SSL_OP_NO_TLSv1_1 |
                           SSL_OP_NO_TLSv1_2 | SSL_OP_NO_DTLSv1_2;
        SSL_CTX_set_options(m_ctx, flags);

        if (!SSL_CTX_set_default_verify_paths(m_ctx)) {
            return fromLastError("SSL_CTX_set_default_verify_paths");
        }

        m_bio = BIO_new_ssl_connect(m_ctx);
        if (!m_bio) return fromLastError("BIO_new_ssl_connect");

        if (!BIO_set_conn_hostname(m_bio, (address + ":" + _ts(port)).c_str()))
            return fromLastError("BIO_set_conn_hostname");

        BIO_get_ssl(m_bio, &m_ssl);
        if (!m_ssl) return fromLastError("BIO_get_ssl");

        if (!SSL_set_ciphersuites(m_ssl, PreferredCiphers))
            return fromLastError("SSL_set_ciphersuites");

        if (!SSL_set_tlsext_host_name(m_ssl, address.c_str()))
            LOGT(
                "Failed to set server TLS extension host name (non fatal) with "
                "error {}",
                fromLastError("SSL_set_tlsext_host_name"));

        if (BIO_do_connect(m_bio) != 1) return fromLastError("BIO_do_connect");

        if (BIO_do_handshake(m_bio) != 1)
            return fromLastError("BIO_do_handshake");

        // Perform X509 verification here. There are two documents that provide
        // guidance on the gyrations. First is RFC 5280, and second is RFC 6125.
        // Two other documents of interest are:
        //   Baseline Certificate Requirements:
        //     https://www.cabforum.org/Baseline_Requirements_V1_1_6.pdf
        //   Extended Validation Certificate Requirements:
        //     https://www.cabforum.org/Guidelines_v1_4_3.pdf
        //
        // Minimum steps to perform:
        //   1. Call m_sslget_peer_certificate and ensure the certificate is
        //      non-NULL. It should never be NULL because Anonymous
        //      Diffie-Hellman (ADH) is not allowed.
        //   2. Call m_sslget_verify_result and ensure it returns X509_V_OK.
        //      This return value depends upon the verify_callback provided.
        //      The library default validation is also fine (and there's no
        //      need to change it).
        //   3. Verify either the CN or the SAN matches the host connected.
        //      Note Well (N.B.): OpenSSL prior to version 1.1.0 did *NOT*
        // 		perform hostname verification. If using OpenSSL 0.9.8 or
        //		1.0.1, then hostname verification must be done manually.
        //      The code as a template that could do hostname verification is
        //		logCnName and logSanName. Be sensitive to ccTLDs (don't
        //		natively transform the hostname string).
        //		http://publicsuffix.org/ might be helpful.
        //
        // If all three checks succeed, then there is a chance at a secure
        // connection. But its only a chance, and either pin your
        // certificates (to remove DNS, CA, and Web Hosters from the equation)
        // or implement a Trust-On-First-Use (TOFU) scheme like Perspectives
        // or SSH. But before you TOFU, make the customary checks to ensure
        // the certificate passes the sniff test.
        //

        // Step 1: verify a server certificate was presented during negotiation
        // https://www.openssl.org/docs/ssl/m_sslget_peer_certificate.html
        X509 *cert = SSL_get_peer_certificate(m_ssl);
        auto guardUtf8 = util::Scope{[&]() noexcept {
            if (cert) X509_free(cert);
        }};

        ASSERT(cert);
        if (!cert)
            return toError(X509_V_ERR_APPLICATION_VERIFICATION,
                           "SSL_get_peer_certificate");

        // Step 2: verify the result of chain verification
        // http://www.openssl.org/docs/ssl/m_sslget_verify_result.html
        // Error codes: http://www.openssl.org/docs/apps/verify.html

        if (auto res = SSL_get_verify_result(m_ssl); res != X509_V_OK)
            return toError(_cast<unsigned long>(res), "SSL_get_verify_result");

        return {};
    }

    // Recv data form a TLS socket
    Error read(OutputData data) const noexcept {
        while (data) {
            // Receive as much as we can
            auto recvSize =
                BIO_read(m_bio, data.cast<unsigned char>(), data.sizeAs<int>());
            if (recvSize < 0) {
                if (BIO_should_retry(m_bio) && !async::cancelled()) {
                    LOGT(
                        "OpenSSL read failed due to retryable condition; "
                        "retrying",
                        lastSocketError());
                    continue;
                } else
                    return fromLastError("BIO_read");
            }
            if (recvSize == 0) return {};

            LOGT("Read", data.slice(recvSize));

            data.consumeSlice(recvSize);
        }
        return {};
    }

    // Send data on a socket
    Error write(InputData data) noexcept {
        while (data) {
            LOGT("Write", data);

            // Send it
            auto sentSize = BIO_write(m_bio, data.cast<unsigned char>(),
                                      data.sizeAs<int>());
            if (sentSize < 0) {
                if (BIO_should_retry(m_bio) && !async::cancelled()) {
                    LOGT(
                        "OpenSSL write failed due to retryable condition; "
                        "retrying",
                        lastSocketError());
                    continue;
                } else
                    return fromLastError("BIO_write");
            }

            data.consumeSlice(sentSize);
        }

        return {};
    }

    void close() const noexcept {
        m_ssl = {};
        if (m_bio) {
            BIO_free_all(m_bio);
            m_bio = {};
        }
        if (m_ctx) {
            SSL_CTX_free(m_ctx);
            m_ctx = {};
        }
    }

protected:
    struct Initializer {
        Initializer() noexcept {
            (void)SSL_library_init();
            SSL_load_error_strings();
        }

        ~Initializer() noexcept {}

        X509_STORE *loadStore() const noexcept { return m_ca.loadStore(); }

    private:
        TlsCa m_ca;
    };

    struct ErrorCategory : std::error_category {
        const char *name() const noexcept override { return "tls"; }
        std::string message(int code) const override {
            char buffer[256]{};
            ERR_error_string_n(_cast<unsigned long>(code), buffer,
                               sizeof(buffer) / sizeof(char));
            return std::string{buffer};
        }
    };

    static int verifyCallback(int preverify,
                              X509_STORE_CTX *x509_ctx) noexcept {
        int depth = X509_STORE_CTX_get_error_depth(x509_ctx);
        int err = X509_STORE_CTX_get_error(x509_ctx);

        X509 *cert = X509_STORE_CTX_get_current_cert(x509_ctx);
        X509_NAME *iname = cert ? X509_get_issuer_name(cert) : nullptr;
        X509_NAME *sname = cert ? X509_get_subject_name(cert) : nullptr;

        LOG(Tls, "TLS verify callback: depth={}, pre-verify={}", depth,
            preverify);

        logCnName("Issuer (cn)", iname);
        logCnName("Subject (cn)", sname);

        if (depth == 0) {
            // If depth is 0, its the server's certificate. Print the SANs
            logSanName("Subject (san)", cert);
        }

        if (preverify == 0) {
            auto msg{"(other)"_tv};
            switch (err) {
                case X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
                    msg = "X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
                    break;
                case X509_V_ERR_CERT_UNTRUSTED:
                    msg = "X509_V_ERR_CERT_UNTRUSTED";
                    break;
                case X509_V_ERR_SELF_SIGNED_CERT_IN_CHAIN:
                    msg = "X509_V_ERR_SELF_SIGNED_CERT_IN_CHAIN";
                    break;
                case X509_V_ERR_CERT_NOT_YET_VALID:
                    msg = "X509_V_ERR_CERT_NOT_YET_VALID";
                    break;
                case X509_V_ERR_CERT_HAS_EXPIRED:
                    msg = "X509_V_ERR_CERT_HAS_EXPIRED";
                    break;
                case X509_V_OK:
                    msg = "X509_V_OK";
                    break;
                default:
                    break;
            }
            LOG(Tls, "{}", toError(err, msg));
        }

        return preverify;
    }

    static void logCnName(const char *label, X509_NAME *const name) noexcept {
        bool success{};
        unsigned char *utf8{};
        auto guardUtf8 = util::Scope{[&]() noexcept {
            if (utf8) OPENSSL_free(utf8);
        }};
        auto guardOutput = util::Scope{[&]() noexcept {
            if (success) {
                LOG(Tls, "TLS {} is {}", label,
                    _ts(_reCast<const char *>(utf8)));
                return;
            }
            LOG(Tls, "TLS {} is not available", label);
        }};

        if (!name) return;

        int idx{X509_NAME_get_index_by_NID(name, NID_commonName, -1)};
        if (!(idx > -1)) return;

        X509_NAME_ENTRY *entry = X509_NAME_get_entry(name, idx);
        if (!entry) return;

        ASN1_STRING *data = X509_NAME_ENTRY_get_data(entry);
        if (!data) return;

        int length = ASN1_STRING_to_UTF8(&utf8, data);
        if (!utf8 || !(length > 0)) return;

        success = true;
    }

    static void logSanName(const char *label, X509 *const cert) {
        bool success{};

        auto guardOutputFailure = util::Scope{[&]() noexcept {
            if (success) return;
            LOG(Tls, "TLS {} is not available", _ts(label));
        }};

        if (!cert) return;

        auto names = static_cast<GENERAL_NAMES *>(
            X509_get_ext_d2i(cert, NID_subject_alt_name, 0, 0));
        auto guardNames = util::Scope{[&]() noexcept {
            if (names) GENERAL_NAMES_free(names);
        }};

        if (!names) return;

        int count{sk_GENERAL_NAME_num(names)};
        if (!count) return;

        for (int i = 0; i < count; ++i) {
            unsigned char *utf8{};
            auto guardUtf8 = util::Scope{[&]() noexcept {
                if (utf8) OPENSSL_free(utf8);
            }};

            GENERAL_NAME *entry = sk_GENERAL_NAME_value(names, i);
            if (!entry) continue;

            if (GEN_DNS != entry->type) {
                LOG(Tls, "Unknown GENERAL_NAME type: {}", entry->type);
                continue;
            }

            int len1{ASN1_STRING_to_UTF8(&utf8, entry->d.dNSName)};
            if (!utf8) continue;

            auto len2 =
                _cast<decltype(len1)>(strlen(_reCast<const char *>(utf8)));
            if (len1 != len2) {
                LOG(Tls,
                    "strlen(...) and ASN1_STRING size do not match (embedded "
                    "NUL?): {} vs {}",
                    len2, len1);
                continue;
            }

            // If there's a problem with string lengths, then
            // we skip the candidate and move on to the next.
            // Another policy would be to fail since it probably
            // indicates the client is under attack.
            LOG(Tls, "Tls {} is {}", label, _reCast<const char *>(utf8));
            success = true;
        }
    }

    static Error fromLastError(const char *const label) noexcept {
        return toError(ERR_get_error(), label);
    }

    static Error toError(unsigned long err, TextView label) {
        auto makeError = [](unsigned long err) noexcept -> auto {
            return std::error_code{_cast<int>(err),
                                   ErrorCategorySingleton::get()};
        };
        const char *const str = ERR_reason_error_string(err);
        if (str)
            return APERR(makeError(err), "TLS failure in", label, "with", str);
        return APERR(makeError(err), "TLS failure in", label, "with error code",
                     err);
    }

protected:
    const Initializer &m_initalizer;

    mutable const SSL_METHOD *m_method{};
    mutable SSL_CTX *m_ctx{};
    mutable BIO *m_bio{};
    mutable SSL *m_ssl{};
};

}  // namespace engine::net
