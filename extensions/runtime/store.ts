export type Selector<T, S> = (state: T) => S;
export type StoreListener<S> = (value: S, previous: S) => void;

interface Subscription<T, S> {
  selector: Selector<T, S>;
  listener: StoreListener<S>;
  value: S;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) Object.freeze(value);
  return value;
}

export class StateStore<T extends object> {
  private state: T;
  private subscriptions = new Set<Subscription<T, unknown>>();

  constructor(initial: T) {
    this.state = freeze(initial);
  }

  get(): Readonly<T> {
    return this.state;
  }

  update(updater: Partial<T> | ((current: Readonly<T>) => Partial<T>)): Readonly<T> {
    const patch = typeof updater === "function" ? updater(this.state) : updater;
    const next = freeze({ ...this.state, ...patch });
    if (Object.keys(patch).every((key) => Object.is(this.state[key as keyof T], next[key as keyof T]))) return this.state;
    const previous = this.state;
    this.state = next;
    for (const subscription of this.subscriptions) {
      const value = subscription.selector(next);
      if (!Object.is(value, subscription.value)) {
        const oldValue = subscription.value;
        subscription.value = value;
        subscription.listener(value, oldValue);
      }
    }
    return previous === next ? previous : next;
  }

  subscribe<S>(selector: Selector<T, S>, listener: StoreListener<S>): () => void {
    const subscription: Subscription<T, S> = { selector, listener, value: selector(this.state) };
    this.subscriptions.add(subscription as Subscription<T, unknown>);
    return () => this.subscriptions.delete(subscription as Subscription<T, unknown>);
  }

  clear(): void {
    this.subscriptions.clear();
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }
}
