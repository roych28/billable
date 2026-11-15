export type ClaudeMultiAccountAccount = { name: string; dir: string; email: string }

export type ClaudeMultiAccountInfo = {
  current: ClaudeMultiAccountAccount
  others: ClaudeMultiAccountAccount[]
  /** The folder the session started in: the launcher picks the account from it. */
  cwd: string
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
      run: { startedAt: number; startUsd: number } | null
      consumed: string | null
      hinted: string | null
    }
  }
}
