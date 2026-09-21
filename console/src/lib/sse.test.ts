import { describe, expect, it } from "vitest";
import { createSseParser, type SseFrame } from "./sse";

function parse(chunks: string[]): SseFrame[] {
  const out: SseFrame[] = [];
  const p = createSseParser((f) => out.push(f));
  chunks.forEach((c) => p.push(c));
  return out;
}

describe("SSE parser", () => {
  it("parses id/event/data frames as sent by the harness", () => {
    expect(parse(['id: 7\nevent: action.decided\ndata: {"a":1}\n\n'])).toEqual([
      { id: "7", event: "action.decided", data: '{"a":1}' },
    ]);
  });

  it("reassembles frames split across arbitrary chunk boundaries", () => {
    const frames = parse(["id: 1\nev", "ent: agent.progress\nda", 'ta: {"m":"x"}\n', "\nid: 2\nevent: end\ndata: {}\n\n"]);
    expect(frames.map((f) => [f.id, f.event])).toEqual([
      ["1", "agent.progress"],
      ["2", "end"],
    ]);
  });

  it("ignores keep-alive comments and tolerates CRLF", () => {
    expect(parse([": keep-alive\n\n", "event: end\r\ndata: {}\r\n\r\n"])).toEqual([{ id: undefined, event: "end", data: "{}" }]);
  });

  it("joins multi-line data", () => {
    expect(parse(["data: a\ndata: b\n\n"])[0]?.data).toBe("a\nb");
  });

  it("does not emit an incomplete trailing frame", () => {
    expect(parse(["id: 1\nevent: x\ndata: y\n"])).toEqual([]);
  });
});
