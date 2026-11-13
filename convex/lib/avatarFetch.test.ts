import { expect, test, describe, afterEach, vi } from "vitest";
import { downloadAvatarImage } from "./avatarFetch";
import { isAllowedMetaAvatarUrl } from "./metaAvatar";
import { isAllowedAvatarUrl } from "./bridgeAvatar";

afterEach(() => vi.unstubAllGlobals());

const jpeg = () => {
  const b = new Uint8Array(120).fill(7);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};
const LOOKASIDE = "https://platform-lookaside.fbsbx.com/p.jpg";
const CDN = "https://scontent.xx.fbcdn.net/p.jpg";
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

function stub(routes: Record<string, () => Response>) {
  const mock = vi.fn(async (input: unknown) => {
    const r = routes[String(input)];
    return r ? r() : new Response("no", { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
const meta = { allowUrl: isAllowedMetaAvatarUrl, maxBytes: 1_000_000, followOneRedirect: true };

describe("downloadAvatarImage: redirect", () => {
  test("Meta: 302 para host permitido baixa", async () => {
    const mock = stub({ [LOOKASIDE]: () => redirect(CDN), [CDN]: () => new Response(jpeg() as BodyInit) });
    expect(await downloadAvatarImage(LOOKASIDE, meta)).not.toBeNull();
    expect(mock).toHaveBeenCalledTimes(2);
  });

  test("Meta: 302 para host fora da lista recusa sem buscar o destino", async () => {
    const mock = stub({ [LOOKASIDE]: () => redirect("https://evil.test/p.jpg") });
    expect(await downloadAvatarImage(LOOKASIDE, meta)).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  test("Meta: dois redirects recusa", async () => {
    stub({ [LOOKASIDE]: () => redirect(CDN), [CDN]: () => redirect("https://scontent.xx.fbcdn.net/q.jpg") });
    expect(await downloadAvatarImage(LOOKASIDE, meta)).toBeNull();
  });

  test("WhatsApp: 302 segue recusado", async () => {
    const wa = "https://pps.whatsapp.net/a.jpg";
    const mock = stub({ [wa]: () => redirect("https://pps.whatsapp.net/b.jpg") });
    expect(await downloadAvatarImage(wa, { allowUrl: isAllowedAvatarUrl, maxBytes: 1_000_000 })).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
