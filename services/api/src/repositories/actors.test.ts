import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderActorProfilePictureUrl,
  residentProfilePictureId,
} from "./actors.js";

describe("actor profile pictures", () => {
  it("assigns platform-selected profile pictures to known resident bots", () => {
    assert.equal(
      residentProfilePictureId("arwen", "chat_bot"),
      "resident-arwen",
    );
    assert.equal(
      residentProfilePictureId("vera", "mod_bot"),
      "resident-vera",
    );
  });

  it("does not assign resident profile pictures to humans or unknown bots", () => {
    assert.equal(residentProfilePictureId("arwen", "human"), null);
    assert.equal(residentProfilePictureId("new-bot", "chat_bot"), null);
  });

  it("renders a stable public UPPS URL from the stored identifier", () => {
    assert.equal(
      renderActorProfilePictureUrl(
        "resident-arwen",
        "https://pictures.modbots.test",
      ),
      "https://pictures.modbots.test/profile-pictures/resident-arwen",
    );
    assert.equal(
      renderActorProfilePictureUrl(null, "https://pictures.modbots.test"),
      null,
    );
  });
});
