/** New Session on a Harness without the sidebar primary action: the argument-free `uiWorkspace.startSession` call that its entry points make. */

/**
 * Answer argument-free `startSession` calls on Work's navigation service with `run` while `applies` holds; every other call reaches the service unchanged.
 * Harness 0.2.1-rc.3's New Session button, brand, title-bar control and `session.new` shortcut all make that call through one shared service instance, so the
 * answer is defined on that instance itself: a property assigned through a Cordis service proxy lands on the caller's own shadow and other callers never see it.
 * @param service - the `uiWorkspace` service.
 * @param applies - read at each call; false hands the call to the service.
 * @param run - runs in place of the call.
 * @returns a disposer that restores the service's own `startSession` unless something else replaced it since.
 * @throws when the service has no `startSession` method.
 */
export function answerNewSession(service: object, applies: () => boolean, run: () => void): () => void {
  const previous = Object.getOwnPropertyDescriptor(service, 'startSession')
  const original: unknown = Reflect.get(service, 'startSession')
  if (typeof original !== 'function') throw new Error('uiWorkspace.startSession is not a function')
  const answer = function (this: unknown, ...args: unknown[]): unknown {
    if (args.every(arg => arg === undefined) && applies()) { run(); return undefined }
    return Reflect.apply(original, this, args)
  }
  Object.defineProperty(service, 'startSession', { configurable: true, writable: true, value: answer })
  return () => {
    if (Object.getOwnPropertyDescriptor(service, 'startSession')?.value !== answer) return
    if (previous) Object.defineProperty(service, 'startSession', previous)
    else Reflect.deleteProperty(service, 'startSession')
  }
}
