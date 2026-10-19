// Coroutine-based mission scripting.
// A script is a generator that yields: a number (wait seconds), a predicate (wait until true) or nothing (next frame).
export type Wait = number | (() => boolean) | void;
export type Script = Generator<Wait, void, void>;

interface Running {
  gen: Script;
  wait: number;
  until: (() => boolean) | null;
}

export class ScriptRunner {
  private running: Running[] = [];

  run(gen: Script): void {
    const r: Running = { gen, wait: 0, until: null };
    this.running.push(r);
    this.step(r);
  }

  clear(): void {
    this.running.length = 0;
  }

  private step(r: Running): boolean {
    const res = r.gen.next();
    if (res.done) return false;
    const v = res.value;
    if (typeof v === 'number') r.wait = v;
    else if (typeof v === 'function') r.until = v;
    return true;
  }

  update(dt: number): void {
    for (let i = 0; i < this.running.length; i++) {
      const r = this.running[i];
      if (r.wait > 0) {
        r.wait -= dt;
        if (r.wait > 0) continue;
      }
      if (r.until) {
        if (!r.until()) continue;
        r.until = null;
      }
      if (!this.step(r)) {
        this.running.splice(i, 1);
        i--;
      }
    }
  }
}
