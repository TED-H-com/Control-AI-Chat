import type { Context } from 'hono';
import type { AppVariables, TenantContext } from '../lib/http/index.js';
import type { StreamEvent } from '../shared/api.js';

export type RouteEnv = { Variables: AppVariables };
export type JsonObject = Readonly<Record<string, unknown>>;

export interface RouteRequest {
  /** Absolute request URL. Optional for direct service tests and legacy adapters. */
  readonly url?: string;
  readonly tenant: TenantContext | null;
  readonly requestId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Headers;
  readonly body: unknown;
  readonly rawBody: Uint8Array | null;
}

export interface RouteResult {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RouteServices {
  execute(operation: string, request: RouteRequest): Promise<RouteResult>;
}

export type { RouteDefinition } from './definition.js';

export interface SseSink {
  emit(event: StreamEvent): Promise<void>;
  heartbeat(): Promise<void>;
}

export type RouteContext = Context<RouteEnv>;
