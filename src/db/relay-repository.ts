import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResolvedIdentity {
  userId: string;
  conversationId: string;
  isNewUser: boolean;
}

export interface AuthSession {
  userId: string;
  conversationId: string;
}

export interface GitHubInstallationCandidate {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
}

export interface VerifiedAuthSession extends AuthSession {
  githubUserId: number;
  githubLogin: string;
  repositorySelection: "all" | "selected";
}

export interface GitHubConnectionInput {
  userId: string;
  installationId: number;
  githubUserId: number;
  githubLogin: string;
  repositorySelection: "all" | "selected";
}

export interface NotificationTarget {
  platform: string;
  externalUserId: string;
  externalSpaceId: string;
}

export interface GitHubConnection {
  installationId: number;
  githubUserId: number;
  githubLogin: string;
  repositorySelection: "all" | "selected";
}

export interface ConversationState {
  conversationId: string;
  userId: string;
  activeRepo: string | null;
  activeBranch: string | null;
  lastPrNumber: number | null;
  lastPrUrl: string | null;
  lastCommitSha: string | null;
  github: GitHubConnection | null;
  pendingGithubConfirmation: boolean;
}

export type ConversationMessageRole = "user" | "assistant" | "system";

export interface ConversationMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: ConversationMessageRole;
  content: string;
  action: string | null;
  createdAt: Date;
}

export interface WorkingMemoryUpdate {
  lastPrNumber?: number | null;
  lastPrUrl?: string | null;
  lastCommitSha?: string | null;
}

export interface MemoryChunkInput {
  userId: string;
  conversationId: string;
  content: string;
  kind?: "turn";
  sourceMessageIds: string[];
  repo?: string | null;
  branch?: string | null;
  embedding: number[];
}

export interface MemoryChunkSearchResult {
  id: string;
  conversationId: string;
  content: string;
  kind: string;
  sourceMessageIds: string[];
  repo: string | null;
  branch: string | null;
  createdAt: Date;
  distance: number;
}

interface ResolveIdentityRow {
  user_id: string;
  conversation_id: string;
  is_new_user: boolean;
}

interface ConversationStateRow {
  id: string;
  user_id: string;
  active_repo: string | null;
  active_branch: string | null;
  last_pr_number: number | null;
  last_pr_url: string | null;
  last_commit_sha: string | null;
  github_confirmation_pending: boolean;
}

interface GitHubConnectionRow {
  installation_id: number;
  github_user_id: number;
  github_login: string;
  repository_selection: "all" | "selected";
}

interface AuthSessionRow {
  user_id: string;
  conversation_id: string;
}

interface VerifiedAuthSessionRow extends AuthSessionRow {
  github_user_id: number;
  github_login: string;
  repository_selection: "all" | "selected";
}

function repositoryError(context: string, cause: unknown): Error {
  const detail =
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
      ? `: ${cause.message}`
      : "";

  return new Error(`${context}${detail}`, { cause });
}

export interface RelayRepository {
  resolveIdentity(input: {
    platform: string;
    externalUserId: string;
    externalSpaceId: string;
  }): Promise<ResolvedIdentity>;
  hasGitHubConnection(userId: string): Promise<boolean>;
  createAuthSession(input: {
    userId: string;
    conversationId: string;
    stateHash: string;
    expiresAt: Date;
  }): Promise<void>;
  getAuthSession(stateHash: string, now: Date): Promise<AuthSession | null>;
  storeVerifiedGitHubUser(input: {
    stateHash: string;
    now: Date;
    githubUserId: number;
    githubLogin: string;
    installations: GitHubInstallationCandidate[];
  }): Promise<boolean>;
  consumeAuthSession(input: {
    stateHash: string;
    installationId: number;
    now: Date;
  }): Promise<VerifiedAuthSession | null>;
  saveGitHubConnection(input: GitHubConnectionInput): Promise<void>;
  getConversationState(input: {
    userId: string;
    conversationId: string;
  }): Promise<ConversationState>;
  setActiveRepo(conversationId: string, activeRepo: string): Promise<void>;
  setActiveBranch(conversationId: string, activeBranch: string): Promise<void>;
  updateWorkingMemory(
    conversationId: string,
    update: WorkingMemoryUpdate,
  ): Promise<void>;
  appendMessage(input: {
    conversationId: string;
    userId: string;
    role: ConversationMessageRole;
    content: string;
    action?: string | null;
  }): Promise<ConversationMessage>;
  listRecentMessages(
    conversationId: string,
    limit?: number,
  ): Promise<ConversationMessage[]>;
  insertMemoryChunk(input: MemoryChunkInput): Promise<string>;
  searchMemoryChunks(
    userId: string,
    embedding: number[],
    limit?: number,
  ): Promise<MemoryChunkSearchResult[]>;
  getNotificationTarget(conversationId: string): Promise<NotificationTarget | null>;
  markGitHubConfirmationPending(conversationId: string): Promise<void>;
  consumeGitHubConfirmation(conversationId: string): Promise<boolean>;
}

export class SupabaseRelayRepository implements RelayRepository {
  constructor(private readonly client: SupabaseClient) {}

  async resolveIdentity(input: {
    platform: string;
    externalUserId: string;
    externalSpaceId: string;
  }): Promise<ResolvedIdentity> {
    const { data, error } = await this.client.rpc("resolve_relay_identity", {
      p_platform: input.platform,
      p_external_user_id: input.externalUserId,
      p_external_space_id: input.externalSpaceId,
    });

    if (error) throw repositoryError("Failed to resolve Relay identity", error);

    const row = (data as ResolveIdentityRow[] | null)?.[0];
    if (!row) throw new Error("Identity resolution returned no record");

    return {
      userId: row.user_id,
      conversationId: row.conversation_id,
      isNewUser: row.is_new_user,
    };
  }

  async hasGitHubConnection(userId: string): Promise<boolean> {
    const { count, error } = await this.client
      .from("github_connections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

    if (error) throw new Error("Failed to read GitHub connection", { cause: error });
    return (count ?? 0) > 0;
  }

  async createAuthSession(input: {
    userId: string;
    conversationId: string;
    stateHash: string;
    expiresAt: Date;
  }): Promise<void> {
    const { error } = await this.client.from("integration_auth_sessions").insert({
      user_id: input.userId,
      conversation_id: input.conversationId,
      provider: "github",
      state_hash: input.stateHash,
      expires_at: input.expiresAt.toISOString(),
    });

    if (error) throw new Error("Failed to create GitHub auth session", { cause: error });
  }

  async getAuthSession(
    stateHash: string,
    now: Date,
  ): Promise<AuthSession | null> {
    const { data, error } = await this.client
      .from("integration_auth_sessions")
      .select("user_id, conversation_id")
      .eq("provider", "github")
      .eq("state_hash", stateHash)
      .is("consumed_at", null)
      .gt("expires_at", now.toISOString())
      .maybeSingle();

    if (error) throw repositoryError("Failed to read GitHub auth session", error);
    if (!data) return null;

    const row = data as AuthSessionRow;
    return {
      userId: row.user_id,
      conversationId: row.conversation_id,
    };
  }

  async storeVerifiedGitHubUser(input: {
    stateHash: string;
    now: Date;
    githubUserId: number;
    githubLogin: string;
    installations: GitHubInstallationCandidate[];
  }): Promise<boolean> {
    const { data, error } = await this.client
      .from("integration_auth_sessions")
      .update({
        github_user_id: input.githubUserId,
        github_login: input.githubLogin,
        eligible_installations: input.installations,
      })
      .eq("provider", "github")
      .eq("state_hash", input.stateHash)
      .is("consumed_at", null)
      .gt("expires_at", input.now.toISOString())
      .select("id")
      .maybeSingle();

    if (error) {
      throw repositoryError("Failed to store verified GitHub user", error);
    }
    return data !== null;
  }

  async consumeAuthSession(input: {
    stateHash: string;
    installationId: number;
    now: Date;
  }): Promise<VerifiedAuthSession | null> {
    const { data, error } = await this.client.rpc(
      "consume_github_auth_session",
      {
        p_state_hash: input.stateHash,
        p_installation_id: input.installationId,
        p_now: input.now.toISOString(),
      },
    );

    if (error) {
      throw repositoryError("Failed to consume GitHub auth session", error);
    }

    const row = (data as VerifiedAuthSessionRow[] | null)?.[0];
    if (!row) return null;

    return {
      userId: row.user_id,
      conversationId: row.conversation_id,
      githubUserId: row.github_user_id,
      githubLogin: row.github_login,
      repositorySelection: row.repository_selection,
    };
  }

  async saveGitHubConnection(input: GitHubConnectionInput): Promise<void> {
    const { error } = await this.client.from("github_connections").upsert(
      {
        user_id: input.userId,
        installation_id: input.installationId,
        github_user_id: input.githubUserId,
        github_login: input.githubLogin,
        repository_selection: input.repositorySelection,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,installation_id" },
    );

    if (error) throw new Error("Failed to save GitHub connection", { cause: error });
  }

  async getConversationState(input: {
    userId: string;
    conversationId: string;
  }): Promise<ConversationState> {
    const { data: conversation, error: conversationError } = await this.client
      .from("conversations")
      .select(
        "id, user_id, active_repo, active_branch, last_pr_number, last_pr_url, last_commit_sha, github_confirmation_pending",
      )
      .eq("id", input.conversationId)
      .eq("user_id", input.userId)
      .maybeSingle();

    if (conversationError) {
      throw repositoryError("Failed to load conversation state", conversationError);
    }
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const row = conversation as ConversationStateRow;
    const { data: connection, error: connectionError } = await this.client
      .from("github_connections")
      .select(
        "installation_id, github_user_id, github_login, repository_selection",
      )
      .eq("user_id", input.userId)
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (connectionError) {
      throw repositoryError("Failed to load GitHub connection", connectionError);
    }

    const github = connection
      ? {
          installationId: (connection as GitHubConnectionRow).installation_id,
          githubUserId: (connection as GitHubConnectionRow).github_user_id,
          githubLogin: (connection as GitHubConnectionRow).github_login,
          repositorySelection: (connection as GitHubConnectionRow)
            .repository_selection,
        }
      : null;

    return {
      conversationId: row.id,
      userId: row.user_id,
      activeRepo: row.active_repo,
      activeBranch: row.active_branch,
      lastPrNumber: row.last_pr_number,
      lastPrUrl: row.last_pr_url,
      lastCommitSha: row.last_commit_sha,
      github,
      pendingGithubConfirmation: row.github_confirmation_pending,
    };
  }

  async setActiveRepo(conversationId: string, activeRepo: string): Promise<void> {
    const { error } = await this.client
      .from("conversations")
      .update({
        active_repo: activeRepo,
        active_branch: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);

    if (error) throw repositoryError("Failed to set active repository", error);
  }

  async setActiveBranch(
    conversationId: string,
    activeBranch: string,
  ): Promise<void> {
    const { error } = await this.client
      .from("conversations")
      .update({
        active_branch: activeBranch,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);

    if (error) throw repositoryError("Failed to set active branch", error);
  }

  async updateWorkingMemory(
    conversationId: string,
    update: WorkingMemoryUpdate,
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if ("lastPrNumber" in update) patch.last_pr_number = update.lastPrNumber;
    if ("lastPrUrl" in update) patch.last_pr_url = update.lastPrUrl;
    if ("lastCommitSha" in update) patch.last_commit_sha = update.lastCommitSha;

    const { error } = await this.client
      .from("conversations")
      .update(patch)
      .eq("id", conversationId);

    if (error) throw repositoryError("Failed to update working memory", error);
  }

  async appendMessage(input: {
    conversationId: string;
    userId: string;
    role: ConversationMessageRole;
    content: string;
    action?: string | null;
  }): Promise<ConversationMessage> {
    const { data, error } = await this.client
      .from("conversation_messages")
      .insert({
        conversation_id: input.conversationId,
        user_id: input.userId,
        role: input.role,
        content: input.content,
        action: input.action ?? null,
      })
      .select("id, conversation_id, user_id, role, content, action, created_at")
      .single();

    if (error || !data) {
      throw repositoryError("Failed to append conversation message", error);
    }

    return {
      id: data.id,
      conversationId: data.conversation_id,
      userId: data.user_id,
      role: data.role,
      content: data.content,
      action: data.action,
      createdAt: new Date(data.created_at),
    };
  }

  async listRecentMessages(
    conversationId: string,
    limit = 20,
  ): Promise<ConversationMessage[]> {
    const { data, error } = await this.client
      .from("conversation_messages")
      .select("id, conversation_id, user_id, role, content, action, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 100)));

    if (error) {
      throw repositoryError("Failed to list recent messages", error);
    }

    return (data ?? [])
      .map((row) => ({
        id: row.id as string,
        conversationId: row.conversation_id as string,
        userId: row.user_id as string,
        role: row.role as ConversationMessageRole,
        content: row.content as string,
        action: (row.action as string | null) ?? null,
        createdAt: new Date(row.created_at as string),
      }))
      .reverse();
  }

  async insertMemoryChunk(input: MemoryChunkInput): Promise<string> {
    const { data, error } = await this.client
      .from("memory_chunks")
      .insert({
        user_id: input.userId,
        conversation_id: input.conversationId,
        content: input.content,
        kind: input.kind ?? "turn",
        source_message_ids: input.sourceMessageIds,
        repo: input.repo ?? null,
        branch: input.branch ?? null,
        embedding: `[${input.embedding.join(",")}]`,
      })
      .select("id")
      .single();

    if (error || !data) {
      throw repositoryError("Failed to insert memory chunk", error);
    }
    return data.id as string;
  }

  async searchMemoryChunks(
    userId: string,
    embedding: number[],
    limit = 5,
  ): Promise<MemoryChunkSearchResult[]> {
    const { data, error } = await this.client.rpc("search_memory_chunks", {
      p_user_id: userId,
      p_embedding: `[${embedding.join(",")}]`,
      p_limit: limit,
    });

    if (error) {
      throw repositoryError("Failed to search memory chunks", error);
    }

    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      conversationId: row.conversation_id as string,
      content: row.content as string,
      kind: row.kind as string,
      sourceMessageIds: (row.source_message_ids as string[] | null) ?? [],
      repo: (row.repo as string | null) ?? null,
      branch: (row.branch as string | null) ?? null,
      createdAt: new Date(row.created_at as string),
      distance: Number(row.distance),
    }));
  }

  async getNotificationTarget(
    conversationId: string,
  ): Promise<NotificationTarget | null> {
    const { data: conversation, error: conversationError } = await this.client
      .from("conversations")
      .select("user_id, platform, external_space_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (conversationError) {
      throw new Error("Failed to read notification conversation", {
        cause: conversationError,
      });
    }
    if (!conversation) return null;

    const { data: identity, error: identityError } = await this.client
      .from("user_identities")
      .select("external_user_id")
      .eq("user_id", conversation.user_id)
      .eq("platform", conversation.platform)
      .maybeSingle();

    if (identityError) {
      throw new Error("Failed to read notification identity", {
        cause: identityError,
      });
    }
    if (!identity) return null;

    return {
      platform: conversation.platform,
      externalUserId: identity.external_user_id,
      externalSpaceId: conversation.external_space_id,
    };
  }

  async markGitHubConfirmationPending(conversationId: string): Promise<void> {
    const { error } = await this.client
      .from("conversations")
      .update({
        github_confirmation_pending: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);

    if (error) throw new Error("Failed to queue GitHub confirmation", { cause: error });
  }

  async consumeGitHubConfirmation(conversationId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from("conversations")
      .update({
        github_confirmation_pending: false,
        updated_at: now,
      })
      .eq("id", conversationId)
      .eq("github_confirmation_pending", true)
      .select("id")
      .maybeSingle();

    if (error) throw new Error("Failed to consume GitHub confirmation", { cause: error });
    return data !== null;
  }
}
