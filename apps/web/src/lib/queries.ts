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
  type UpdateChannel,
  type UpdateStatus,
} from "./api"

// Query data excludes secrets. Sensitive mutations are discarded when their
// observer resets or unmounts; token reveal components own the visible copy.

export const healthQuery = queryOptions({
  queryKey: ["health"],
  queryFn: api.health,
  refetchInterval: 15_000,
  retry: false,
})

/** Polls quickly while an update runs, so the page notices the restart. */
export const updateQuery = queryOptions({
  queryKey: ["update"],
  queryFn: api.update,
  refetchInterval: (query) => (query.state.data?.applying ? 2_000 : 60_000),
  retry: false,
})

/** Channel changes, checks and applying all answer with the new status. */
export function useUpdateAction<T>(action: (input: T) => Promise<UpdateStatus>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: action,
    onSuccess: (status) => client.setQueryData(updateQuery.queryKey, status),
  })
}

export const useSetUpdateChannel = () => useUpdateAction<UpdateChannel>(api.setUpdateChannel)
export const useCheckUpdate = () => useUpdateAction<void>(api.checkUpdate)
export const useApplyUpdate = () => useUpdateAction<void>(api.applyUpdate)

export const providersQuery = queryOptions({
  queryKey: ["providers"],
  queryFn: async () => (await api.listProviders()).providers,
})

export const profilesQuery = (providerId: string) =>
  queryOptions({
    queryKey: ["providers", providerId, "profiles"],
    queryFn: async () => (await api.listProfiles(providerId)).profiles,
  })

/** The auth an HTTP provider asks for, probed once per dialog open. */
export const authDiscoveryQuery = (providerId: string) =>
  queryOptions({
    queryKey: ["providers", providerId, "auth"],
    queryFn: async () => (await api.discoverAuth(providerId)).authType,
    retry: false,
  })

export const toolkitsQuery = queryOptions({
  queryKey: ["toolkits"],
  queryFn: async () => (await api.listToolkits()).toolkits,
})

/**
 * The upstream's tools. Fetching opens an upstream connection, so results stay
 * fresh until a test replaces them or the profile's credentials change.
 */
export const toolsQuery = (profileId: string) =>
  queryOptions({
    queryKey: ["profiles", profileId, "tools"],
    queryFn: async () => (await api.listTools(profileId)).tools,
    staleTime: Infinity,
    retry: false,
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

export function useEnableRoot() {
  const client = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (providerId: string) => api.enableRoot(providerId),
    onSuccess: () => client.invalidateQueries({ queryKey: providersQuery.queryKey, exact: true }),
  })
}

export function useDisableRoot() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (providerId: string) => api.disableRoot(providerId),
    onSuccess: () => client.invalidateQueries({ queryKey: providersQuery.queryKey, exact: true }),
  })
}

export function useCreateProfile(providerId: string) {
  const client = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (input: ProfileInput) => api.createProfile(providerId, input),
    onSuccess: () => {
      // The provider's root prefixes change with its profile count.
      void client.invalidateQueries({ queryKey: providersQuery.queryKey, exact: true })
      return client.invalidateQueries({ queryKey: profilesQuery(providerId).queryKey })
    },
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
  const client = useQueryClient()
  const replace = useReplaceProfile()
  return useMutation({
    gcTime: 0,
    mutationFn: ({ id, patch }: { id: string; patch: ProfilePatch }) =>
      api.updateProfile(id, patch),
    onSuccess: ({ profile }) => {
      client.removeQueries({ queryKey: toolsQuery(profile.id).queryKey })
      replace(profile)
    },
  })
}

export function useDeleteProfile() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (profile: Profile) => api.deleteProfile(profile.id),
    onSuccess: (_, profile) => {
      void client.invalidateQueries({ queryKey: toolkitsQuery.queryKey })
      void client.invalidateQueries({ queryKey: providersQuery.queryKey, exact: true })
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
    // A passing test already listed the tools; reuse them instead of reconnecting.
    onSuccess: ({ ok, tools }, profile) => {
      if (ok && tools) client.setQueryData(toolsQuery(profile.id).queryKey, tools)
    },
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
