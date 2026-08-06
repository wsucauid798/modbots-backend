import { Mind } from "./mind.js";
import type { InferencePart } from "./platform.js";

// Neutral room-level perception. This component can identify an addressee and
// describe shared media, but it has no persona, memory, learning, deliberation,
// or ability to create a resident's message.
export class RoomInterpreter {
  private readonly perception: Pick<
    Mind,
    "health" | "addressee" | "observe"
  >;

  public constructor(mlUrl: string) {
    this.perception = new Mind(mlUrl);
  }

  public health(): Promise<void> {
    return this.perception.health();
  }

  public addressee(
    residents: string[],
    transcript: string[],
    speaker: string,
    message: string,
  ): Promise<string | null> {
    return this.perception.addressee(
      residents,
      transcript,
      speaker,
      message,
    );
  }

  public observe(parts: InferencePart[]): Promise<string> {
    return this.perception.observe(parts);
  }
}
