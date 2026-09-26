interface Lease {
  modelId: string;
  expiresAt: number;
}

export class ModelLeaseStore {
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly ttlMs = 30 * 60 * 1_000) {}

  get(key: string): string | undefined {
    this.cleanup();
    return this.leases.get(key)?.modelId;
  }

  set(key: string, modelId: string): void {
    this.cleanup();
    this.leases.set(key, { modelId, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.leases.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(key);
    }
  }
}
