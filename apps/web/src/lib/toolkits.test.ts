import { describe, expect, it } from "vitest"
import { toolPrefixes } from "./toolkits"

describe("toolPrefixes", () => {
  it("uses the provider alone until it contributes several profiles", () => {
    const prefixes = toolPrefixes([
      { profileId: "1", providerSlug: "linear", profileSlug: "fountain" },
      { profileId: "2", providerSlug: "linear", profileSlug: "personal" },
      { profileId: "3", providerSlug: "my-notes", profileSlug: "main" },
    ])
    expect(prefixes.get("1")).toBe("linear_fountain_")
    expect(prefixes.get("2")).toBe("linear_personal_")
    expect(prefixes.get("3")).toBe("my_notes_")
  })
})
