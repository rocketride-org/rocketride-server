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

#include <engLib/eng.h>

namespace engine::store::filter::baseObjectStore {
class IBaseInstance;

//-------------------------------------------------------------------------
/// @details
///		This function will validate that the S3 bucket is specified, it
///     is in the correct format, that an access/secret key is specified,
///     and if not syntax only check, that we can login to S3
///	@param[in]	syntaxOnly
///		Perform a syntax check only
//-------------------------------------------------------------------------
Error IBaseEndpoint::validateConfig(bool syntaxOnly) noexcept {
    // Verify the basic settings access key, secret, region
    const auto verifySettings = localfcn()->Error {
        // Check that the basic fields are here
        if (!m_storeConfig.accessKey)
            return APERR(Ec::Error, "Access key is missing");

        if (!m_storeConfig.secretKey)
            return APERR(Ec::Error, "Secret key is missing");

        // For objstore drivers, a url must be specied. For aws, the region
        // must be specified
        if (m_type == "aws") {
            if (!m_storeConfig.region)
                return APERR(Ec::Error, "Region is missing");
        } else {
            if (!m_storeConfig.url || m_storeConfig.url == "http://" ||
                m_storeConfig.url == "https://")
                return APERR(Ec::Error, "Url is missing");
        }

        return {};
    };

    // Verify the bucket name
    const auto verifyBucket = localfcn()->Error {
        for (const auto &bucket : m_storeConfig.buckets) {
            // Check for valid start chr
            const auto lowerCaseOrNumOrSpecialSource =
                localfcn(TextChr chr)->bool {
                return (chr >= 'a' && chr <= 'z') ||
                       (chr >= '0' && chr <= '9') || chr == '*' || chr == '?' ||
                       chr == '!' || chr == '-' || chr == '[' || chr == ']';
            };
            const auto lowerCaseOrNumOrSpecialTarget =
                localfcn(TextChr chr)->bool {
                return (chr >= 'a' && chr <= 'z') ||
                       (chr >= '0' && chr <= '9' || chr == '-');
            };

            std::function<bool(TextChr chr)> checkChar;

            if (config.serviceMode == SERVICE_MODE::SOURCE) {
                checkChar = _mv(lowerCaseOrNumOrSpecialSource);
                // Verify the bucket size
                if (bucket.size() < 1)
                    return APERR(
                        Ec::Error,
                        "Bucket name must be at least 1 character '*'");
            } else if (config.serviceMode == SERVICE_MODE::TARGET) {
                checkChar = _mv(lowerCaseOrNumOrSpecialTarget);
                // Verify the bucket size
                if (bucket.size() < 3)
                    return APERR(Ec::Error,
                                 "Bucket name must be at least 3 characters");
                if (bucket.size() > 63)
                    return APERR(Ec::Error,
                                 "Bucket name must be at most 63 characters");
            } else {
                return APERR(Ec::Error, "Invalid endpoint mode");
            }

            // Get the components of the bucket name
            auto comps = bucket.split('.');
            for (auto compIndex = 0; compIndex < comps.size(); compIndex++) {
                auto label = comps[compIndex];

                // Name must start with a lowercase letter or number
                if (compIndex == 0 && !checkChar(label[0]))
                    return APERR(Ec::Error,
                                 "Bucket name must start with a lowercase "
                                 "letter or number");

                // If this is a null component, we had a leading or trailing .
                if (label.length() < 1)
                    return APERR(Ec::Error,
                                 "Leading or trailing periods are invalid for "
                                 "your bucket name as well as double periods");

                // Check first and last character of each label
                const auto firstChar = label[0];
                const auto lastChar = label[label.length() - 1];
                if (!(checkChar(firstChar) && checkChar(lastChar)) ||
                    firstChar == '-' || lastChar == '-')
                    return APERR(Ec::Error,
                                 "Characters preceding and following a . "
                                 "should be a lowercase letter or a number");

                // Loop through each component
                for (auto chrIndex = 0; chrIndex < label.length(); ++chrIndex) {
                    // If it is not lowercase or number
                    if (!checkChar(label[chrIndex]))
                        return APERR(Ec::Error,
                                     "Bucket names can only contain lowercase "
                                     "a-z, a hyphen or a number");
                }
            }
        }

        return {};
    };

    // Verify that we can login
    const auto verifyAccess = localfcn()->Error {
        // If this is a quick validation, don't attempt connection
        if (syntaxOnly) return {};

        MONITOR(status, "Creating client");

        // Get a new aws client
        auto client = IBaseInstance::getClient(m_storeConfig);
        if (!client) return client.ccode();

        MONITOR(status, "Checking bucket");

        // Ask for a bucket list first
        auto bucketsResult = client->ListBuckets();

        // Check for an error
        if (!bucketsResult.IsSuccess()) {
            monitorS3Warning(*client, _location, bucketsResult.GetError());
            return {};
        }

        bool bFoundSome = false;
        // Get the bucket names and look for our
        const auto &s3Buckets = bucketsResult.GetResult().GetBuckets();
        for (const auto &realBucket : s3Buckets) {
            bool bFound = false;
            for (const auto &configBucket : m_storeConfig.buckets) {
                globber::Glob glob(configBucket, 0);
                if (glob.matches(realBucket.GetName())) {
                    bFound = true;
                    bFoundSome = true;
                    break;
                }
            }

            // If we did not find it, error out
            if (!bFound) continue;

            // If we are AWS (no url override, check the region)
            if (!m_storeConfig.url) {
                MONITOR(status, "Checking region");

                // Create the request
                auto rqu = Aws::S3::Model::GetBucketLocationRequest();
                rqu.SetBucket(realBucket.GetName());

                // Issue it
                auto constrainResult = client->GetBucketLocation(rqu);

                // If not successful, error out
                if (!constrainResult.IsSuccess()) {
                    monitorS3Warning(*client, _location,
                                     constrainResult.GetError());
                    return {};
                }

                // Get the constraint
                auto constraint =
                    constrainResult.GetResult().GetLocationConstraint();

                // Get the region
                auto region = Aws::S3::Model::BucketLocationConstraintMapper::
                    GetNameForBucketLocationConstraint(constraint);

                // According to the
                // https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketLocation.html#RESTBucketGETlocation-responses-response-elements
                // Buckets in Region us-east-1 have a LocationConstraint of
                // null.
                if (region.empty()) {
                    MONITOR(status,
                            "Received empty region, replacing it with "
                            "\"us-east-1\"");
                    region = "us-east-1";
                }
                // If they are different, provide a warning
                if (string::lowerCase(region) !=
                    string::lowerCase(m_storeConfig.region))
                    MONERR(warning, Ec::InvalidParam,
                           "Region for the bucket is actually", region);
            }
        }

        // If we did not find it, error out
        if (!bFoundSome) return APERR(Ec::Error, "A bucket name was not found");

        return {};
    };

    // Run the verifications
    if (auto ccode = verifySettings()) return ccode;
    if (auto ccode = verifyBucket()) return ccode;
    if (auto ccode = verifyAccess()) return ccode;

    // Run the test if needed
    return Parent::validateConfig(syntaxOnly);
}
}  // namespace engine::store::filter::baseObjectStore
