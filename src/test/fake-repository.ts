import type {
  AuthSession,
  GitHubConnectionInput,
  GitHubInstallationCandidate,
  NotificationTarget,
  RelayRepository,
  ResolvedIdentity,
  VerifiedAuthSession,
} from "../db/relay-repository.ts";

interface StoredAuthSession extends AuthSession {
  expiresAt: Date;
  consumed: boolean;
  githubUserId?: number;
  githubLogin?: string;
  installations?: GitHubInstallationCandidate[];
}

export class FakeRelayRepository implements RelayRepository {
  readonly identities = new Map<string, string>();
  readonly conversations = new Map<string, string>();
  readonly authSessions = new Map<string, StoredAuthSession>();
  readonly connections: GitHubConnectionInput[] = [];
  readonly pendingConfirmations = new Set<string>();
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

    const conversationKey = `${userId}:${input.platform}:${input.externalSpaceId}`;
    let conversationId = this.conversations.get(conversationKey);
    conversationId ??= crypto.randomUUID();
    this.conversations.set(conversationKey, conversationId);

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
