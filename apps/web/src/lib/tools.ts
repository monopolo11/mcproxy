import type { JsonSchema, Tool } from "./api"

// Readable summaries of upstream tool schemas. Schemas come straight from the
// upstream server, so every read checks the shape instead of trusting it.

export type ToolParam = { name: string; type: string; required: boolean; description?: string }

const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)

/** Short TypeScript-like type for a schema: `string`, `"a" | "b"`, `number[]`. */
export function schemaType(schema: unknown): string {
  if (!isSchema(schema)) return "any"
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ")
  if ("const" in schema) return JSON.stringify(schema.const)
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined
  if (union) return [...new Set(union.map(schemaType))].join(" | ")
  const ref = text(schema.$ref)
  if (ref) return ref.split("/").pop() ?? ref
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const names = types.map((type) => (type === "array" ? `${wrap(schemaType(schema.items))}[]` : text(type)))
  const known = names.filter((name) => name !== undefined)
  return known.length ? known.join(" | ") : "any"
}

const wrap = (type: string) => (type.includes(" | ") ? `(${type})` : type)

/** Top-level input parameters, required ones first. */
export function toolParams(tool: Tool): ToolParam[] {
  const { properties, required } = tool.inputSchema
  if (!isSchema(properties)) return []
  const requiredNames = new Set(Array.isArray(required) ? required : [])
  return Object.entries(properties)
    .map(([name, schema]) => ({
      name,
      type: schemaType(schema),
      required: requiredNames.has(name),
      description: isSchema(schema) ? text(schema.description) : undefined,
    }))
    .sort((a, b) => Number(b.required) - Number(a.required))
}

/** Case-insensitive match on name, title, or description. */
export function matchesTool(tool: Tool, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [tool.name, tool.title, tool.annotations?.title, tool.description].some((value) =>
    value?.toLowerCase().includes(needle),
  )
}
