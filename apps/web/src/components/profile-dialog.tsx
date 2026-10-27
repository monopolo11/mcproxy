import { useForm, useSelector } from "@tanstack/react-form"
import { useNavigate } from "@tanstack/react-router"
import { PlusIcon, XIcon } from "lucide-react"
import { useMemo, useRef, useState, type ReactNode } from "react"
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
import { absoluteEndpoint, errorMessage, type Profile, type Provider } from "@/lib/api"
import {
  AUTH_LABELS,
  AUTH_TYPES_BY_TRANSPORT,
  emptyProfileForm,
  profileSchemaFor,
  slugify,
  toProfileInput,
  toProfilePatch,
  type ProfileFormValues,
} from "@/lib/forms"
import { useCreateProfile, useUpdateProfile } from "@/lib/queries"
import { describedBy, ErrorText, Field, visibleError } from "./field"
import { TokenReveal } from "./token-reveal"

type Mode = { kind: "create" } | { kind: "edit"; profile: Profile }

/**
 * Create or edit a profile. Creation ends on the one-time access token view;
 * editing keeps stored upstream credentials unless the user replaces them.
 */
export function ProfileDialog({
  provider,
  mode,
  trigger,
}: {
  provider: Provider
  mode: Mode
  trigger: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<{ token: string; endpoint: string }>()

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) setCreated(undefined)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        // The token view must be dismissed deliberately.
        onInteractOutside={(event) => created && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {created ? "Profile created" : mode.kind === "create" ? `New ${provider.name} profile` : `Edit ${mode.profile.name}`}
          </DialogTitle>
        </DialogHeader>
        {created ? (
          <>
            <TokenReveal token={created.token} endpoint={created.endpoint} />
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : open ? (
          <ProfileForm
            provider={provider}
            mode={mode}
            onCreated={setCreated}
            onSaved={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ProfileForm({
  provider,
  mode,
  onCreated,
  onSaved,
}: {
  provider: Provider
  mode: Mode
  onCreated: (result: { token: string; endpoint: string }) => void
  onSaved: () => void
}) {
  const navigate = useNavigate()
  const create = useCreateProfile(provider.id)
  const update = useUpdateProfile()
  const mutation = mode.kind === "create" ? create : update
  const slugEdited = useRef(mode.kind === "edit")
  const transport = provider.transport.type
  const schema = useMemo(() => profileSchemaFor(transport), [transport])
  const authTypes = AUTH_TYPES_BY_TRANSPORT[transport]

  const defaultValues: ProfileFormValues =
    mode.kind === "create"
      ? emptyProfileForm
      : {
          ...emptyProfileForm,
          name: mode.profile.name,
          slug: mode.profile.slug,
          authType: mode.profile.authType,
          replaceAuth: false,
        }

  const form = useProfileForm(defaultValues, schema, async (value) => {
    if (mode.kind === "edit") {
      await update.mutateAsync({ id: mode.profile.id, patch: toProfilePatch(value) })
      onSaved()
      return
    }
    const { profile, accessToken } = await create.mutateAsync(toProfileInput(value))
    onCreated({ token: accessToken, endpoint: absoluteEndpoint(profile.endpoint) })
    await navigate({
      to: "/providers/$providerId/profiles/$profileId",
      params: { providerId: provider.id, profileId: profile.id },
    })
  })

  const replaceAuth = useSelector(form.store, (state) => state.values.replaceAuth)
  const authType = useSelector(form.store, (state) => state.values.authType)

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
              <Field id="profile-name" label="Name" error={error}>
                <Input
                  {...describedBy("profile-name", error)}
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
              <Field id="profile-slug" label="Slug" error={error}>
                <Input
                  {...describedBy("profile-slug", error)}
                  className="font-mono"
                  value={field.state.value}
                  // The slug is part of the endpoint URL, which stays stable.
                  readOnly={mode.kind === "edit"}
                  aria-readonly={mode.kind === "edit"}
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

      <section aria-labelledby="upstream-heading" className="grid gap-4 border-t pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 id="upstream-heading" className="text-sm font-medium">Upstream credentials</h3>
          {mode.kind === "edit" ? (
            <form.Field name="replaceAuth">
              {(field) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-pressed={field.state.value}
                  onClick={() => field.handleChange(!field.state.value)}
                >
                  {field.state.value ? "Keep current" : "Replace"}
                </Button>
              )}
            </form.Field>
          ) : null}
        </div>

        {!replaceAuth ? (
          <p className="text-sm">
            {AUTH_LABELS[authType]}. Stored values stay hidden and unchanged.
          </p>
        ) : (
          <>
            <form.Field name="authType">
              {(field) => {
                const error = visibleError(field.state.meta)
                return (
                  <Field id="profile-auth-type" label="Type" error={error}>
                    <Select
                      value={field.state.value}
                      onValueChange={(value) => {
                        const next = authTypes.find((type) => type === value)
                        if (next) field.handleChange(next)
                      }}
                    >
                      <SelectTrigger {...describedBy("profile-auth-type", error)} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {authTypes.map((type) => (
                          <SelectItem key={type} value={type}>
                            {AUTH_LABELS[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )
              }}
            </form.Field>

            {authType === "bearer" ? (
              <form.Field name="bearerToken">
                {(field) => {
                  const error = visibleError(field.state.meta)
                  return (
                    <Field id="profile-bearer" label="Upstream bearer token" error={error}>
                      <Input
                        {...describedBy("profile-bearer", error)}
                        type="password"
                        autoComplete="off"
                        className="font-mono"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        spellCheck={false}
                      />
                    </Field>
                  )
                }}
              </form.Field>
            ) : null}

            {authType === "headers" || authType === "env" ? (
              <PairsEditor form={form} name={authType} />
            ) : null}

            {authType === "oauth" ? <OAuthFields form={form} /> : null}
          </>
        )}
      </section>

      {mutation.error ? <ErrorText>{errorMessage(mutation.error)}</ErrorText> : null}

      <DialogFooter>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {mode.kind === "create"
                ? submitting ? "Creating" : "Create profile"
                : submitting ? "Saving" : "Save"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  )
}

/** The profile form; its inferred type binds sub-editors to exact field names. */
function useProfileForm(
  defaultValues: ProfileFormValues,
  schema: ReturnType<typeof profileSchemaFor>,
  submit: (value: ProfileFormValues) => Promise<void>,
) {
  return useForm({
    defaultValues,
    validators: { onChange: schema },
    onSubmit: ({ value }) => submit(value),
  })
}
type ProfileForm = ReturnType<typeof useProfileForm>

/** Key/value rows for upstream headers or environment variables. */
function PairsEditor({ form, name }: { form: ProfileForm; name: "headers" | "env" }) {
  const [reveal, setReveal] = useState(false)
  const noun = name === "headers" ? "Header" : "Variable"

  return (
    <form.Field name={name} mode="array">
      {(field) => {
        const listError = visibleError(field.state.meta)
        return (
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {name === "headers" ? "Upstream headers" : "Upstream environment"}
              </span>
              <Button type="button" variant="ghost" size="xs" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>
                {reveal ? "Hide values" : "Show values"}
              </Button>
            </div>
            {field.state.value.map((_, index) => (
              <div key={index} className="grid grid-cols-[1fr_1.4fr_auto] items-start gap-2">
                <form.Field name={`${name}[${index}].key`}>
                  {(keyField) => {
                    const id = `${name}-${index}-key`
                    const error = visibleError(keyField.state.meta)
                    return (
                      <div className="grid gap-1">
                        <Input
                          {...describedBy(id, error)}
                          aria-label={`${noun} ${index + 1} name`}
                          className="font-mono text-xs"
                          value={keyField.state.value}
                          onBlur={keyField.handleBlur}
                          onChange={(event) => keyField.handleChange(event.target.value)}
                          placeholder={name === "headers" ? "X-Api-Key" : "API_KEY"}
                          spellCheck={false}
                        />
                        {error ? (
                          <p id={`${id}-error`} className="text-xs text-destructive">
                            {error}
                          </p>
                        ) : null}
                      </div>
                    )
                  }}
                </form.Field>
                <form.Field name={`${name}[${index}].value`}>
                  {(valueField) => (
                    <Input
                      aria-label={`${noun} ${index + 1} value`}
                      type={reveal ? "text" : "password"}
                      autoComplete="off"
                      className="font-mono text-xs"
                      value={valueField.state.value}
                      onBlur={valueField.handleBlur}
                      onChange={(event) => valueField.handleChange(event.target.value)}
                      placeholder="Value"
                      spellCheck={false}
                    />
                  )}
                </form.Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${noun.toLowerCase()} ${index + 1}`}
                  disabled={field.state.value.length === 1}
                  onClick={() => field.removeValue(index)}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            <div className="flex items-center justify-between gap-2">
              {listError ? <p className="text-xs text-destructive">{listError}</p> : <span />}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => field.pushValue({ key: "", value: "" })}
              >
                <PlusIcon /> Add {noun.toLowerCase()}
              </Button>
            </div>
          </div>
        )
      }}
    </form.Field>
  )
}

/** Optional pre-registered client details; blank uses discovery and dynamic registration. */
function OAuthFields({ form }: { form: ProfileForm }) {
  return (
    <div className="grid gap-4">
      <p className="text-sm">
        Leave blank to use dynamic client registration. Connect after saving.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <form.Field name="clientId">
          {(field) => (
            <Field id="oauth-client-id" label="Client ID">
              <Input
                id="oauth-client-id"
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
        <form.Field name="clientSecret">
          {(field) => (
            <Field id="oauth-client-secret" label="Client secret">
              <Input
                id="oauth-client-secret"
                type="password"
                autoComplete="off"
                className="font-mono"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Optional"
              />
            </Field>
          )}
        </form.Field>
      </div>
      <form.Field name="scopes">
        {(field) => (
          <Field id="oauth-scopes" label="Scopes">
            <Input
              id="oauth-scopes"
              className="font-mono"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              placeholder="Optional, space separated"
              spellCheck={false}
            />
          </Field>
        )}
      </form.Field>
    </div>
  )
}
