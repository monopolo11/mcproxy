import { z } from "zod";
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80);
const name = z.string().trim().min(1).max(160);
const entries = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),
  z.string().max(16384),
);
export const providerInput = z.object({
  name,
  slug,
  transport: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("http"),
      url: z.url().refine((value) => {
        const u = new URL(value);
        return (
          ["https:", "http:"].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !u.hash
        );
      }, "Use an HTTP URL without credentials or fragment"),
    }),
    z.object({
      type: z.literal("stdio"),
      command: z.string().min(1).max(4096),
      args: z.array(z.string()).max(100),
      cwd: z.string().optional(),
    }),
  ]),
});
const forbidden =
  /^(host|connection|content-length|transfer-encoding|upgrade|keep-alive|te|trailer|proxy-.*|mcp-.*|forwarded|x-forwarded-.*|x-real-ip|sec-.*|origin|accept|content-type|cookie|set-cookie|x-mcproxy-.*)$/i;
export const authInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("bearer"),
    token: z
      .string()
      .min(1)
      .max(16384)
      .refine((v) => !/[\r\n]/.test(v), "Invalid token"),
  }),
  z.object({
    type: z.literal("headers"),
    headers: entries.refine(
      (v) =>
        Object.entries(v).every(
          ([k, s]) => !forbidden.test(k) && !/[\r\n]/.test(s),
        ),
      "Forbidden authentication header",
    ),
  }),
  z.object({ type: z.literal("env"), env: entries }),
  z.object({
    type: z.literal("oauth"),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().optional(),
    scopes: z.array(z.string()).optional(),
  }),
]);
export const profileInput = z.object({ name, slug, auth: authInput });
export const profilePatch = z.object({
  name: name.optional(),
  auth: authInput.optional(),
});
export type AuthInput = z.infer<typeof authInput>;
export type ProviderInput = z.infer<typeof providerInput>;
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function compatible(
  transport: ProviderInput["transport"],
  auth: AuthInput,
) {
  if (
    (transport.type === "stdio" && !["none", "env"].includes(auth.type)) ||
    (transport.type === "http" && auth.type === "env")
  )
    throw new AppError(
      "incompatible_auth",
      "Authentication does not match transport",
    );
}
