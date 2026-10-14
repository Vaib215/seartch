import { describe, expect, it } from "vitest";
import { decodeBody } from "../src/decode";

describe("decodeBody", () => {
  const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b]); // "日本" in Shift_JIS

  it("uses the Content-Type charset", async () => {
    expect(await decodeBody(new Response(sjis), "text/html; charset=Shift_JIS")).toBe("日本");
  });

  it("falls back to a <meta charset> tag", async () => {
    const head = new TextEncoder().encode('<meta charset="shift_jis">');
    const body = new Uint8Array([...head, ...sjis]);
    expect(await decodeBody(new Response(body), "text/html")).toBe('<meta charset="shift_jis">日本');
  });

  it("defaults to UTF-8 and survives unknown labels", async () => {
    expect(await decodeBody(new Response("héllo"), "text/html")).toBe("héllo");
    expect(await decodeBody(new Response("héllo"), "text/html; charset=bogus-9")).toBe("héllo");
  });
});
