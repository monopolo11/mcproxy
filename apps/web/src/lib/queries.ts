import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  api,
  type Profile,
  type ProfileInput,
  type ProfilePatch,
  type ProviderInput,
  type TokenOwner,
  type Toolkit,
  type ToolkitInput,
  type ToolkitPatch,
} from "./api"

// Query data excludes secrets. Sensitive mutations are discarded when their
// observer resets or unmounts; token reveal components own the visible copy.

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

export const toolkitsQuery = queryOptions({
  queryKey: ["toolkits"],
  queryFn: async () => (await api.listToolkits()).toolkits,
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
      // Toolkits lose the deleted profiles as members.
      void client.invalidateQueries({ queryKey: toolkitsQuery.queryKey })
      return client.invalidateQueries({ queryKey: providersQuery.queryKey, exact: true })
    },
  })
}

export function useCreateProfile(providerId: string) {
  const client = useQueryClient()
  return useMutation({
    gcTime: 0,
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
    gcTime: 0,
    mutationFn: ({ id, patch }: { id: string; patch: ProfilePatch }) =>
      api.updateProfile(id, patch),
    onSuccess: ({ profile }) => replace(profile),
  })
}

export function useDeleteProfile() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (profile: Profile) => api.deleteProfile(profile.id),
    onSuccess: (_, profile) => {
      void client.invalidateQueries({ queryKey: toolkitsQuery.queryKey })
      return client.invalidateQueries({ queryKey: profilesQuery(profile.providerId).queryKey })
    },
  })
}

export function useRotateToken() {
  return useMutation({ gcTime: 0, mutationFn: (owner: TokenOwner) => api.rotateToken(owner) })
}

/** Fetches the current token on demand; the caller keeps it in component state. */
export function useRevealToken() {
  return useMutation({ gcTime: 0, mutationFn: (owner: TokenOwner) => api.revealToken(owner) })
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
  return useMutation({ gcTime: 0, mutationFn: (profileId: string) => api.startOAuth(profileId) })
}

export function useCreateToolkit() {
  const client = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (input: ToolkitInput) => api.createToolkit(input),
    onSuccess: () => client.invalidateQueries({ queryKey: toolkitsQuery.queryKey }),
  })
}

export function useUpdateToolkit() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ToolkitPatch }) => api.updateToolkit(id, patch),
    onSuccess: ({ toolkit }) =>
      client.setQueryData(toolkitsQuery.queryKey, (list) =>
        list?.map((item) => (item.id === toolkit.id ? toolkit : item)),
      ),
  })
}

export function useDeleteToolkit() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (toolkit: Toolkit) => api.deleteToolkit(toolkit.id),
    onSuccess: () => client.invalidateQueries({ queryKey: toolkitsQuery.queryKey }),
  })
}

export function useTestToolkit() {
  return useMutation({ mutationFn: (toolkit: Toolkit) => api.testToolkit(toolkit.id) })
}
