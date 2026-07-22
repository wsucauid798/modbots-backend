import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyMiddie from "@fastify/middie";
import fastifyStatic from "@fastify/static";
import fastifyView from "@fastify/view";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { Redis } from "ioredis";
import nunjucks from "nunjucks";
import type Provider from "oidc-provider";
import { BackendClient, BackendError } from "./backend.js";
import type { AccountConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

// The account session is a signed cookie holding the actor id. It exists
// for the standalone account page; the OIDC provider keeps its own session
// for the sign-in hand-off.
const sessionCookie = "modbots_account";
const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;
const recoveryCodeTtlSeconds = 10 * 60;
const recoveryCodePrefix = "MBR-";

interface PageError {
  field: string;
  message: string;
}

type ScreenMode = "login" | "register";

interface PageValues {
  username?: string;
  displayName?: string;
  acceptPolicy?: boolean;
}

const isExpiredInteraction = (error: unknown): boolean =>
  error instanceof Error && error.name === "SessionNotFound";

const interactionFailureReason = (error: unknown): string =>
  error instanceof Error && error.message.length > 0
    ? error.message
    : "interaction session unavailable";

// Errors render inline at the field they belong to; "form" is the one
// form-level slot (a failure not attributable to a single field).
const byField = (errors: PageError[]): Record<string, string> => {
  const map: Record<string, string> = {};

  for (const error of errors) {
    if (!(error.field in map)) {
      map[error.field] = error.message;
    }
  }

  return map;
};

const screenMode = (value: string | undefined): ScreenMode =>
  value === "register" ? "register" : "login";

const recoveryCodeKey = (code: string): string =>
  `account:desktop-recovery:${code}`;

const createRecoveryCode = (): string =>
  `${recoveryCodePrefix}${randomBytes(5).toString("hex").toUpperCase()}`;

export const buildApp = async (
  config: AccountConfig,
  backend: BackendClient,
  provider: Provider,
): Promise<FastifyInstance> => {
  const app = Fastify({ logger: true });
  const redis = new Redis(config.redisUrl);

  // The provider is mounted as middleware ahead of Fastify's body parsing:
  // its endpoints read the raw request stream themselves, and a parsed
  // (consumed) body would leave the token endpoint blind.
  await app.register(fastifyMiddie);

  const oidcCallback = provider.callback();

  app.use((request, response, next) => {
    const url = request.url ?? "";

    if (
      url.startsWith("/oidc/") ||
      url === "/.well-known/openid-configuration"
    ) {
      oidcCallback(request, response);
      return;
    }

    next();
  });

  app.register(fastifyCookie, { secret: config.cookieSecret });
  app.register(fastifyFormbody);
  app.register(fastifyStatic, {
    root: join(here, "..", "public", "assets"),
    prefix: "/assets/",
  });
  app.register(fastifyView, {
    engine: { nunjucks },
    root: join(here, "views"),
  });

  const setSession = (reply: { setCookie: Function }, actorId: string) => {
    reply.setCookie(sessionCookie, actorId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      signed: true,
      maxAge: sessionMaxAgeSeconds,
    });
  };

  const sessionActorId = (request: {
    cookies: Record<string, string | undefined>;
    unsignCookie: (value: string) => { valid: boolean; value: string | null };
  }): string | null => {
    const raw = request.cookies[sessionCookie];

    if (raw === undefined) {
      return null;
    }

    const unsigned = request.unsignCookie(raw);
    return unsigned.valid ? unsigned.value : null;
  };

  const renderAuthView = (
    reply: { view: Function; code: (statusCode: number) => { view: Function } },
    screen: ScreenMode,
    model: {
      uid: string | null;
      errors: Record<string, string>;
      values: PageValues;
    },
    statusCode?: number,
  ) => {
    const viewName = screen === "register" ? "register.njk" : "login.njk";

    if (statusCode === undefined) {
      return reply.view(viewName, model);
    }

    return reply.code(statusCode).view(viewName, model);
  };

  const beginDesktopHandoff = async (
    request: FastifyRequest,
    reply: FastifyReply,
    actorId: string,
  ) => {
    const interaction = await provider.interactionDetails(request.raw, reply.raw);
    const clientId = String(interaction.params.client_id ?? "");
    const client = await provider.Client.find(clientId);

    if (client === undefined) {
      throw new Error(`OIDC client '${clientId}' was not found`);
    }

    let grantId = interaction.grantId;

    if (grantId === undefined) {
      const grant = new provider.Grant({ clientId, accountId: actorId });
      grant.addOIDCScope("openid profile");
      grantId = await grant.save();
    }

    const accessToken = new provider.AccessToken({
      accountId: actorId,
      client,
      grantId,
      gty: "authorization_code",
      scope: "openid profile",
    });

    const recoveryCode = createRecoveryCode();
    const accessTokenValue = await accessToken.save();

    await redis.set(
      recoveryCodeKey(recoveryCode),
      accessTokenValue,
      "EX",
      recoveryCodeTtlSeconds,
    );

    const resumeUrl = await provider.interactionResult(
      request.raw,
      reply.raw,
      { login: { accountId: actorId } },
      { mergeWithLastSubmission: false },
    );

    return reply.view("continue.njk", {
      clientName:
        clientId === "modbots-desktop"
          ? "Mod Bots Desktop"
          : clientId === "modbots-web"
            ? "Mod Bots Web"
            : clientId,
      recoveryCode,
      recoveryMinutes: Math.floor(recoveryCodeTtlSeconds / 60),
      resumeUrl,
    });
  };

  app.get("/health", async () => ({ status: "ok", service: "account" }));

  // The one canonical, linkable home of the participation policy. Clients
  // never render the policy themselves; they link here.
  app.get("/policy", async (_request, reply) => {
    const policy = await backend.policy();
    return reply.view("policy.njk", { policy });
  });

  interface LoginQuery {
    uid?: string;
    screen?: string;
  }

  // One front door: /login. Registration is a mode of the same surface
  // (?screen=register), never a separately routed destination. When the
  // pending interaction asks for consent (a native client is completing
  // sign-in), the page is the continue confirmation instead of a form.
  app.get<{ Querystring: LoginQuery }>("/login", async (request, reply) => {
    const { uid, screen } = request.query;

    if (uid !== undefined) {
      try {
        const interaction = await provider.interactionDetails(
          request.raw,
          reply.raw,
        );

        if (
          interaction.prompt.name === "consent" &&
          typeof interaction.session?.accountId === "string"
        ) {
          let grantId = interaction.grantId;

          if (grantId === undefined) {
            const grant = new provider.Grant({
              clientId: String(interaction.params.client_id ?? ""),
              accountId: interaction.session.accountId,
            });
            grant.addOIDCScope("openid profile");
            grantId = await grant.save();
          }

          await provider.interactionFinished(
            request.raw,
            reply.raw,
            { consent: { grantId } },
            { mergeWithLastSubmission: true },
          );
          return reply;
        }
      } catch (error) {
        if (!isExpiredInteraction(error)) {
          throw error;
        }

        request.log.warn(
          {
            uid,
            reason: interactionFailureReason(error),
          },
          "OIDC login interaction expired before the account page could resume it",
        );

        // Never silently turn an app log-in into a site-only log-in: the
        // person would end up logged in here while their app waits for a
        // hand-off that can no longer happen.
        return reply.code(400).view("error.njk", {
          heading: "This log-in request has expired",
          message:
            "The request from your app timed out. Go back to Mod Bots and try logging in again.",
        });
      }
    }

    return renderAuthView(reply, screenMode(screen), {
      uid: uid ?? null,
      errors: {},
      values: {},
    });
  });

  interface LoginBody {
    uid?: string;
    screen?: string;
    username?: string;
    password?: string;
    acceptPolicy?: string;
  }

  app.post<{ Body: LoginBody }>("/login", async (request, reply) => {
    const uid = request.body.uid ?? null;
    const screen = screenMode(request.body.screen);
    const username = (request.body.username ?? "").trim();
    const password = request.body.password ?? "";
    const accepted = request.body.acceptPolicy === "on";
    const errors: PageError[] = [];

    if (username.length === 0) {
      errors.push({ field: "username", message: "Enter your username." });
    }

    if (password.length === 0) {
      errors.push({ field: "password", message: "Enter your password." });
    }

    if (!accepted) {
      errors.push({
        field: "acceptPolicy",
        message: "Logging in requires accepting the Participation Policy.",
      });
    }

    const actor =
      errors.length > 0
        ? null
        : await backend.verifyCredentials(username, password, accepted);

    if (errors.length === 0 && actor === null) {
      errors.push({
        field: "form",
        message: "Username or password is incorrect.",
      });
    }

    if (actor === null) {
      return renderAuthView(
        reply,
        screen,
        {
          uid,
          errors: byField(errors),
          values: { username, acceptPolicy: accepted },
        },
        errors.some((error) => error.field === "form") ? 401 : 400,
      );
    }

    setSession(reply, actor.id);

    if (uid !== null) {
      try {
        return await beginDesktopHandoff(request, reply, actor.id);
      } catch (error) {
        if (!isExpiredInteraction(error)) {
          throw error;
        }

        request.log.warn(
          {
            uid,
            actorId: actor.id,
            reason: interactionFailureReason(error),
          },
          "OIDC login interaction expired after credentials were accepted",
        );

        // The credentials were fine; only the app's log-in request went
        // stale. Say so instead of pretending something broke.
        return reply.code(400).view("error.njk", {
          heading: "This log-in request has expired",
          message:
            "You are logged in here, but the request from your app timed out. Go back to Mod Bots and try logging in again.",
        });
      }
    }

    return reply.redirect("/account");
  });

  interface GuestLoginBody {
    uid?: string;
    screen?: string;
    displayName?: string;
    acceptPolicy?: string;
  }

  app.post<{ Body: GuestLoginBody }>("/guest-login", async (request, reply) => {
    const uid = request.body.uid ?? null;
    const screen = screenMode(request.body.screen);
    const displayName = (request.body.displayName ?? "").trim();
    const accepted = request.body.acceptPolicy === "on";
    const errors: PageError[] = [];

    if (!accepted) {
      errors.push({
        field: "acceptPolicy",
        message: "Guest entry requires accepting the Participation Policy.",
      });
    }

    if (errors.length > 0) {
      return renderAuthView(reply, screen, {
        uid,
        errors: byField(errors),
        values: { displayName, acceptPolicy: accepted },
      });
    }

    const outcome = await backend.createGuest(
      displayName.length === 0 ? null : displayName,
    );
    setSession(reply, outcome.actor.id);

    if (uid !== null) {
      try {
        return await beginDesktopHandoff(request, reply, outcome.actor.id);
      } catch (error) {
        if (!isExpiredInteraction(error)) {
          throw error;
        }

        request.log.warn(
          {
            uid,
            actorId: outcome.actor.id,
            reason: interactionFailureReason(error),
          },
          "OIDC login interaction expired after guest entry was accepted",
        );

        // The guest entry succeeded here; only the app's request went stale.
        return reply.code(400).view("error.njk", {
          heading: "This log-in request has expired",
          message:
            "You entered here as a guest, but the request from your app timed out. Go back to Mod Bots and try again.",
        });
      }
    }

    return reply.redirect("/account");
  });

  interface CancelBody {
    uid?: string;
  }

  app.post<{ Body: CancelBody }>("/login/cancel", async (request, reply) => {
    const uid = request.body.uid ?? null;

    if (uid === null) {
      return reply.redirect("/login");
    }

    try {
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        {
          error: "access_denied",
          error_description: "Sign-in was canceled.",
        },
        { mergeWithLastSubmission: false },
      );
      return reply;
    } catch (error) {
      if (!isExpiredInteraction(error)) {
        throw error;
      }

      request.log.warn(
        {
          uid,
          reason: interactionFailureReason(error),
        },
        "OIDC login interaction expired before cancellation could return to the app",
      );

      return reply.code(400).view("error.njk", {
        heading: "This log-in request has expired",
        message:
          "The request from your app already expired. Go back to Mod Bots and try logging in again.",
      });
    }
  });

  interface RecoveryRedeemBody {
    code?: string;
  }

  app.post<{ Body: RecoveryRedeemBody }>(
    "/login/recovery/redeem",
    async (request, reply) => {
      const code = (request.body.code ?? "").trim().toUpperCase();

      if (!code.startsWith(recoveryCodePrefix)) {
        return reply.code(400).send({
          error: "invalid_recovery_code",
          message: "The recovery code format is invalid.",
        });
      }

      const key = recoveryCodeKey(code);
      const accessToken = await redis.get(key);

      if (accessToken === null) {
        return reply.code(404).send({
          error: "recovery_code_not_found",
          message: "That recovery code is missing or expired.",
        });
      }

      await redis.del(key);

      return reply.code(200).send({ accessToken });
    },
  );

  interface RegisterBody {
    uid?: string;
    username?: string;
    displayName?: string;
    password?: string;
    acceptPolicy?: string;
  }

  app.post<{ Body: RegisterBody }>("/register", async (request, reply) => {
    const uid = request.body.uid ?? null;
    const username = (request.body.username ?? "").trim();
    const displayName = (request.body.displayName ?? "").trim();
    const password = request.body.password ?? "";
    const accepted = request.body.acceptPolicy === "on";
    const errors: PageError[] = [];

    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(username)) {
      errors.push({
        field: "username",
        message:
          "Username must be 3 to 64 letters, numbers, underscores, or hyphens.",
      });
    }

    if (password.length < 8 || password.length > 200) {
      errors.push({
        field: "password",
        message: "Password must be 8 to 200 characters.",
      });
    }

    if (!accepted) {
      errors.push({
        field: "acceptPolicy",
        message: "Registration requires accepting the Participation Policy.",
      });
    }

    const renderErrors = (code: number) =>
      reply.code(code).view("register.njk", {
        uid,
        errors: byField(errors),
        values: { username, displayName, acceptPolicy: accepted },
      });

    if (errors.length > 0) {
      return renderErrors(400);
    }

    let actorId: string;

    try {
      const outcome = await backend.register({
        username,
        displayName: displayName.length === 0 ? null : displayName,
        password,
      });
      actorId = outcome.actor.id;
    } catch (error) {
      if (error instanceof BackendError && error.code === "username_taken") {
        errors.push({
          field: "username",
          message: `The username '${username}' is already taken.`,
        });
        return renderErrors(409);
      }

      throw error;
    }

    // Registration ends logged in; a fresh registrant never re-enters the
    // password they typed a moment ago.
    setSession(reply, actorId);

    if (uid !== null) {
      try {
        return await beginDesktopHandoff(request, reply, actorId);
      } catch (error) {
        if (!isExpiredInteraction(error)) {
          throw error;
        }

        request.log.warn(
          {
            uid,
            actorId,
            reason: interactionFailureReason(error),
          },
          "OIDC login interaction expired after account creation",
        );

        // The account exists and they are logged in here; only the app's
        // request went stale.
        return reply.code(400).view("error.njk", {
          heading: "This log-in request has expired",
          message:
            "Your account was created and you are logged in here, but the request from your app timed out. Go back to Mod Bots and try logging in again.",
        });
      }
    }

    return reply.redirect("/account");
  });

  app.get("/account", async (request, reply) => {
    const actorId = sessionActorId(request);

    if (actorId === null) {
      return reply.redirect("/login");
    }

    try {
      const actor = await backend.getActor(actorId);
      return reply.view("account.njk", { actor });
    } catch {
      reply.clearCookie(sessionCookie, { path: "/" });
      return reply.redirect("/login");
    }
  });

  app.post("/logout", async (_request, reply) => {
    reply.clearCookie(sessionCookie, { path: "/" });
    return reply.redirect("/login");
  });

  app.get("/", async (_request, reply) => reply.redirect("/login"));

  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);
    return reply.code(500).view("error.njk", {});
  });

  return app;
};
