import { describe, it, expect } from "vitest";
import { tokenizeArgs } from "../src/exec.js";

describe("tokenizeArgs", () => {
  it("splits on whitespace", () => {
    expect(tokenizeArgs("-i input.mp4 -c copy out.mp4")).toEqual(["-i", "input.mp4", "-c", "copy", "out.mp4"]);
  });

  it("keeps double-quoted groups intact", () => {
    expect(tokenizeArgs('-metadata title="My Movie" out.mp4')).toEqual(["-metadata", "title=My Movie", "out.mp4"]);
  });

  it("keeps single-quoted groups intact", () => {
    expect(tokenizeArgs("commit -m 'initial commit'")).toEqual(["commit", "-m", "initial commit"]);
  });

  it("treats shell metacharacters as literal tokens (no shell interpretation)", () => {
    // These are passed to execFile as argv, so they can never spawn a subshell.
    expect(tokenizeArgs("status; rm -rf /")).toEqual(["status;", "rm", "-rf", "/"]);
    expect(tokenizeArgs("$(whoami)")).toEqual(["$(whoami)"]);
  });

  it("returns an empty array for blank input", () => {
    expect(tokenizeArgs("")).toEqual([]);
    expect(tokenizeArgs("   ")).toEqual([]);
  });
});
