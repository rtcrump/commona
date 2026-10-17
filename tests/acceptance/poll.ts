export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when `ready` becomes true before the budget. The last check runs at the deadline. */
export async function poll(budgetMs: number, ready: () => boolean): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (ready()) return true;
    if (Date.now() >= deadline) return ready();
    await delay(50);
  }
}

export async function pollAsync(budgetMs: number, ready: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await ready()) return true;
    if (Date.now() >= deadline) return ready();
    await delay(100);
  }
}
