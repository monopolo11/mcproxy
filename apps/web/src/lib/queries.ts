import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type Profile, type ProfileInput, type ProfilePatch, type ProviderInput } from "./api"

// Query keys and cache-aware mutations. Server responses never contain upstream
// secrets, and one-time access tokens are returned to the caller, not cached.

export const healthQuery = queryOptions({
  queryKey: ["health"],
  queryFn: api.health,
  refetchInterval: 15_000,
  retry: false,
})

export const providersQuery = queryOptions({
  queryKey: ["providers"],
  queryFn: async () => (await api.listProviders()).providers,
})

export const profilesQuery = (providerId: string) =>
  queryOptions({
    queryKey: ["providers", providerId, "profiles"],
    queryFn: async () => (await api.listProfiles(providerId)).profiles,
  })

export function useCreateProvider() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: ProviderInput) => api.createProvider(input),
    onSuccess: () => client.invalidateQueries({ queryKey: providersQuery.queryKey }),
  })
}

export function useDeleteProvider() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (providerId: string) => api.deleteProvider(providerId),
    onSuccess: (_, providerId) => {
      client.removeQueries({ queryKey: profilesQuery(providerId).queryKey })
      return client.invalidateQueries({ queryKey: providersQuery.queryKey, exact: true })
    },
  })
}

export function useCreateProfile(providerId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: ProfileInput) => api.createProfile(providerId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: profilesQuery(providerId).queryKey }),
  })
}

/** Writes a fresh profile into its provider's cached list. */
function useReplaceProfile() {
  const client = useQueryClient()
  return (profile: Profile) => {
    client.setQueryData(profilesQuery(profile.providerId).queryKey, (list) =>
      list?.map((item) => (item.id === profile.id ? profile : item)),
    )
  }
}

export function useUpdateProfile() {
  const replace = useReplaceProfile()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ProfilePatch }) =>
      api.updateProfile(id, patch),
    onSuccess: ({ profile }) => replace(profile),
  })
}

export function useDeleteProfile() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (profile: Profile) => api.deleteProfile(profile.id),
    onSuccess: (_, profile) =>
      client.invalidateQueries({ queryKey: profilesQuery(profile.providerId).queryKey }),
  })
}

export function useRotateToken() {
  return useMutation({ mutationFn: (profileId: string) => api.rotateToken(profileId) })
}

export function useTestProfile() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (profile: Profile) => api.testProfile(profile.id),
    // A test can change status or lastError on the daemon side.
    onSettled: (_, __, profile) =>
      client.invalidateQueries({ queryKey: profilesQuery(profile.providerId).queryKey }),
  })
}

export function useStartOAuth() {
  return useMutation({ mutationFn: (profileId: string) => api.startOAuth(profileId) })
}
