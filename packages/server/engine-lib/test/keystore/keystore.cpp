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

#include <engLib/eng.h>
#include "test.h"

using namespace engine::keystore;

application::Opt optKeyStoreNetUrl{"--url.keystorenet"};
_const TextView defaultKeyStoreFile = "kvsfile://data/keystore.json"_tv;

/**
 * Tests main functionality of the KeyStore
 * It could run against KeyStoreFile or KeyStoreNet.
 * To run against KeyStoreNet command line like next needs to be specified:
 *      engtest.exe
 * "--url.keystorenet=kvsnet://localhost:9745/?secure=true&tlsCaFile=D%3A%5Cdevelopment%5CRocketRide%5CGIT%5Crocketride-app.applat-7888.keyvaluestorage.2.12%5Cbuild%5Crocketride%5Cdebug%5Capp%5Cserver%5Ccertificates%5Clocal-ca.pem&tlsKeyFile=D%3A%5Cdevelopment%5CRocketRide%5CGIT%5Crocketride-app.applat-7888.keyvaluestorage.2.12%5Cbuild%5Crocketride%5Cdebug%5Capp%5Cserver%5Ccertificates%5Clocalhost-key.pem&tlsCertFile=D%3A%5Cdevelopment%5CRocketRide%5CGIT%5Crocketride-app.applat-7888.keyvaluestorage.2.12%5Cbuild%5Crocketride%5Cdebug%5Capp%5Cserver%5Ccertificates%5Clocalhost-cert.pem"
 * --testArgs=keystore/net,keystoreservice/net --diag To run is successfully,
 * the APP needs to be running, and `--url.keystorenet` parameter points to the
 * correct URL from the running APP To obtain the correct URL - APP could be run
 * with `--engine.keepInput` option, and the URL should be taken from the
 * resulting .json file
 * @param KeystoreClass class name to test against
 * @param keystoreName key store name
 */
template <class KeystoreClass>
void runKeyStoreTests(TextView keystoreName) {
    auto logScope = enableTestLogging(Lvl::KeyStore, Lvl::Connection, Lvl::Tls);

    KeystoreClass keystore;

    //-------------------------------
    // KeyStoreNet not-opened Section
    //-------------------------------
    SECTION("not-opened") {
        REQUIRE_ERROR(keystore.getValue("partition1", "key1"), Ec::NotOpen);
        REQUIRE_ERROR(keystore.setValue("partition1", "key1", "value11"),
                      Ec::NotOpen);
        REQUIRE_ERROR(keystore.deleteKey("partition1", "key1"), Ec::NotOpen);
        REQUIRE_ERROR(keystore.deleteAll("partition1"), Ec::NotOpen);
        REQUIRE_ERROR(keystore.getAll("partition1"), Ec::NotOpen);
        REQUIRE_ERROR(keystore.copyAll("partition1", "partition2"),
                      Ec::NotOpen);
        REQUIRE_ERROR(keystore.moveAll("partition1", "partition2", true, false),
                      Ec::NotOpen);
    }

    REQUIRE_NO_ERROR(keystore.open(keystoreName));

    //-------------------------------
    // KeyStoreNet open Section
    //-------------------------------
    SECTION("open") {
        REQUIRE_ERROR(keystore.open(keystoreName), Ec::AlreadyOpened);
    }

    //-------------------------------
    // KeyStoreNet setValue Section
    //-------------------------------
    SECTION("setValue") {
        REQUIRE_NO_ERROR(keystore.setValue("partition1", "key1", "value11"));
        REQUIRE_NO_ERROR(keystore.setValue("partition1", "key2", "value12"));
        REQUIRE_NO_ERROR(keystore.setValue("partition2", "key1", "value21"));
        REQUIRE_NO_ERROR(keystore.setValue("partition2", "key2", "value22"));
        // default partition
        REQUIRE_NO_ERROR(keystore.setValue("defaultkey1", "defaultvalue1"));
        REQUIRE_NO_ERROR(keystore.setValue(KeyStore::PARTITION_DEFAULT,
                                           "defaultkey2", "defaultvalue2"));
    }

    //-------------------------------
    // KeyStoreNet getValue Section
    //-------------------------------
    SECTION("getValue") {
        REQUIRE_VALUE(keystore.getValue("partition1", "key1"), "value11");
        REQUIRE_VALUE(keystore.getValue("partition1", "key2"), "value12");
        REQUIRE_VALUE(keystore.getValue("partition1", "key3"), "");
        REQUIRE_VALUE(keystore.getValue("partition2", "key1"), "value21");
        REQUIRE_VALUE(keystore.getValue("partition2", "key2"), "value22");
        REQUIRE_VALUE(keystore.getValue("partition2", "key3"), "");
        REQUIRE_VALUE(keystore.getValue("partition3", "key1"), "");
        // default partition
        REQUIRE_VALUE(keystore.getValue("defaultkey1"), "defaultvalue1");
        REQUIRE_VALUE(
            keystore.getValue(KeyStore::PARTITION_DEFAULT, "defaultkey2"),
            "defaultvalue2");
    }

    //-------------------------------
    // KeyStoreNet deleteKey Section
    //-------------------------------
    SECTION("deleteKey") {
        REQUIRE_NO_ERROR(keystore.deleteKey("partition1", "key1"));
        REQUIRE_NO_ERROR(keystore.deleteKey("partition1", "key1"));
        REQUIRE_NO_ERROR(keystore.deleteKey("partition1", "key3"));
        REQUIRE_NO_ERROR(keystore.deleteKey("partition3", "key1"));

        REQUIRE_VALUE(keystore.getValue("partition1", "key1"), "");
        REQUIRE_VALUE(keystore.getValue("partition1", "key2"), "value12");
        REQUIRE_VALUE(keystore.getValue("partition2", "key1"), "value21");
        REQUIRE_VALUE(keystore.getValue("partition2", "key2"), "value22");
    }

    //-------------------------------
    // KeyStoreNet deleteAll Section
    //-------------------------------
    SECTION("deleteAll") {
        REQUIRE_NO_ERROR(keystore.deleteAll("partition2"));
        REQUIRE_NO_ERROR(keystore.deleteAll("partition2"));
        REQUIRE_NO_ERROR(keystore.deleteAll("partition3"));

        REQUIRE_VALUE(keystore.getValue("partition1", "key1"), "");
        REQUIRE_VALUE(keystore.getValue("partition1", "key2"), "value12");
        REQUIRE_VALUE(keystore.getValue("partition2", "key1"), "");
        REQUIRE_VALUE(keystore.getValue("partition2", "key2"), "");
    }

    //-------------------------------
    // KeyStoreNet getAll Section
    //-------------------------------
    SECTION("getAll") {
        REQUIRE_NO_ERROR(keystore.setValue("partition1", "key1", "value11"));

        REQUIRE_VALUE(
            keystore.getAll("partition1"),
            KeyStore::Values({{"key1", "value11"}, {"key2", "value12"}}));
        REQUIRE_VALUE(keystore.getAll("partition2"), KeyStore::Values());
        REQUIRE_VALUE(keystore.getAll("partition3"), KeyStore::Values());
    }

    //-------------------------------
    // KeyStoreNet copyAll Section
    //-------------------------------
    SECTION("copyAll") {
        REQUIRE_NO_ERROR(keystore.copyAll("partition1", "partition2"));

        REQUIRE_VALUE(
            keystore.getAll("partition1"),
            KeyStore::Values({{"key1", "value11"}, {"key2", "value12"}}));
        REQUIRE_VALUE(
            keystore.getAll("partition2"),
            KeyStore::Values({{"key1", "value11"}, {"key2", "value12"}}));
        REQUIRE_VALUE(keystore.getAll("partition3"), KeyStore::Values());
    }

    //-------------------------------
    // KeyStoreNet moveAll Section
    //-------------------------------
    SECTION("moveAll") {
        REQUIRE_NO_ERROR(keystore.deleteAll("partition2"));

        // move without check for empty
        REQUIRE_NO_ERROR(
            keystore.moveAll("partition1", "partition2", true, false));

        REQUIRE_VALUE(keystore.getAll("partition1"), KeyStore::Values());
        REQUIRE_VALUE(
            keystore.getAll("partition2"),
            KeyStore::Values({{"key1", "value11"}, {"key2", "value12"}}));
        REQUIRE_VALUE(keystore.getAll("partition3"), KeyStore::Values());

        // move with check for empty - should not replace anything
        REQUIRE_NO_ERROR(
            keystore.moveAll("partition1", "partition2", true, true));
        REQUIRE_VALUE(keystore.getAll("partition1"), KeyStore::Values());
        REQUIRE_VALUE(
            keystore.getAll("partition2"),
            KeyStore::Values({{"key1", "value11"}, {"key2", "value12"}}));

        // checking erasure of destination partition
        REQUIRE_NO_ERROR(keystore.deleteAll("partition1"));
        REQUIRE_NO_ERROR(keystore.deleteAll("partition2"));
        REQUIRE_NO_ERROR(keystore.setValue("partition1", "key1", "value11"));
        REQUIRE_NO_ERROR(keystore.setValue("partition1", "key2", "value12"));
        REQUIRE_NO_ERROR(keystore.setValue("partition2", "key3", "value31"));
        REQUIRE_NO_ERROR(keystore.setValue("partition2", "key4", "value42"));
        REQUIRE_VALUE(
            keystore.getAll("partition1"),
            KeyStore::Values({{"key1", "value11"}, {"key2", "value12"}}));
        REQUIRE_VALUE(
            keystore.getAll("partition2"),
            KeyStore::Values({{"key3", "value31"}, {"key4", "value42"}}));
        REQUIRE_NO_ERROR(
            keystore.moveAll("partition1", "partition2", true, true));
        REQUIRE_VALUE(keystore.getAll("partition1"), KeyStore::Values());
        REQUIRE_VALUE(
            keystore.getAll("partition2"),
            KeyStore::Values({{"key1", "value11"}, {"key2", "value12"}}));

        // checking that destination partition is not cleaned up
        REQUIRE_NO_ERROR(keystore.deleteAll("partition1"));
        REQUIRE_NO_ERROR(keystore.deleteAll("partition2"));
        REQUIRE_NO_ERROR(keystore.setValue("partition1", "key1", "value11"));
        REQUIRE_NO_ERROR(keystore.setValue("partition1", "key2", "value12"));
        REQUIRE_NO_ERROR(keystore.setValue("partition2", "key3", "value31"));
        REQUIRE_NO_ERROR(keystore.setValue("partition2", "key4", "value42"));
        REQUIRE_VALUE(
            keystore.getAll("partition1"),
            KeyStore::Values({{"key1", "value11"}, {"key2", "value12"}}));
        REQUIRE_VALUE(
            keystore.getAll("partition2"),
            KeyStore::Values({{"key3", "value31"}, {"key4", "value42"}}));
        REQUIRE_NO_ERROR(
            keystore.moveAll("partition1", "partition2", false, true));
        REQUIRE_VALUE(keystore.getAll("partition1"), KeyStore::Values());
        REQUIRE_VALUE(keystore.getAll("partition2"),
                      KeyStore::Values({{"key1", "value11"},
                                        {"key2", "value12"},
                                        {"key3", "value31"},
                                        {"key4", "value42"}}));
    }
}

/**
 * Tests service functionality of the KeyStore.
 * Service key store is a wrapper around main KeyStore (which could be either
 * KeyStoreFile or KeyStoreNet). The service key store modifies keys by adding
 * prefix to them
 * @param KeystoreClass class name to test against (KeyStoreFile or KeyStoreNet)
 * @param keystoreName key store name
 */
template <class KeystoreClass>
void runKeyStoreServiceTests(TextView keystoreName) {
    auto logScope = enableTestLogging(Lvl::KeyStore, Lvl::Connection, Lvl::Tls);

    auto errorOrKeystore = open(keystoreName);
    if (errorOrKeystore.hasCcode()) throw errorOrKeystore.ccode();
    KeyStorePtr keystore = errorOrKeystore.value();
    const auto serviceKey = "service"_tv;
    errorOrKeystore = makeShared<ServiceKeyStore>(serviceKey, keystore);
    if (errorOrKeystore.hasCcode()) throw errorOrKeystore.ccode();
    KeyStorePtr servicekeystore = errorOrKeystore.value();

    //-------------------------------
    // KeyStoreNet clean-up
    //-------------------------------
    SECTION("clean-up") {
        REQUIRE_NO_ERROR(keystore->deleteAll("partition1"));
        REQUIRE_NO_ERROR(keystore->deleteAll("partition2"));
    }

    //-------------------------------
    // KeyStoreNet setValue Section
    //-------------------------------
    SECTION("serviceSetValue") {
        REQUIRE_NO_ERROR(keystore->setValue("partition1", "key1", "value11"));
        REQUIRE_NO_ERROR(
            servicekeystore->setValue("partition1", "key2", "value12"));
        REQUIRE_NO_ERROR(keystore->setValue("partition2", "key1", "value21"));
        REQUIRE_NO_ERROR(
            servicekeystore->setValue("partition2", "key2", "value22"));
        // default partition
        REQUIRE_NO_ERROR(keystore->setValue("defaultkey1", "defaultvalue1"));
        REQUIRE_NO_ERROR(
            servicekeystore->setValue("defaultkey2", "defaultvalue2"));
        REQUIRE_NO_ERROR(keystore->setValue(
            _ts(serviceKey, "/", KeyStore::PARTITION_DEFAULT), "defaultkey3",
            "defaultvalue3"));
    }

    //-------------------------------
    // KeyStoreNet getValue Section
    //-------------------------------
    SECTION("serviceGetValue") {
        REQUIRE_VALUE(keystore->getValue("partition1", "key1"), "value11");
        REQUIRE_VALUE(servicekeystore->getValue("partition1", "key2"),
                      "value12");
        REQUIRE_VALUE(
            keystore->getValue(_ts(serviceKey, "/", "partition1"), "key2"),
            "value12");
        REQUIRE_VALUE(keystore->getValue("partition1", "key3"), "");

        REQUIRE_VALUE(keystore->getValue("partition2", "key1"), "value21");
        REQUIRE_VALUE(servicekeystore->getValue("partition2", "key2"),
                      "value22");
        REQUIRE_VALUE(
            keystore->getValue(_ts(serviceKey, "/", "partition2"), "key2"),
            "value22");
        REQUIRE_VALUE(keystore->getValue("partition2", "key3"), "");

        REQUIRE_VALUE(keystore->getValue("partition3", "key1"), "");

        // default partition
        REQUIRE_VALUE(keystore->getValue("defaultkey1"), "defaultvalue1");
        REQUIRE_VALUE(servicekeystore->getValue("defaultkey2"),
                      "defaultvalue2");
        REQUIRE_VALUE(keystore->getValue(
                          _ts(serviceKey, "/", KeyStore::PARTITION_DEFAULT),
                          "defaultkey3"),
                      "defaultvalue3");
    }
}

TEST_CASE("keystore/net", "[.]") {
    REQUIRE(optKeyStoreNetUrl);
    runKeyStoreTests<KeyStoreNet>(_cast<TextView>(optKeyStoreNetUrl));
}

TEST_CASE("keystore/file") {
    runKeyStoreTests<KeyStoreFile>(defaultKeyStoreFile);
}

TEST_CASE("keystoreservice/net", "[.]") {
    REQUIRE(optKeyStoreNetUrl);
    runKeyStoreServiceTests<KeyStoreNet>(_cast<TextView>(optKeyStoreNetUrl));
}

TEST_CASE("keystoreservice/file") {
    runKeyStoreServiceTests<KeyStoreFile>(defaultKeyStoreFile);
}
