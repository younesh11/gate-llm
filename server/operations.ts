import { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { HttpError, type Store } from './store.ts';
import { version } from './meta.ts';

export const logLevels = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = typeof logLevels[number];
export type LogDestination = { write(line: string): void };
export function parseLogLevel(value = 'info'): LogLevel {
  if (!(logLevels as readonly string[]).includes(value)) throw new Error('LOG_LEVEL must be silent, fatal, error, warn, info, debug or trace.');
  return value as LogLevel;
}

export function safeError(error: unknown) {
  let code = 'internal_error';
  if (error instanceof HttpError) code = error.code;
  else if (error instanceof ZodError) code = 'validation_error';
  else if (error && typeof error === 'object' && 'code' in error && ['ERR_SQLITE_ERROR', 'ERR_INVALID_STATE', 'ENOSPC', 'EACCES', 'EROFS', 'EMFILE', 'ENFILE'].includes(String(error.code))) code = String(error.code);
  return { type: 'Error', code, message: 'Error details omitted from operational logs.', stack: '' };
}

const route = (request: FastifyRequest) => request.routeOptions.url ?? 'unmatched';
export function loggingOptions(level: LogLevel = 'info', stream?: LogDestination) {
  return {
    logger: {
      level, ...(stream ? { stream } : {}),
      // Only allowlisted fields are serialized. Never emit raw URLs (including
      // query strings), headers, bodies, error messages or stack traces.
      serializers: {
        req: (request: FastifyRequest) => ({ method: request.method, route: route(request) }),
        res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
        err: safeError
      },
      redact: { paths: ['req.headers', 'req.body', 'res.headers', 'res.body', 'headers', 'body', 'authorization', 'cookie', 'password', 'api_key', 'token', 'secret'], remove: true }
    },
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'request_id' }),
    requestIdHeader: false as const,
    genReqId: () => randomUUID()
  };
}

export function registerOperations(app: FastifyInstance, db: Store) {
  let draining = false;
  app.addHook('preClose', async () => { draining = true; app.log.info({ event: 'gateway_draining' }); });
  app.addHook('onRequest', async (request, reply) => { reply.header('x-request-id', request.id); });
  app.addHook('onResponse', async (request, reply) => {
    const path = route(request);
    if (reply.statusCode < 400 && ['/health', '/ready'].includes(path)) return;
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info';
    request.log[level]({ event: 'http_request_completed', method: request.method, route: path, status: reply.statusCode, duration_ms: Math.round(reply.elapsedTime) });
  });
  app.get('/health', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', version };
  });
  app.get('/ready', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (draining) return reply.code(503).send({ status: 'draining', version });
    try {
      db.checkReady();
      return { status: 'ready', version, checks: { database: 'ok' } };
    } catch (error) {
      request.log.error({ event: 'readiness_failed', error: safeError(error) });
      return reply.code(503).send({ status: 'not_ready', version, checks: { database: 'error' } });
    }
  });
}
