import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { ArbError } from "../src/error.js";
import { parseIcu } from "../src/icu.js";
import { parseArb } from "../src/json.js";
import { resolveSettings } from "../src/settings.js";
import { settings } from "./helpers.js";

const json = (source: string) => parseArb(new TextEncoder().encode(source), "test.arb");

describe("native JSON validation and duplicate-key scanner", () => {
  test.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"@@data":[{"a":1,"a":2}]}',
    '{"@@data":{"a\\"b":1,"a\\"b":2}}',
  ])("rejects duplicate decoded keys in %s", (source) => {
    expect(() => json(source)).toThrow("Duplicate JSON key");
  });

  test.each([
    '{"@@data":[{"a":1},{"a":2}]}',
    '{"@@data":{"a":"{\\"a\\":1,\\"a\\":2}","b":"a:b,c"}}',
    '{"true":"true","false":false,"null":null,"0":0,"a":[],"b":{}}',
    '{"__proto__":{"a":1},"constructor":"safe"}',
    '{"@@data":[1e30,-0,1.25e-5,true,false,null,"[{}],:\\"\\\\"]}',
  ])("matches JSON.parse for %s", (source) => {
    expect(json(source)).toEqual(JSON.parse(source));
  });

  test("accepts exactly 64 containers and rejects the next before recursive traversal", () => {
    expect(json(`{"@@data":${"[".repeat(63)}0${"]".repeat(63)}}`)).toHaveProperty("@@data");
    expect(() => json(`{"@@data":${"[".repeat(64)}0${"]".repeat(64)}}`)).toThrow("64 levels");
    expect(() => json(`{"@@data":${"[".repeat(10000)}0${"]".repeat(10000)}}`)).toThrow(ArbError);
  });

  test("preserves random JSON data and Unicode without confusing string contents with keys", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (value) => {
        const text = JSON.stringify(value);
        expect(json(text)).toEqual(JSON.parse(text));
      }),
      { numRuns: 250, seed: 34298 },
    );
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("界", "😀", "\u2028", "\u0000", '"', "\\", "]", "{", ":", ",")),
        (characters) => {
          const value = { [characters.join("")]: characters.join("") };
          expect(json(JSON.stringify(value))).toEqual(value);
        },
      ),
      { numRuns: 150, seed: 34298 },
    );
  });
});

describe("local ICU syntax inspector", () => {
  test.each([
    ["It's fine", "It's fine"],
    ["It''s fine", "It's fine"],
    ["'{''}'", "{'}"],
    ["'{name}'", "{name}"],
    ["'#' outside", "'#' outside"],
    ["'ordinary'", "'ordinary'"],
  ])("decodes ICU apostrophes in %s", (source, expected) => {
    expect(parseIcu(source, 10)).toEqual([{ type: "text", value: expected }]);
  });

  test("recognizes Unicode arguments, formatter styles, ordinals and plural offsets", () => {
    expect(parseIcu("{名前} {n, number} {d, date, ::yMMMMd}", 10)).toMatchObject([
      { type: "argument", name: "名前" },
      { type: "text", value: " " },
      { type: "formatter", formatter: "number" },
      { type: "text", value: " " },
      { type: "formatter", formatter: "date", style: "::yMMMMd" },
    ]);
    expect(parseIcu("{n, selectordinal, offset:2 one {#st} other {'#'th}}", 2)).toEqual([
      {
        type: "choice",
        name: "n",
        kind: "selectordinal",
        offset: 2,
        cases: [
          { key: "one", parts: [{ type: "pound" }, { type: "text", value: "st" }] },
          { key: "other", parts: [{ type: "text", value: "#th" }] },
        ],
      },
    ]);
  });

  test("scans quoted and nested formatter parameters without ending the surrounding argument", () => {
    expect(parseIcu("{n, number, '{'x'}' '' {style}}", 10)).toEqual([
      { type: "formatter", name: "n", formatter: "number", style: "'{'x'}' '' {style}" },
    ]);
  });

  test.each([
    ["}", "closing brace"],
    ["{", "identifier"],
    ["{n", "Expected"],
    ["{n, number, x", "opening brace"],
    ["'{", "apostrophe"],
    ["{n, select, other {x}", "identifier"],
    ["{n, select, yes {x}}", "other case"],
    ["{n, select, offset:1 other {x}}", "cannot have a plural offset"],
    ["{n, select, =1 {x} other {y}}", "exact plural case"],
    ["{n, plural, bad {x} other {y}}", "Invalid plural category"],
    ["{n, plural, other {x} other {y}}", "Duplicate"],
    ["{n, plural, other {x", "opening brace"],
    [`{n, plural, offset:${"9".repeat(400)} other {x}}`, "finite"],
  ])("rejects malformed ICU: %s", (source, message) => {
    expect(() => parseIcu(source, 10)).toThrow(message);
  });

  test("bounds Cartesian expansion before invoking the mapper", () => {
    const source = "{a, select, x {X} other {Y}}{b, select, x {X} other {Y}}";
    expect(parseIcu(source, 4)).toHaveLength(2);
    expect(() => parseIcu(source, 3)).toThrow("maxVariants");
    expect(() => parseIcu("{a, select, other {x} x {y} y {z}}", 2)).toThrow("maxVariants");
  });

  test("enforces nesting before a deeply recursive parser can overflow", () => {
    const nested = (count: number) =>
      `${"{n, select, other {".repeat(count)}text${"}}".repeat(count)}`;
    expect(parseIcu(nested(32), 1)).toHaveLength(1);
    expect(() => parseIcu(nested(33), 1)).toThrow("32 levels");
    expect(() => parseIcu(nested(10000), 1)).toThrow(ArbError);
    expect(() => parseIcu(`{n, number, ${"{".repeat(33)}x${"}".repeat(33)}}`, 1)).toThrow(
      "32 levels",
    );
  });
});

test.each([null, [], false, 1, "bad"])("rejects non-object plugin configuration %j", (value) => {
  const project = { ...settings(), "plugin.inlang.arb": value };
  expect(() =>
    resolveSettings(project as unknown as Parameters<typeof resolveSettings>[0]),
  ).toThrow("Invalid settings");
});
