export const oneDriveProviderScopes = {
  userRead: "User.Read",
  filesRead: "Files.Read",
  filesReadWrite: "Files.ReadWrite",
  filesReadAll: "Files.Read.All",
  filesReadWriteAll: "Files.ReadWrite.All",
  offlineAccess: "offline_access",
} as const;

export const oneDriveReadScopes: string[] = [oneDriveProviderScopes.filesRead];
export const oneDriveWriteScopes: string[] = [oneDriveProviderScopes.filesReadWrite];
/**
 * The scopes a client may request for this provider.
 *
 * This list is the ALLOW-LIST `normalizeRequestedScopes` validates
 * `requestedScopes` against, and also the fallback given to a client that
 * requests none. So a scope missing here cannot be asked for at all: the
 * authorization start fails with `requestedScopes contains a scope not
 * declared by one_drive`, before the provider is ever contacted.
 *
 * `Files.Read` is listed alongside `Files.ReadWrite` so a read-only
 * integration can ask for read-only access. Several actions here are
 * read-only by construction — `get_drive`, `list_folder_children`,
 * `download_file`, `list_item_permissions` — and a client calling only those
 * has no reason to hold a token that can delete the user's files. Without
 * `Files.Read` declared, the narrowest grant such a client could obtain was
 * full read/write: a consent screen that overstates what the integration
 * does, and a token whose extra power nothing needs.
 *
 * Both are declared rather than one replaced. The write actions
 * (`upload_file`, `create_folder`, `update_file_content`, `delete_item`)
 * genuinely need `Files.ReadWrite`, so which to request belongs to the
 * client. A caller that requests nothing still receives the whole list, whose
 * effective access is unchanged — `Files.ReadWrite` already subsumes
 * `Files.Read`.
 */
export const oneDriveOAuthScopes: string[] = [
  oneDriveProviderScopes.userRead,
  oneDriveProviderScopes.filesRead,
  oneDriveProviderScopes.filesReadWrite,
  oneDriveProviderScopes.offlineAccess,
];
