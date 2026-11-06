import "reflect-metadata";
import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AccessGuard, CONFIG, GRANTS, IDENTITY, KK_SESSIONS, KkSessionRegistry, READINESS, SESSIONS } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { requestContext, securityHeaders, stdoutSink, type LogSink } from "./http.js";
import type { IdentityResolver } from "./identity.js";
import { AuthController, GrantsController, HealthController, type GrantService, type ReadinessProbe } from "./routes.js";
import { SessionService } from "./session.js";

export interface AppDeps {
  config: ApiConfig;
  identity: IdentityResolver;
  /** The M1.7 engine (or null until it is wired: grant routes then answer 503). */
  grants?: GrantService | null;
  readiness?: ReadinessProbe;
  log?: LogSink;
  now?: () => number;
  /** Shared with the PolicyEngine as its `verifyKkSession` hook. */
  kkSessions?: KkSessionRegistry;
}

@Module({})
class ApiModule {
  static register(deps: Required<Omit<AppDeps, "now" | "log">> & { sessions: SessionService }): DynamicModule {
    return {
      module: ApiModule,
      controllers: [HealthController, AuthController, GrantsController],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: IDENTITY, useValue: deps.identity },
        { provide: SESSIONS, useValue: deps.sessions },
        { provide: GRANTS, useValue: deps.grants },
        { provide: READINESS, useValue: deps.readiness },
        { provide: KK_SESSIONS, useValue: deps.kkSessions },
        { provide: APP_GUARD, useClass: AccessGuard },
      ],
    };
  }
}

export async function createApp(deps: AppDeps): Promise<NestExpressApplication> {
  const log = deps.log ?? stdoutSink;
  const sessions = new SessionService(deps.config.sessionKey, deps.config.secureCookies, deps.now);
  const app = await NestFactory.create<NestExpressApplication>(
    ApiModule.register({
      config: deps.config,
      identity: deps.identity,
      grants: deps.grants ?? null,
      readiness: deps.readiness ?? (async () => {}),
      kkSessions: deps.kkSessions ?? new KkSessionRegistry(),
      sessions,
    }),
    { logger: false, bodyParser: false },
  );
  app.disable("x-powered-by");
  // Proxies are not trusted: identity comes from the TCP peer only (ADR-0005: no Serve, no proxy).
  app.set("trust proxy", false);
  app.use(requestContext(log));
  app.use(securityHeaders(deps.config.secureCookies));
  app.useBodyParser("json", { limit: "64kb", strict: true, type: "application/json" });
  return app;
}
