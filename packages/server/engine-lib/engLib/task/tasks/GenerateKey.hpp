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

namespace engine::task::generateKey {

// TODO: Don't know if this is actually used any more, but it has
// been updated to at least compile, but has not been refactored

//
// Either generate a random AES-256 key or derive an AES-256 key
// from a passphrase and a salt (optional) [APPLAT-1681]
//
class Task : public ITask {
public:
    using Parent = ITask;
    using Parent::Parent;

    //-----------------------------------------------------------------
    /// @details
    ///		Hard-coded salt for key derivation; used if app does not
    ///		supply own salt. A fixed salt is required for key recovery.
    //-----------------------------------------------------------------
    _const auto defaultKeyDerivationSalt = "7d2cf81792db4e59"_tv;

    //-----------------------------------------------------------------
    /// @details
    ///		There's no hard rule guidance on how many iterations should
    ///		be used with PBKDF2.  The standard recommends a minimum of
    ///		1000. The value chosen is a function of the complexity of
    ///		the passphrase and available compute resources. Key derivation
    ///		will typically be performed by the platform, so they're our
    ///		compute resources, notthe customer's.  If a sufficiently
    ///		complex passphrase is used, 500k should be more than enough.
    ///		A fixed number of iterations is required for key recovery.
    //-----------------------------------------------------------------
    _const auto defaultKeyDerivationIterations = 500'000u;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our log level
    //-----------------------------------------------------------------
    _const auto LogLevel = Lvl::JobGenerateKey;

    //-----------------------------------------------------------------
    ///	@details
    ///		Define our factory info
    //-----------------------------------------------------------------
    _const auto Factory = Factory::makeFactory<Task, ITask>("generateKey");

protected:
    //-----------------------------------------------------------------
    ///	@details
    ///		Execute the task - send results over the >INFO channel
    //-----------------------------------------------------------------
    Error exec() noexcept override {
        size_t iterations = defaultKeyDerivationIterations;
        Text hexEncodedSalt;
        Text passphrase;

        // Generate a random key
        const auto generateRandomKey = localfcn()->ErrorOr<crypto::Key> {
            LOGT("Generating random key");
            return crypto::generateKey(crypto::engineCipher());
        };

        // Generate a key based on a passphrase
        const auto deriveKeyFromPassphrase = localfcn()->ErrorOr<crypto::Key> {
            // Determine salt
            memory::Data<uint8_t> saltBuffer;
            InputData salt;

            if (hexEncodedSalt) {
                // The salt is only used if we're deriving a key from a
                // passphrase rather than generating a random one
                if (!passphrase)
                    return APERRL(
                        JobGenerateKey, Ec::InvalidParam,
                        "Salt cannot be specified without a passphrase");

                // Decode the salt
                saltBuffer = crypto::hexDecode(hexEncodedSalt);
            } else {
                // If no salt was specified, use our hard-coded salt
                LOGT("No salt specified; using fixed salt");
                saltBuffer = crypto::hexDecode(defaultKeyDerivationSalt);
            }

            // Get the salt as in input data
            salt = saltBuffer;

            LOGT("Deriving key from password using PBKDF2");
            return crypto::deriveKeyFromPassword(
                crypto::engineCipher(), passphrase, saltBuffer, iterations);
        };

        // Get our parameters
        if (auto ccode = taskConfig().lookupAssign("passphrase", passphrase) ||
                         taskConfig().lookupAssign("salt", hexEncodedSalt) ||
                         taskConfig().lookupAssign("iterations", iterations))
            return ccode;

        // If a passphrase was specified, derive the key from the passphrase
        // using PBKDF2.  Otherwise, generate a random AES-256 key.
        auto key = passphrase ? deriveKeyFromPassphrase() : generateRandomKey();
        if (!key) return APERRT(key.ccode(), "Failed to generate key");

        // Encrypt the generated key with the engine key to create the
        // token that will be resubmitted with future jobs
        auto token = crypto::engineEncrypt(key->keyData());
        if (!token)
            return APERRT(token.ccode(),
                          "Failed to encrypt generated key using engine key");

        // Build the results
        json::Value result;
        result["token"] = crypto::hexEncode(*token);
        result["keyId"] = key->immutableId();

        // Report result to monitor
        MONITOR(info, "result", result);
        return {};
    }
};

}  // namespace engine::task::generateKey
