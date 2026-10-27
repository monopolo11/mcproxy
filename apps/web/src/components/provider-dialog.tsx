import { useForm, useSelector } from "@tanstack/react-form"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react"
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
import { errorMessage, type Provider } from "@/lib/api"
import {
  emptyProviderForm,
  providerFormSchema,
  slugify,
  toProviderInput,
  type ProfileFormValues,
  type ProviderFormValues,
} from "@/lib/forms"
import {
  parsePastedServer,
  PASTE_LABELS,
  pastedFormValues,
  pastedProfileValues,
  type PastedServer,
} from "@/lib/paste"
import { useCreateProvider } from "@/lib/queries"
import { describedBy, ErrorText, Field, visibleError } from "./field"
import { ProfileForm } from "./profile-dialog"

type FirstProfile = { provider: Provider; initial: Partial<ProfileFormValues> }

/**
 * Dialog that registers an HTTP or stdio MCP server (a provider), then opens
 * it. Pasting an add command or config fills the form; when the paste carried
 * credentials, the dialog continues with the first profile, prefilled.
 */
export function ProviderDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [firstProfile, setFirstProfile] = useState<FirstProfile | null>(null)
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) setFirstProfile(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className={firstProfile ? "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl" : "sm:max-w-lg"}
      >
        {firstProfile ? (
          <>
            <DialogHeader>
              <DialogTitle>New {firstProfile.provider.name} profile</DialogTitle>
            </DialogHeader>
            <ProfileForm
              provider={firstProfile.provider}
              mode={{ kind: "create" }}
              initial={firstProfile.initial}
              onDone={() => onOpenChange(false)}
            />
          </>
        ) : (
          <>
            <DialogHeader className="flex-row items-baseline justify-between pr-8">
              <DialogTitle>Add MCP</DialogTitle>
              <span className="text-xs text-muted-foreground">Paste a command to fill</span>
            </DialogHeader>
            {/* Remounting on open resets the form. */}
            {open ? <ProviderForm onDone={() => onOpenChange(false)} onFirstProfile={setFirstProfile} /> : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ProviderForm({
  onDone,
  onFirstProfile,
}: {
  onDone: () => void
  onFirstProfile: (next: FirstProfile) => void
}) {
  const create = useCreateProvider()
  const navigate = useNavigate()
  const slugEdited = useRef(false)
  /** The last paste and the values it replaced, for Undo. */
  const [pasted, setPasted] = useState<{ server: PastedServer; previous: ProviderFormValues } | null>(null)

  const form = useForm({
    defaultValues: emptyProviderForm,
    validators: { onSubmit: providerFormSchema },
    onSubmit: async ({ value }) => {
      const { provider } = await create.mutateAsync(toProviderInput(value))
      // Credentials only carry over while the transport still matches the paste.
      const initial = pasted?.server.transport.type === value.transport ? pastedProfileValues(pasted.server) : null
      if (initial) onFirstProfile({ provider, initial })
      else onDone()
      await navigate({ to: "/providers/$providerId", params: { providerId: provider.id } })
    },
  })

  const onPaste = useEffectEvent((event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain") ?? ""
    const server = parsePastedServer(text)
    if (!server) return
    // In a field, a single word, bare URL, or bare command is ordinary input,
    // except that the Command field splits a pasted command line.
    const field = event.target instanceof Element ? event.target.closest("input, textarea") : null
    if (field) {
      const bare = server.source === "url" || (server.source === "command" && field.id !== "provider-command")
      if (bare || !/\s/.test(text.trim())) return
    }
    event.preventDefault()
    const previous = form.state.values
    form.reset({ ...previous, ...pastedFormValues(server) }, { keepDefaultValues: true })
    slugEdited.current = false
    setPasted({ server, previous })
  })
  useEffect(() => {
    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
  }, [])

  const undo = () => {
    if (!pasted) return
    form.reset(pasted.previous, { keepDefaultValues: true })
    slugEdited.current = pasted.previous.slug !== slugify(pasted.previous.name)
    setPasted(null)
  }

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
      {pasted ? (
        <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-success">Filled from {PASTE_LABELS[pasted.server.source]}</span>
          {pastedProfileValues(pasted.server) ? (
            <span className="text-warning">Credentials go on the profile next</span>
          ) : null}
          <button type="button" className="text-link underline-offset-4 hover:underline" onClick={undo}>
            Undo
          </button>
        </p>
      ) : null}

      <div className="grid items-start gap-4 sm:grid-cols-2">
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
              {submitting ? "Adding" : "Add MCP"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  )
}
