# msservices

RocketRide source endpoints for Microsoft 365: SharePoint document libraries and
Outlook mailboxes, both reached through the Microsoft Graph API.

## What it does

The node scans a Microsoft 365 tenant and feeds what it finds into the pipeline
on the `tags` lane. It registers three services over one shared Graph connector:
`ms-sharepointcpp` for SharePoint drives, and `outlook-enterprise` and
`outlook-personal` for mailboxes, which differ only in how they authenticate.
The services are marked internal, so they are not offered on the canvas and are
reached through task or pipeline configuration.

## Lanes

| Input | Output | Description |
| ----- | ------ | ----------- |
| `_source` | `tags` | Emits the scanned items to be processed. |

## Configuration

Every service authenticates as a registered Entra ID application, so all of them
take a `clientId` and a `clientSecret`. Include paths begin with the container:
a site or drive for SharePoint, a mailbox folder for Outlook.

### ms-sharepointcpp

Set `tenant` to the directory (tenant) id the application belongs to.

### outlook-enterprise

Set `tenant` as above. The application authenticates on its own behalf, so it
reaches the mailboxes its Graph permissions allow.

### outlook-personal

Takes a `refreshToken` instead of a tenant, since a personal account
authenticates as the signed-in user rather than as the directory.

## Notes

### One library, three services

All three services name the same `msservices` library, which the engine loads
once, on the first lookup of any of them. That load registers the factories of
all three. Outlook is a source only; configuring it as a target is refused.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
