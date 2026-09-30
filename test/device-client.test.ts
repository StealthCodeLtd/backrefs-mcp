import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { postDevice } from "../src/device-client";

/**
 * A device request carries the device code, and the poll that succeeds returns
 * a live key, so neither may cross the network in clear.
 */
describe("postDevice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("refuses plain http to a remote host without sending anything", async () => {
    const fetchMock = stubFetch();

    const result = await postDevice("http://backrefs.example", "/device/start", {}, z.object({}));

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/https/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never follows a redirect, which would replay the device code elsewhere", async () => {
    const fetchMock = stubFetch();

    await postDevice("https://backrefs.com", "/device/start", {}, z.object({}));

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("allows plain http to loopback, for local development", async () => {
    const fetchMock = stubFetch();

    await postDevice("http://localhost:3001", "/device/start", {}, z.object({}));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
