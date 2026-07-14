import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePathScope, resolvePathSearchScope } from "./path-scope.js";

const cwd = "/workspace/projects/drone";
const home = "/home/pilot";

function scope(query: string) {
  return resolvePathSearchScope({ cwd, home, query });
}

describe("path search scope", () => {
  it("uses cwd and immediate contents for a bare @ query", () => {
    expect(scope("")).toEqual({
      searchRoot: cwd,
      displayPrefix: "",
      needle: "",
      onlyImmediate: true,
    });
  });

  it("uses cwd for a normal @foo query", () => {
    expect(scope("foo")).toEqual({
      searchRoot: cwd,
      displayPrefix: "",
      needle: "foo",
      onlyImmediate: false,
    });
  });

  it("scopes @~/foo and @~/ to home", () => {
    expect(scope("~/foo")).toEqual({
      searchRoot: home,
      displayPrefix: "~/",
      needle: "foo",
      onlyImmediate: false,
    });
    expect(scope("~/")).toEqual({
      searchRoot: home,
      displayPrefix: "~/",
      needle: "",
      onlyImmediate: true,
    });
  });

  it("scopes @../foo to one parent", () => {
    expect(scope("../foo")).toEqual({
      searchRoot: "/workspace/projects",
      displayPrefix: "../",
      needle: "foo",
      onlyImmediate: false,
    });
  });

  it("supports repeated parents and an empty parent needle", () => {
    expect(scope("../../foo")).toEqual({
      searchRoot: "/workspace",
      displayPrefix: "../../",
      needle: "foo",
      onlyImmediate: false,
    });
    expect(scope("../../")).toEqual({
      searchRoot: "/workspace",
      displayPrefix: "../../",
      needle: "",
      onlyImmediate: true,
    });
  });

  it("treats ./ as cwd shorthand without retaining a display prefix", () => {
    expect(scope("./")).toEqual({
      searchRoot: cwd,
      displayPrefix: "",
      needle: "",
      onlyImmediate: true,
    });
    expect(scope("./src")).toEqual({
      searchRoot: cwd,
      displayPrefix: "",
      needle: "src",
      onlyImmediate: false,
    });
  });

  it("clamps excessive leading parents at the filesystem root", () => {
    const root = path.parse(cwd).root;
    expect(scope("../../../../../../foo")).toEqual({
      searchRoot: root,
      displayPrefix: "../../../../../../",
      needle: "foo",
      onlyImmediate: false,
    });
    expect(
      resolvePathSearchScope({ cwd: root, home, query: "../../../" }),
    ).toEqual({
      searchRoot: root,
      displayPrefix: "../../../",
      needle: "",
      onlyImmediate: true,
    });
  });

  it("rejects traversal that appears after the leading scope shorthand", () => {
    expect(scope("src/../secret")).toBeUndefined();
    expect(scope("~/../secret")).toBeUndefined();
    expect(scope("../src/../../secret")).toBeUndefined();
    expect(scope("./../secret")).toBeUndefined();
    expect(scope("/absolute")).toBeUndefined();
  });

  it("normalizes harmless separators and current-directory segments", () => {
    expect(scope("src//./tui/")).toMatchObject({
      searchRoot: cwd,
      displayPrefix: "",
      needle: "src/tui/",
      onlyImmediate: false,
    });
    expect(scope("..\\README")).toMatchObject({
      searchRoot: "/workspace/projects",
      displayPrefix: "../",
      needle: "README",
    });
  });

  it("rejects NUL and other control characters in any input", () => {
    expect(scope("src\0secret")).toBeUndefined();
    expect(scope("src\nsecret")).toBeUndefined();
    expect(resolvePathSearchScope({ cwd: `${cwd}\0`, home, query: "foo" })).toBeUndefined();
    expect(resolvePathSearchScope({ cwd, home: `${home}\n`, query: "foo" })).toBeUndefined();
  });

  it("exports a parse-oriented alias", () => {
    expect(parsePathScope({ cwd, home, query: "foo" })).toEqual(scope("foo"));
  });
});
