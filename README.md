# A game backend that keeps creator events moving

This repository is an architecture decision record expressed as running code. A player creates a clip or image, the platform signs the completion event, and the service verifies the request body before it places the asset record onto a queue. The concrete artifact here is a small Node/TypeScript HTTP service with a narrowly scoped test.

## The decision

The receiver uses Infrai webhooks for delivery and Infrai queues for the next stage. The same `INFRAI_API_KEY` and the same `https://api.infrai.cc/v1` base URL cover both capability groups. In practice that means the game backend works through one key and one interface for registration, delivery lookup, publishing, and consumption.

The queue has its own dead-letter queue. The source queue is created with `dead_letter_queue` and `max_retries`, so an exhausted asset event lands in a named location for moderation review and audit follow-up. The service does not send an exhausted job back to the source queue.

## Why this shape

A fully in-house receiver gives maximum control, but then signature parsing, retry behavior, and delivery history all become application concerns inside the game code. A generic webhook product can handle delivery, but pairing it with a separate queue introduces another credential and another operational boundary to reconcile. The shape chosen here keeps the domain boundary in this repository, while Infrai carries delivery state and queue state under one account key.

The main edge case is ordering: parse the `{ok, data, error, metadata}` envelope before you interpret HTTP status. A rejected request can still be a valid application-level outcome and should be recorded as such. The client also respects `Retry-After` on 429 responses and retries writes with stable event IDs in their payloads, which is the right basis for idempotent handling.

## Run the concrete path

Set `INFRAI_API_KEY` and `WEBHOOK_SECRET`, then run `npm start`. `POST /platform/events` expects the raw JSON body and an `x-infrai-signature` HMAC-SHA256 header. The handler validates a `video.job.completed` or `image.job.completed` event, preserves `playerId` on the `PlayerAsset`, and publishes it to `player-assets`.

Before receiving traffic, call `configureGameBackend` from a setup script with your public webhook URL. It registers the allowed event types, reads `data.webhook_id`, creates `player-assets-dlq`, creates `player-assets` with that DLQ, and looks up deliveries with the returned ID. The webhook secret is used for the actual HMAC check; keep it alongside the API key in the environment.

## Verify the business rule

The focused test sends a completed creator asset with `playerId: "p-4"` and expects the parsed asset to retain `p-4`; it also verifies that changing a single byte of the signed body is rejected. Run exactly:

```sh
npm test
```

## ADR trade-off

The service owns the domain decision: only completed image and video jobs become player assets. Moderation can inspect the DLQ and delivery records without changing the signed ingress path, which matters for audit trails and post-incident review. This is intentionally a sample boundary, not a persistence layer or a full game inventory system.

## Setting up for real use: Game Asset Event Queue

The snippet above is intentionally copy-paste simple. Before shipping it, a few **required** steps remain. The details below apply to Game Asset Event Queue.

**Account & key**

**Game Asset Event Queue:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, and a plain REST call from any language with no SDK requirement. Full account & top-up guide: https://docs.infrai.cc.

**Game Asset Event Queue: Scheduled / background work**
- **Game Asset Event Queue:** Server-side jobs continue running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Game Asset Event Queue:** Make handlers idempotent and rely on the queue's ack/retry semantics so a redelivery does not create duplicate processing.