import { describe, it, expect, afterEach } from "vitest";
import { authorizeCronRequest } from "../auth";

const req = (auth?: string) =>
  new Request("http://localhost/api/cron/tick", { headers: auth ? { authorization: auth } : {} });

describe("authorizeCronRequest", () => {
  const original = process.env.CRON_SECRET;
  afterEach(() => {
    process.env.CRON_SECRET = original;
  });

  it("refuses when CRON_SECRET is not configured", () => {
    delete process.env.CRON_SECRET;
    expect(authorizeCronRequest(req("Bearer x"))?.status).toBe(500);
  });

  it("rejects missing or wrong tokens", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(authorizeCronRequest(req())?.status).toBe(401);
    expect(authorizeCronRequest(req("Bearer nope"))?.status).toBe(401);
    expect(authorizeCronRequest(req("s3cret"))?.status).toBe(401);
  });

  it("accepts the right bearer token", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(authorizeCronRequest(req("Bearer s3cret"))).toBeNull();
  });
});
