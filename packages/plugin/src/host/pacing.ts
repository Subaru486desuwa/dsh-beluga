/**
 * Pace a long batch so the Host keeps serving other requests.
 * @param budgetMs - longest uninterrupted run between yields.
 * @returns a function to await after each unit of work.
 */
export function pacing(budgetMs = 16): () => Promise<void> {
  let started = performance.now()
  return async () => {
    if (performance.now() - started < budgetMs) return
    await new Promise(resolve => setImmediate(resolve))
    started = performance.now()
  }
}
