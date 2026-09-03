export interface Env {
  APP_VERSION: string
  ENVIRONMENT: string

  ASSETS: Fetcher
  DB: D1Database
  CONFIG_KV: KVNamespace
  OBJECTS: R2Bucket
  EVENTS_QUEUE: Queue<PlatformEvent>
  USER_STATE: DurableObjectNamespace
  POOL_STATE: DurableObjectNamespace
}

export interface PlatformEvent<TPayload = unknown> {
  schema_version: 1
  event_id: string
  event_type: string
  occurred_at_ms: number
  aggregate_type: string
  aggregate_id: string
  payload: TPayload
}
