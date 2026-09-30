import type { ZodType } from "zod";

import { API_PATH, ApiErrorSchema } from "./contract";
import { isLoopback } from "./url";

/**
 * The two anonymous device routes, and nothing else.
 *
 * POST only and never retried: `/device/start` creates a grant and
 * `/device/poll` can consume one, so a replay is either a second grant or a
 * lost key. A failed poll is the caller's to repeat on its own schedule.
 */

const TIMEOUT_MS = 30_000;

export type DeviceResult<T> = { ok: true; data: T } | { ok: false; message: string };

export async function postDevice<T>(
  apiOrigin: string,
  path: "/device/start" | "/device/poll",
  body: unknown,
  schema: ZodType<T>,
): Promise<DeviceResult<T>> {
  // Checked here, at the one place a device request leaves, so neither
  // --api-url nor BACKREFS_API_URL can send a device code or a key in clear.
  let origin: URL;
  try {
    origin = new URL(apiOrigin);
  } catch {
    return { ok: false, message: "--api-url is not a valid URL." };
  }
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLoopback(origin.hostname))) {
    return {
      ok: false,
      message: "--api-url must use https: (plain http: is allowed only for localhost).",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${apiOrigin.replace(/\/$/, "")}${API_PATH}${path}`, {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      // A 307/308 would replay this body — the device code — to wherever the
      // Location points, past the https check above. The api never redirects
      // these routes, so a redirect is refused rather than followed.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      message: timedOut
        ? `The backrefs API did not answer within ${TIMEOUT_MS / 1000}s.`
        : "Could not reach the backrefs API.",
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A proxy's HTML error page or an empty body: the status carries the meaning.
  }

  if (!response.ok) {
    const envelope = ApiErrorSchema.safeParse(payload);
    return {
      ok: false,
      message: envelope.success ? envelope.data.error : `The backrefs API answered ${response.status}.`,
    };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      message: `The backrefs API answered ${path} in a shape this installer does not recognise — update @stealth-code/backrefs-mcp.`,
    };
  }
  return { ok: true, data: parsed.data };
}
