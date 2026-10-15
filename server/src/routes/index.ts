import { Hono } from 'hono';
import { routeDefinitions } from './catalog.js';
import { createChatRoutes, type ChatPipelineServices } from './chat.js';
import { mountDefinitions } from './http.js';
import type { ConfirmRunDependencies } from '../app/chat/confirm-run.js';
import type { RouteEnv, RouteServices } from './types.js';

export interface ApiRouteServices extends RouteServices { readonly chat:ChatPipelineServices; readonly confirmations?:ConfirmRunDependencies; }

/** Creates the complete v1 route tree. Mount this app at `/api/v1`. */
export function createV1Routes(services:ApiRouteServices):Hono<RouteEnv> {
  const app=new Hono<RouteEnv>();
  mountDefinitions(app,services,routeDefinitions);
  app.route('/',createChatRoutes(services.chat,services.confirmations));
  return app;
}

export * from './chat.js';
export * from './types.js';
