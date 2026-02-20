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

#include <wincrypt.h>

#ifdef X509_NAME
#undef X509_NAME
#endif  // X509_NAME

#include <openssl/x509.h>

#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "cryptui.lib")

namespace engine::net {

// This class implements searches the os certificate authority for root
// signing certificates used for trust chain validation.
class TlsCa final {
    struct Initializer final {
        _const auto LogLevel = Lvl::Tls;

        Initializer() noexcept {
            PCCERT_CONTEXT pContext{NULL};
            X509 *x509{};

            HCERTSTORE hStore = ::CertOpenSystemStoreA(NULL, "ROOT");

            if (!hStore) {
                LOGT("Unable to open root certificate");
                return;
            }

            auto next = [&]() noexcept -> bool {
                pContext = CertEnumCertificatesInStore(hStore, pContext);
                return pContext;
            };
            while (next()) {
                const unsigned char *pEncoded = pContext->pbCertEncoded;
                if (!pEncoded) {
                    LOGT("Encoded certificate is null");
                    continue;
                }
                x509 = d2i_X509(NULL, &pEncoded, pContext->cbCertEncoded);
                if (!x509) {
                    LOGT("Unable to convert certificate from store");
                    continue;
                }

                LOGT("Certificate loaded from certificate store with id:",
                     _reCast<uintptr_t>(x509), " and data:",
                     memory::DataView{
                         pContext->pbCertEncoded,
                         _reCast<uintptr_t>(pEncoded) -
                             _reCast<uintptr_t>(pContext->pbCertEncoded)});

                m_certs.push_back(x509);
            }

            CertFreeCertificateContext(pContext);
            CertCloseStore(hStore, 0);
        }

        ~Initializer() noexcept {
            for (auto cert : m_certs) {
                X509_free(cert);
            }
        }

        X509_STORE *loadStore() const noexcept {
            auto store = X509_STORE_new();
            for (auto cert : m_certs) {
                if (X509_STORE_add_cert(store, cert)) {
                    LOGT("Certificate added from certificate store with id:",
                         _reCast<uintptr_t>(cert));
                } else {
                    LOGT(
                        "Failed to add certificate from certificate store with "
                        "id:",
                        _reCast<uintptr_t>(cert));
                }
            }
            return store;
        }

    private:
        std::vector<X509 *> m_certs;
    };

public:
    _const auto LogLevel = Lvl::Tls;

    TlsCa() noexcept : m_initalizer(m_singleton.get()) {}

    ~TlsCa() noexcept = default;

    X509_STORE *loadStore() const noexcept { return m_initalizer.loadStore(); }

private:
    Singleton<Initializer> m_singleton;
    Initializer &m_initalizer;
};

}  // namespace engine::net
