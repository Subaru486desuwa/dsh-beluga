/** Model choices never contain credentials or private provider configuration. */
export interface ModelRef { readonly provider: string; readonly model: string; readonly inline?: true; readonly effort?: string }
/** One reasoning effort a route offers, from least to most. */
export interface EffortChoice { readonly id: string; readonly name: string; readonly description?: string }
/** A selectable route. `effort` is the one last sent with it; `lastUsed` marks the route of the last sent message. */
export interface ModelChoice extends ModelRef {
  readonly name: string
  readonly images: boolean
  readonly imageNote?: string
  readonly efforts?: readonly EffortChoice[]
  readonly defaultEffort?: string
  readonly lastUsed?: true
}
export interface InlineProvider { readonly baseURL: string; readonly credentialRef: string; readonly models: string[] }
/** The same route, ignoring the effort sent with it. */
export function sameRoute(left: ModelRef, right: ModelRef): boolean { return left.provider === right.provider && left.model === right.model && !!left.inline === !!right.inline }
export function routeKey(model: ModelRef): string { return JSON.stringify([model.provider, model.model, !!model.inline]) }
