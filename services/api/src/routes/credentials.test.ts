import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { hashPassword } from "../domain/credentials.js";
import type {
  Actor,
  ActorRepository,
} from "../repositories/actors.js";
import type { CredentialRepository } from "../repositories/credentials.js";
import { credentialRoutes } from "./credentials.js";

const registeredActor: Actor = {
  id: "human-1",
  handle: "test-user",
  displayName: "Test User",
  discriminator: "0001",
  registered: true,
  display: "Test User#0001",
  profilePictureId: null,
  profilePictureUrl: null,
  bio: null,
  pronouns: null,
  location: null,
  links: [],
  type: "human",
  policyVersionAccepted: null,
  policyAcceptedAt: null,
  retiredAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("credential routes", () => {
  it("requires and records policy acceptance after password verification", async () => {
    const passwordHash = await hashPassword("correct-password");
    let recordedVersion: string | null = null;
    const actors: ActorRepository = {
      getById: async () => registeredActor,
      getByHandle: async (handle) =>
        handle === registeredActor.handle ? registeredActor : null,
      recordPolicyAcceptance: async (actorId, policyVersion) => {
        assert.equal(actorId, registeredActor.id);
        recordedVersion = policyVersion;
        return {
          ...registeredActor,
          policyVersionAccepted: policyVersion,
          policyAcceptedAt: "2026-07-05T00:00:00.000Z",
        };
      },
    };
    const credentials: CredentialRepository = {
      setPassword: async () => undefined,
      passwordHashFor: async () => passwordHash,
    };
    const app = Fastify();
    await app.register(credentialRoutes(actors, credentials));

    const rejected = await app.inject({
      method: "POST",
      url: "/api/credentials/verify",
      payload: {
        username: registeredActor.handle,
        password: "correct-password",
      },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(recordedVersion, null);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/credentials/verify",
      payload: {
        username: registeredActor.handle,
        password: "correct-password",
        acceptPolicy: true,
      },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(typeof recordedVersion, "string");
    assert.equal(accepted.json().actor.policyVersionAccepted, recordedVersion);

    await app.close();
  });

  it("does not record acceptance when the password is wrong", async () => {
    const passwordHash = await hashPassword("correct-password");
    let acceptanceRecorded = false;
    const actors: ActorRepository = {
      getById: async () => registeredActor,
      getByHandle: async () => registeredActor,
      recordPolicyAcceptance: async () => {
        acceptanceRecorded = true;
        return registeredActor;
      },
    };
    const credentials: CredentialRepository = {
      setPassword: async () => undefined,
      passwordHashFor: async () => passwordHash,
    };
    const app = Fastify();
    await app.register(credentialRoutes(actors, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/credentials/verify",
      payload: {
        username: registeredActor.handle,
        password: "wrong-password",
        acceptPolicy: true,
      },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(acceptanceRecorded, false);
    await app.close();
  });
});
