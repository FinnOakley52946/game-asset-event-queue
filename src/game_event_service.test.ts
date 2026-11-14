import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { validateEvent, verifySignature } from "./game_event_service.ts";

test("a completed creator asset keeps its player identity at the boundary", () => {
  const event = validateEvent({ id: "evt-7", type: "video.job.completed", playerId: "p-4", asset: { assetId: "asset-9", title: "Launch trailer", kind: "clip" } });
  assert.equal(event.asset.playerId, "p-4");
  assert.equal(event.type, "video.job.completed");
});

test("the webhook accepts only the HMAC for the exact body", () => {
  const body = JSON.stringify({ id: "evt-7" });
  const signature = createHmac("sha256", "test-secret").update(body).digest("hex");
  assert.equal(verifySignature(body, signature, "test-secret"), true);
  assert.equal(verifySignature(`${body} `, signature, "test-secret"), false);
});
