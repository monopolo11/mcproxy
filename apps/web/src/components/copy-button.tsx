import { CheckIcon, CopyIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { errorMessage } from "@/lib/api"

/**
 * Copies `value` and briefly swaps the icon to confirm. A function value is
 * resolved first, so secrets can be fetched only when the user asks to copy.
 */
export function CopyButton({ value, label }: { value: string | (() => Promise<string>); label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    let text: string
    try {
      text = typeof value === "string" ? value : await value()
    } catch (error) {
      toast.error(errorMessage(error))
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      toast.error("Clipboard unavailable. Select the text and copy it manually.")
    }
  }

  return (
    <Button type="button" variant="ghost" size="icon-sm" onClick={copy} aria-label={label} title={label}>
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
    </Button>
  )
}
