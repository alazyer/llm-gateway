/**
 * Workspace module barrel export.
 */

export type {
  Workspace,
  WorkspaceStatus,
  WorkspaceModelConfig,
  WorkspaceToken,
  TokenScope,
  WorkspaceMember,
  WorkspaceRole,
  UsageRecord,
  UsageSummary,
  UsageByModel,
  DailyUsage,
} from "./entity.js";

export {
  InMemoryWorkspaceStorage,
  type WorkspaceStorage,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput,
  type ListWorkspacesOptions,
  type CreateTokenInput,
  type AddMemberInput,
} from "./storage.js";

export {
  registerWorkspaceContext,
  type RegisterWorkspaceContextOptions,
} from "./context.js";

export {
  registerWorkspaceAuth,
  extractWorkspaceToken,
  scopeSatisfies,
  type RegisterWorkspaceAuthOptions,
} from "./auth.js";

export {
  roleHasPermission,
  scopeToRole,
  scopeHasPermission,
  userHasPermission,
  type Permission,
} from "./rbac.js";

export {
  registerUsageTracking,
  recordRequestUsage,
  estimateCostUsd,
  type RegisterUsageTrackingOptions,
} from "./usage.js";
