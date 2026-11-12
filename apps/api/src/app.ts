import "reflect-metadata";
import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { HttpsOptions } from "@nestjs/common/interfaces/external/https-options.interface.js";
import { AccessGuard, CONFIG, GRANTS, IDENTITY, KK_SESSIONS, KkSessionRegistry, READINESS, SESSIONS, SETUP } from "./auth.js";
import type { ApiConfig, ApiTls } from "./config.js";
import { cors } from "./cors.js";
import { requestContext, securityHeaders, stdoutSink, type LogSink } from "./http.js";
import type { IdentityResolver } from "./identity.js";
import {
  AuthController,
  GrantsController,
  HealthController,
  ProjectSettingsController,
  SettingsController,
  SetupController,
  VaultController,
  type GrantService,
  type ReadinessProbe,
  type SetupServices,
} from "./routes.js";
import { SessionService } from "./session.js";
import { NotificationsController, type NotifyServices } from "./notify-routes.js";
import { NOTIFY } from "./notify.js";
import { DEAD_LETTERS, DeadLettersController, type DeadLetterServices } from "./dead-letters.js";
import { REQUIREMENTS, RequirementsController, type RequirementsServices } from "./requirements.js";

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
  /** M1.4 settings store and vault (null parts answer 503 `*-not-configured`). */
  setup?: SetupServices;
  /** M1.6 notifier (null → notification routes answer 503 `notifications-not-configured`). */
  notify?: NotifyServices;
  /** DEVOS-77 dead-letter view (null parts → 503 `dead-letters-not-configured`). */
  deadLetters?: DeadLetterServices;
  /** M2.2-d2 spec intake (null parts → 503 `requirements-not-configured`). */
  requirements?: RequirementsServices;
  /** R3-a: certificate + key → the API listens on HTTPS (TLS 1.2+); null/absent → plain HTTP (tests, CI). */
  tls?: ApiTls | null;
}

@Module({})
class ApiModule {
  static register(deps: Required<Omit<AppDeps, "now" | "log" | "tls">> & { sessions: SessionService }): DynamicModule {
    return {
      module: ApiModule,
      controllers: [HealthController, AuthController, GrantsController, SetupController, SettingsController, ProjectSettingsController, VaultController, NotificationsController, DeadLettersController, RequirementsController],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: IDENTITY, useValue: deps.identity },
        { provide: SESSIONS, useValue: deps.sessions },
        { provide: GRANTS, useValue: deps.grants },
        { provide: READINESS, useValue: deps.readiness },
        { provide: KK_SESSIONS, useValue: deps.kkSessions },
        { provide: SETUP, useValue: deps.setup },
        { provide: NOTIFY, useValue: deps.notify },
        { provide: DEAD_LETTERS, useValue: deps.deadLetters },
        { provide: REQUIREMENTS, useValue: deps.requirements },
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
      setup: deps.setup ?? { settings: null, vault: null },
      notify: deps.notify ?? { notifier: null },
      deadLetters: deps.deadLetters ?? { queue: null, audit: null },
      requirements: deps.requirements ?? { pipeline: null, store: null, cards: null },
      sessions,
    }),
    {
      logger: false,
      bodyParser: false,
      // Nest passes httpsOptions to node:https createServer unchanged; its type omits minVersion.
      ...(deps.tls ? { httpsOptions: { cert: deps.tls.cert, key: deps.tls.key, minVersion: "TLSv1.2" } as HttpsOptions } : {}),
    },
  );
  app.disable("x-powered-by");
  // Proxies are not trusted: identity comes from the TCP peer only (ADR-0005: no Serve, no proxy).
  app.set("trust proxy", false);
  app.use(requestContext(log));
  app.use(securityHeaders(deps.config.secureCookies));
  app.use(cors(deps.config.allowedOrigins));
  app.useBodyParser("json", { limit: "64kb", strict: true, type: "application/json" });
  // M1.4: a body-parser failure answers a fixed code. The default handler can echo the parser's
  // message, which quotes the body, and a body may carry a secret.
  app.use(bodyErrors);
  return app;
}

function bodyErrors(err: unknown, _req: unknown, res: any, next: (e?: unknown) => void) {
  if (!err) return next();
  const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 400;
  const code = status === 413 ? "body-too-large" : status === 415 ? "body-unsupported-type" : "body-invalid-json";
  res.status(status === 413 || status === 415 ? status : 400).json({ statusCode: status === 413 || status === 415 ? status : 400, code });
}
