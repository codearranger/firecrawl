import { toSearxngMapQuery } from "./map-searxng-query";

describe("toSearxngMapQuery", () => {
  it("strips scheme and www from site: targets", () => {
    expect(toSearxngMapQuery("site:https://www.example.com")).toBe(
      "site:example.com",
    );
  });

  it("keeps a path and the search terms", () => {
    expect(toSearxngMapQuery("pricing site:docs.example.com/v2/")).toBe(
      "pricing site:docs.example.com/v2",
    );
  });

  it("leaves queries without site: alone", () => {
    expect(toSearxngMapQuery("pricing example.com")).toBe(
      "pricing example.com",
    );
  });
});
