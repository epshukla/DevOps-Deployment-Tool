import { describe, it, expect, vi } from "vitest";
import { fanOutToWebhook, isSafeWebhookUrl, webhookPayload } from "../notify-webhook";
import { createFakeSupabase } from "./helpers/fake-supabase";

describe("isSafeWebhookUrl", () => {
  it("allows public https endpoints", () => {
    expect(isSafeWebhookUrl("https://hooks.slack.com/services/T/B/x")).toBe(true);
    expect(isSafeWebhookUrl("https://discord.com/api/webhooks/1/abc")).toBe(true);
  });

  it("rejects http, credentials and internal hosts", () => {
    for (const url of [
      "http://hooks.slack.com/x",
      "https://user:pw@example.com/",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://192.168.1.1/x",
      "https://172.20.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "not a url",
    ]) {
      expect(isSafeWebhookUrl(url)).toBe(false);
    }
  });
});

describe("fanOutToWebhook", () => {
  it("posts a Slack/Discord-compatible body to the org webhook", async () => {
    const { client } = createFakeSupabase(() => ({ data: { notify_webhook_url: "https://hooks.example.com/x" } }));
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    const ok = await fanOutToWebhook(client, "org", { type: "run_failed", title: "Run failed", body: "api #12" }, fetchFn as never);

    expect(ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/x");
    expect(JSON.parse(init.body)).toMatchObject({ text: "*Run failed*\napi #12", content: "*Run failed*\napi #12" });
  });

  it("does nothing without a (safe) webhook and never throws", async () => {
    const fetchFn = vi.fn();
    const none = createFakeSupabase(() => ({ data: { notify_webhook_url: null } }));
    expect(await fanOutToWebhook(none.client, "o", { type: "t", title: "a", body: "b" }, fetchFn as never)).toBe(false);
    const unsafe = createFakeSupabase(() => ({ data: { notify_webhook_url: "https://127.0.0.1/" } }));
    expect(await fanOutToWebhook(unsafe.client, "o", { type: "t", title: "a", body: "b" }, fetchFn as never)).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();

    const failing = createFakeSupabase(() => ({ data: { notify_webhook_url: "https://hooks.example.com/" } }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = vi.fn().mockRejectedValue(new Error("down"));
    expect(await fanOutToWebhook(failing.client, "o", { type: "t", title: "a", body: "b" }, boom as never)).toBe(false);
    err.mockRestore();
  });

  it("includes the link when present", () => {
    expect(webhookPayload({ type: "t", title: "a", body: "b", href: "/runs/1" }).href).toBe("/runs/1");
  });
});
