/** Model choices never contain credentials or private provider configuration. */
export interface ModelRef { readonly provider: string; readonly model: string; readonly inline?: true }
export interface ModelChoice extends ModelRef { readonly name: string; readonly images: boolean; readonly imageNote?: string }
export interface InlineProvider { readonly baseURL: string; readonly credentialRef: string; readonly models: string[] }
