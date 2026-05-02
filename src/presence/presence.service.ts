import { Injectable } from '@nestjs/common';

@Injectable()
export class PresenceService {
  private readonly ttlMs = 60 * 1000;
  private readonly activeUsers = new Map<string, number>();

  markActive(userId: string) {
    if (!userId) {
      return;
    }

    this.activeUsers.set(userId, Date.now());
    this.prune();
  }

  getActiveUserIds() {
    this.prune();
    return new Set(this.activeUsers.keys());
  }

  private prune() {
    const cutoff = Date.now() - this.ttlMs;

    for (const [userId, lastSeenAt] of this.activeUsers.entries()) {
      if (lastSeenAt < cutoff) {
        this.activeUsers.delete(userId);
      }
    }
  }
}
