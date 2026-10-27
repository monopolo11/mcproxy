import { useForm, useSelector } from "@tanstack/react-form"
import { useNavigate } from "@tanstack/react-router"
import { useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/api"
import {
  emptyProviderForm,
  providerFormSchema,
  slugify,
  toProviderInput,
} from "@/lib/forms"
import { useCreateProvider } from "@/lib/queries"
import { describedBy, ErrorText, Field, visibleError } from "./field"

/** Dialog that registers an HTTP or stdio MCP server, then opens it. */
export function ProviderDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
        </DialogHeader>
        {/* Remounting on open resets the form. */}
        {open ? <ProviderForm onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function ProviderForm({ onDone }: { onDone: () => void }) {
  const create = useCreateProvider()
  const navigate = useNavigate()
  const slugEdited = useRef(false)

  const form = useForm({
    defaultValues: emptyProviderForm,
    validators: { onChange: providerFormSchema },
    onSubmit: async ({ value }) => {
      const { provider } = await create.mutateAsync(toProviderInput(value))
      onDone()
      await navigate({ to: "/providers/$providerId", params: { providerId: provider.id } })
    },
  })
  const transport = useSelector(form.store, (state) => state.values.transport)

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit().catch(() => undefined)
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <form.Field
          name="name"
          listeners={{
            onChange: ({ value }) => {
              if (!slugEdited.current) form.setFieldValue("slug", slugify(value))
            },
          }}
        >
          {(field) => {
            const error = visibleError(field.state.meta)
            return (
              <Field id="provider-name" label="Name" error={error}>
                <Input
                  {...describedBy("provider-name", error)}
                  autoFocus
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Linear"
                />
              </Field>
            )
          }}
        </form.Field>
        <form.Field name="slug">
          {(field) => {
            const error = visibleError(field.state.meta)
            return (
              <Field id="provider-slug" label="Slug" error={error}>
                <Input
                  {...describedBy("provider-slug", error)}
                  className="font-mono"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    slugEdited.current = true
                    field.handleChange(event.target.value)
                  }}
                  placeholder="linear"
                  spellCheck={false}
                />
              </Field>
            )
          }}
        </form.Field>
      </div>

      <form.Field name="transport">
        {(field) => (
          <Field id="provider-transport" label="Transport">
            <Select
              value={field.state.value}
              onValueChange={(value) => {
                if (value === "http" || value === "stdio") field.handleChange(value)
              }}
            >
              <SelectTrigger id="provider-transport" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP (Streamable HTTP endpoint)</SelectItem>
                <SelectItem value="stdio">stdio (local command)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>

      {transport === "http" ? (
        <form.Field name="url">
          {(field) => {
            const error = visibleError(field.state.meta)
            return (
              <Field id="provider-url" label="Server URL" error={error}>
                <Input
                  {...describedBy("provider-url", error)}
                  className="font-mono"
                  type="url"
                  inputMode="url"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  spellCheck={false}
                />
              </Field>
            )
          }}
        </form.Field>
      ) : (
        <>
          <form.Field name="command">
            {(field) => {
              const error = visibleError(field.state.meta)
              return (
                <Field id="provider-command" label="Command" error={error}>
                  <Input
                    {...describedBy("provider-command", error)}
                    className="font-mono"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder="npx"
                    spellCheck={false}
                  />
                </Field>
              )
            }}
          </form.Field>
          <form.Field name="args">
            {(field) => (
              <Field id="provider-args" label="Arguments" hint="One per line">
                <Textarea
                  {...describedBy("provider-args", undefined, "One per line")}
                  className="min-h-20 font-mono text-xs"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder={"-y\n@modelcontextprotocol/server-everything"}
                  spellCheck={false}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="cwd">
            {(field) => (
              <Field id="provider-cwd" label="Working directory">
                <Input
                  id="provider-cwd"
                  className="font-mono"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Optional"
                  spellCheck={false}
                />
              </Field>
            )}
          </form.Field>
        </>
      )}

      {create.error ? <ErrorText>{errorMessage(create.error)}</ErrorText> : null}

      <DialogFooter>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {submitting ? "Adding" : "Add provider"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  )
}
