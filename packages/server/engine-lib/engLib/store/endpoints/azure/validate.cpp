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

namespace engine::store::filter::azure {

//-------------------------------------------------------------------------
/// @details
///		This function will validate that the Azure container is specified, it
///     is in the correct format, that an Access name and key is specified,
///     and if not syntax only check, that we can login to Azure
///	@param[in]	syntaxOnly
///		Only do a syntax verification
//-------------------------------------------------------------------------
Error IFilterEndpoint::validateConfig(bool syntaxOnly) noexcept {
    // Verify the basic settings account name, account key, container
    const auto verifySettings = localfcn()->Error {
        // Check that the basic fields are here
        if (!m_blobConfig.accountName)
            MONERR(error, Ec::InvalidParam, "Account name is missing");

        if (!m_blobConfig.accountKey)
            MONERR(error, Ec::InvalidParam, "Account key is missing");

        return {};
    };

    // Verify the container name
    const auto verifyContainer = localfcn()->Error {
        if (config.serviceMode == SERVICE_MODE::TARGET) {
            // This should be a valid DNS name containing only lowercase
            // letters, numbers and hyphens
            Text container = m_blobConfig.containers[0];

            const auto lowerCaseOrNum = localfcn(TextChr chr)->bool {
                return (chr >= 'a' && chr <= 'z') || (chr >= '0' && chr <= '9');
            };
            const auto isHyphen = localfcn(TextChr chr)->bool {
                return (chr == '-');
            };

            // Verify the container size
            if (container.size() < 3) {
                MONERR(error, Ec::InvalidParam,
                       "Container name must be at least 3 characters");
            }
            if (container.size() > 63) {
                MONERR(error, Ec::InvalidParam,
                       "Container name must be at most 63 characters");
            }

            // Name must start or end with a lowercase letter or a number
            if (!(lowerCaseOrNum(container[0]) &&
                  lowerCaseOrNum(*container.rbegin()))) {
                MONERR(error, Ec::InvalidParam,
                       "Container name must start with a lowercase letter or "
                       "number");
            }

            // Name can contain only lowercase letters, numbers or '-' followed
            // by letter or a number
            for (size_t i = 0; i < container.size(); ++i) {
                if (lowerCaseOrNum(container[i])) {
                    continue;
                } else if (isHyphen(container[i])) {
                    ++i;
                    if (i < container.size() && lowerCaseOrNum(container[i])) {
                        continue;
                    } else {
                        MONERR(error, Ec::InvalidParam,
                               "Container name can only contain a hyphen "
                               "followed by letter or number");
                        break;
                    }
                } else {
                    MONERR(error, Ec::InvalidParam,
                           "Container name can only contain lowercase a-z, a "
                           "hyphen or a number");
                    break;
                }
            }
        }

        return {};
    };

    const auto verifyAccess = localfcn()->Error {
        if (syntaxOnly) {
            MONITOR(status, "Syntax only validation.");
            return {};  // No connection attempt is needed
        }

        try {
            if (!m_client.m_blobServiceClient) {
                MONERR(error, Ec::InvalidParam,
                       "BlobServiceClient is not initialized.");
                return {};
            }
            std::vector<Text> allContainers;
            std::string token{};
            auto options = Azure::Storage::Blobs::ListBlobContainersOptions();
            auto response =
                m_client.m_blobServiceClient->ListBlobContainers(options);
            // Create a list of all containers in azure
            do {
                for (const auto& container : response.BlobContainers) {
                    allContainers.push_back(container.Name);
                }

                if (!response.NextPageToken.HasValue()) break;

                token = response.NextPageToken.Value();
                if (!token.length()) break;

                options.ContinuationToken = token;
                response =
                    m_client.m_blobServiceClient->ListBlobContainers(options);
            } while (true);

            std::set<Text> azureContainers(allContainers.begin(),
                                           allContainers.end());
            bool allExist = std::all_of(
                m_blobConfig.containers.begin(), m_blobConfig.containers.end(),
                [&](const Text& element) {
                    return azureContainers.count(element) > 0;
                });

            if (!allExist) {
                MONERR(error, Ec::InvalidParam,
                       "Missing access to required container");
                return {};  // Exit early if a required container is missing
            }
            MONITOR(status,
                    "Successfully validated connection to Azure Blob Storage.");
            return {};  // Success
        } catch (const Azure::Storage::StorageException& ex) {
            MONERR(error, Ec::InvalidParam,
                   "Azure Blob Storage connection validation failed: Azure "
                   "Storage exception.",
                   ex.what());
        } catch (const std::exception& ex) {
            MONERR(error, Ec::InvalidParam, "Validation failed.", ex.what());
        }
        return {};
    };

    // Run the verifications
    if (auto ccode = verifySettings()) return ccode;
    if (auto ccode = verifyContainer()) return ccode;
    if (auto ccode = verifyAccess()) return ccode;

    // Run the test if needed
    return Parent::validateConfig(syntaxOnly);
}
}  // namespace engine::store::filter::azure
