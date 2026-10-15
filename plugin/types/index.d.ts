export type ClaudeMultiAccountAccount = { name: string; dir: string; email: string }

export type ClaudeMultiAccountInfo = {
  current: ClaudeMultiAccountAccount
  others: ClaudeMultiAccountAccount[]
  folder: string
  transcript: string
}

export type ClaudeMultiAccountUsage = {
  usd?: number
  limits: { kind: string; percentUsed: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    'multi-account': {
      info: ClaudeMultiAccountInfo | null
      usage: ClaudeMultiAccountUsage
      next: string | null
      handoff: string | null
    }
  }
}
