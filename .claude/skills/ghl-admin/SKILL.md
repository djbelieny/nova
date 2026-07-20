---
name: ghl-admin
description: GoHighLevel admin — locations, users, calendars, appointments, forms, funnels, surveys, custom fields, tags, notes, tasks, conversations, and settings. Use when the user asks about GHL locations, users, calendars, bookings, forms, funnels, or admin tasks.
---

# GHL Admin & Configuration

## When to Use
- Location management and settings
- User management
- Calendar and appointment management
- Forms and surveys
- Funnels and pages
- Custom fields and values
- Tags and notes
- Tasks and conversations
- Call logs and messaging
- Business management
- Custom objects and schemas
- Shipping and store settings
- Event notifications
- SaaS and billing admin

## Available Tools

Fetch these MCP tools using `ToolSearch` before calling them. Due to the large number of admin tools, use keyword search to find the right one:

```
ToolSearch query: "+gohighlevel calendar"
ToolSearch query: "+gohighlevel location"
ToolSearch query: "+gohighlevel custom-field"
```

### Location & Company
`get-location`, `put-location`, `search-locations`, `create-location`, `delete-location`, `get-company`, `locations`, `locations-deprecated`

### Users
`create-user`, `get-user`, `update-user`, `delete-user`, `search-users`, `get-user-by-location`, `filter-users-by-email`

### Calendars & Appointments
`get-calendars`, `get-calendar`, `create-calendar`, `update-calendar`, `delete-calendar`, `create-calendar-group`, `edit-group`, `delete-group`, `disable-group`, `get-groups`, `validate-groups-slug`, `create-calendar-resource`, `update-calendar-resource`, `get-calendar-resource`, `fetch-calendar-resources`, `delete-calendar-resource`, `create-appointment`, `edit-appointment`, `get-appointment`, `get-appointments-for-contact`, `get-slots`, `create-block-slot`, `edit-block-slot`, `get-blocked-slots`, `get-calendar-events`, `create-appointment-note`, `update-appointment-note`, `delete-appointment-note`, `get-appointment-notes`

### Forms & Surveys
`get-forms`, `get-forms-submissions`, `get-surveys`, `get-surveys-submissions`

### Funnels
`getFunnels`, `getPagesByFunnelId`, `getPagesCountByFunnelId`

### Custom Fields & Values
`create-custom-field`, `update-custom-field`, `delete-custom-field`, `get-custom-fields`, `get-custom-field`, `create-custom-field-2`, `update-custom-field-2`, `delete-custom-field-2`, `get-custom-field-by-id`, `get-custom-fields-by-object-key`, `create-custom-field-folder`, `update-custom-field-folder`, `delete-custom-field-folder`, `create-custom-value`, `update-custom-value`, `delete-custom-value`, `get-custom-value`, `get-custom-values`

### Tags
`create-tag`, `get-tag-by-id`, `update-tag`, `delete-tag`, `get-tags-by-ids`, `get-tags-location-id`, `get-location-tags`

### Notes
`create-note`, `update-note`, `delete-note`, `get-note`, `get-all-notes`

### Tasks
`create-task`, `update-task`, `delete-task`, `get-task`, `get-all-tasks`, `update-task-completed`, `task-search`, `create-recurring-task`, `update-recurring-task`, `delete-recurring-task`, `get-recurring-task-by-id`

### Conversations & Messages
`create-conversation`, `get-conversation`, `update-conversation`, `delete-conversation`, `search-conversation`, `get-messages`, `get-message`, `send-a-new-message`, `add-an-inbound-message`, `add-an-outbound-message`, `update-message-status`, `get-message-recording`, `get-message-transcription`, `download-message-transcription`, `live-chat-agent-typing`, `get-email-by-id`

### Calls
`get-call-logs`, `getCallLog`, `active-numbers`, `getNumberPoolList`

### Business
`create-business`, `get-business`, `update-business`, `delete-Business`, `get-businesses-by-location`

### Custom Objects
`create-custom-object-schema`, `update-custom-object`, `get-object-schema-by-key`, `get-object-by-location-id`, `create-object-record`, `update-object-record`, `delete-object-record`, `get-record-by-id`, `search-object-records`

### Associations & Relations
`create-association`, `create-association-2`, `update-association`, `delete-association`, `get-association-by-ID`, `get-association-by-object-keys`, `get-association-key-by-key-name`, `find-associations`, `create-relation`, `get-relations-by-record-id`

### Custom Menus & Links
`create-custom-menu`, `get-custom-menu-by-id`, `get-custom-menus`, `update-custom-menu`, `delete-custom-menu`, `create-link`, `get-link-by-id`, `get-links`, `update-link`, `delete-link`, `search-trigger-links`

### Redirects & Categories
`create-redirect`, `update-redirect-by-id`, `delete-redirect-by-id`, `fetch-redirects-list`, `get-categories-id`, `get-categories-location-id`

### Shipping & Store
`create-shipping-zone`, `get-shipping-zones`, `update-shipping-zone`, `delete-shipping-zone`, `get-available-shipping-zones`, `create-shipping-rate`, `get-shipping-rates`, `list-shipping-rates`, `update-shipping-rate`, `delete-shipping-rate`, `create-shipping-carrier`, `get-shipping-carriers`, `list-shipping-carriers`, `update-shipping-carrier`, `delete-shipping-carrier`, `get-list-inventory`, `update-inventory`, `update-display-priority`, `create-store-setting`, `get-store-settings`, `update-store-status`

### SaaS Admin
`enable-saas-location`, `enable-saas-location-deprecated`, `pause-location`, `pause-location-deprecated`, `get-saas-locations`, `get-saas-locations-deprecated`, `get-saas-plan`, `get-saas-plan-deprecated`, `bulk-enable-saas`, `bulk-enable-saas-deprecated`, `bulk-disable-saas`, `bulk-disable-saas-deprecated`, `update-rebilling`, `update-rebilling-deprecated`, `update-saas-subscription-deprecated`, `get-location-subscription`, `get-location-subscription-deprecated`, `get-agency-plans`, `get-agency-plans-deprecated`

### Snapshots & Integration
`get-custom-snapshots`, `create-snapshot-share-link`, `get-snapshot-push`, `get-latest-snapshot-push`, `create-integration`, `delete-integration`, `create-integration-provider`, `list-integration-providers`, `get-installed-location`, `get-installer-details`, `uninstall-application`, `custom-provider-marketplace-app-update-capabilities`

### Events & Config
`create-event-notification`, `update-event-notification`, `delete-event-notification`, `get-event-notification`, `find-event-notification`, `delete-event`, `create-config`, `fetch-config`, `disconnect-config`, `set-accounts`, `get-account`, `delete-account`, `set-google-locations`, `get-google-locations`, `get-timezones`, `verify-email`, `check-url-slug-exists`

### Bulk Operations
`bulkEdit`, `bulkUpdate`

### Actions
`create-action`, `get-action`, `update-action`, `delete-action`

## Usage Pattern

1. Use `ToolSearch` with query like `"+gohighlevel calendar"` to find the specific tools you need
2. Use `ToolSearch` with `"select:mcp__gohighlevel__create-appointment"` to fetch the exact tool schema
3. Call the fetched tool with required parameters
