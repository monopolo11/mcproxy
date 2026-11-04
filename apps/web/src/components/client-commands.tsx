import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CLIENT_IDS, CLIENT_LABELS, SCOPES, SCOPE_LABELS, clientCommand, type Scope } from "@/lib/clients"
import { usePrefs } from "@/lib/prefs"
import { TOKEN_MASK, type AccessToken } from "./access-token"
import { ClientLogo } from "./client-logos"
import { CopyButton } from "./copy-button"
import { Section } from "./page"

/**
 * One tab per client with the command that registers an endpoint under
 * `name`, in the chosen scope. The displayed text follows the token's masked state; copy always
 * uses the real token.
 */
export function ClientCommands({
  name,
  endpoint,
  token,
}: {
  name: string
  endpoint: string
  token: AccessToken
}) {
  const prefs = usePrefs()
  const visible = CLIENT_IDS.filter((id) => !prefs.hiddenClients.includes(id))
  const first = visible[0]
  const [scope, setScope] = useState<Scope>("user")

  return (
    <Section title="Add to client">
      {first === undefined ? (
        <p className="text-muted-foreground">
          Every client is hidden.{" "}
          <Link to="/settings/clients" className="text-link underline-offset-4 hover:underline">
            Choose clients
          </Link>
        </p>
      ) : (
        <Tabs defaultValue={first}>
          <div className="flex items-center gap-2">
            <TabsList aria-label="Client">
              {visible.map((id) => (
                <TabsTrigger key={id} value={id}>
                  <ClientLogo id={id} />
                  {CLIENT_LABELS[id]}
                </TabsTrigger>
              ))}
            </TabsList>
            <Select
              value={scope}
              onValueChange={(value) => {
                const next = SCOPES.find((s) => s === value)
                if (next) setScope(next)
              }}
            >
              <SelectTrigger aria-label="Scope" size="sm" className="ml-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {SCOPE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {visible.map((id) => {
            const command = clientCommand(id, { name, endpoint, token: token.token ?? TOKEN_MASK, scope })
            return (
              <TabsContent key={id} value={id} className="grid gap-1.5">
                <div className="relative rounded-lg border bg-field">
                  <pre className="overflow-x-auto p-3 pr-11 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                    {command.text}
                  </pre>
                  <div className="absolute top-1.5 right-1.5">
                    <CopyButton
                      label={`Copy ${command.label} command`}
                      value={async () => clientCommand(id, { name, endpoint, token: await token.ensure(), scope }).text}
                    />
                  </div>
                </div>
                {command.hint ? <p className="text-xs text-muted-foreground">{command.hint}</p> : null}
              </TabsContent>
            )
          })}
        </Tabs>
      )}
    </Section>
  )
}
