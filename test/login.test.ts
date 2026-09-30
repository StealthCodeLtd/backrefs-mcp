import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runLogin } from "../src/login";

// A cloud hostname longer than the api's clientName cap allows.
const LONG_HOST = `ip-10-0-0-1.${"x".repeat(60)}.compute.internal`;
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  hostname: () => LONG_HOST,
}));

/**
 * The key is live on the account the moment the device flow mints it, so every
 * flag must be settled before the first request, and every way the flow can
 * end has to say what became of a key it may have created.
 */
describe("runLogin", () => {
  const START = {
    deviceCode: "d".repeat(43),
    userCode: "ABCD-EFGH",
    verificationUri: "https://backrefs.com/device",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    intervalSeconds: 1,
  };

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refuses --print-token beside install options before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runLogin(["--print-token", "--dry-run"])).rejects.toThrow(/--print-token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns that a key may exist when a lost poll is followed by 'unknown'", async () => {
    // The first poll's answer never arrives — the api may have minted the key
    // for it — and the grant is gone by the next one.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(START))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json({ status: "unknown" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runLogin(["--print-token"])).rejects.toThrow(/may already have created a key/);
  });

  it("keeps the default client name within the api's cap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(START))
      .mockResolvedValueOnce(json({ status: "denied" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runLogin(["--print-token"])).rejects.toThrow(/denied/);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.clientName.length).toBeLessThanOrEqual(60);
    expect(body.clientName).toMatch(/^backrefs-mcp on ip-10-0-0-1\./);
  });
});
