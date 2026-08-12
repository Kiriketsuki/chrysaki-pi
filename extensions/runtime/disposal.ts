export type Disposable = (() => void | Promise<void>) | { dispose(): void | Promise<void> };

export class DisposalRegistry {
  private resources = new Set<Disposable>();
  private disposed = false;

  add<T extends Disposable>(resource: T): T {
    if (this.disposed) void this.disposeOne(resource);
    else this.resources.add(resource);
    return resource;
  }

  delete(resource: Disposable): void { this.resources.delete(resource); }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const resources = [...this.resources].reverse();
    this.resources.clear();
    await Promise.allSettled(resources.map((resource) => this.disposeOne(resource)));
  }

  private disposeOne(resource: Disposable): void | Promise<void> {
    return typeof resource === "function" ? resource() : resource.dispose();
  }

  get size(): number { return this.resources.size; }
  get isDisposed(): boolean { return this.disposed; }
}
