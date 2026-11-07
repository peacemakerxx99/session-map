export type EventKind =
  | 'opened'
  | 'branched'
  | 'step'
  | 'decision'
  | 'achievement'
  | 'closed'

export type Source = 'claude' | 'auto' | 'person'

export type Issue = {
  id: string
  title: string
  status: 'active' | 'closed'
  parentId?: string
  openedAt: number
  closedAt?: number
}

export type TimelineEvent = {
  id: string
  at: number
  issueId: string
  kind: EventKind
  text: string
  source: Source
}

export type OpenItem = {
  id: string
  kind: 'decision' | 'todo'
  text: string
  options?: string[]
  issueId?: string
  status: 'open' | 'answered' | 'done' | 'dropped'
  answer?: string
  at: number
  resolvedAt?: number
  source: Source
  /** When the item was first raised, in an earlier session it was carried from. */
  carriedFrom?: number
}

export type SessionMap = {
  issues: Issue[]
  events: TimelineEvent[]
  items: OpenItem[]
  seq: number
}

/** Open items an earlier session in this folder left, offered at start. */
export type CarryOffer = { fromSid: string; items: OpenItem[] }

export type PaneFlags = { timeline: boolean; items: boolean; combined?: boolean; completed?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-map': {
      map: Shaped<SessionMap>
      panes: PaneFlags
      carry: CarryOffer | null
    }
  }
}
