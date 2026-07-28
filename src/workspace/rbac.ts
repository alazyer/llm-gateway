/**
 * Role-Based Access Control for workspaces.
 * Maps roles to permissions and provides checking functions.
 */

import type { WorkspaceRole, TokenScope } from "./entity.js";
import type { WorkspaceStorage } from "./storage.js";

export type Permission =
  | "workspace:read"
  | "workspace:write"
  | "workspace:delete"
  | "workspace:admin"
  | "models:read"
  | "models:write"
  | "tokens:read"
  | "tokens:write"
  | "members:read"
  | "members:write"
  | "usage:read"
  | "requests:read"
  | "requests:write";

const ROLE_PERMISSIONS: Record<WorkspaceRole, Permission[]> = {
  owner: [
    "workspace:read",
    "workspace:write",
    "workspace:delete",
    "workspace:admin",
    "models:read",
    "models:write",
    "tokens:read",
    "tokens:write",
    "members:read",
    "members:write",
    "usage:read",
    "requests:read",
    "requests:write",
  ],
  admin: [
    "workspace:read",
    "workspace:write",
    "models:read",
    "models:write",
    "tokens:read",
    "tokens:write",
    "members:read",
    "members:write",
    "usage:read",
    "requests:read",
    "requests:write",
  ],
  member: [
    "workspace:read",
    "models:read",
    "tokens:read",
    "usage:read",
    "requests:read",
    "requests:write",
  ],
  viewer: [
    "workspace:read",
    "models:read",
    "usage:read",
    "requests:read",
  ],
};

/**
 * Check whether a role grants a specific permission.
 */
export function roleHasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Map a token scope to an effective workspace role.
 * Token scopes are narrower than roles; we use the highest role
 * the scope allows for permission checks.
 */
export function scopeToRole(scope: TokenScope): WorkspaceRole {
  switch (scope) {
    case "admin":
      return "admin";
    case "write":
      return "member";
    case "read":
      return "viewer";
  }
}

/**
 * Check if a token scope grants a specific permission.
 */
export function scopeHasPermission(scope: TokenScope, permission: Permission): boolean {
  return roleHasPermission(scopeToRole(scope), permission);
}

/**
 * Check if a user has a specific permission in a workspace,
 * looking up their role from storage.
 */
export function userHasPermission(
  storage: WorkspaceStorage,
  workspaceId: string,
  userId: string,
  permission: Permission,
): boolean {
  const role = storage.getMemberRole(workspaceId, userId);
  if (!role) {
    return false;
  }
  return roleHasPermission(role, permission);
}
