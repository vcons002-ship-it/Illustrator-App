/** A session owns its tool renders, not the independent image playground. */
export type RenderRequestOwner = "chat" | "playground";

/** Keep cancellation scoped even when a scheduled task switches the visible chat. */
export class RenderRequestTracker {
  private readonly requests = new Map<RenderRequestOwner, number>();

  start(owner: RenderRequestOwner, requestId: number): void {
    this.requests.set(owner, requestId);
  }

  current(owner: RenderRequestOwner): number | undefined {
    return this.requests.get(owner);
  }

  finish(owner: RenderRequestOwner, requestId: number): void {
    // A late reply from an older render must not detach its replacement's Stop button.
    if (this.requests.get(owner) === requestId) this.requests.delete(owner);
  }

  clear(): void {
    this.requests.clear();
  }
}
