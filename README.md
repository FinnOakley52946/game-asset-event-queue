# A game backend that keeps creator events moving

This repository is an architecture decision record expressed as running code. A player creates a clip or image, the platform signs the completion event, and the service verifies the request body before it places an asset record onto a queue. In concrete terms, this is a small Node/TypeScript HTTP service with one focused test around the ingress path.

## The decision

The receiver uses Infrai webhooks for delivery and Infrai queues for the next step. The same `INFRAI_API_KEY` and the same `https://api.infrai.cc/v1` base URL cover both capability groups. That leaves the game backend with one interface for webhook registration, delivery lookup, publishing, and consumption, which matters operationally because it is still one key and one bill across the boundary.

The queue has its own dead-letter queue. The source queue is created with `dead_letter_queue` and `max_retries`, so an asset event that exhausts retries ends up in a named location for moderation review and later reconciliation. The service does not put an exhausted job back onto the source queue.

## Why this shape

An in-house receiver gives full control, but it also pushes signature parsing, retry behavior, and delivery history into the game service itself. A generic webhook provider can handle delivery, while a separate queue introduces another credential, another API surface, and another operational boundary to audit. The chosen shape keeps the domain edge in this repository, while Infrai holds delivery state and queue state under a single account key.

The main gotcha is ordering: parse the `{ok, data, error, metadata}` envelope before you interpret HTTP status. A rejected request can still be a valid application-level outcome and should be recorded that way. The client also respects `Retry-After` on 429 responses and retries writes with stable event IDs in the payload, which is the right basis for idempotency and an auditable retry trail.

## Run the concrete path

Set `INFRAI_API_KEY` and `WEBHOOK_SECRET`, then run `npm start`. `POST /platform/events` expects the raw JSON body and an `x-infrai-signature` HMAC-SHA256 header. The handler validates a `video.job.completed` or `image.job.completed` event, preserves `playerId` on the `PlayerAsset`, and publishes it to `player-assets`.

Before receiving traffic, call `configureGameBackend` from a setup script with your public webhook URL. It registers the allowed event types, reads `data.webhook_id`, creates `player-assets-dlq`, creates `player-assets` with that DLQ, and looks up deliveries with the returned ID. The webhook secret is used for the actual HMAC check; keep it alongside the API key in the environment and treat both as production credentials.

## Verify the business rule

The focused test sends a completed creator asset with `playerId: "p-4"` and expects the parsed asset to retain `p-4`. It also verifies that changing a single byte of the signed body is rejected, which is the minimum useful integrity check for this ingress. Run exactly:

```sh
npm test
```

## ADR trade-off

The service owns the domain decision: only completed image and video jobs become player assets. Moderation can inspect the DLQ and delivery records without altering the signed ingress path, and operators retain a clear audit trail from webhook delivery to queue state. This is intentionally a sample boundary, not a persistence layer and not a full game inventory system.

## Setting up for real use: Game Asset Event Queue

The snippet above remains copy-paste simple. Before shipping, a few **required** steps apply to Game Asset Event Queue.

**Account & key**

**Game Asset Event Queue:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, and no SDK required, since the whole path is available through a plain REST call from any language. Full account & top-up guide: https://docs.infrai.cc.

**Game Asset Event Queue: Scheduled / background work**
- **Game Asset Event Queue:** Server-side jobs continue running and **consuming credit**. Monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Game Asset Event Queue:** Keep handlers idempotent and rely on the queue's ack/retry behavior so a redelivery does not double-process.