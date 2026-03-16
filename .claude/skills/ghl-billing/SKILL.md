---
name: ghl-billing
description: GoHighLevel billing — invoices, estimates, payments, products, orders, subscriptions, coupons, and pricing. Use when the user asks about invoices, estimates, payments, products, orders, charges, or subscriptions in GoHighLevel.
---

# GHL Billing & Commerce

## When to Use
- Create, send, or manage invoices
- Estimates and estimate templates
- Payment links and charges
- Product and price management
- Order management and fulfillment
- Subscriptions and coupons
- Transaction history

## Available Tools

Fetch these MCP tools using `ToolSearch` before calling them:

| Tool | Purpose |
|------|---------|
| `mcp__gohighlevel__create-invoice` | Create invoice |
| `mcp__gohighlevel__update-invoice` | Update invoice |
| `mcp__gohighlevel__send-invoice` | Send invoice |
| `mcp__gohighlevel__get-invoice` | Get invoice |
| `mcp__gohighlevel__list-invoices` | List invoices |
| `mcp__gohighlevel__list-invoices-2` | List invoices (v2) |
| `mcp__gohighlevel__delete-invoice` | Delete invoice |
| `mcp__gohighlevel__void-invoice` | Void invoice |
| `mcp__gohighlevel__record-invoice` | Record invoice payment |
| `mcp__gohighlevel__text2pay-invoice` | Text2Pay invoice |
| `mcp__gohighlevel__create-invoice-schedule` | Create invoice schedule |
| `mcp__gohighlevel__update-invoice-schedule` | Update invoice schedule |
| `mcp__gohighlevel__get-invoice-schedule` | Get invoice schedule |
| `mcp__gohighlevel__list-invoice-schedules` | List invoice schedules |
| `mcp__gohighlevel__delete-invoice-schedule` | Delete invoice schedule |
| `mcp__gohighlevel__cancel-invoice-schedule` | Cancel invoice schedule |
| `mcp__gohighlevel__schedule-invoice-schedule` | Schedule invoice |
| `mcp__gohighlevel__auto-payment-invoice-schedule` | Auto-payment schedule |
| `mcp__gohighlevel__update-and-schedule-invoice-schedule` | Update & schedule |
| `mcp__gohighlevel__create-invoice-template` | Create invoice template |
| `mcp__gohighlevel__update-invoice-template` | Update invoice template |
| `mcp__gohighlevel__get-invoice-template` | Get invoice template |
| `mcp__gohighlevel__list-invoice-templates` | List invoice templates |
| `mcp__gohighlevel__delete-invoice-template` | Delete invoice template |
| `mcp__gohighlevel__update-invoice-late-fees-configuration` | Late fees config |
| `mcp__gohighlevel__update-invoice-payment-methods-configuration` | Payment methods config |
| `mcp__gohighlevel__update-invoice-template-late-fees-configuration` | Template late fees |
| `mcp__gohighlevel__update-invoice-last-visited-at` | Update last visited |
| `mcp__gohighlevel__generate-invoice-number` | Generate invoice number |
| `mcp__gohighlevel__create-new-estimate` | Create estimate |
| `mcp__gohighlevel__update-estimate` | Update estimate |
| `mcp__gohighlevel__send-estimate` | Send estimate |
| `mcp__gohighlevel__list-estimates` | List estimates |
| `mcp__gohighlevel__delete-estimate` | Delete estimate |
| `mcp__gohighlevel__create-estimate-template` | Create estimate template |
| `mcp__gohighlevel__update-estimate-template` | Update estimate template |
| `mcp__gohighlevel__list-estimate-templates` | List estimate templates |
| `mcp__gohighlevel__delete-estimate-template` | Delete estimate template |
| `mcp__gohighlevel__preview-estimate-template` | Preview estimate template |
| `mcp__gohighlevel__generate-estimate-number` | Generate estimate number |
| `mcp__gohighlevel__update-estimate-last-visited-at` | Update last visited |
| `mcp__gohighlevel__create-invoice-from-estimate` | Invoice from estimate |
| `mcp__gohighlevel__create-product` | Create product |
| `mcp__gohighlevel__get-product-by-id` | Get product |
| `mcp__gohighlevel__update-product-by-id` | Update product |
| `mcp__gohighlevel__delete-product-by-id` | Delete product |
| `mcp__gohighlevel__create-price-for-product` | Create price |
| `mcp__gohighlevel__get-price-by-id-for-product` | Get price |
| `mcp__gohighlevel__update-price-by-id-for-product` | Update price |
| `mcp__gohighlevel__delete-price-by-id-for-product` | Delete price |
| `mcp__gohighlevel__list-prices-for-product` | List prices |
| `mcp__gohighlevel__list-orders` | List orders |
| `mcp__gohighlevel__get-order-by-id` | Get order |
| `mcp__gohighlevel__create-order-fulfillment` | Create fulfillment |
| `mcp__gohighlevel__list-order-fulfillment` | List fulfillments |
| `mcp__gohighlevel__list-order-notes` | List order notes |
| `mcp__gohighlevel__record-order-payment` | Record order payment |
| `mcp__gohighlevel__post-migrate-order-payment-status` | Migrate payment status |
| `mcp__gohighlevel__charge` | Charge |
| `mcp__gohighlevel__getCharges` | Get charges |
| `mcp__gohighlevel__getSpecificCharge` | Get specific charge |
| `mcp__gohighlevel__deleteCharge` | Delete charge |
| `mcp__gohighlevel__generate-payment-link` | Generate payment link |
| `mcp__gohighlevel__list-transactions` | List transactions |
| `mcp__gohighlevel__get-transaction-by-id` | Get transaction |
| `mcp__gohighlevel__list-subscriptions` | List subscriptions |
| `mcp__gohighlevel__get-subscription-by-id` | Get subscription |
| `mcp__gohighlevel__create-coupon` | Create coupon |
| `mcp__gohighlevel__get-coupon` | Get coupon |
| `mcp__gohighlevel__update-coupon` | Update coupon |
| `mcp__gohighlevel__delete-coupon` | Delete coupon |
| `mcp__gohighlevel__list-coupons` | List coupons |
| `mcp__gohighlevel__create-product-collection` | Create collection |
| `mcp__gohighlevel__get-product-collection` | Get collection |
| `mcp__gohighlevel__get-product-collection-id` | Get collection by ID |
| `mcp__gohighlevel__update-product-collection` | Update collection |
| `mcp__gohighlevel__delete-product-collection` | Delete collection |
| `mcp__gohighlevel__get-product-reviews` | Get reviews |
| `mcp__gohighlevel__update-product-review` | Update review |
| `mcp__gohighlevel__bulk-update-product-review` | Bulk update reviews |
| `mcp__gohighlevel__delete-product-review` | Delete review |
| `mcp__gohighlevel__get-reviews-count` | Get reviews count |
| `mcp__gohighlevel__get-product-store-stats` | Store stats |
| `mcp__gohighlevel__hasFunds` | Check funds |

## Usage Pattern

1. Use `ToolSearch` with query `"select:mcp__gohighlevel__create-invoice"` (or whichever tool you need)
2. Call the fetched tool with required parameters
3. The GHL location ID comes from the user's configured environment
