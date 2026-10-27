import { useForm, useSelector } from "@tanstack/react-form"
import { useQueries, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage, type Toolkit } from "@/lib/api"
import { slugify, toolkitFormSchema, type ToolkitFormValues } from "@/lib/forms"
import { profilesQuery, providersQuery, useCreateToolkit, useUpdateToolkit } from "@/lib/queries"
import { toolPrefixes } from "@/lib/toolkits"
import { describedBy, ErrorText, Field, visibleError } from "./field"
import { ProfileStatus } from "./status"

type Mode = { kind: "create" } | { kind: "edit"; toolkit: Toolkit }

/**
 * Create or edit a toolkit: a name plus the profiles it exposes. Creation
 * opens the new toolkit, where its token can be shown. The slug is fixed
 * after creation so the endpoint stays stable.
 */
export function ToolkitDialog({
  mode,
  trigger,
  onSaved,
}: {
  mode: Mode
  trigger: ReactNode
  onSaved?: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent aria-describedby={undefined} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode.kind === "create" ? "New toolkit" : `Edit ${mode.toolkit.name}`}</DialogTitle>
        </DialogHeader>
        {/* Remounting on open resets the form. */}
        {open ? (
          <ToolkitForm
            mode={mode}
            onDone={() => {
              onSaved?.()
              setOpen(false)
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ToolkitForm({ mode, onDone }: { mode: Mode; onDone: () => void }) {
  const create = useCreateToolkit()
  const update = useUpdateToolkit()
  const navigate = useNavigate()
  const slugEdited = useRef(mode.kind === "edit")
  const providers = useQuery(providersQuery)
  const profiles = useQueries({
    queries: (providers.data ?? []).map((provider) => profilesQuery(provider.id)),
  })

  const form = useForm({
    defaultValues:
      mode.kind === "create"
        ? ({ name: "", slug: "", profileIds: [] } satisfies ToolkitFormValues)
        : ({
            name: mode.toolkit.name,
            slug: mode.toolkit.slug,
            profileIds: mode.toolkit.members.map((member) => member.profileId),
          } satisfies ToolkitFormValues),
    validators: { onChange: toolkitFormSchema },
    onSubmit: async ({ value }) => {
      const name = value.name.trim()
      if (mode.kind === "create") {
        const { toolkit } = await create.mutateAsync({ name, slug: value.slug, profileIds: value.profileIds })
        create.reset()
        onDone()
        await navigate({ to: "/toolkit/$toolkitId", params: { toolkitId: toolkit.id } })
        return
      }
      await update.mutateAsync({ id: mode.toolkit.id, patch: { name, profileIds: value.profileIds } })
      onDone()
    },
  })
  const selected = useSelector(form.store, (state) => state.values.profileIds)

  // Prefix preview follows the current selection, using the daemon's rule.
  const members = (providers.data ?? []).flatMap((provider, index) =>
    (profiles[index]?.data ?? [])
      .filter((profile) => selected.includes(profile.id))
      .map((profile) => ({ profileId: profile.id, providerSlug: provider.slug, profileSlug: profile.slug })),
  )
  const prefixes = toolPrefixes(members)
  const error = create.error ?? update.error

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
              <Field id="toolkit-name" label="Name" error={error}>
                <Input
                  {...describedBy("toolkit-name", error)}
                  autoFocus
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Work"
                />
              </Field>
            )
          }}
        </form.Field>
        <form.Field name="slug">
          {(field) => {
            const error = visibleError(field.state.meta)
            return (
              <Field id="toolkit-slug" label="Slug" error={error}>
                <Input
                  {...describedBy("toolkit-slug", error)}
                  className="font-mono"
                  value={field.state.value}
                  disabled={mode.kind === "edit"}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    slugEdited.current = true
                    field.handleChange(event.target.value)
                  }}
                  placeholder="work"
                  spellCheck={false}
                />
              </Field>
            )
          }}
        </form.Field>
      </div>

      <form.Field name="profileIds">
        {(field) => (
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Profiles</legend>
            {providers.isPending ? (
              <p className="text-muted-foreground">Loading</p>
            ) : providers.isError ? (
              <ErrorText>{errorMessage(providers.error)}</ErrorText>
            ) : providers.data.length === 0 ? (
              <p className="text-muted-foreground">Add an MCP with a profile first.</p>
            ) : (
              <ul className="divide-y overflow-hidden rounded-lg border">
                {providers.data.map((provider, index) =>
                  (profiles[index]?.data ?? []).map((profile) => {
                    const id = `member-${profile.id}`
                    const checked = field.state.value.includes(profile.id)
                    return (
                      <li key={profile.id} className="flex h-9 items-center gap-3 px-3.5">
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={(next) => {
                            field.handleChange(
                              next === true
                                ? [...field.state.value, profile.id]
                                : field.state.value.filter((item) => item !== profile.id),
                            )
                          }}
                        />
                        <Label htmlFor={id} className="flex min-w-0 flex-1 items-center gap-2 font-normal">
                          <ProfileStatus status={profile.status} />
                          <span className="text-muted-foreground">{provider.name}</span>
                          <span aria-hidden className="text-muted-foreground">
                            /
                          </span>
                          <span className="truncate">{profile.name}</span>
                        </Label>
                        {checked ? (
                          <code className="font-mono text-[11px] text-muted-foreground">{prefixes.get(profile.id)}</code>
                        ) : null}
                      </li>
                    )
                  }),
                )}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Tools are exposed as prefix + tool name. A provider with several profiles here adds the profile slug.
            </p>
          </fieldset>
        )}
      </form.Field>

      {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}

      <DialogFooter>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {mode.kind === "create" ? (submitting ? "Creating" : "Create toolkit") : submitting ? "Saving" : "Save"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  )
}
