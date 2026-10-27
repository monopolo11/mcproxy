import { expect, it } from "vitest"
import { matchesTool, schemaType, toolParams } from "./tools"

it("renders schema types compactly and tolerates malformed schemas", () => {
  expect(schemaType({ type: "string" })).toBe("string")
  expect(schemaType({ enum: ["todo", "done"] })).toBe('"todo" | "done"')
  expect(schemaType({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } })).toBe("(string | number)[]")
  expect(schemaType({ type: ["string", "null"] })).toBe("string | null")
  expect(schemaType({ $ref: "#/$defs/Issue" })).toBe("Issue")
  expect(schemaType({ type: 42 })).toBe("any")
  expect(schemaType("nonsense")).toBe("any")
})

it("lists required parameters first and ignores a non-array required list", () => {
  const tool = {
    name: "save_issue",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string", description: "Issue title" } },
      required: ["title"],
    },
  }
  expect(toolParams(tool)).toEqual([
    { name: "title", type: "string", required: true, description: "Issue title" },
    { name: "id", type: "string", required: false, description: undefined },
  ])
  expect(toolParams({ name: "x", inputSchema: { properties: { a: {} }, required: "a" } })[0]?.required).toBe(false)
  expect(matchesTool({ name: "list_issues", description: "Find Linear issues", inputSchema: {} }, "linear")).toBe(true)
})
