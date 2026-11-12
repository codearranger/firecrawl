import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("self-hosted media store", () => {
  let dir: string;
  let media: typeof import("./selfhost-media.js");

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-"));
    process.env.SELF_HOSTED_MEDIA_DIR = dir;
    process.env.SELF_HOSTED_MEDIA_PUBLIC_URL = "http://fc.test:3002/";
    process.env.SELF_HOSTED_MEDIA_TTL_HOURS = "24";
    vi.resetModules();
    media = await import("./selfhost-media.js");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.SELF_HOSTED_MEDIA_DIR;
    delete process.env.SELF_HOSTED_MEDIA_PUBLIC_URL;
  });

  it("stores an inline png and returns a short URL", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const url = await media.storeInlineMedia(
      `data:image/png;base64,${png.toString("base64")}`,
    );
    expect(url).toMatch(
      /^http:\/\/fc\.test:3002\/v2\/media\/[A-Za-z0-9_-]{32}\.png$/,
    );
    const name = url.split("/").pop()!;
    expect(media.MEDIA_NAME.test(name)).toBe(true);
    expect(fs.readFileSync(path.join(dir, name))).toEqual(png);
  });

  it("stores jpeg and pdf with the right extension", async () => {
    expect(await media.storeInlineMedia("data:image/jpeg;base64,AAAA")).toMatch(
      /\.jpg$/,
    );
    expect(
      await media.storeInlineMedia("data:application/pdf;base64,AAAA"),
    ).toMatch(/\.pdf$/);
  });

  it("leaves URLs and other values unchanged", async () => {
    expect(await media.storeInlineMedia("https://cdn.test/a.png")).toBe(
      "https://cdn.test/a.png",
    );
    expect(await media.storeInlineMedia("data:text/html;base64,AAAA")).toBe(
      "data:text/html;base64,AAAA",
    );
  });

  it("rejects names outside the store's pattern", () => {
    expect(media.MEDIA_NAME.test("../../etc/passwd")).toBe(false);
    expect(media.MEDIA_NAME.test("short.png")).toBe(false);
  });

  it("cleanup removes only expired media", async () => {
    const fresh = (await media.storeInlineMedia("data:image/png;base64,AAAA"))
      .split("/")
      .pop()!;
    const old = (await media.storeInlineMedia("data:image/png;base64,AAAA"))
      .split("/")
      .pop()!;
    const past = new Date(Date.now() - 48 * 3600_000);
    fs.utimesSync(path.join(dir, old), past, past);
    expect(await media.cleanupSelfHostedMedia()).toBe(1);
    expect(fs.existsSync(path.join(dir, fresh))).toBe(true);
    expect(fs.existsSync(path.join(dir, old))).toBe(false);
  });
});
