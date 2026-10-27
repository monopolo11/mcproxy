// Mirrors the daemon's tool prefix rule so the toolkit form can preview names
// before saving. The daemon's view stays authoritative once a toolkit exists.

export type PrefixMember = { profileId: string; providerSlug: string; profileSlug: string }

const identifier = (slug: string) => slug.replace(/-/g, "_")

/**
 * Prefix per member: `provider_` when the provider has one profile in the
 * toolkit, `provider_profile_` when it has several.
 */
export function toolPrefixes(members: readonly PrefixMember[]): Map<string, string> {
  const perProvider = new Map<string, number>()
  for (const member of members) {
    perProvider.set(member.providerSlug, (perProvider.get(member.providerSlug) ?? 0) + 1)
  }
  return new Map(
    members.map((member) => [
      member.profileId,
      (perProvider.get(member.providerSlug) ?? 0) > 1
        ? `${identifier(member.providerSlug)}_${identifier(member.profileSlug)}_`
        : `${identifier(member.providerSlug)}_`,
    ]),
  )
}
