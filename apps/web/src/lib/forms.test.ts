import { describe, expect, it } from "vitest"
import {
  emptyProfileForm,
  emptyProviderForm,
  profileSchemaFor,
  providerFormSchema,
  slugify,
  toProfileInput,
  toProfilePatch,
  toProviderInput,
  type ProfileFormValues,
} from "./forms"

const profile = (patch: Partial<ProfileFormValues>): ProfileFormValues => ({
  ...emptyProfileForm,
  name: "Work",
  slug: "work",
  ...patch,
})

const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`)

describe("provider form", () => {
  it("builds a stdio transport with one argument per line and optional cwd", () => {
    const values = {
      ...emptyProviderForm,
      name: " Everything ",
      slug: "everything",
      transport: "stdio" as const,
      command: "npx",
      args: "-y\n\n  @scope/server with space  \n",
      cwd: "",
    }
    expect(providerFormSchema.safeParse(values).success).toBe(true)
    expect(toProviderInput(values)).toEqual({
      name: "Everything",
      slug: "everything",
      transport: { type: "stdio", command: "npx", args: ["-y", "@scope/server with space"] },
    })
  })

  it("requires an http(s) URL only for http transport", () => {
    const http = { ...emptyProviderForm, name: "A", slug: "a", url: "ftp://x" }
    expect(issues(providerFormSchema.safeParse(http))).toEqual(["url: Enter an http or https URL"])
    const stdio = { ...http, transport: "stdio" as const, command: "node" }
    expect(providerFormSchema.safeParse(stdio).success).toBe(true)
  })

  it("rejects credentials and fragments in provider URLs", () => {
    for (const url of ["https://user:password@example.com/mcp", "https://example.com/mcp#fragment"]) {
      const values = { ...emptyProviderForm, name: "A", slug: "a", url }
      expect(issues(providerFormSchema.safeParse(values))).toEqual(["url: Remove credentials and fragments from the URL"])
    }
  })

  it("keeps accented words together in generated slugs", () => {
    expect(slugify("Résumé Ångström")).toBe("resume-angstrom")
  })
})

describe("profile form", () => {
  it("rejects auth types the transport cannot carry", () => {
    expect(issues(profileSchemaFor("stdio").safeParse(profile({ authType: "oauth" })))).toEqual([
      "authType: OAuth is not available for stdio providers",
    ])
    expect(issues(profileSchemaFor("http").safeParse(profile({ authType: "env" })))).toEqual([
      "authType: Environment variables is not available for http providers",
    ])
  })

  it("validates header rows and blocks proxy-managed headers", () => {
    const result = profileSchemaFor("http").safeParse(
      profile({
        authType: "headers",
        headers: [
          { key: "X-Api-Key", value: "a" },
          { key: "x-api-key", value: "b" },
          { key: "Mcp-Session-Id", value: "c" },
          { key: "", value: "" },
        ],
      }),
    )
    expect(issues(result)).toEqual([
      "headers.1.key: Duplicate name",
      "headers.2.key: Mcp-Session-Id is managed by the proxy",
    ])
  })

  it("converts env rows and oauth fields into the API shape", () => {
    const env = profile({ authType: "env", env: [{ key: "API_KEY", value: "s3cret" }, { key: "", value: "" }] })
    expect(profileSchemaFor("stdio").safeParse(env).success).toBe(true)
    expect(toProfileInput(env).auth).toEqual({ type: "env", env: { API_KEY: "s3cret" } })

    const oauth = profile({ authType: "oauth", scopes: "read, write  admin" })
    expect(toProfileInput(oauth).auth).toEqual({ type: "oauth", scopes: ["read", "write", "admin"] })
  })

  it("rejects routing and browser-controlled authentication headers", () => {
    for (const key of ["Forwarded", "X-Forwarded-For", "X-Real-IP", "Sec-Fetch-Site"]) {
      expect(issues(profileSchemaFor("http").safeParse(profile({ authType: "headers", headers: [{ key, value: "value" }] })))).toEqual([
        `headers.0.key: ${key} is managed by the proxy`,
      ])
    }
  })

  it("omits auth from edits unless credentials are being replaced", () => {
    const kept = profile({ replaceAuth: false, authType: "bearer", bearerToken: "" })
    expect(profileSchemaFor("http").safeParse(kept).success).toBe(true)
    expect(toProfilePatch(kept)).toEqual({ name: "Work" })

    const replaced = profile({ replaceAuth: true, authType: "bearer", bearerToken: " t " })
    expect(toProfilePatch(replaced)).toEqual({ name: "Work", auth: { type: "bearer", token: "t" } })
  })
})
