import { describe, expect, it } from "vitest"
import { clientCommand, clientCommands, codexEnvVar } from "./clients"

const target = {
  name: "linear-work",
  endpoint: "http://127.0.0.1:7433/mcps/linear/work",
  token: "k3Jd8sQ2pL0vXh7NtR1wYb9ZcE4mA6uG5fT8oV2iH3nK0Q",
}

describe("client commands", () => {
  it("every client gets the endpoint and the bearer token", () => {
    for (const command of clientCommands(target)) {
      expect(command.text, command.id).toContain(target.endpoint)
      expect(command.text, command.id).toContain(target.token)
      expect(command.text, command.id).toContain("linear-work")
    }
  })

  it("codex passes the token through a derived environment variable", () => {
    expect(codexEnvVar("linear-work")).toBe("MCPROXY_LINEAR_WORK")
    const { text } = clientCommand("codex", target)
    expect(text).toContain(`export MCPROXY_LINEAR_WORK="${target.token}"`)
    expect(text).toContain("--bearer-token-env-var MCPROXY_LINEAR_WORK")
  })

  it("JSON variants parse and carry the Authorization header", () => {
    const cursor = JSON.parse(clientCommand("cursor", target).text)
    expect(cursor.mcpServers["linear-work"].headers.Authorization).toBe(`Bearer ${target.token}`)
    const raw = JSON.parse(clientCommand("json", target).text)
    expect(raw["linear-work"]).toMatchObject({ type: "http", url: target.endpoint })
  })
})
