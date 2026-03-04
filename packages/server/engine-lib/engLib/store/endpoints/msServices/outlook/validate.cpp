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

namespace engine::store::filter::outlook {
//-------------------------------------------------------------------------
/// @details
///     Microsoft Graph application permission constants for Outlook validation
///     These are the correct permission GUIDs from Microsoft Graph API
///     Reference: https://graphpermissions.merill.net/permission
///     Organized by permission hierarchy (higher permissions include lower
///     ones)
//-------------------------------------------------------------------------

// Mail permissions (hierarchical: ReadWrite > Read)
_const auto MAIL_READWRITE_PERMISSION =
    "e2a3a72e-5f79-4c64-b1b1-878b674786c9"_tv;  // Mail.ReadWrite
_const auto MAIL_READ_PERMISSION =
    "810c84a8-4a9e-49e6-bf7d-12d183f40d01"_tv;  // Mail.Read

// User permissions (hierarchical: ReadWrite.All > Read.All)
_const auto USER_READWRITE_ALL_PERMISSION =
    "741f803b-c850-494e-b5df-cde7c675a1ca"_tv;  // User.ReadWrite.All
_const auto USER_READ_ALL_PERMISSION =
    "df021288-bdef-4463-88db-98f22de89214"_tv;  // User.Read.All

// MailboxSettings permissions (hierarchical: ReadWrite > Read)
_const auto MAILBOXSETTINGS_READWRITE_PERMISSION =
    "6931bccd-447a-43d1-b442-00a195474933"_tv;  // MailboxSettings.ReadWrite
_const auto MAILBOXSETTINGS_READ_PERMISSION =
    "40f97065-369a-49f4-947c-6a255697ae91"_tv;  // MailboxSettings.Read

//-------------------------------------------------------------------------
/// @details
///		This function will validate that the Outlook configuration is correct
///	@param[in]	syntaxOnly
///		Only do a syntax verification
//-------------------------------------------------------------------------
Error IFilterEndpoint::validateConfig(bool syntaxOnly) noexcept {
    LOGT("Validating Outlook configuration, syntax only: {}", syntaxOnly);

    // If not syntax only, perform connectivity and permission validation
    if (!syntaxOnly) {
        LOGT(
            "Performing connectivity and permission validation for Outlook "
            "configuration");

        // Check Microsoft Graph permissions
        if (auto ccode = checkOutlookPermissions()) {
            LOGT("Permission validation failed: {}", ccode);
            return ccode;
        }
    }

    LOGT("Microsoft Graph API permissions validation successful for Outlook");
    return {};
}

//-------------------------------------------------------------------------
/// @details
///     Check if the application has required Microsoft Graph permissions for
///     Outlook Handles different permission requirements for Enterprise vs
///     Personal accounts
/// @returns
///     Error (empty if successful, error details if validation fails)
//-------------------------------------------------------------------------
Error IFilterEndpoint::checkOutlookPermissions() noexcept {
    const Text& clientId = m_msConfig->m_clientId;
    LOGT("Checking Outlook permissions for client ID: {}", clientId);

    if (!m_msEmailNode) {
        return APERR(Ec::InvalidParam, "Email node not initialized");
    }

    // Personal accounts use delegated permissions, not application permissions
    // For personal accounts, we can't check application permissions via service
    // principal
    if (!m_msConfig->m_isEnterprise) {
        LOGT(
            "Skipping application permission validation for personal account - "
            "uses delegated permissions");
        return {};
    }

    try {
        // Step 1: Get service principal ID by client ID
        auto servicePrincipalId =
            m_msEmailNode->getServicePrincipalId(clientId);
        if (servicePrincipalId.hasCcode()) {
            LOGT("Failed to get service principal: {}",
                 servicePrincipalId.ccode());
            return servicePrincipalId.ccode();
        }

        LOGT("Found service principal ID: {}", servicePrincipalId.value());

        // Step 2: Get app role assignments for the service principal
        auto appRoleIds = m_msEmailNode->getAppRoleAssignments(
            clientId, servicePrincipalId.value());
        if (appRoleIds.hasCcode()) {
            LOGT("Failed to get role assignments: {}", appRoleIds.ccode());
            return appRoleIds.ccode();
        }

        // Check for required Microsoft Graph application permissions
        bool hasMailPermission = false;
        bool hasUserPermission = false;
        bool hasMailboxPermission = false;

        for (const auto& roleId : appRoleIds.value()) {
            LOGT("Checking assigned role ID:", roleId);
            // Check for Mail permissions (hierarchy: ReadWrite > Read)
            // Required for reading email messages
            if (roleId == MAIL_READWRITE_PERMISSION ||
                roleId == MAIL_READ_PERMISSION) {
                hasMailPermission = true;
                LOGT("Found mail permission: {}", roleId);
            }
            // Check for User permissions (hierarchy: ReadWrite.All > Read.All)
            // Required for reading user profile information
            else if (roleId == USER_READWRITE_ALL_PERMISSION ||
                     roleId == USER_READ_ALL_PERMISSION) {
                hasUserPermission = true;
                LOGT("Found user permission: {}", roleId);
            }
            // Check for MailboxSettings permissions (hierarchy: ReadWrite >
            // Read) Required for accessing mailbox configuration and settings
            else if (roleId == MAILBOXSETTINGS_READWRITE_PERMISSION ||
                     roleId == MAILBOXSETTINGS_READ_PERMISSION) {
                hasMailboxPermission = true;
                LOGT("Found mailbox settings permission: {}", roleId);
            }
        }

        if (hasMailPermission && hasUserPermission && hasMailboxPermission)
            return {};

        Text missingPermissionsMessage;

        // Build detailed error message for missing permissions
        if (!hasMailPermission) {
            LOGT(
                "Missing required mail permission (Mail.ReadWrite or "
                "Mail.Read)");
            missingPermissionsMessage =
                "Mail.ReadWrite or Mail.Read (required for email access)"_tv;
        }

        if (!hasUserPermission) {
            LOGT(
                "Missing required user permission (User.ReadWrite.All or "
                "User.Read.All)");
            if (!missingPermissionsMessage.empty())
                missingPermissionsMessage += "; "_tv;
            missingPermissionsMessage +=
                "User.ReadWrite.All or User.Read.All (required for user profile access)"_tv;
        }

        if (!hasMailboxPermission) {
            LOGT(
                "Missing required mailbox permission "
                "(MailboxSettings.ReadWrite or MailboxSettings.Read)");
            if (!missingPermissionsMessage.empty())
                missingPermissionsMessage += "; "_tv;
            missingPermissionsMessage +=
                "MailboxSettings.ReadWrite or MailboxSettings.Read (required for mailbox configuration)"_tv;
        }

        return APERR(Ec::InvalidParam,
                     "Required Microsoft Graph API permissions not granted for "
                     "Outlook access. Please ensure admin consent is provided "
                     "for the following permissions:",
                     missingPermissionsMessage);
    } catch (const std::exception& e) {
        return APERR(Ec::RequestFailed,
                     "Exception while checking permissions:", e.what());
    }

    LOGT("All required permissions are granted");
    return {};
}

}  // namespace engine::store::filter::outlook
