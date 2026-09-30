import { describe, expect, it } from "vitest";

import { PollDeviceGrantResponseSchema } from "../src/contract";

/**
 * The `authenticated` poll is answered exactly once — the grant is consumed by
 * the read that produces it — so a parse failure there loses a key that is
 * already live. These pin the looseness that prevents that.
 */
describe("poll response", () => {
  const authenticated = {
    status: "authenticated",
    secret: `brf_${"a".repeat(43)}`,
    key: {
      id: "k1",
      name: "backrefs-mcp on box",
      keyPrefix: "brf_aaaaaaaa",
      scopes: ["read"],
      lastUsedAt: null,
      expiresAt: null,
      maxCommitTokens: null,
      createdAt: "2026-09-30T10:00:00.000Z",
    },
  };

  it("parses the api's authenticated answer", () => {
    expect(PollDeviceGrantResponseSchema.parse(authenticated)).toMatchObject({
      status: "authenticated",
      secret: authenticated.secret,
    });
  });

  it("still parses when the api adds a scope this installer has never heard of", () => {
    const withNewScope = { ...authenticated, key: { ...authenticated.key, scopes: ["billing"] } };

    expect(PollDeviceGrantResponseSchema.safeParse(withNewScope).success).toBe(true);
  });

  it("still parses when the api adds a field", () => {
    const withNewField = { ...authenticated, key: { ...authenticated.key, region: "eu" } };

    expect(PollDeviceGrantResponseSchema.safeParse(withNewField).success).toBe(true);
  });
});
