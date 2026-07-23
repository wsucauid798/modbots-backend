import { generateKeyPair, exportJWK } from "jose";
import { Redis } from "ioredis";
import Provider from "oidc-provider";
import type { Adapter, AdapterPayload } from "oidc-provider";
import type { AccountConfig } from "./config.js";
import type { BackendClient } from "./backend.js";

// Storage for the provider's artifacts (codes, tokens, sessions, grants)
// lives in Redis. This is the adapter shape oidc-provider documents.
const grantable = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
]);

const consumable = new Set([
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
]);

const grantKeyFor = (id: string): string => `oidc:grant:${id}`;
const userCodeKeyFor = (userCode: string): string =>
  `oidc:userCode:${userCode}`;
const uidKeyFor = (uid: string): string => `oidc:uid:${uid}`;

const createAdapterClass = (redis: Redis) =>
  class RedisAdapter implements Adapter {
    private readonly name: string;

    public constructor(name: string) {
      this.name = name;
    }

    private key(id: string): string {
      return `oidc:${this.name}:${id}`;
    }

    public async upsert(
      id: string,
      payload: AdapterPayload,
      expiresIn: number,
    ): Promise<void> {
      const key = this.key(id);
      const multi = redis.multi();

      if (consumable.has(this.name)) {
        multi.hset(key, { payload: JSON.stringify(payload) });
      } else {
        multi.set(key, JSON.stringify(payload));
      }

      if (expiresIn) {
        multi.expire(key, expiresIn);
      }

      if (grantable.has(this.name) && typeof payload.grantId === "string") {
        const grantKey = grantKeyFor(payload.grantId);
        multi.rpush(grantKey, key);
        multi.expire(grantKey, expiresIn);
      }

      if (typeof payload.userCode === "string") {
        const userCodeKey = userCodeKeyFor(payload.userCode);
        multi.set(userCodeKey, id);
        multi.expire(userCodeKey, expiresIn);
      }

      if (typeof payload.uid === "string") {
        const uidKey = uidKeyFor(payload.uid);
        multi.set(uidKey, id);
        multi.expire(uidKey, expiresIn);
      }

      await multi.exec();
    }

    public async find(id: string): Promise<AdapterPayload | undefined> {
      const key = this.key(id);
      const data = consumable.has(this.name)
        ? await redis.hgetall(key)
        : await redis.get(key);

      if (
        data === null ||
        (typeof data === "object" && Object.keys(data).length === 0)
      ) {
        return undefined;
      }

      if (typeof data === "string") {
        return JSON.parse(data) as AdapterPayload;
      }

      const record = data as { payload: string; consumed?: string };
      const parsed = JSON.parse(record.payload) as AdapterPayload;

      return {
        ...parsed,
        ...(record.consumed === undefined
          ? {}
          : { consumed: Number(record.consumed) }),
      };
    }

    public async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      const id = await redis.get(uidKeyFor(uid));
      return id === null ? undefined : this.find(id);
    }

    public async findByUserCode(
      userCode: string,
    ): Promise<AdapterPayload | undefined> {
      const id = await redis.get(userCodeKeyFor(userCode));
      return id === null ? undefined : this.find(id);
    }

    public async destroy(id: string): Promise<void> {
      await redis.del(this.key(id));
    }

    public async revokeByGrantId(grantId: string): Promise<void> {
      const grantKey = grantKeyFor(grantId);
      const keys = await redis.lrange(grantKey, 0, -1);
      const multi = redis.multi();

      for (const key of keys) {
        multi.del(key);
      }

      multi.del(grantKey);
      await multi.exec();
    }

    public async consume(id: string): Promise<void> {
      await redis.hset(this.key(id), {
        consumed: Math.floor(Date.now() / 1000),
      });
    }
  };

// First-party clients skip the consent screen: the platform's own apps do
// not ask the user to grant the platform access to itself.
const firstPartyClients = new Set(["modbots-desktop", "modbots-web"]);
const desktopCorsOrigins = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
]);

const clientAllowsOrigin = (
  redirectUris: readonly string[] | undefined,
  origin: string,
): boolean => {
  if (redirectUris === undefined) {
    return false;
  }

  return redirectUris.some((uri) => {
    try {
      return new URL(uri).origin === origin;
    } catch {
      return false;
    }
  });
};

export const createOidcProvider = async (
  config: AccountConfig,
  backend: BackendClient,
): Promise<Provider> => {
  const redis = new Redis(config.redisUrl);

  // Dev signing key: generated at boot when no key is configured, which
  // invalidates outstanding tokens on restart. A stable key arrives with
  // deployment work (B031).
  const { privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(privateKey);

  const provider = new Provider(config.issuer, {
    adapter: createAdapterClass(redis),
    clients: [
      {
        client_id: "modbots-desktop",
        client_name: "Mod Bots Desktop",
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        redirect_uris: [config.desktopRedirectUri],
      },
      {
        client_id: "modbots-web",
        client_name: "Mod Bots Web",
        application_type: "web",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        redirect_uris: [config.webRedirectUri],
        // Web logout ends the provider session and lands back on the app.
        post_logout_redirect_uris: [new URL("/", config.webRedirectUri).toString()],
      },
    ],
    cookies: {
      keys: [config.cookieSecret],
    },
    jwks: { keys: [jwk] },
    scopes: ["openid", "profile"],
    claims: {
      openid: ["sub"],
      profile: ["name", "preferred_username"],
    },
    // The provider's endpoints live under /oidc; the app's own pages own
    // the rest of the URL space. Discovery stays at the standard
    // /.well-known/openid-configuration.
    routes: {
      authorization: "/oidc/auth",
      token: "/oidc/token",
      userinfo: "/oidc/me",
      jwks: "/oidc/jwks",
      revocation: "/oidc/token/revocation",
      introspection: "/oidc/token/introspection",
      end_session: "/oidc/session/end",
    },
    pkce: {
      required: () => true,
    },
    // Clients may hint which screen the person meant to land on (the
    // agreed flow: a "Create account" button opens the same door with the
    // register hint).
    extraParams: ["screen"],
    features: {
      devInteractions: { enabled: false },
      rpInitiatedLogout: {
        enabled: true,
        // A website's logout is one action, not a questionnaire: submit the
        // provider's confirmation form automatically.
        logoutSource: async (ctx, form) => {
          ctx.body = [
            "<!DOCTYPE html><html><head><title>Signing out</title></head>",
            '<body onload="document.forms[0].submit()">',
            form.replace(
              "</form>",
              '<input type="hidden" name="logout" value="yes"/></form>',
            ),
            "</body></html>",
          ].join("");
        },
      },
    },
    clientBasedCORS(ctx, origin, client) {
      if (
        client.clientId === "modbots-desktop" &&
        desktopCorsOrigins.has(origin)
      ) {
        return true;
      }

      if (ctx.oidc.route === "userinfo" || client.clientAuthMethod === "none") {
        return clientAllowsOrigin(client.redirectUris, origin);
      }

      return false;
    },
    interactions: {
      url: (ctx, interaction) =>
        ctx.oidc.params?.screen === "register"
          ? `/register?uid=${interaction.uid}`
          : `/login?uid=${interaction.uid}`,
    },
    async findAccount(_ctx, id) {
      try {
        const actor = await backend.getActor(id);

        return {
          accountId: id,
          claims: () => ({
            sub: id,
            preferred_username: actor.display,
            name: actor.displayName,
          }),
        };
      } catch {
        return undefined;
      }
    },
    async loadExistingGrant(ctx) {
      const grantId = ctx.oidc.session?.grantIdFor(
        ctx.oidc.client!.clientId,
      );

      if (grantId) {
        return ctx.oidc.provider.Grant.find(grantId);
      }

      if (!firstPartyClients.has(ctx.oidc.client!.clientId)) {
        return undefined;
      }

      const grant = new ctx.oidc.provider.Grant({
        clientId: ctx.oidc.client!.clientId,
        accountId: ctx.oidc.session!.accountId,
      });

      grant.addOIDCScope("openid profile");
      await grant.save();
      return grant;
    },
  });

  // Behind the reverse proxy at modbots.ai the connection to this service
  // is plain HTTP; trust the proxy's forwarded protocol.
  provider.proxy = true;

  return provider;
};
