# Create a Customer

## Prerequisites

- Ability to create Customers in the Stripe account.

## Method

`POST`

## URL

`https://api.stripe.com/v1/customers`

## Headers

```json
{
  "Accept": "application/json",
  "Content-Type": "application/x-www-form-urlencoded"
}
```

## Description

Creates a new customer object.

## Enforcement Rules

- When executing the action, send body fields as `application/x-www-form-urlencoded` (not JSON).
- When executing the action, ensure to send **Query Parameters** in the URL as query parameters and **not** in the body.

## Optional Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `expand` | array of strings | Specifies which fields in the response should be expanded. |

## Optional Request Body Fields (application/x-www-form-urlencoded)

| Parameter | Type | Description |
|---|---|---|
| `address` | object \| `""` | Customer address object, or empty string. |
| `address.city` | string | Max length 5000. |
| `address.country` | string | Max length 5000. |
| `address.line1` | string | Max length 5000. |
| `address.line2` | string | Max length 5000. |
| `address.postal_code` | string | Max length 5000. |
| `address.state` | string | Max length 5000. |
| `balance` | integer | An integer amount in cents (or local equivalent) that represents the customer's current balance, which affects the customer's future invoices. Negative = credit; positive = increases amount due. |
| `business_name` | string \| `""` | Business name. |
| `cash_balance` | object | Cash balance configuration. |
| `cash_balance.settings` | object | Cash balance settings. |
| `cash_balance.settings.reconciliation_mode` | string | One of: `automatic`, `manual`, `merchant_default`. |
| `description` | string | Max length 5000. An arbitrary string to attach to a customer object (shown in dashboard). |
| `email` | string | Max length 512. Customer email address (shown in dashboard). |
| `individual_name` | string \| `""` | Individual name. |
| `invoice_prefix` | string | Max length 5000. Prefix used to generate unique invoice numbers. Must be 3–12 uppercase letters or numbers. |
| `invoice_settings` | object | Invoice settings for the customer. |
| `invoice_settings.custom_fields` | array of objects \| `""` | Custom fields array, or empty string. Each entry has required `name`, `value`. |
| `invoice_settings.custom_fields[].name` | string | **Required** (within each custom field). Max length 40. |
| `invoice_settings.custom_fields[].value` | string | **Required** (within each custom field). Max length 140. |
| `invoice_settings.default_payment_method` | string | Max length 5000. |
| `invoice_settings.footer` | string | Max length 5000. |
| `invoice_settings.rendering_options` | object \| `""` | Rendering options object, or empty string. |
| `invoice_settings.rendering_options.amount_tax_display` | string | One of: `exclude_tax`, `include_inclusive_tax`, or empty. |
| `invoice_settings.rendering_options.template` | string | Max length 5000. |
| `metadata` | object \| `""` | Key-value pairs, or empty string. Format: `{[key: string]: string}`. |
| `name` | string | Max length 256. Customer full name or business name. |
| `next_invoice_sequence` | integer | Sequence to be used on the customer's next invoice. Defaults to 1. |
| `payment_method` | string | Max length 5000. |
| `phone` | string | Max length 20. Customer phone number. |
| `preferred_locales` | array of strings | Customer preferred languages, ordered by preference. |
| `shipping` | object \| `""` | Shipping info object, or empty string. |
| `shipping.address` | object | **Required** (if `shipping` is provided as an object). |
| `shipping.address.city` | string | Max length 5000. |
| `shipping.address.country` | string | Max length 5000. |
| `shipping.address.line1` | string | Max length 5000. |
| `shipping.address.line2` | string | Max length 5000. |
| `shipping.address.postal_code` | string | Max length 5000. |
| `shipping.address.state` | string | Max length 5000. |
| `shipping.name` | string | **Required** (if `shipping` is provided as an object). Max length 5000. |
| `shipping.phone` | string | Max length 5000. |
| `source` | string | Max length 5000. |
| `tax` | object | Tax-related settings. |
| `tax.ip_address` | string \| `""` | IP address, or empty string. |
| `tax.validate_location` | string | One of: `deferred`, `immediately`. |
| `tax_exempt` | string | One of: `none`, `exempt`, `reverse`. Customer’s tax exemption status. |
| `tax_id_data` | array of objects | The customer's tax IDs. Each entry has required `type` and `value`. |
| `tax_id_data[].type` | string | **Required**. One of the documented tax ID types (e.g., `eu_vat`, `us_ein`, etc.). Max length 5000. |
| `tax_id_data[].value` | string | **Required**. Tax ID value. |
| `test_clock` | string | Max length 5000. ID of the test clock to attach to the customer. |

## Response

### Success Response (200 OK)

```json
{
  "id": "cus_Rp8yQn9JHq3m1A",
  "object": "customer",
  "address": {
    "city": "San Francisco",
    "country": "US",
    "line1": "510 Townsend St",
    "line2": "Floor 2",
    "postal_code": "94103",
    "state": "CA"
  },
  "balance": 0,
  "created": 1710350000,
  "currency": "usd",
  "default_source": null,
  "delinquent": false,
  "description": "Example customer",
  "email": "customer@example.com",
  "invoice_credit_balance": {},
  "invoice_prefix": "ABC123",
  "invoice_settings": {
    "custom_fields": [
      {
        "name": "PO",
        "value": "PO-12345"
      }
    ],
    "default_payment_method": null,
    "footer": "Thanks for your business",
    "rendering_options": null
  },
  "livemode": false,
  "metadata": {
    "account_id": "acct_001"
  },
  "name": "Jenny Rosen",
  "next_invoice_sequence": 1,
  "phone": "+14155552671",
  "preferred_locales": [
    "en"
  ],
  "shipping": null,
  "tax": {
    "automatic_tax": "supported",
    "ip_address": "203.0.113.10",
    "location": null,
    "provider": "stripe"
  },
  "tax_exempt": "none",
  "tax_ids": {
    "object": "list",
    "data": [],
    "has_more": false,
    "url": "/v1/customers/cus_Rp8yQn9JHq3m1A/tax_ids"
  },
  "test_clock": null
}
```

### Error Response (Default)

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "Invalid email address",
    "param": "email",
    "code": "parameter_invalid_integer",
    "doc_url": "https://docs.stripe.com/error-codes",
    "request_log_url": "https://dashboard.stripe.com/test/logs/req_123"
  }
}
```

## Response Fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier for the object. |
| `object` | string | String representing the object's type. For this endpoint: `customer`. |
| `address` | object | Customer address. |
| `balance` | integer | Current balance stored on the customer in their default currency. |
| `created` | integer | Time at which the object was created (seconds since Unix epoch). |
| `currency` | string | Three-letter ISO code for the currency the customer can be charged in for recurring billing purposes. |
| `default_source` | string \| object \| null | Default payment source (may be an ID or expanded object). |
| `delinquent` | boolean | Tracks the most recent state change on any invoice belonging to the customer. |
| `description` | string | An arbitrary string attached to the object. |
| `email` | string | Customer email address. |
| `invoice_credit_balance` | object | Map of currency to integer amounts for multi-currency invoice credit balances. |
| `invoice_prefix` | string | Prefix used to generate unique invoice numbers. |
| `invoice_settings` | object | Invoice settings for the customer. |
| `livemode` | boolean | `true` if in live mode; `false` if in test mode. |
| `metadata` | object | Key-value pairs attached to the object. |
| `name` | string | Customer name. |
| `next_invoice_sequence` | integer | Suffix of the customer's next invoice number (when applicable). |
| `phone` | string | Customer phone number. |
| `preferred_locales` | array of strings | Customer preferred locales (languages), ordered by preference. |
| `shipping` | object \| null | Shipping details. |
| `tax` | object | Tax-related fields including provider and location inference fields. |
| `tax_exempt` | string | Tax exemption status: `none`, `exempt`, or `reverse`. |
| `tax_ids` | object | List object containing the customer's tax IDs. |
| `test_clock` | string \| object \| null | Test clock ID or expanded object, if attached. |

## Sample Request

```bash
curl -i --request POST 'https://api.stripe.com/v1/customers' \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'email=customer@example.com' \
  --data-urlencode 'name=Jenny Rosen' \
  --data-urlencode 'description=Example customer'
```

## Example Usage

### Example 1: Create a basic customer

```bash
curl -i --request POST 'https://api.stripe.com/v1/customers' \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'email=customer@example.com' \
  --data-urlencode 'name=Jenny Rosen'
```

### Example 2: Create a customer with address and phone

```bash
curl -i --request POST 'https://api.stripe.com/v1/customers' \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'name=Acme, Inc.' \
  --data-urlencode 'phone=+14155552671' \
  --data-urlencode 'address[line1]=510 Townsend St' \
  --data-urlencode 'address[city]=San Francisco' \
  --data-urlencode 'address[state]=CA' \
  --data-urlencode 'address[postal_code]=94103' \
  --data-urlencode 'address[country]=US'
```

### Example 3: Expand fields in the response

```bash
curl -i --request POST 'https://api.stripe.com/v1/customers?expand[]=default_source' \
  --header 'Accept: application/json' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'email=customer@example.com' \
  --data-urlencode 'name=Jenny Rosen'
```

## Behavior

1. Accepts `application/x-www-form-urlencoded` input to define customer attributes.
2. Creates the customer object.
3. Returns the created customer object (optionally expanding fields requested via `expand`).

## Notes

- Many request fields accept either an object value or an empty string (`""`) as indicated in the source documentation.
- Amounts such as `balance` are expressed in the smallest currency unit (for example, cents for USD).