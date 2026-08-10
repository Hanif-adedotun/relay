import type {
  AuthSession,
  ConversationMessage,
  ConversationMessageRole,
  ConversationState,
  GitHubConnectionInput,
  GitHubInstallationCandidate,
  MemoryChunkInput,
  MemoryChunkSearchResult,
  NotificationTarget,
  RelayRepository,
  ResolvedIdentity,
  VerifiedAuthSession,
  WorkingMemoryUpdate,
} from "../db/relay-repository.ts";

interface StoredAuthSession extends AuthSession {
  expiresAt: Date;
  consumed: boolean;
  githubUserId?: number;
  githubLogin?: string;
  installations?: GitHubInstallationCandidate[];
}

interface StoredConversation {
  userId: string;
  activeRepo: string | null;
  activeBranch: string | null;
  lastPrNumber: number | null;
  lastPrUrl: string | null;
  lastCommitSha: string | null;
}

interface StoredMemoryChunk {
  id: string;
  userId: string;
  conversationId: string;
  content: string;
  kind: string;
  sourceMessageIds: string[];
  repo: string | null;
  branch: string | null;
  embedding: number[];
  createdAt: Date;
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class FakeRelayRepository implements RelayRepository {
  readonly identities = new Map<string, string>();
  readonly spaceToConversation = new Map<string, string>();
  readonly conversations = new Map<string, StoredConversation>();
  readonly authSessions = new Map<string, StoredAuthSession>();
  readonly connections: GitHubConnectionInput[] = [];
  readonly pendingConfirmations = new Set<string>();
  readonly messages: ConversationMessage[] = [];
  readonly memoryChunks: StoredMemoryChunk[] = [];
  notificationTarget: NotificationTarget | null = null;

  async resolveIdentity(input: {
    platform: string;
    externalUserId: string;
    externalSpaceId: string;
  }): Promise<ResolvedIdentity> {
    const identityKey = `${input.platform}:${input.externalUserId}`;
    let userId = this.identities.get(identityKey);
    const isNewUser = !userId;
    userId ??= crypto.randomUUID();
    this.identities.set(identityKey, userId);

    const spaceKey = `${userId}:${input.platform}:${input.externalSpaceId}`;
    let conversationId = this.spaceToConversation.get(spaceKey);
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      this.spaceToConversation.set(spaceKey, conversationId);
      this.conversations.set(conversationId, {
        userId,
        activeRepo: null,
        activeBranch: null,
        lastPrNumber: null,
        lastPrUrl: null,
        lastCommitSha: null,
      });
    }

    return { userId, conversationId, isNewUser };
  }

  async hasGitHubConnection(userId: string): Promise<boolean> {
    return this.connections.some((connection) => connection.userId === userId);
  }

  async createAuthSession(input: {
    userId: string;
    conversationId: string;
    stateHash: string;
    expiresAt: Date;
  }): Promise<void> {
    this.authSessions.set(input.stateHash, {
      userId: input.userId,
      conversationId: input.conversationId,
      expiresAt: input.expiresAt,
      consumed: false,
    });
  }

  async getAuthSession(
    stateHash: string,
    now: Date,
  ): Promise<AuthSession | null> {
    const session = this.authSessions.get(stateHash);
    if (!session || session.consumed || session.expiresAt <= now) return null;

    return {
      userId: session.userId,
      conversationId: session.conversationId,
    };
  }

  async storeVerifiedGitHubUser(input: {
    stateHash: string;
    now: Date;
    githubUserId: number;
    githubLogin: string;
    installations: GitHubInstallationCandidate[];
  }): Promise<boolean> {
    const session = this.authSessions.get(input.stateHash);
    if (!session || session.consumed || session.expiresAt <= input.now) {
      return false;
    }

    session.githubUserId = input.githubUserId;
    session.githubLogin = input.githubLogin;
    session.installations = input.installations;
    return true;
  }

  async consumeAuthSession(input: {
    stateHash: string;
    installationId: number;
    now: Date;
  }): Promise<VerifiedAuthSession | null> {
    const session = this.authSessions.get(input.stateHash);
    const installation = session?.installations?.find(
      (candidate) => candidate.id === input.installationId,
    );
    if (
      !session ||
      !installation ||
      session.consumed ||
      session.expiresAt <= input.now ||
      session.githubUserId === undefined ||
      session.githubLogin === undefined
    ) {
      return null;
    }

    session.consumed = true;
    return {
      userId: session.userId,
      conversationId: session.conversationId,
      githubUserId: session.githubUserId,
      githubLogin: session.githubLogin,
      repositorySelection: installation.repositorySelection,
    };
  }

  async saveGitHubConnection(input: GitHubConnectionInput): Promise<void> {
    this.connections.push(input);
  }

  async getConversationState(input: {
    userId: string;
    conversationId: string;
  }): Promise<ConversationState> {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation || conversation.userId !== input.userId) {
      throw new Error("Conversation not found");
    }

    const connection = this.connections.find(
      (candidate) => candidate.userId === input.userId,
    );

    return {
      conversationId: input.conversationId,
      userId: input.userId,
      activeRepo: conversation.activeRepo,
      activeBranch: conversation.activeBranch,
      lastPrNumber: conversation.lastPrNumber,
      lastPrUrl: conversation.lastPrUrl,
      lastCommitSha: conversation.lastCommitSha,
      github: connection
        ? {
            installationId: connection.installationId,
            githubUserId: connection.githubUserId,
            githubLogin: connection.githubLogin,
            repositorySelection: connection.repositorySelection,
          }
        : null,
      pendingGithubConfirmation: this.pendingConfirmations.has(
        input.conversationId,
      ),
    };
  }

  async setActiveRepo(conversationId: string, activeRepo: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    conversation.activeRepo = activeRepo;
    conversation.activeBranch = null;
  }

  async setActiveBranch(
    conversationId: string,
    activeBranch: string,
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    conversation.activeBranch = activeBranch;
  }

  async updateWorkingMemory(
    conversationId: string,
    update: WorkingMemoryUpdate,
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if ("lastPrNumber" in update) {
      conversation.lastPrNumber = update.lastPrNumber ?? null;
    }
    if ("lastPrUrl" in update) {
      conversation.lastPrUrl = update.lastPrUrl ?? null;
    }
    if ("lastCommitSha" in update) {
      conversation.lastCommitSha = update.lastCommitSha ?? null;
    }
  }

  async appendMessage(input: {
    conversationId: string;
    userId: string;
    role: ConversationMessageRole;
    content: string;
    action?: string | null;
  }): Promise<ConversationMessage> {
    const message: ConversationMessage = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      userId: input.userId,
      role: input.role,
      content: input.content,
      action: input.action ?? null,
      createdAt: new Date(),
    };
    this.messages.push(message);
    return message;
  }

  async listRecentMessages(
    conversationId: string,
    limit = 20,
  ): Promise<ConversationMessage[]> {
    return this.messages
      .filter((message) => message.conversationId === conversationId)
      .slice(-Math.max(1, Math.min(limit, 100)));
  }

  async insertMemoryChunk(input: MemoryChunkInput): Promise<string> {
    const id = crypto.randomUUID();
    this.memoryChunks.push({
      id,
      userId: input.userId,
      conversationId: input.conversationId,
      content: input.content,
      kind: input.kind ?? "turn",
      sourceMessageIds: input.sourceMessageIds,
      repo: input.repo ?? null,
      branch: input.branch ?? null,
      embedding: input.embedding,
      createdAt: new Date(),
    });
    return id;
  }

  async searchMemoryChunks(
    userId: string,
    embedding: number[],
    limit = 5,
  ): Promise<MemoryChunkSearchResult[]> {
    return this.memoryChunks
      .filter((chunk) => chunk.userId === userId)
      .map((chunk) => ({
        id: chunk.id,
        conversationId: chunk.conversationId,
        content: chunk.content,
        kind: chunk.kind,
        sourceMessageIds: chunk.sourceMessageIds,
        repo: chunk.repo,
        branch: chunk.branch,
        createdAt: chunk.createdAt,
        distance: cosineDistance(chunk.embedding, embedding),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, Math.max(1, Math.min(limit, 20)));
  }

  async getNotificationTarget(): Promise<NotificationTarget | null> {
    return this.notificationTarget;
  }

  async markGitHubConfirmationPending(conversationId: string): Promise<void> {
    this.pendingConfirmations.add(conversationId);
  }

  async consumeGitHubConfirmation(conversationId: string): Promise<boolean> {
    return this.pendingConfirmations.delete(conversationId);
  }
}
