export type FakeInteractiveState = "starting" | "blocked" | "ready" | "running" | "interrupted";

export class FakeInteractiveCli {
  readonly inputs: string[] = [];
  state: FakeInteractiveState;

  constructor(private readonly screens: Readonly<Record<Exclude<FakeInteractiveState, "interrupted">, string>>, initial: FakeInteractiveState = "starting") {
    this.state = initial;
  }

  capture(): string { return this.state === "interrupted" ? "Interrupted\n" : this.screens[this.state]; }

  submit(input: string): void {
    this.inputs.push(input);
    if (this.state === "blocked" && input === "y") this.state = "ready";
    else if (this.state === "ready") this.state = "running";
  }

  showPrompt(): void { this.state = "blocked"; }
  becomeReady(): void { this.state = "ready"; }
  interrupt(): void { this.state = "interrupted"; }
}
