import { z } from "zod";

/**
 * The api's device sign-in contract (RFC 8628), hand-kept.
 *
 * A copy of `packages/api-schemas/src/device/device.ts` in the private Backrefs
 * monorepo — this package cannot import it. A change to one is a change to
 * both, and the api ships first: a published installer cannot be recalled, so
 * a field the api adds must be optional here until every old installer is gone.
 *
 * The copy is deliberately LOOSER than the original where the original is
 * strict about things this package only displays. `authenticated` is returned
 * exactly once — the grant is consumed by the poll that reads it — so a parse
 * failure on that response loses a key that is already live on the account.
 * A new scope name or error code must not be able to cause that.
 */

/** Where the api lives, and the path its versioned routes sit under. */
export const DEFAULT_API_ORIGIN = "https://backrefs.com";
export const API_PATH = "/api/v1";

/** The hosted MCP endpoint. Its own origin, not a path on the app's. */
export const DEFAULT_SERVER_URL = "https://mcp.backrefs.com";

/**
 * The mount that serves `backrefs_login` to a caller holding nothing, and the
 * full surface to one holding a bearer.
 */
export const HEADLESS_PATH = "mcp-headless";

/** The name every host config registers the server under. */
export const SERVER_KEY = "backrefs";

/** The env var Codex reads the key from. One name, so a key has one home. */
export const TOKEN_ENV_VAR = "BACKREFS_TOKEN";

export const StartDeviceGrantResponseSchema = z.object({
  /** The poll handle. Never displayed to the user. */
  deviceCode: z.string(),
  /** The code to read out. Displayed, and useless without a signed-in browser. */
  userCode: z.string(),
  verificationUri: z.string(),
  expiresAt: z.string(),
  /** Seconds to wait between polls (RFC 8628 §3.5). */
  intervalSeconds: z.number().int().positive(),
});
export type StartDeviceGrantResponse = z.infer<typeof StartDeviceGrantResponseSchema>;

/** The minted key as the api describes it — only the fields shown to the user. */
const MintedKeySchema = z.object({
  name: z.string(),
  // Strings, not the api's scope enum: a scope added there must not fail the
  // one response that carries the secret.
  scopes: z.array(z.string()),
  maxCommitTokens: z.number().nullable(),
});

export const PollDeviceGrantResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("slow_down") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("unknown") }),
  z.object({
    status: z.literal("authenticated"),
    /** The `brf_…` secret. Written to config; never echoed. */
    secret: z.string(),
    key: MintedKeySchema,
  }),
]);
export type PollDeviceGrantResponse = z.infer<typeof PollDeviceGrantResponseSchema>;

/** The api's error envelope, reduced to what is shown: its code list is not copied. */
export const ApiErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
});
