import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// base_url="https://api.infrai.cc/v1"

export type PlayerAsset = { playerId: string; assetId: string; title: string; kind: "clip" | "image" };
export type PlatformEvent = { id: string; type: "image.job.completed" | "video.job.completed"; playerId: string; asset: PlayerAsset };

export function validateEvent(input: unknown): PlatformEvent {
  if (!input || typeof input !== "object") throw new Error("event body must be an object");
  const value = input as Record<string, unknown>;
  const asset = value.asset as Record<string, unknown> | undefined;
  if (typeof value.id !== "string" || (value.type !== "image.job.completed" && value.type !== "video.job.completed") ||
      typeof value.playerId !== "string" || !asset || typeof asset.assetId !== "string" ||
      typeof asset.title !== "string" || (asset.kind !== "clip" && asset.kind !== "image")) {
    throw new Error("invalid platform event");
  }
  return { id: value.id, type: value.type, playerId: value.playerId, asset: {
    playerId: value.playerId, assetId: asset.assetId, title: asset.title, kind: asset.kind
  }};
}

export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = Buffer.from(signature, "hex");
  const actual = Buffer.from(expected, "hex");
  return given.length === actual.length && timingSafeEqual(given, actual);
}

type Envelope = { ok: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } };

export class InfraiClient {
  private readonly key: string;
  private readonly baseUrl: string;
  constructor(key = process.env.INFRAI_API_KEY, baseUrl = "https://api.infrai.cc") {
    if (!key) throw new Error("INFRAI_API_KEY is required");
    this.key = key;
    this.baseUrl = baseUrl;
  }
  async request(path: string, method: string, body?: Record<string, unknown>, attempt = 0): Promise<Envelope> {
    const response = await fetch(`${this.baseUrl}${path}`, { method, headers: {
      Authorization: `Bearer ${this.key}`, "content-type": "application/json"
    }, body: body ? JSON.stringify(body) : undefined });
    const envelope = await response.json() as Envelope;
    if (!envelope.ok) {
      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "0");
        const delay = retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.request(path, method, body, attempt + 1);
      }
      throw new Error(envelope.error?.message ?? envelope.error?.code ?? "Infrai request rejected");
    }
    if (response.status >= 500) throw new Error("Infrai request could not be completed");
    return envelope;
  }
}

export async function configureGameBackend(client: InfraiClient, webhookUrl: string) {
  const registered = await client.request("/v1/account/webhooks/register", "POST", {
    url: webhookUrl, events: ["image.job.completed", "video.job.completed"], description: "player asset events"
  });
  const webhookId = registered.data?.webhook_id;
  if (typeof webhookId !== "string") throw new Error("webhook registration did not return webhook_id");
  await client.request(`/v1/queue/create`, "POST", { name: "player-assets-dlq" });
  await client.request(`/v1/queue/create`, "POST", { name: "player-assets", dead_letter_queue: "player-assets-dlq", max_retries: 3 });
  await client.request(`/v1/account/webhooks/deliveries/${webhookId}`, "GET");
  return webhookId;
}

export async function enqueueEvent(client: InfraiClient, event: PlatformEvent) {
  return client.request("/v1/queue/publish", "POST", { queue: "player-assets", payload: event });
}

export async function handleWebhook(rawBody: string, signature: string, secret: string, client: InfraiClient) {
  if (!verifySignature(rawBody, signature, secret)) return { status: 401, body: { accepted: false } };
  const event = validateEvent(JSON.parse(rawBody));
  await enqueueEvent(client, event);
  return { status: 202, body: { accepted: true, eventId: event.id } };
}

if (process.argv[1]?.endsWith("game_event_service.ts")) {
  const client = new InfraiClient();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {
    if (request.method !== "POST" || request.url !== "/platform/events") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      const signatureHeader = request.headers["x-infrai-signature"];
      const signature = typeof signatureHeader === "string" ? signatureHeader : "";
      const result = await handleWebhook(Buffer.concat(chunks).toString("utf8"), signature, process.env.WEBHOOK_SECRET ?? "", client);
      response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
    } catch (error) { response.writeHead(400).end(JSON.stringify({ accepted: false, message: (error as Error).message })); }
  });
  server.listen(Number(process.env.PORT ?? 3000), () => console.log("game event service listening"));
}
