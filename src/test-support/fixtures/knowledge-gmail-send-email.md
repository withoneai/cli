# Send Email

## Endpoint

`POST https://api.example.com/v1/gmail/send-email`

## Headers
```
"x-api-secret": "{{API_SECRET}}"
```

## Description

Sends an email through Gmail. Takes the message as fields - recipients, subject, body - and assembles the RFC 2822 message Gmail's API requires, so the caller never builds MIME or base64.

Supports multiple recipients, CC and BCC, HTML or plain-text bodies, custom labels, and replying into an existing conversation via `threadId` with the `In-Reply-To` and `References` headers a standards-compliant client reads.

Plain-text bodies are escaped and wrapped in HTML, which avoids Gmail's plain-text line wrapping. A caller who already has HTML passes `isHtml: true` and it is sent as written.

## Request Body

### Required Request Body Fields

| Parameter       | Type               | Description                                                                  |
|-----------------|--------------------|------------------------------------------------------------------------------|
| `connectionKey` | string             | The connection key for Gmail authentication                                  |
| `to`            | string \| string[] | Recipient(s). A comma-separated string or an array                           |
| `subject`       | string             | Subject line. Non-ASCII subjects are RFC 2047 encoded automatically          |
| `body`          | string             | Body content. Plain text unless `isHtml` is set                              |

### Optional Request Body Fields

| Parameter    | Type               | Description                                                                                  |
|--------------|--------------------|----------------------------------------------------------------------------------------------|
| `cc`         | string \| string[] | CC recipients                                                                                 |
| `bcc`        | string \| string[] | BCC recipients                                                                                |
| `isHtml`     | boolean            | Treat `body` as HTML and send it unescaped (default: `false`)                                  |
| `from`       | string             | The `From` header. Must be an address the account is allowed to send as                        |
| `replyTo`    | string             | The `Reply-To` header                                                                          |
| `inReplyTo`  | string             | The `Message-ID` this replies to, e.g. `<abc@mail.gmail.com>`                                   |
| `references` | string             | The `References` header, for threading in non-Gmail clients                                     |
| `threadId`   | string             | Gmail thread to send into. Gmail also requires the subject to match the thread's                |
| `labelIds`   | string[]           | Labels to apply to the sent message. Absent means none - Gmail applies `SENT` itself            |
| `userId`     | string             | The mailbox to send from (default: `"me"`, the credential's own)                                |

## Response

### Success Response (200 OK)

```json
{
  "email": {
    "messageId": "18d3c5e2f8a91234",
    "threadId": "18d3c5e2f8a91234",
    "labelIds": ["SENT"],
    "recipients": {
      "to": ["john@example.com"],
      "cc": ["team@example.com"]
    },
    "subject": "Meeting Tomorrow",
    "sent": true
  },
  "message": "Successfully sent email \"Meeting Tomorrow\" to 2 recipients",
  "summary": "Sent email \"Meeting Tomorrow\" (18d3c5e2f8a91234) to 2 recipients"
}
```

### Error Response (400 Bad Request)

```json
{
  "statusCode": 400,
  "message": "The request body is not valid for `send-email`",
  "error": "Bad Request"
}
```

Returned when `to`, `subject` or `body` is missing, or a field has the wrong type. **Nothing is sent** in this case.

## Response Fields

| Field                       | Type     | Description                                                            |
|-----------------------------|----------|------------------------------------------------------------------------|
| `email.messageId`           | string   | The ID Gmail assigned the sent message                                 |
| `email.threadId`            | string   | The conversation it landed in                                          |
| `email.labelIds`            | string[] | Labels Gmail applied                                                   |
| `email.recipients.to`       | string[] | The `to` addresses, as parsed from the request                         |
| `email.recipients.cc`       | string[] | (Optional) Only present when CC was given                              |
| `email.recipients.bcc`      | string[] | (Optional) Only present when BCC was given                             |
| `email.subject`             | string   | The subject that was sent                                              |
| `email.sent`                | boolean  | Always `true` on a success response                                    |
| `message`                   | string   | Success message naming the subject and recipient count                 |
| `summary`                   | string   | Summary including the message ID                                       |

The recipient lists are reported from the request rather than from Gmail's answer, which carries only IDs - so the addresses can be confirmed without re-fetching the message.

## Sample Request

```bash
curl -i --location --request POST 'https://api.example.com/v1/gmail/send-email' \
  --header 'Content-Type: application/json' \
  --header 'x-api-secret: <your-api-secret>' \
  --data '{
    "connectionKey": "live::gmail::default::<your-connection-key>",
    "to": "john@example.com",
    "subject": "Meeting Tomorrow",
    "body": "Hi John,\n\nAre you free at 2 PM?"
  }'
```

## Example Usage

### Example 1: Simple Message

```bash
curl -X POST https://api.example.com/v1/gmail/send-email \
  -H "Content-Type: application/json" \
  -H "x-api-secret: your-api-secret" \
  -d '{
    "connectionKey": "live::gmail::default::your-connection-key",
    "to": "john@example.com",
    "subject": "Meeting Tomorrow",
    "body": "Hi John,\n\nAre you free at 2 PM?"
  }'
```

### Example 2: Several Recipients, With CC and BCC

```bash
curl -X POST https://api.example.com/v1/gmail/send-email \
  -H "Content-Type: application/json" \
  -H "x-api-secret: your-api-secret" \
  -d '{
    "connectionKey": "live::gmail::default::your-connection-key",
    "to": ["a@example.com", "b@example.com"],
    "cc": "manager@example.com",
    "bcc": "archive@example.com",
    "subject": "Weekly update",
    "body": "Everything shipped."
  }'
```

### Example 3: HTML Body

```bash
curl -X POST https://api.example.com/v1/gmail/send-email \
  -H "Content-Type: application/json" \
  -H "x-api-secret: your-api-secret" \
  -d '{
    "connectionKey": "live::gmail::default::your-connection-key",
    "to": "john@example.com",
    "subject": "Release notes",
    "body": "<h1>Shipped</h1><p>See the <a href=\"https://example.com\">changelog</a>.</p>",
    "isHtml": true
  }'
```

### Example 4: Reply Into an Existing Thread

```bash
curl -X POST https://api.example.com/v1/gmail/send-email \
  -H "Content-Type: application/json" \
  -H "x-api-secret: your-api-secret" \
  -d '{
    "connectionKey": "live::gmail::default::your-connection-key",
    "to": "john@example.com",
    "subject": "Re: Meeting Tomorrow",
    "body": "2 PM works.",
    "threadId": "18d3c5e2f8a91234",
    "inReplyTo": "<CAF=abc123@mail.gmail.com>",
    "references": "<CAF=abc123@mail.gmail.com>"
  }'
```

## Behavior

1. **Validate request**: `connectionKey`, `to`, `subject` and `body` must be present. A malformed request is refused before anything is sent.
2. **Assemble the message**: MIME headers, the subject RFC 2047 encoded if it is not ASCII, and the body as HTML.
3. **Encode**: the whole message base64url, as Gmail's `raw` field requires.
4. **Send**: one call to `messages.send`, with `threadId` and `labelIds` when given.
5. **Answer**: Gmail's IDs, plus the recipient lists from the request.

## Notes

- Uses one Gmail action: `messages.send`.
- The message is always sent as `text/html; charset=UTF-8`. Plain text is HTML-escaped first, so a `<` in what you write arrives as a `<` rather than as markup.
- Newlines in a plain-text body become `<br>`.
- Non-ASCII subjects are encoded as `=?UTF-8?B?…?=`. A raw non-ASCII subject is not legal in a mail header.
- **Threading needs both parts**: `threadId` is Gmail's own, and `inReplyTo`/`references` are what other mail clients read. Gmail additionally requires the subject to match the thread's, conventionally with a `Re:` prefix.
- `from` only works for an address the authenticated account is allowed to send as; Gmail rejects anything else.
- Labels are not defaulted. Composer applied `["INBOX", "UNREAD"]`, which marked a message you had just sent as unread mail in your own inbox.
- Attachments are not supported by this endpoint.

## Error Handling

- **400 Bad Request**: a header value containing a line break. `subject`, `to`, `cc`, `bcc`, `from`, `replyTo`, `inReplyTo` and `references` are all refused if they contain CR or LF, because a header value that spans lines is a second header - a subject of `"Hi\r\nBcc: someone@else"` would otherwise add a recipient you never named. Refused, not stripped.
- **400 Bad Request**: `to` that resolves to no address (`""`, `[]`, `" , "`). The message would carry a bare `To:` header.

- **400 Bad Request**: a missing or mistyped field. Refused before the message is assembled, so nothing is sent.
- **Gmail's own errors** are returned with the platform's status and body - for example `403` for an unpermitted `from`, or `400` when `threadId` names a thread whose subject does not match.
- **This action is never retried.** A retried send is a second email, and no answer distinguishes "the send failed" from "the send succeeded and the reply was lost". A failure means the message may or may not have gone; check the mailbox rather than resending blindly.
