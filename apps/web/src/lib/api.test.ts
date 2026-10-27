import { describe, expect, it } from "vitest"
import { ApiError, request } from "./api"

type Call = { path: string; init: RequestInit | undefined }

function fakeFetch(response: Response | Error) {
  const calls: Call[] = []
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ path: String(input), init })
    if (response instanceof Error) throw response
    return response
  }
  return { calls, fetcher }
}

describe("request", () => {
  it("sends the control header and JSON body", async () => {
    const { calls, fetcher } = fakeFetch(Response.json({ ok: true }, { status: 201 }))
    await request("POST", "/api/providers", { name: "x" }, fetcher)
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get("X-Mcproxy-Request")).toBe("1")
    expect(headers.get("Content-Type")).toBe("application/json")
    expect(calls[0]?.init?.body).toBe('{"name":"x"}')
  })

  it("surfaces the daemon error envelope", async () => {
    const body = { error: { code: "slug_taken", message: "Slug already used." } }
    const { fetcher } = fakeFetch(Response.json(body, { status: 409 }))
    const error = await request("POST", "/api/providers", {}, fetcher).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: "slug_taken", message: "Slug already used." })
  })

  it("treats 204 as empty and network or proxy failures as unreachable", async () => {
    expect(await request("DELETE", "/api/profiles/1", undefined, fakeFetch(new Response(null, { status: 204 })).fetcher)).toBeUndefined()
    await expect(request("GET", "/api/health", undefined, fakeFetch(new TypeError("fetch failed")).fetcher)).rejects.toMatchObject({ code: "unreachable", status: 0 })
    await expect(request("GET", "/api/health", undefined, fakeFetch(new Response("Bad gateway", { status: 502 })).fetcher)).rejects.toMatchObject({ code: "unreachable" })
  })
})
