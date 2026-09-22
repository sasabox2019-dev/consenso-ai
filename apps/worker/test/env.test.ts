import { describe, expect, it } from "vitest";
import { clientIp } from "../src/env";

describe("clientIp trust model", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://x/api/consensus", { headers });

  it("cf-connecting-ip siempre gana (red de Cloudflare)", () => {
    const r = req({
      "cf-connecting-ip": "1.2.3.4",
      "x-real-ip": "9.9.9.9",
      "x-forwarded-for": "8.8.8.8",
    });
    expect(clientIp(r)).toBe("1.2.3.4");
    expect(clientIp(r, { TRUST_PROXY_IP: "1" })).toBe("1.2.3.4");
  });

  it("sin flag: cabeceras de proxy ignoradas (anti-spoof)", () => {
    const r = req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "8.8.8.8, 7.7.7.7" });
    expect(clientIp(r)).toBe("unknown");
  });

  it("con TRUST_PROXY_IP: usa X-Real-IP y luego la primera entrada de XFF", () => {
    expect(clientIp(req({ "x-real-ip": "9.9.9.9" }), { TRUST_PROXY_IP: "1" })).toBe("9.9.9.9");
    expect(clientIp(req({ "x-forwarded-for": "8.8.8.8, 7.7.7.7" }), { TRUST_PROXY_IP: "1" })).toBe(
      "8.8.8.8",
    );
    expect(clientIp(req({}), { TRUST_PROXY_IP: "1" })).toBe("unknown");
  });
});
