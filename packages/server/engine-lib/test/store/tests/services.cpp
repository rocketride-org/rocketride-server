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

#include "test.h"

TEST_CASE("store::Services") {
    auto _res = IServices::getServiceSchemas();
    if (!_res) {
        ASSERT_MSG(true, "getServiceSchemas Failed");
    }

    auto schema{_mv(*_res)};

    SECTION("version") {
        REQUIRE(schema.isMember("version"));
        REQUIRE(schema["version"].isInt());
        REQUIRE(schema["version"] == IServices::VERSION);
    }

    SECTION("services") {
        REQUIRE(schema.isMember("services"));
        REQUIRE(schema["services"].isObject());
    }

    json::Value &services = schema["services"];

    SECTION("SourcesAndTarget") {
        REQUIRE(services["aws"]);
        REQUIRE(services["aws"]["Source"]);
        REQUIRE(services["aws"]["Target"]);
    }

    // Source
    SECTION("SourcesFields") {
        json::Value awsSource = services["aws"].lookup<json::Value>("Source");

        REQUIRE(awsSource["schema"]);
        REQUIRE(awsSource["ui"]);
    }

    SECTION("SourcesSchemaFields") {
        json::Value awsSourceSchema =
            services["aws"].lookup<json::Value>("Source").lookup<json::Value>(
                "schema");

        REQUIRE(awsSourceSchema["properties"]);
        REQUIRE(awsSourceSchema["properties"].isObject());
        REQUIRE(awsSourceSchema["required"]);
        REQUIRE(awsSourceSchema["required"].isArray());
        REQUIRE(awsSourceSchema["title"]);
        REQUIRE(awsSourceSchema["title"].isString());
        REQUIRE(awsSourceSchema["type"]);
        REQUIRE(awsSourceSchema["type"].isString());
    }

    SECTION("SourcesUIFields") {
        json::Value awsSourceSchema =
            services["aws"].lookup<json::Value>("Source").lookup<json::Value>(
                "ui");

        REQUIRE(awsSourceSchema["estimation"]);
        REQUIRE(awsSourceSchema["estimation"].isObject());
        REQUIRE(awsSourceSchema["exclude"]);
        REQUIRE(awsSourceSchema["exclude"].isObject());
        REQUIRE(awsSourceSchema["include"]);
        REQUIRE(awsSourceSchema["include"].isObject());
        REQUIRE(awsSourceSchema["mode"]);
        REQUIRE(awsSourceSchema["mode"].isObject());
        REQUIRE(awsSourceSchema["parameters"]);
        REQUIRE(awsSourceSchema["parameters"].isObject());
        REQUIRE(awsSourceSchema["type"]);
        REQUIRE(awsSourceSchema["type"].isObject());
        REQUIRE(awsSourceSchema["ui:order"]);
        REQUIRE(awsSourceSchema["ui:order"].isArray());

        json::Value name = awsSourceSchema.lookup<json::Value>("name");
        REQUIRE(name.isObject());
        REQUIRE(name.lookup<bool>("ui:readonlyOnEdit") == true);
    }

    SECTION("SourcesSchemaPropertiesFields") {
        json::Value awsSourceSchemaProps =
            services["aws"]
                .lookup<json::Value>("Source")
                .lookup<json::Value>("schema")
                .lookup<json::Value>("properties");

        REQUIRE(awsSourceSchemaProps["estimation"]);
        REQUIRE(awsSourceSchemaProps["estimation"].isObject());
        REQUIRE(awsSourceSchemaProps["exclude"]);
        REQUIRE(awsSourceSchemaProps["exclude"].isObject());
        REQUIRE(awsSourceSchemaProps["include"]);
        REQUIRE(awsSourceSchemaProps["include"].isObject());
        REQUIRE(awsSourceSchemaProps["mode"]);
        REQUIRE(awsSourceSchemaProps["mode"].isObject());
        REQUIRE(awsSourceSchemaProps["name"]);
        REQUIRE(awsSourceSchemaProps["name"].isObject());
        REQUIRE(awsSourceSchemaProps["parameters"]);
        REQUIRE(awsSourceSchemaProps["parameters"].isObject());
        REQUIRE(awsSourceSchemaProps["type"]);
        REQUIRE(awsSourceSchemaProps["type"].isObject());
    }

    SECTION("SourcesSchemaCostEstimationPropertiesFields") {
        json::Value awsSourceSchemaEstimationProps =
            services["aws"]
                .lookup<json::Value>("Source")
                .lookup<json::Value>("schema")
                .lookup<json::Value>("properties")
                .lookup<json::Value>("estimation")
                .lookup<json::Value>("properties");

        REQUIRE(awsSourceSchemaEstimationProps.isObject());
        json::Value accessCost =
            awsSourceSchemaEstimationProps.lookup<json::Value>("accessCost");
        REQUIRE(accessCost.isObject());
        REQUIRE(accessCost.lookup<json::Value>("default"));
        REQUIRE(accessCost.lookup<json::Value>("description"));
        REQUIRE(accessCost.lookup<json::Value>("minimum"));
        REQUIRE(accessCost.lookup<json::Value>("title"));
        REQUIRE(accessCost.lookup<json::Value>("type"));
        json::Value accessDelay =
            awsSourceSchemaEstimationProps.lookup<json::Value>("accessDelay");
        REQUIRE(accessDelay.isObject());
        REQUIRE(accessDelay.lookup<json::Value>("default"));
        REQUIRE(accessDelay.lookup<json::Value>("description"));
        REQUIRE(accessDelay.lookup<json::Value>("minimum"));
        REQUIRE(accessDelay.lookup<json::Value>("title"));
        REQUIRE(accessDelay.lookup<json::Value>("type"));
        json::Value accessRate =
            awsSourceSchemaEstimationProps.lookup<json::Value>("accessRate");
        REQUIRE(accessRate.isObject());
        REQUIRE(accessRate.lookup<json::Value>("default"));
        REQUIRE(accessRate.lookup<json::Value>("description"));
        REQUIRE(accessRate.lookup<json::Value>("minimum"));
        REQUIRE(accessRate.lookup<json::Value>("title"));
        REQUIRE(accessRate.lookup<json::Value>("type"));
        json::Value storeCost =
            awsSourceSchemaEstimationProps.lookup<json::Value>("storeCost");
        REQUIRE(storeCost.isObject());
        REQUIRE(storeCost.lookup<json::Value>("default"));
        REQUIRE(storeCost.lookup<json::Value>("description"));
        REQUIRE(storeCost.lookup<json::Value>("minimum"));
        REQUIRE(storeCost.lookup<json::Value>("title"));
        REQUIRE(storeCost.lookup<json::Value>("type"));
    }

    SECTION("SourcesSchemaExcludePropertiesFields") {
        json::Value awsSourceSchemaExclude =
            services["aws"]
                .lookup<json::Value>("Source")
                .lookup<json::Value>("schema")
                .lookup<json::Value>("properties")
                .lookup<json::Value>("exclude");

        REQUIRE(awsSourceSchemaExclude.isObject());
        REQUIRE(awsSourceSchemaExclude.lookup<Text>("title") ==
                "Exclude paths");
        REQUIRE(awsSourceSchemaExclude.lookup<Text>("type") == "array");
        json::Value items = awsSourceSchemaExclude.lookup<json::Value>("items");
        REQUIRE(items.isObject());
        REQUIRE(items.lookup<json::Value>("properties").isObject());
        REQUIRE(items.lookup<json::Value>("properties")
                    .lookup<json::Value>("path")
                    .isObject());
        REQUIRE(items.lookup<json::Value>("required").isArray());
        REQUIRE(items.lookup<Text>("type") == "object");
    }

    SECTION("SourcesSchemaIncludePropertiesFields") {
        json::Value awsSourceSchemaExclude =
            services["aws"]
                .lookup<json::Value>("Source")
                .lookup<json::Value>("schema")
                .lookup<json::Value>("properties")
                .lookup<json::Value>("include");

        REQUIRE(awsSourceSchemaExclude.isObject());
        REQUIRE(awsSourceSchemaExclude.lookup<Text>("title") ==
                "Include paths");
        REQUIRE(awsSourceSchemaExclude.lookup<Text>("type") == "array");
        json::Value items = awsSourceSchemaExclude.lookup<json::Value>("items");
        REQUIRE(items.isObject());
        REQUIRE(items.lookup<json::Value>("properties").isObject());
        REQUIRE(items.lookup<json::Value>("properties")
                    .lookup<json::Value>("path")
                    .isObject());

        json::Value dependencies = items.lookup<json::Value>("dependencies");
        REQUIRE(dependencies.isObject());

        // Only Index is the dependency
        REQUIRE(dependencies.lookup<json::Value>("index").isObject());
        json::Value oneOf =
            dependencies.lookup<json::Value>("index").lookup<json::Value>(
                "oneOf");
        REQUIRE(oneOf.isArray());
        REQUIRE(oneOf.size() >= 1);
        json::Value properties = oneOf[0].lookup<json::Value>("properties");
        REQUIRE(properties.isObject());
        REQUIRE(properties.lookup<json::Value>("classify"));
        REQUIRE(properties.lookup<json::Value>("ocr"));
    }

    SECTION("SourcesSchemaModePropertiesFields") {
        json::Value awsSourceSchemaMode = services["aws"]
                                              .lookup<json::Value>("Source")
                                              .lookup<json::Value>("schema")
                                              .lookup<json::Value>("properties")
                                              .lookup<json::Value>("mode");

        REQUIRE(awsSourceSchemaMode.isObject());
        REQUIRE(awsSourceSchemaMode.lookup<Text>("default") == "Source");
        REQUIRE(awsSourceSchemaMode.lookup<Text>("type") == "string");
    }

    SECTION("SourcesSchemaModePropertiesFields") {
        json::Value awsSourceSchemaMode = services["aws"]
                                              .lookup<json::Value>("Source")
                                              .lookup<json::Value>("schema")
                                              .lookup<json::Value>("properties")
                                              .lookup<json::Value>("mode");

        REQUIRE(awsSourceSchemaMode.isObject());
        REQUIRE(awsSourceSchemaMode.lookup<Text>("default") == "Source");
        REQUIRE(awsSourceSchemaMode.lookup<Text>("type") == "string");
    }

    SECTION("SourcesSchemaNamePropertiesFields") {
        json::Value awsSourceSchemaName = services["aws"]
                                              .lookup<json::Value>("Source")
                                              .lookup<json::Value>("schema")
                                              .lookup<json::Value>("properties")
                                              .lookup<json::Value>("name");

        REQUIRE(awsSourceSchemaName.isObject());
        REQUIRE(awsSourceSchemaName.lookup<Text>("title") ==
                "Data Catalog Name");
        REQUIRE(awsSourceSchemaName.lookup<Text>("type") == "string");
        REQUIRE(awsSourceSchemaName.lookup<int>("minLength") == 2);
        REQUIRE(awsSourceSchemaName.lookup<int>("maxLength") == 32);
    }

    SECTION("SourcesSchemaParametersPropertiesFields") {
        json::Value awsSourceSchemaParameters =
            services["aws"]
                .lookup<json::Value>("Source")
                .lookup<json::Value>("schema")
                .lookup<json::Value>("properties")
                .lookup<json::Value>("parameters");

        REQUIRE(awsSourceSchemaParameters.isObject());
        REQUIRE(awsSourceSchemaParameters.lookup<Text>("title") ==
                "Parameters");
        REQUIRE(awsSourceSchemaParameters.lookup<Text>("type") == "object");
        REQUIRE(awsSourceSchemaParameters.lookup<json::Value>("required")
                    .isArray());

        json::Value properties =
            awsSourceSchemaParameters.lookup<json::Value>("properties");
        REQUIRE(properties.isObject());
        REQUIRE(properties.lookup<json::Value>("accessKey").isObject());
        REQUIRE(properties.lookup<json::Value>("region").isObject());
        REQUIRE(properties.lookup<json::Value>("secretKey").isObject());
    }

    SECTION("SourcesSchemaUIEstimationPropertiesFields") {
        json::Value awsSourceUiEstimation =
            services["aws"]
                .lookup<json::Value>("Source")
                .lookup<json::Value>("ui")
                .lookup<json::Value>("estimation");

        REQUIRE(awsSourceUiEstimation.isObject());
        json::Value uiOrder =
            awsSourceUiEstimation.lookup<json::Value>("ui:order");
        REQUIRE(uiOrder.isArray());
        REQUIRE(uiOrder.size() == 4);
        REQUIRE(uiOrder[0] == "accessDelay");
        REQUIRE(uiOrder[1] == "accessRate");
        REQUIRE(uiOrder[2] == "storeCost");
        REQUIRE(uiOrder[3] == "accessCost");
    }

    SECTION("SourcesSchemaUIExclude") {
        json::Value awsSourceUiExclude = services["aws"]
                                             .lookup<json::Value>("Source")
                                             .lookup<json::Value>("ui")
                                             .lookup<json::Value>("exclude");

        REQUIRE(awsSourceUiExclude.isObject());
        json::Value uiOrder =
            awsSourceUiExclude.lookup<json::Value>("ui:order");
        REQUIRE(uiOrder.isArray());
        REQUIRE(uiOrder.size() == 1);
        REQUIRE(uiOrder[0] == "items");

        json::Value items = awsSourceUiExclude.lookup<json::Value>("items");
        REQUIRE(items.isObject());
        json::Value itemsUiOrder = items.lookup<json::Value>("ui:order");
        REQUIRE(itemsUiOrder.isArray());
        REQUIRE(itemsUiOrder.size() == 1);
        REQUIRE(itemsUiOrder[0] == "path");
    }

    SECTION("SourcesSchemaUIInclude") {
        json::Value awsSourceUiInclude = services["aws"]
                                             .lookup<json::Value>("Source")
                                             .lookup<json::Value>("ui")
                                             .lookup<json::Value>("include");

        REQUIRE(awsSourceUiInclude.isObject());
        json::Value uiOrder =
            awsSourceUiInclude.lookup<json::Value>("ui:order");
        REQUIRE(uiOrder.isArray());
        REQUIRE(uiOrder.size() == 1);
        REQUIRE(uiOrder[0] == "items");

        json::Value items = awsSourceUiInclude.lookup<json::Value>("items");
        REQUIRE(items.isObject());
        json::Value itemsUiOrder = items.lookup<json::Value>("ui:order");
        REQUIRE(itemsUiOrder.isArray());
        REQUIRE(itemsUiOrder.size() == 7);
        REQUIRE(itemsUiOrder[0] == "path");
        REQUIRE(itemsUiOrder[1] == "permissions");
        REQUIRE(itemsUiOrder[2] == "signing");
        REQUIRE(itemsUiOrder[3] == "index");
        REQUIRE(itemsUiOrder[4] == "vectorize");
        REQUIRE(itemsUiOrder[5] == "classify");
        REQUIRE(itemsUiOrder[6] == "ocr");
    }

    SECTION("SourcesSchemaUIIncludeChip") {
        json::Value awsSourceUiInclude = services["aws"]
                                             .lookup<json::Value>("Source")
                                             .lookup<json::Value>("ui")
                                             .lookup<json::Value>("include");

        REQUIRE(awsSourceUiInclude.isObject());
        json::Value uiOrder =
            awsSourceUiInclude.lookup<json::Value>("ui:order");
        REQUIRE(uiOrder.isArray());
        REQUIRE(uiOrder.size() == 1);
        REQUIRE(uiOrder[0] == "items");

        json::Value items = awsSourceUiInclude.lookup<json::Value>("items");
        REQUIRE(items.isObject());
        REQUIRE(items.lookup<json::Value>("signing").lookup<Text>("chip") ==
                "Signing");
        REQUIRE(items.lookup<json::Value>("index").lookup<Text>("chip") ==
                "Index");
        REQUIRE(items.lookup<json::Value>("permissions").lookup<Text>("chip") ==
                "Permissions");
        REQUIRE(items.lookup<json::Value>("classify").lookup<Text>("chip") ==
                "Classify");
        REQUIRE(items.lookup<json::Value>("ocr").lookup<Text>("chip") == "OCR");
    }

    // Target

    SECTION("TargetFields") {
        json::Value awsSource = services["aws"]["Target"];

        REQUIRE(awsSource["schema"]);
        REQUIRE(awsSource["ui"]);
    }

    SECTION("TargetSchemaFields") {
        json::Value awsSourceSchema =
            services["aws"].lookup<json::Value>("Target").lookup<json::Value>(
                "schema");

        REQUIRE(awsSourceSchema["properties"]);
        REQUIRE(awsSourceSchema["properties"].isObject());
        REQUIRE(awsSourceSchema["required"]);
        REQUIRE(awsSourceSchema["required"].isArray());
        REQUIRE(awsSourceSchema["title"]);
        REQUIRE(awsSourceSchema["title"].isString());
        REQUIRE(awsSourceSchema["type"]);
        REQUIRE(awsSourceSchema["type"].isString());
    }

    SECTION("TargetUIFields") {
        json::Value awsSourceSchema =
            services["aws"].lookup<json::Value>("Target").lookup<json::Value>(
                "ui");

        // REQUIRE(awsSourceSchema["estimation"]);
        // REQUIRE(awsSourceSchema["estimation"].isObject());
        REQUIRE(awsSourceSchema["mode"]);
        REQUIRE(awsSourceSchema["mode"].isObject());
        REQUIRE(awsSourceSchema["parameters"]);
        REQUIRE(awsSourceSchema["parameters"].isObject());
        REQUIRE(awsSourceSchema["type"]);
        REQUIRE(awsSourceSchema["type"].isObject());
        REQUIRE(awsSourceSchema["ui:order"]);
        REQUIRE(awsSourceSchema["ui:order"].isArray());
    }

    // SECTION("TargetSchemaCostEstimationPropertiesFields") {

    //     json::Value value = *res;
    //     json::Value awsTargetSchemaEstimationProps =
    //     value["aws"].lookup<json::Value>("Target")
    //         .lookup<json::Value>("schema")
    //         .lookup<json::Value>("properties")
    //         .lookup<json::Value>("estimation")
    //         .lookup<json::Value>("properties");

    //     REQUIRE(awsTargetSchemaEstimationProps.isObject());
    //     json::Value accessCost =
    //     awsTargetSchemaEstimationProps.lookup<json::Value>("accessCost");
    //     REQUIRE(accessCost.isObject());
    //     REQUIRE(accessCost.lookup<json::Value>("default"));
    //     REQUIRE(accessCost.lookup<json::Value>("description"));
    //     REQUIRE(accessCost.lookup<json::Value>("minimum"));
    //     REQUIRE(accessCost.lookup<json::Value>("title"));
    //     REQUIRE(accessCost.lookup<json::Value>("type"));
    //     json::Value accessDelay =
    //     awsTargetSchemaEstimationProps.lookup<json::Value>("accessDelay");
    //     REQUIRE(accessDelay.isObject());
    //     REQUIRE(accessDelay.lookup<json::Value>("default"));
    //     REQUIRE(accessDelay.lookup<json::Value>("description"));
    //     REQUIRE(accessDelay.lookup<json::Value>("minimum"));
    //     REQUIRE(accessDelay.lookup<json::Value>("title"));
    //     REQUIRE(accessDelay.lookup<json::Value>("type"));
    //     json::Value accessRate =
    //     awsTargetSchemaEstimationProps.lookup<json::Value>("accessRate");
    //     REQUIRE(accessRate.isObject());
    //     REQUIRE(accessRate.lookup<json::Value>("default"));
    //     REQUIRE(accessRate.lookup<json::Value>("description"));
    //     REQUIRE(accessRate.lookup<json::Value>("minimum"));
    //     REQUIRE(accessRate.lookup<json::Value>("title"));
    //     REQUIRE(accessRate.lookup<json::Value>("type"));
    //     json::Value storeCost =
    //     awsTargetSchemaEstimationProps.lookup<json::Value>("storeCost");
    //     REQUIRE(storeCost.isObject());
    //     REQUIRE(storeCost.lookup<json::Value>("default"));
    //     REQUIRE(storeCost.lookup<json::Value>("description"));
    //     REQUIRE(storeCost.lookup<json::Value>("minimum"));
    //     REQUIRE(storeCost.lookup<json::Value>("title"));
    //     REQUIRE(storeCost.lookup<json::Value>("type"));
    // }

    SECTION("TargetSchemaModePropertiesFields") {
        json::Value awsTargetSchemaMode = services["aws"]
                                              .lookup<json::Value>("Target")
                                              .lookup<json::Value>("schema")
                                              .lookup<json::Value>("properties")
                                              .lookup<json::Value>("mode");

        REQUIRE(awsTargetSchemaMode.isObject());
        REQUIRE(awsTargetSchemaMode.lookup<Text>("default") == "Target");
        REQUIRE(awsTargetSchemaMode.lookup<Text>("type") == "string");
    }

    // SECTION("TargetSchemaNamePropertiesFields") {

    //     json::Value value = *res;
    //     json::Value awsTargetSchemaName =
    //     value["aws"].lookup<json::Value>("Target")
    //         .lookup<json::Value>("schema")
    //         .lookup<json::Value>("properties")
    //         .lookup<json::Value>("name");

    //     REQUIRE(awsTargetSchemaName.isObject());
    //     REQUIRE(awsTargetSchemaName.lookup<Text>("title") == "Service Name");
    //     REQUIRE(awsTargetSchemaName.lookup<Text>("type") == "string");
    //     REQUIRE(awsTargetSchemaName.lookup<int>("minLength") == 2);
    //     REQUIRE(awsTargetSchemaName.lookup<int>("maxLength") == 32);
    // }

    SECTION("TargetSchemaParametersPropertiesFields") {
        json::Value awsTargetSchemaParameters =
            services["aws"]
                .lookup<json::Value>("Target")
                .lookup<json::Value>("schema")
                .lookup<json::Value>("properties")
                .lookup<json::Value>("parameters");

        REQUIRE(awsTargetSchemaParameters.isObject());
        // REQUIRE(awsTargetSchemaParameters.lookup<Text>("title") ==
        // "Parameters");
        REQUIRE(awsTargetSchemaParameters.lookup<Text>("type") == "object");
        REQUIRE(awsTargetSchemaParameters.lookup<json::Value>("required")
                    .isArray());

        json::Value properties =
            awsTargetSchemaParameters.lookup<json::Value>("properties");
        REQUIRE(properties.isObject());
        REQUIRE(properties.lookup<json::Value>("accessKey").isObject());
        REQUIRE(properties.lookup<json::Value>("region").isObject());
        REQUIRE(properties.lookup<json::Value>("secretKey").isObject());
        REQUIRE(properties.lookup<json::Value>("storePath").isObject());
    }

    // SECTION("TargetUIEstimationPropertiesFields") {

    //     json::Value value = *res;
    //     json::Value awsTargetUiEstimation =
    //     value["aws"].lookup<json::Value>("Target")
    //         .lookup<json::Value>("ui")
    //         .lookup<json::Value>("estimation");

    //     REQUIRE(awsTargetUiEstimation.isObject());
    //     json::Value uiOrder =
    //     awsTargetUiEstimation.lookup<json::Value>("ui:order");
    //     REQUIRE(uiOrder.isArray());
    //     REQUIRE(uiOrder.size() == 4);
    //     REQUIRE(uiOrder[0] == "accessDelay");
    //     REQUIRE(uiOrder[1] == "accessRate");
    //     REQUIRE(uiOrder[2] == "storeCost");
    //     REQUIRE(uiOrder[3] == "accessCost");
    // }

    SECTION("TargetUIParametersPropertiesFields") {
        json::Value awsTargetUiEstimation =
            services["aws"]
                .lookup<json::Value>("Target")
                .lookup<json::Value>("ui")
                .lookup<json::Value>("parameters");

        REQUIRE(awsTargetUiEstimation.isObject());
        json::Value uiOrder =
            awsTargetUiEstimation.lookup<json::Value>("ui:order");
        REQUIRE(uiOrder.isArray());
        REQUIRE(uiOrder.size() == 4);
        REQUIRE(uiOrder[0] == "storePath");
        REQUIRE(uiOrder[1] == "accessKey");
        REQUIRE(uiOrder[2] == "secretKey");
        REQUIRE(uiOrder[3] == "region");

        json::Value accessKey =
            awsTargetUiEstimation.lookup<json::Value>("accessKey");
        REQUIRE(accessKey.isObject());
        REQUIRE(accessKey.lookup<bool>("ui:secure") == true);

        json::Value secretKey =
            awsTargetUiEstimation.lookup<json::Value>("secretKey");
        REQUIRE(secretKey.isObject());
        REQUIRE(secretKey.lookup<bool>("ui:secure") == true);
        REQUIRE(secretKey.lookup<Text>("ui:widget") == "password");
    }
}
