// =============================================================================
// MIT License
//
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

#include "test.h"

using namespace engine::store::pipeline;

namespace {

_const auto Secret = "example-param-token-secret"_tv;

// Sets the deployment secret for the life of the scope, then restores it
class SecretEnvScope {
public:
    explicit SecretEnvScope(TextView value) noexcept
        : m_saved(plat::env(crypto::ParamTokenSecretEnv)) {
        plat::setEnv(crypto::ParamTokenSecretEnv, value);
    }
    ~SecretEnvScope() { plat::setEnv(crypto::ParamTokenSecretEnv, m_saved); }

private:
    Text m_saved;
};

// Encrypt values into a secureParameters token with the given secret
Text makeToken(const json::Value &values, TextView secret) {
    return crypto::base64Encode(
        *crypto::paramTokenEncrypt(values.stringify(), secret));
}

// A pipeline whose source keeps one secure value in its profile section and
// one in its parameters
json::Value makePipeline(TextView secret) {
    auto root = R"({
        "pipeline": {
            "source": "source_1",
            "components": [
                {
                    "id": "source_1",
                    "provider": "filesys",
                    "config": {
                        "profile": "default",
                        "default": {
                            "secureParameters": { "secure": ["apikey"] }
                        },
                        "parameters": {
                            "user": "example-user",
                            "secureParameters": { "secure": ["password"] }
                        }
                    }
                }
            ]
        }
    })"_json;

    auto &config = root["pipeline"]["components"][0]["config"];
    config["default"]["secureParameters"]["token"] = makeToken(
        R"({"apikey": "example-api-key"})"_json, secret);  // gitleaks:allow
    config["parameters"]["secureParameters"]["token"] = makeToken(
        R"({"password": "example-password"})"_json, secret);  // gitleaks:allow
    return root;
}

}  // namespace

TEST_CASE("PipelineConfig::resolveSecureParameters") {
    SECTION("original-format tokens") {
        SecretEnvScope scope({});
        PipelineConfig pipeline(makePipeline({}));

        REQUIRE_NO_ERROR(pipeline.resolveSecureParameters());

        auto &config = pipeline.components()[0]["config"];
        REQUIRE(config["default"]["apikey"].asString() == "example-api-key");
        REQUIRE(config["parameters"]["password"].asString() ==
                "example-password");
        REQUIRE(config["parameters"]["user"].asString() == "example-user");
        REQUIRE_FALSE(config["default"].isMember("secureParameters"));
        REQUIRE_FALSE(config["parameters"].isMember("secureParameters"));
    }

    SECTION("versioned tokens") {
        SecretEnvScope scope(Secret);
        PipelineConfig pipeline(makePipeline(Secret));

        REQUIRE_NO_ERROR(pipeline.resolveSecureParameters());

        auto &config = pipeline.components()[0]["config"];
        REQUIRE(config["default"]["apikey"].asString() == "example-api-key");
        REQUIRE(config["parameters"]["password"].asString() ==
                "example-password");
        REQUIRE_FALSE(config["default"].isMember("secureParameters"));
        REQUIRE_FALSE(config["parameters"].isMember("secureParameters"));
    }

    SECTION("versioned tokens without the secret") {
        auto root = makePipeline(Secret);
        SecretEnvScope scope({});
        PipelineConfig pipeline(_mv(root));

        auto ccode = pipeline.resolveSecureParameters();
        REQUIRE_ERROR(ccode, Ec::InvalidCipher, "which is not set");
        REQUIRE(ccode.message().contains(crypto::ParamTokenSecretEnv));
        REQUIRE_FALSE(_ts(ccode).contains(Secret));
    }

    SECTION("altered versioned token") {
        SecretEnvScope scope(Secret);
        PipelineConfig pipeline(makePipeline(Secret));

        // Flip a bit in the last byte of the authentication tag
        auto &secure =
            pipeline
                .components()[0]["config"]["parameters"]["secureParameters"];
        Text encoded = secure["token"].asString();
        auto token = *crypto::base64Decode(encoded);
        token[token.size() - 1] ^= 0x01;
        secure["token"] = crypto::base64Encode(token);

        auto ccode = pipeline.resolveSecureParameters();
        REQUIRE_ERROR(ccode, Ec::InvalidCipher, "failed authentication");
        REQUIRE_FALSE(_ts(ccode).contains(Secret));
        REQUIRE_FALSE(pipeline.components()[0]["config"]["parameters"].isMember(
            "password"));
    }

    SECTION("values already set are kept") {
        SecretEnvScope scope({});
        PipelineConfig pipeline(makePipeline({}));
        pipeline.components()[0]["config"]["parameters"]["password"] =
            "updated-password";

        REQUIRE_NO_ERROR(pipeline.resolveSecureParameters());
        REQUIRE(pipeline.components()[0]["config"]["parameters"]["password"]
                    .asString() == "updated-password");
    }

    SECTION("malformed section") {
        PipelineConfig pipeline(makePipeline({}));
        pipeline.components()[0]["config"]["parameters"]["secureParameters"]
                             ["token"] = 42;

        REQUIRE_ERROR(pipeline.resolveSecureParameters(), Ec::InvalidParam,
                      "'secureParameters' must have a 'token' string");
    }

    SECTION("pipeline without components") {
        PipelineConfig pipeline(R"({"pipeline": {"source": "source_1"}})"_json);

        REQUIRE_NO_ERROR(pipeline.resolveSecureParameters());
        REQUIRE_FALSE(pipeline.root()["pipeline"].isMember("components"));
    }
}
