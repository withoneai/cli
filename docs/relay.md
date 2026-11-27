# Relay

Receiving webhook events and forwarding them. Part of the [One CLI reference](./README.md).

## `one relay`

Receive webhooks from platforms and forward them to any connected platform via passthrough actions.

```bash
one relay platforms                        # List relay-capable platforms + event type counts
one relay event-types <platform>           # List supported event types for a platform
one relay metadata <platform>              # List the --metadata keys the platform needs on create
one relay create --connection-key <key> --create-webhook --event-filters '["event.type"]'
one relay activate <id> --actions '<json>' # Attach passthrough forwarding actions (agent mode: add --confirm-write for actions that write)
one relay list                             # List existing relay endpoints
one relay events --platform <p>            # Inspect received events
one relay deliveries --endpoint-id <id>    # Check delivery status
```

Start with `one relay platforms` to discover which platforms support relay at all, then drill into `event-types <platform>` for the specific events and `metadata <platform>` for the `--metadata` keys it needs. With `--create-webhook`, `relay create` refuses to create anything while a required key is missing. Run `one guide relay` for the full reference.
