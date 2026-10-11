/**
 * Licence of this file: the test inputs are adapted from the examples of the
 * CommonMark Spec, version 0.31.2, by John MacFarlane, and of the GitHub
 * Flavored Markdown Spec, version 0.29-gfm, by GitHub, Inc. Both specs are
 * licensed under the Creative Commons Attribution-ShareAlike 4.0
 * International licence (https://creativecommons.org/licenses/by-sa/4.0/),
 * so this file is too, unlike the rest of texwright (MIT). See
 * THIRD-PARTY-NOTICES.md. https://spec.commonmark.org/0.31.2/ and
 * https://github.github.com/gfm/
 *
 * CommonMark 0.31 spec examples (and GFM tables and strikethrough), checked
 * as texwright document trees rather than HTML. The numbers label the cases
 * with the spec's example numbering as closely as it was reconstructed (the
 * spec itself is not bundled), so treat them as approximate. Where
 * texwright's dialect deliberately differs from plain
 * CommonMark the expectation says so: smart typography (curly quotes,
 * dashes), bare URLs and e-mail addresses becoming links, a paragraph holding
 * only an image becoming a figure, and leading Unicode spaces trimmed from
 * paragraphs. Heading ids are texwright's own and are left out of the
 * comparison, and so are the empty Text nodes the converter leaves where a
 * strong pair sits directly inside emphasis (`***foo***`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Block, Inline } from "../src/ast.js";
import { memoryContext } from "../src/parse/context.js";
import { parseMarkdown } from "../src/parse/markdown.js";

const isEmptyText = (n: unknown): boolean => typeof n === "object" && n !== null && (n as Inline).t === "Text" && (n as { text: string }).text === "";

/** Blocks of `src`, without positions, heading ids or empty Text nodes. */
function blocks(src: string): Block[] {
  const doc = parseMarkdown(src, memoryContext({}));
  return JSON.parse(
    JSON.stringify(doc.blocks, function (this: Record<string, unknown>, key, value) {
      if (key === "pos") return undefined;
      if (key === "id" && this.t === "Heading") return undefined;
      return Array.isArray(value) ? value.filter((v) => !isEmptyText(v)) : value;
    }),
  );
}

type In = Inline | string;
const ins = (c: In[]): Inline[] => c.map((x) => (typeof x === "string" ? { t: "Text", text: x } : x));
const sb: Inline = { t: "SoftBreak" };
const lb: Inline = { t: "LineBreak" };
const em = (...c: In[]): Inline => ({ t: "Emph", content: ins(c) });
const strong = (...c: In[]): Inline => ({ t: "Strong", content: ins(c) });
const strike = (...c: In[]): Inline => ({ t: "Strike", content: ins(c) });
const code = (text: string): Inline => ({ t: "Code", text });
const link = (url: string, ...c: In[]): Inline => ({ t: "Link", url, content: ins(c) });
const linkT = (url: string, title: string, ...c: In[]): Inline => ({ t: "Link", url, title, content: ins(c) });
const img = (src: string, alt: In[], title?: string): Inline => (title ? { t: "Image", src, alt: ins(alt), title } : { t: "Image", src, alt: ins(alt) });
const raw = (text: string): Inline => ({ t: "RawInline", format: "html", text });
const p = (...c: In[]): Block => ({ t: "Para", content: ins(c) });
const plain = (...c: In[]): Block => ({ t: "Plain", content: ins(c) });
const h = (level: 1 | 2 | 3 | 4 | 5 | 6, ...c: In[]): Block => ({ t: "Heading", level, content: ins(c), numbered: true });
const quote = (...b: Block[]): Block => ({ t: "BlockQuote", blocks: b });
const hr: Block = { t: "HorizontalRule" };
const html = (text: string): Block => ({ t: "RawBlock", format: "html", text });
const pre = (text: string, lang?: string): Block => (lang ? { t: "CodeBlock", text, lang } : { t: "CodeBlock", text });
const ul = (tight: boolean, ...items: Block[][]): Block => ({ t: "List", ordered: false, tight, items });
const ol = (start: number, tight: boolean, ...items: Block[][]): Block => ({ t: "List", ordered: true, start, tight, items });

interface Case {
  /** Spec example number, or a short name for GFM and texwright cases. */
  ex: number | string;
  md: string;
  out: Block[];
  note?: string;
}

function run(title: string, cases: Case[]): void {
  describe(title, () => {
    for (const c of cases) {
      it(`${typeof c.ex === "number" ? `example ${c.ex}` : c.ex}: ${JSON.stringify(c.md).slice(0, 60)}${c.note ? ` (${c.note})` : ""}`, () => {
        assert.deepEqual(blocks(c.md), c.out);
      });
    }
  });
}

run("tabs", [
  { ex: 1, md: "\tfoo\tbaz\t\tbim", out: [pre("foo\tbaz\t\tbim")] },
  { ex: 2, md: "  \tfoo\tbaz\t\tbim", out: [pre("foo\tbaz\t\tbim")] },
  { ex: 3, md: "    a\ta\n    ὐ\ta", out: [pre("a\ta\nὐ\ta")] },
  { ex: 4, md: "  - foo\n\n\tbar", out: [ul(false, [p("foo"), p("bar")])] },
  { ex: 5, md: "- foo\n\n\t\tbar", out: [ul(false, [p("foo"), pre("  bar")])] },
  { ex: 6, md: ">\t\tfoo", out: [quote(pre("  foo"))] },
  { ex: 7, md: "-\t\tfoo", out: [ul(true, [pre("  foo")])] },
  { ex: 8, md: "    foo\n\tbar", out: [pre("foo\nbar")] },
  { ex: 9, md: " - foo\n   - bar\n\t - baz", out: [ul(true, [plain("foo"), ul(true, [plain("bar"), ul(true, [plain("baz")])])])] },
  { ex: 10, md: "#\tFoo", out: [h(1, "Foo")] },
  { ex: 11, md: "*\t*\t*\t", out: [hr] },
]);

run("backslash escapes", [
  {
    ex: 14,
    md: '\\*not emphasized*\n\\<br/> not a tag\n\\[not a link](/foo)\n\\`not code`\n1\\. not a list\n\\* not a list\n\\# not a heading\n\\[foo]: /url "not a reference"\n\\&ouml; not a character entity',
    out: [
      p(
        "*not emphasized*", sb, "<br/> not a tag", sb, "[not a link](/foo)", sb, "`not code`", sb, "1. not a list", sb, "* not a list", sb,
        "# not a heading", sb, "[foo]: /url \u201cnot a reference\u201d", sb, "&ouml; not a character entity",
      ),
    ],
    note: "smart quotes",
  },
  { ex: 15, md: "\\\\*emphasis*", out: [p("\\", em("emphasis"))] },
  { ex: 16, md: "foo\\\nbar", out: [p("foo", lb, "bar")] },
  { ex: 17, md: "`` \\[\\` ``", out: [p(code("\\[\\`"))] },
  { ex: 18, md: "    \\[\\]", out: [pre("\\[\\]")] },
  { ex: 19, md: "~~~\n\\[\\]\n~~~", out: [pre("\\[\\]")] },
  { ex: 20, md: "<https://example.com?find=\\*>", out: [p(link("https://example.com?find=%5C*", "https://example.com?find=\\*"))] },
  { ex: 21, md: '<a href="/bar\\/)">', out: [html('<a href="/bar\\/)">')] },
  { ex: 22, md: '[foo](/bar\\* "ti\\*tle")', out: [p(linkT("/bar*", "ti*tle", "foo"))] },
  { ex: 23, md: '[foo]\n\n[foo]: /bar\\* "ti\\*tle"', out: [p(linkT("/bar*", "ti*tle", "foo"))] },
  { ex: 24, md: "``` foo\\+bar\nfoo\n```", out: [pre("foo", "foo+bar")] },
]);

run("entity and numeric character references", [
  {
    ex: 25,
    md: "&nbsp; &amp; &copy; &AElig; &Dcaron;\n&frac34; &HilbertSpace; &DifferentialD;\n&ClockwiseContourIntegral; &ngE;",
    out: [p("& \u00a9 \u00c6 \u010e", sb, "\u00be \u210b \u2146", sb, "\u2232 \u2267\u0338")],
    note: "the leading no-break space is trimmed from the paragraph",
  },
  { ex: 26, md: "&#35; &#1234; &#992; &#0;", out: [p("# \u04d2 \u03e0 \ufffd")] },
  { ex: 27, md: "&#X22; &#XD06; &#xcab;", out: [p('" \u0d06 \u0cab')] },
  { ex: 28, md: "&nbsp &x; &#; &#x;\n&#87654321;\n&#abcdef0;\n&ThisIsNotDefined; &hi?;", out: [p("&nbsp &x; &#; &#x;", sb, "&#87654321;", sb, "&#abcdef0;", sb, "&ThisIsNotDefined; &hi?;")] },
  { ex: 29, md: "&copy", out: [p("&copy")] },
  { ex: 30, md: "&MadeUpEntity;", out: [p("&MadeUpEntity;")] },
  { ex: 31, md: '<a href="&ouml;&ouml;.html">', out: [html('<a href="&ouml;&ouml;.html">')] },
  { ex: 32, md: '[foo](/f&ouml;&ouml; "f&ouml;&ouml;")', out: [p(linkT("/f%C3%B6%C3%B6", "f\u00f6\u00f6", "foo"))] },
  { ex: 33, md: '[foo]\n\n[foo]: /f&ouml;&ouml; "f&ouml;&ouml;"', out: [p(linkT("/f%C3%B6%C3%B6", "f\u00f6\u00f6", "foo"))] },
  { ex: 34, md: "``` f&ouml;&ouml;\nfoo\n```", out: [pre("foo", "f\u00f6\u00f6")] },
  { ex: 35, md: "`f&ouml;&ouml;`", out: [p(code("f&ouml;&ouml;"))] },
  { ex: 36, md: "    f&ouml;f&ouml;", out: [pre("f&ouml;f&ouml;")] },
  { ex: 37, md: "&#42;foo&#42;\n*foo*", out: [p("*foo*", sb, em("foo"))] },
  { ex: 38, md: "&#42; foo\n\n* foo", out: [p("* foo"), ul(true, [plain("foo")])] },
  { ex: 39, md: "foo&#10;&#10;bar", out: [p("foo\n\nbar")] },
  { ex: 41, md: "[a](url &quot;tit&quot;)", out: [p('[a](url "tit")')] },
]);

run("precedence and thematic breaks", [
  { ex: 42, md: "- `one\n- two`", out: [ul(true, [plain("`one")], [plain("two`")])] },
  { ex: 43, md: "***\n---\n___", out: [hr, hr, hr] },
  { ex: 44, md: "+++", out: [p("+++")] },
  { ex: 45, md: "===", out: [p("===")] },
  { ex: 46, md: "--\n**\n__", out: [p("\u2013", sb, "**", sb, "__")], note: "-- is an en dash" },
  { ex: 47, md: " ***\n  ***\n   ***", out: [hr, hr, hr] },
  { ex: 48, md: "    ***", out: [pre("***")] },
  { ex: 49, md: "Foo\n    ***", out: [p("Foo", sb, "***")] },
  { ex: 50, md: "_____________________________________", out: [hr] },
  { ex: 51, md: " - - -", out: [hr] },
  { ex: 52, md: " **  * ** * ** * **", out: [hr] },
  { ex: 53, md: "-     -      -      -", out: [hr] },
  { ex: 54, md: "- - - -    ", out: [hr] },
  { ex: 55, md: "_ _ _ _ a\n\na------\n\n---a---", out: [p("_ _ _ _ a"), p("a------"), p("\u2014a\u2014")], note: "--- is an em dash" },
  { ex: 56, md: " *-*", out: [p(em("-"))] },
  { ex: 57, md: "- foo\n***\n- bar", out: [ul(true, [plain("foo")]), hr, ul(true, [plain("bar")])] },
  { ex: 58, md: "Foo\n***\nbar", out: [p("Foo"), hr, p("bar")] },
  { ex: 59, md: "Foo\n---\nbar", out: [h(2, "Foo"), p("bar")] },
  { ex: 60, md: "* Foo\n* * *\n* Bar", out: [ul(true, [plain("Foo")]), hr, ul(true, [plain("Bar")])] },
  { ex: 61, md: "- Foo\n- * * *", out: [ul(true, [plain("Foo")], [hr])] },
]);

run("ATX headings", [
  { ex: 62, md: "# foo\n## foo\n### foo\n#### foo\n##### foo\n###### foo", out: [h(1, "foo"), h(2, "foo"), h(3, "foo"), h(4, "foo"), h(5, "foo"), h(6, "foo")] },
  { ex: 63, md: "####### foo", out: [p("####### foo")] },
  { ex: 64, md: "#5 bolt\n\n#hashtag", out: [p("#5 bolt"), p("#hashtag")] },
  { ex: 65, md: "\\## foo", out: [p("## foo")] },
  { ex: 66, md: "# foo *bar* \\*baz\\*", out: [h(1, "foo ", em("bar"), " *baz*")] },
  { ex: 67, md: "#                  foo                     ", out: [h(1, "foo")] },
  { ex: 68, md: " ### foo\n  ## foo\n   # foo", out: [h(3, "foo"), h(2, "foo"), h(1, "foo")] },
  { ex: 69, md: "    # foo", out: [pre("# foo")] },
  { ex: 70, md: "foo\n    # bar", out: [p("foo", sb, "# bar")] },
  { ex: 71, md: "## foo ##\n  ###   bar    ###", out: [h(2, "foo"), h(3, "bar")] },
  { ex: 72, md: "# foo ##################################\n##### foo ##", out: [h(1, "foo"), h(5, "foo")] },
  { ex: 73, md: "### foo ###     ", out: [h(3, "foo")] },
  { ex: 74, md: "### foo ### b", out: [h(3, "foo ### b")] },
  { ex: 75, md: "# foo#", out: [h(1, "foo#")] },
  { ex: 76, md: "### foo \\###\n## foo #\\##\n# foo \\#", out: [h(3, "foo ###"), h(2, "foo ###"), h(1, "foo #")] },
  { ex: 77, md: "****\n## foo\n****", out: [hr, h(2, "foo"), hr] },
  { ex: 78, md: "Foo bar\n# baz\nBar foo", out: [p("Foo bar"), h(1, "baz"), p("Bar foo")] },
  { ex: 79, md: "## \n#\n### ###", out: [h(2), h(1), h(3)] },
]);

run("setext headings", [
  { ex: 80, md: "Foo *bar*\n=========\n\nFoo *bar*\n---------", out: [h(1, "Foo ", em("bar")), h(2, "Foo ", em("bar"))] },
  { ex: 81, md: "Foo *bar\nbaz*\n====", out: [h(1, "Foo ", em("bar", sb, "baz"))] },
  { ex: 82, md: "  Foo *bar\nbaz*\t\n====", out: [h(1, "Foo ", em("bar", sb, "baz"))] },
  { ex: 83, md: "Foo\n-------------------------\n\nFoo\n=", out: [h(2, "Foo"), h(1, "Foo")] },
  { ex: 84, md: "   Foo\n---\n\n  Foo\n-----\n\n  Foo\n  ===", out: [h(2, "Foo"), h(2, "Foo"), h(1, "Foo")] },
  { ex: 85, md: "    Foo\n    ---\n\n    Foo\n---", out: [pre("Foo\n---\n\nFoo"), hr] },
  { ex: 86, md: "Foo\n   ----      ", out: [h(2, "Foo")] },
  { ex: 87, md: "Foo\n    ---", out: [p("Foo", sb, "\u2014")], note: "--- is an em dash" },
  { ex: 88, md: "Foo\n= =\n\nFoo\n--- -", out: [p("Foo", sb, "= ="), p("Foo"), hr] },
  { ex: 89, md: "Foo  \n-----", out: [h(2, "Foo")] },
  { ex: 90, md: "Foo\\\n----", out: [h(2, "Foo\\")] },
  {
    ex: 91,
    md: '`Foo\n----\n`\n\n<a title="a lot\n---\nof dashes"/>',
    out: [h(2, "`Foo"), p("`"), h(2, '<a title="a lot'), p('of dashes"/>')],
  },
  { ex: 92, md: "> Foo\n---", out: [quote(p("Foo")), hr] },
  { ex: 93, md: "> foo\nbar\n===", out: [quote(p("foo", sb, "bar", sb, "==="))] },
  { ex: 94, md: "- Foo\n---", out: [ul(true, [plain("Foo")]), hr] },
  { ex: 95, md: "Foo\nBar\n---", out: [h(2, "Foo", sb, "Bar")] },
  { ex: 96, md: "x\n\n---\nFoo\n---\nBar\n---\nBaz", out: [p("x"), hr, h(2, "Foo"), h(2, "Bar"), p("Baz")], note: "a leading paragraph keeps --- from opening front matter" },
  { ex: 97, md: "\n====", out: [p("====")] },
  { ex: 99, md: "- foo\n-----", out: [ul(true, [plain("foo")]), hr] },
  { ex: 100, md: "    foo\n---", out: [pre("foo"), hr] },
  { ex: 101, md: "> foo\n-----", out: [quote(p("foo")), hr] },
  { ex: 102, md: "\\> foo\n------", out: [h(2, "> foo")] },
  { ex: 103, md: "Foo\n\nbar\n---\nbaz", out: [p("Foo"), h(2, "bar"), p("baz")] },
  { ex: 104, md: "Foo\nbar\n\n---\n\nbaz", out: [p("Foo", sb, "bar"), hr, p("baz")] },
  { ex: 105, md: "Foo\nbar\n* * *\nbaz", out: [p("Foo", sb, "bar"), hr, p("baz")] },
]);

run("indented code", [
  { ex: 107, md: "    a simple\n      indented code block", out: [pre("a simple\n  indented code block")] },
  { ex: 108, md: "  - foo\n\n    bar", out: [ul(false, [p("foo"), p("bar")])] },
  { ex: 109, md: "1.  foo\n\n    - bar", out: [ol(1, false, [p("foo"), ul(true, [plain("bar")])])] },
  { ex: 110, md: "    <a/>\n    *hi*\n\n    - one", out: [pre("<a/>\n*hi*\n\n- one")] },
  { ex: 111, md: "    chunk1\n\n    chunk2\n  \n \n \n    chunk3", out: [pre("chunk1\n\nchunk2\n\n\n\nchunk3")] },
  { ex: 112, md: "    chunk1\n      \n      chunk2", out: [pre("chunk1\n  \n  chunk2")] },
  { ex: 113, md: "Foo\n    bar", out: [p("Foo", sb, "bar")] },
  { ex: 114, md: "    foo\nbar", out: [pre("foo"), p("bar")] },
  { ex: 115, md: "# Heading\n    foo\nHeading\n------\n    foo\n----", out: [h(1, "Heading"), pre("foo"), h(2, "Heading"), pre("foo"), hr] },
  { ex: 116, md: "        foo\n    bar", out: [pre("    foo\nbar")] },
  { ex: 117, md: "\n    \n    foo\n    ", out: [pre("foo")] },
  { ex: 118, md: "    foo  ", out: [pre("foo  ")] },
]);

run("fenced code", [
  { ex: 119, md: "```\n<\n >\n```", out: [pre("<\n >")] },
  { ex: 120, md: "~~~\n<\n >\n~~~", out: [pre("<\n >")] },
  { ex: 121, md: "``\nfoo\n``", out: [p(code("foo"))] },
  { ex: 122, md: "```\naaa\n~~~\n```", out: [pre("aaa\n~~~")] },
  { ex: 123, md: "~~~\naaa\n```\n~~~", out: [pre("aaa\n```")] },
  { ex: 124, md: "````\naaa\n```\n``````", out: [pre("aaa\n```")] },
  { ex: 125, md: "~~~~\naaa\n~~~\n~~~~", out: [pre("aaa\n~~~")] },
  { ex: 126, md: "```", out: [pre("")] },
  { ex: 127, md: "`````\n\n```\naaa", out: [pre("\n```\naaa")] },
  { ex: 128, md: "> ```\n> aaa\n\nbbb", out: [quote(pre("aaa")), p("bbb")] },
  { ex: 129, md: "```\n\n  \n```", out: [pre("\n  ")] },
  { ex: 130, md: "```\n```", out: [pre("")] },
  { ex: 131, md: " ```\n aaa\naaa\n```", out: [pre("aaa\naaa")] },
  { ex: 132, md: "  ```\naaa\n  aaa\naaa\n  ```", out: [pre("aaa\naaa\naaa")] },
  { ex: 133, md: "   ```\n   aaa\n    aaa\n  aaa\n   ```", out: [pre("aaa\n aaa\naaa")] },
  { ex: 134, md: "    ```\n    aaa\n    ```", out: [pre("```\naaa\n```")] },
  { ex: 135, md: "```\naaa\n  ```", out: [pre("aaa")] },
  { ex: 136, md: "   ```\naaa\n  ```", out: [pre("aaa")] },
  { ex: 137, md: "```\naaa\n    ```", out: [pre("aaa\n    ```")] },
  { ex: 138, md: "``` ```\naaa", out: [p(code(" "), sb, "aaa")] },
  { ex: 139, md: "~~~~~~\naaa\n~~~ ~~", out: [pre("aaa\n~~~ ~~")] },
  { ex: 140, md: "foo\n```\nbar\n```\nbaz", out: [p("foo"), pre("bar"), p("baz")] },
  { ex: 141, md: "foo\n---\n~~~\nbar\n~~~\n# baz", out: [h(2, "foo"), pre("bar"), h(1, "baz")] },
  { ex: 142, md: "```ruby\ndef foo(x)\n  return 3\nend\n```", out: [pre("def foo(x)\n  return 3\nend", "ruby")] },
  { ex: 143, md: "~~~~    ruby startline=3 $%@#$\ndef foo(x)\n  return 3\nend\n~~~~~~~", out: [pre("def foo(x)\n  return 3\nend", "ruby")] },
  { ex: 144, md: "````;\n````", out: [pre("", ";")] },
  { ex: 145, md: "``` aa ```\nfoo", out: [p(code("aa"), sb, "foo")] },
  { ex: 146, md: "~~~ aa ``` ~~~\nfoo\n~~~", out: [pre("foo", "aa")] },
  { ex: 147, md: "```\n``` aaa\n```", out: [pre("``` aaa")] },
]);

run("HTML blocks", [
  {
    ex: 148,
    md: "<table><tr><td>\n<pre>\n**Hello**,\n\n_world_.\n</pre>\n</td></tr></table>",
    out: [html("<table><tr><td>\n<pre>\n**Hello**,"), p(em("world"), ".", sb, raw("</pre>")), html("</td></tr></table>")],
  },
  {
    ex: 149,
    md: "<table>\n  <tr>\n    <td>\n           hi\n    </td>\n  </tr>\n</table>\n\nokay.",
    out: [html("<table>\n  <tr>\n    <td>\n           hi\n    </td>\n  </tr>\n</table>"), p("okay.")],
  },
  { ex: 150, md: " <div>\n  *hello*\n         <foo><a>", out: [html(" <div>\n  *hello*\n         <foo><a>")] },
  { ex: 151, md: "</div>\n*foo*", out: [html("</div>\n*foo*")] },
  { ex: 152, md: '<DIV CLASS="foo">\n\n*Markdown*\n\n</DIV>', out: [html('<DIV CLASS="foo">'), p(em("Markdown")), html("</DIV>")] },
  { ex: 153, md: '<div id="foo"\n  class="bar">\n</div>', out: [html('<div id="foo"\n  class="bar">\n</div>')] },
  { ex: 155, md: '<div id="foo">\n*hi*', out: [html('<div id="foo">\n*hi*')] },
  { ex: 156, md: "<div class\nfoo", out: [html("<div class\nfoo")] },
  { ex: 157, md: "<div *???-&&&-<---\n*foo*", out: [html("<div *???-&&&-<---\n*foo*")] },
  { ex: 158, md: '<div><a href="bar">*foo*</a></div>', out: [html('<div><a href="bar">*foo*</a></div>')] },
  { ex: 160, md: "<div></div>\n``` c\nint x = 33;\n```", out: [html("<div></div>\n``` c\nint x = 33;\n```")] },
  { ex: 161, md: '<a href="foo">\n*bar*\n</a>', out: [html('<a href="foo">\n*bar*\n</a>')] },
  { ex: 162, md: "<Warning>\n*bar*\n</Warning>", out: [html("<Warning>\n*bar*\n</Warning>")] },
  { ex: 165, md: "<del>\n\n*foo*\n\n</del>", out: [html("<del>"), p(em("foo")), html("</del>")] },
  { ex: 166, md: "<del>*foo*</del>", out: [p(raw("<del>"), em("foo"), raw("</del>"))] },
  {
    ex: 167,
    md: '<pre language="haskell"><code>\nimport Text.HTML.TagSoup\n\nmain :: IO ()\nmain = print $ parseTags tags\n</code></pre>\nokay',
    out: [html('<pre language="haskell"><code>\nimport Text.HTML.TagSoup\n\nmain :: IO ()\nmain = print $ parseTags tags\n</code></pre>'), p("okay")],
  },
  { ex: 169, md: '<style\n  type="text/css">\nh1 {color:red;}\n\np {color:blue;}\n</style>\nokay', out: [html('<style\n  type="text/css">\nh1 {color:red;}\n\np {color:blue;}\n</style>'), p("okay")] },
  { ex: 170, md: '<style\n  type="text/css">\n\nfoo', out: [html('<style\n  type="text/css">\n\nfoo')] },
  { ex: 171, md: "> <div>\n> foo\n\nbar", out: [quote(html("<div>\nfoo")), p("bar")] },
  { ex: 172, md: "- <div>\n- foo", out: [ul(true, [html("<div>")], [plain("foo")])] },
  { ex: 173, md: "<style>p{color:red;}</style>\n*foo*", out: [html("<style>p{color:red;}</style>"), p(em("foo"))] },
  { ex: 174, md: "<!-- foo -->*bar*\n*baz*", out: [html("<!-- foo -->*bar*"), p(em("baz"))] },
  { ex: 175, md: "<script>\nfoo\n</script>1. *bar*", out: [html("<script>\nfoo\n</script>1. *bar*")] },
  { ex: 176, md: "<!-- Foo\n\nbar\n   baz -->\nokay", out: [html("<!-- Foo\n\nbar\n   baz -->"), p("okay")] },
  { ex: 177, md: "<?php\n\n  echo '>';\n\n?>\nokay", out: [html("<?php\n\n  echo '>';\n\n?>"), p("okay")] },
  { ex: 178, md: "<!DOCTYPE html>", out: [html("<!DOCTYPE html>")] },
  {
    ex: 179,
    md: "<![CDATA[\nfunction matchwo(a,b)\n{\n  if (a < b && a < 0) then {\n    return 1;\n\n  } else {\n\n    return 0;\n  }\n}\n]]>\nokay",
    out: [html("<![CDATA[\nfunction matchwo(a,b)\n{\n  if (a < b && a < 0) then {\n    return 1;\n\n  } else {\n\n    return 0;\n  }\n}\n]]>"), p("okay")],
  },
  { ex: 180, md: "  <!-- foo -->\n\n    <!-- foo -->", out: [html("  <!-- foo -->"), pre("<!-- foo -->")] },
  { ex: 181, md: "  <div>\n\n    <div>", out: [html("  <div>"), pre("<div>")] },
  { ex: 182, md: "Foo\n<div>\nbar\n</div>", out: [p("Foo"), html("<div>\nbar\n</div>")] },
  { ex: 183, md: "<div>\nbar\n</div>\n*foo*", out: [html("<div>\nbar\n</div>\n*foo*")] },
  { ex: 184, md: 'Foo\n<a href="bar">\nbaz', out: [p("Foo", sb, raw('<a href="bar">'), sb, "baz")], note: "type 7 cannot interrupt a paragraph" },
  { ex: 185, md: "<div>\n\n*Emphasized* text.\n\n</div>", out: [html("<div>"), p(em("Emphasized"), " text."), html("</div>")] },
  { ex: 186, md: "<div>\n*Emphasized* text.\n</div>", out: [html("<div>\n*Emphasized* text.\n</div>")] },
  { ex: 187, md: "<table>\n\n<tr>\n\n<td>\nHi\n</td>\n\n</tr>\n\n</table>", out: [html("<table>"), html("<tr>"), html("<td>\nHi\n</td>"), html("</tr>"), html("</table>")] },
  {
    ex: 188,
    md: "<table>\n\n  <tr>\n\n    <td>\n      Hi\n    </td>\n\n  </tr>\n\n</table>",
    out: [html("<table>"), html("  <tr>"), pre("<td>\n  Hi\n</td>"), html("  </tr>"), html("</table>")],
  },
]);

run("link reference definitions", [
  { ex: 189, md: '[foo]: /url "title"\n\n[foo]', out: [p(linkT("/url", "title", "foo"))] },
  { ex: 190, md: "   [foo]: \n      /url  \n           'the title'  \n\n[foo]", out: [p(linkT("/url", "the title", "foo"))] },
  { ex: 191, md: "[Foo*bar\\]]:my_(url) 'title (with parens)'\n\n[Foo*bar\\]]", out: [p(linkT("my_(url)", "title (with parens)", "Foo*bar]"))] },
  { ex: 192, md: "[Foo bar]:\n<my url>\n'title'\n\n[Foo bar]", out: [p(linkT("my%20url", "title", "Foo bar"))] },
  { ex: 193, md: "[foo]: /url '\ntitle\nline1\nline2\n'\n\n[foo]", out: [p(linkT("/url", "\ntitle\nline1\nline2\n", "foo"))] },
  {
    ex: 194,
    md: "[foo]: /url 'title\n\nwith blank line'\n\n[foo]",
    out: [p("[foo]: /url 'title"), p("with blank line’"), p("[foo]")],
    note: "an unpaired closing quote is an apostrophe",
  },
  { ex: 195, md: "[foo]:\n/url\n\n[foo]", out: [p(link("/url", "foo"))] },
  { ex: 196, md: "[foo]:\n\n[foo]", out: [p("[foo]:"), p("[foo]")] },
  { ex: 197, md: "[foo]: <>\n\n[foo]", out: [p(link("", "foo"))] },
  { ex: 198, md: "[foo]: <bar>(baz)\n\n[foo]", out: [p("[foo]: ", raw("<bar>"), "(baz)"), p("[foo]")] },
  { ex: 199, md: '[foo]: /url\\bar\\*baz "foo\\"bar\\baz"\n\n[foo]', out: [p(linkT("/url%5Cbar*baz", 'foo"bar\\baz', "foo"))] },
  { ex: 200, md: "[foo]\n\n[foo]: url", out: [p(link("url", "foo"))] },
  { ex: 201, md: "[foo]\n\n[foo]: first\n[foo]: second", out: [p(link("first", "foo"))] },
  { ex: 202, md: "[FOO]: /url\n\n[Foo]", out: [p(link("/url", "Foo"))] },
  { ex: 203, md: "[ΑΓΩ]: /φου\n\n[αγω]", out: [p(link("/%CF%86%CE%BF%CF%85", "αγω"))] },
  { ex: 204, md: "[foo]: /url", out: [] },
  { ex: 205, md: "[\nfoo\n]: /url\nbar", out: [p("bar")] },
  { ex: 206, md: '[foo]: /url "title" ok', out: [p("[foo]: /url “title” ok")], note: "smart quotes" },
  { ex: 207, md: '[foo]: /url\n"title" ok', out: [p("“title” ok")], note: "smart quotes" },
  { ex: 208, md: '    [foo]: /url "title"\n\n[foo]', out: [pre('[foo]: /url "title"'), p("[foo]")] },
  { ex: 209, md: "```\n[foo]: /url\n```\n\n[foo]", out: [pre("[foo]: /url"), p("[foo]")] },
  { ex: 210, md: "Foo\n[bar]: /baz\n\n[bar]", out: [p("Foo", sb, "[bar]: /baz"), p("[bar]")] },
  { ex: 211, md: "# [Foo]\n[foo]: /url\n> bar", out: [h(1, link("/url", "Foo")), quote(p("bar"))] },
  { ex: 212, md: "[foo]: /url\nbar\n===\n[foo]", out: [h(1, "bar"), p(link("/url", "foo"))] },
  { ex: 213, md: "[foo]: /url\n===\n[foo]", out: [p("===", sb, link("/url", "foo"))] },
  {
    ex: 214,
    md: '[foo]: /foo-url "foo"\n[bar]: /bar-url\n  "bar"\n[baz]: /baz-url\n\n[foo],\n[bar],\n[baz]',
    out: [p(linkT("/foo-url", "foo", "foo"), ",", sb, linkT("/bar-url", "bar", "bar"), ",", sb, link("/baz-url", "baz"))],
  },
  { ex: 215, md: "[foo]\n\n> [foo]: /url", out: [p(link("/url", "foo")), quote()] },
]);

run("paragraphs and blank lines", [
  { ex: 216, md: "aaa\n\nbbb", out: [p("aaa"), p("bbb")] },
  { ex: 217, md: "aaa\nbbb\n\nccc\nddd", out: [p("aaa", sb, "bbb"), p("ccc", sb, "ddd")] },
  { ex: 218, md: "aaa\n\n\nbbb", out: [p("aaa"), p("bbb")] },
  { ex: 219, md: "  aaa\n bbb", out: [p("aaa", sb, "bbb")] },
  { ex: 220, md: "aaa\n             bbb\n                                       ccc", out: [p("aaa", sb, "bbb", sb, "ccc")] },
  { ex: 221, md: "   aaa\nbbb", out: [p("aaa", sb, "bbb")] },
  { ex: 222, md: "    aaa\nbbb", out: [pre("aaa"), p("bbb")] },
  { ex: 223, md: "aaa     \nbbb     ", out: [p("aaa", lb, "bbb")] },
  { ex: 227, md: "  \n\naaa\n  \n\n# aaa\n\n  ", out: [p("aaa"), h(1, "aaa")] },
]);

run("block quotes", [
  { ex: 228, md: "> # Foo\n> bar\n> baz", out: [quote(h(1, "Foo"), p("bar", sb, "baz"))] },
  { ex: 229, md: "># Foo\n>bar\n> baz", out: [quote(h(1, "Foo"), p("bar", sb, "baz"))] },
  { ex: 230, md: "   > # Foo\n   > bar\n > baz", out: [quote(h(1, "Foo"), p("bar", sb, "baz"))] },
  { ex: 231, md: "    > # Foo\n    > bar\n    > baz", out: [pre("> # Foo\n> bar\n> baz")] },
  { ex: 232, md: "> # Foo\n> bar\nbaz", out: [quote(h(1, "Foo"), p("bar", sb, "baz"))], note: "lazy continuation" },
  { ex: 233, md: "> bar\nbaz\n> foo", out: [quote(p("bar", sb, "baz", sb, "foo"))] },
  { ex: 234, md: "> foo\n---", out: [quote(p("foo")), hr] },
  { ex: 235, md: "> - foo\n- bar", out: [quote(ul(true, [plain("foo")])), ul(true, [plain("bar")])] },
  { ex: 236, md: ">     foo\n    bar", out: [quote(pre("foo")), pre("bar")] },
  { ex: 237, md: "> ```\nfoo\n```", out: [quote(pre("")), p("foo"), pre("")] },
  { ex: 238, md: "> foo\n    - bar", out: [quote(p("foo", sb, "- bar"))] },
  { ex: 239, md: ">", out: [quote()] },
  { ex: 240, md: ">\n>  \n> ", out: [quote()] },
  { ex: 241, md: ">\n> foo\n>  ", out: [quote(p("foo"))] },
  { ex: 242, md: "> foo\n\n> bar", out: [quote(p("foo")), quote(p("bar"))] },
  { ex: 243, md: "> foo\n> bar", out: [quote(p("foo", sb, "bar"))] },
  { ex: 244, md: "> foo\n>\n> bar", out: [quote(p("foo"), p("bar"))] },
  { ex: 245, md: "foo\n> bar", out: [p("foo"), quote(p("bar"))] },
  { ex: 246, md: "> aaa\n***\n> bbb", out: [quote(p("aaa")), hr, quote(p("bbb"))] },
  { ex: 247, md: "> bar\nbaz", out: [quote(p("bar", sb, "baz"))] },
  { ex: 248, md: "> bar\n\nbaz", out: [quote(p("bar")), p("baz")] },
  { ex: 249, md: "> bar\n>\nbaz", out: [quote(p("bar")), p("baz")] },
  { ex: 250, md: "> > > foo\nbar", out: [quote(quote(quote(p("foo", sb, "bar"))))] },
  { ex: 251, md: ">>> foo\n> bar\n>>baz", out: [quote(quote(quote(p("foo", sb, "bar", sb, "baz"))))] },
  { ex: 252, md: ">     code\n\n>    not code", out: [quote(pre("code")), quote(p("not code"))] },
]);

run("list items", [
  {
    ex: 253,
    md: "A paragraph\nwith two lines.\n\n    indented code\n\n> A block quote.",
    out: [p("A paragraph", sb, "with two lines."), pre("indented code"), quote(p("A block quote."))],
  },
  {
    ex: 254,
    md: "1.  A paragraph\n    with two lines.\n\n        indented code\n\n    > A block quote.",
    out: [ol(1, false, [p("A paragraph", sb, "with two lines."), pre("indented code"), quote(p("A block quote."))])],
  },
  { ex: 255, md: "- one\n\n two", out: [ul(true, [plain("one")]), p("two")] },
  { ex: 256, md: "- one\n\n  two", out: [ul(false, [p("one"), p("two")])] },
  { ex: 257, md: " -    one\n\n     two", out: [ul(true, [plain("one")]), pre(" two")] },
  { ex: 258, md: " -    one\n\n      two", out: [ul(false, [p("one"), p("two")])] },
  { ex: 259, md: "   > > 1.  one\n>>\n>>     two", out: [quote(quote(ol(1, false, [p("one"), p("two")])))] },
  { ex: 260, md: ">>- one\n>>\n  >  > two", out: [quote(quote(ul(true, [plain("one")]), p("two")))] },
  { ex: 261, md: "-one\n\n2.two", out: [p("-one"), p("2.two")] },
  { ex: 262, md: "- foo\n\n\n  bar", out: [ul(false, [p("foo"), p("bar")])] },
  {
    ex: 263,
    md: "1.  foo\n\n    ```\n    bar\n    ```\n\n    baz\n\n    > bam",
    out: [ol(1, false, [p("foo"), pre("bar"), p("baz"), quote(p("bam"))])],
  },
  { ex: 264, md: "- Foo\n\n      bar\n\n\n      baz", out: [ul(false, [p("Foo"), pre("bar\n\n\nbaz")])] },
  { ex: 265, md: "123456789. ok", out: [ol(123456789, true, [plain("ok")])] },
  { ex: 266, md: "1234567890. not ok", out: [p("1234567890. not ok")] },
  { ex: 267, md: "0. ok", out: [ol(0, true, [plain("ok")])] },
  { ex: 268, md: "003. ok", out: [ol(3, true, [plain("ok")])] },
  { ex: 269, md: "-1. not ok", out: [p("-1. not ok")] },
  { ex: 270, md: "- foo\n\n      bar", out: [ul(false, [p("foo"), pre("bar")])] },
  { ex: 271, md: "  10.  foo\n\n           bar", out: [ol(10, false, [p("foo"), pre("bar")])] },
  { ex: 272, md: "    indented code\n\nparagraph\n\n    more code", out: [pre("indented code"), p("paragraph"), pre("more code")] },
  { ex: 273, md: "1.     indented code\n\n   paragraph\n\n       more code", out: [ol(1, false, [pre("indented code"), p("paragraph"), pre("more code")])] },
  { ex: 274, md: "1.      indented code\n\n   paragraph\n\n       more code", out: [ol(1, false, [pre(" indented code"), p("paragraph"), pre("more code")])] },
  { ex: 275, md: "   foo\n\nbar", out: [p("foo"), p("bar")] },
  { ex: 276, md: "-    foo\n\n  bar", out: [ul(true, [plain("foo")]), p("bar")] },
  { ex: 277, md: "-  foo\n\n   bar", out: [ul(false, [p("foo"), p("bar")])] },
  { ex: 278, md: "-\n  foo\n-\n  ```\n  bar\n  ```\n-\n      baz", out: [ul(true, [plain("foo")], [pre("bar")], [pre("baz")])] },
  { ex: 279, md: "-   \n  foo", out: [ul(true, [plain("foo")])] },
  { ex: 280, md: "-\n\n  foo", out: [ul(true, []), p("foo")] },
  { ex: 281, md: "- foo\n-\n- bar", out: [ul(true, [plain("foo")], [], [plain("bar")])] },
  { ex: 282, md: "- foo\n-   \n- bar", out: [ul(true, [plain("foo")], [], [plain("bar")])] },
  { ex: 283, md: "1. foo\n2.\n3. bar", out: [ol(1, true, [plain("foo")], [], [plain("bar")])] },
  { ex: 284, md: "*", out: [ul(true, [])] },
  { ex: 285, md: "foo\n*\n\nfoo\n1.", out: [p("foo", sb, "*"), p("foo", sb, "1.")] },
  {
    ex: 286,
    md: " 1.  A paragraph\n     with two lines.\n\n         indented code\n\n     > A block quote.",
    out: [ol(1, false, [p("A paragraph", sb, "with two lines."), pre("indented code"), quote(p("A block quote."))])],
  },
  { ex: 289, md: "    1.  A paragraph\n        with two lines.", out: [pre("1.  A paragraph\n    with two lines.")] },
  {
    ex: 290,
    md: "  1.  A paragraph\nwith two lines.\n\n          indented code\n\n      > A block quote.",
    out: [ol(1, false, [p("A paragraph", sb, "with two lines."), pre("indented code"), quote(p("A block quote."))])],
    note: "lazy continuation",
  },
  { ex: 291, md: "  1.  A paragraph\n    with two lines.", out: [ol(1, true, [plain("A paragraph", sb, "with two lines.")])] },
  { ex: 292, md: "> 1. > Blockquote\ncontinued here.", out: [quote(ol(1, true, [quote(p("Blockquote", sb, "continued here."))]))] },
  { ex: 293, md: "> 1. > Blockquote\n> continued here.", out: [quote(ol(1, true, [quote(p("Blockquote", sb, "continued here."))]))] },
  {
    ex: 294,
    md: "- foo\n  - bar\n    - baz\n      - boo",
    out: [ul(true, [plain("foo"), ul(true, [plain("bar"), ul(true, [plain("baz"), ul(true, [plain("boo")])])])])],
  },
  { ex: 295, md: "- foo\n - bar\n  - baz\n   - boo", out: [ul(true, [plain("foo")], [plain("bar")], [plain("baz")], [plain("boo")])] },
  { ex: 296, md: "10) foo\n    - bar", out: [ol(10, true, [plain("foo"), ul(true, [plain("bar")])])] },
  { ex: 297, md: "10) foo\n   - bar", out: [ol(10, true, [plain("foo")]), ul(true, [plain("bar")])] },
  { ex: 298, md: "- - foo", out: [ul(true, [ul(true, [plain("foo")])])] },
  { ex: 299, md: "1. - 2. foo", out: [ol(1, true, [ul(true, [ol(2, true, [plain("foo")])])])] },
  { ex: 300, md: "- # Foo\n- Bar\n  ---\n  baz", out: [ul(true, [h(1, "Foo")], [h(2, "Bar"), plain("baz")])] },
]);

run("lists", [
  { ex: 301, md: "- foo\n- bar\n+ baz", out: [ul(true, [plain("foo")], [plain("bar")]), ul(true, [plain("baz")])] },
  { ex: 302, md: "1. foo\n2. bar\n3) baz", out: [ol(1, true, [plain("foo")], [plain("bar")]), ol(3, true, [plain("baz")])] },
  { ex: 303, md: "Foo\n- bar\n- baz", out: [p("Foo"), ul(true, [plain("bar")], [plain("baz")])] },
  { ex: 304, md: "The number of windows in my house is\n14.  The number of doors is 6.", out: [p("The number of windows in my house is", sb, "14.  The number of doors is 6.")] },
  { ex: 305, md: "The number of windows in my house is\n1.  The number of doors is 6.", out: [p("The number of windows in my house is"), ol(1, true, [plain("The number of doors is 6.")])] },
  { ex: 306, md: "- foo\n\n- bar\n\n\n- baz", out: [ul(false, [p("foo")], [p("bar")], [p("baz")])] },
  {
    ex: 307,
    md: "- foo\n  - bar\n    - baz\n\n\n      bim",
    out: [ul(true, [plain("foo"), ul(true, [plain("bar"), ul(false, [p("baz"), p("bim")])])])],
  },
  { ex: 308, md: "- foo\n- bar\n\n<!-- -->\n\n- baz\n- bim", out: [ul(true, [plain("foo")], [plain("bar")]), html("<!-- -->"), ul(true, [plain("baz")], [plain("bim")])] },
  {
    ex: 309,
    md: "-   foo\n\n    notcode\n\n-   foo\n\n<!-- -->\n\n    code",
    out: [ul(false, [p("foo"), p("notcode")], [p("foo")]), html("<!-- -->"), pre("code")],
  },
  {
    ex: 310,
    md: "- a\n - b\n  - c\n   - d\n  - e\n - f\n- g",
    out: [ul(true, [plain("a")], [plain("b")], [plain("c")], [plain("d")], [plain("e")], [plain("f")], [plain("g")])],
  },
  { ex: 311, md: "1. a\n\n  2. b\n\n   3. c", out: [ol(1, false, [p("a")], [p("b")], [p("c")])] },
  { ex: 312, md: "- a\n - b\n  - c\n   - d\n    - e", out: [ul(true, [plain("a")], [plain("b")], [plain("c")], [plain("d", sb, "- e")])] },
  { ex: 313, md: "1. a\n\n  2. b\n\n    3. c", out: [ol(1, false, [p("a")], [p("b")]), pre("3. c")] },
  { ex: 314, md: "- a\n- b\n\n- c", out: [ul(false, [p("a")], [p("b")], [p("c")])] },
  { ex: 315, md: "* a\n*\n\n* c", out: [ul(false, [p("a")], [], [p("c")])] },
  { ex: 316, md: "- a\n- b\n\n  c\n- d", out: [ul(false, [p("a")], [p("b"), p("c")], [p("d")])] },
  { ex: 317, md: "- a\n- b\n\n  [ref]: /url\n- d", out: [ul(false, [p("a")], [p("b")], [p("d")])] },
  { ex: 318, md: "- a\n- ```\n  b\n\n\n  ```\n- c", out: [ul(true, [plain("a")], [pre("b\n\n")], [plain("c")])] },
  { ex: 319, md: "- a\n  - b\n\n    c\n- d", out: [ul(true, [plain("a"), ul(false, [p("b"), p("c")])], [plain("d")])] },
  { ex: 320, md: "* a\n  > b\n  >\n* c", out: [ul(true, [plain("a"), quote(p("b"))], [plain("c")])] },
  { ex: 321, md: "- a\n  > b\n  ```\n  c\n  ```\n- d", out: [ul(true, [plain("a"), quote(p("b")), pre("c")], [plain("d")])] },
  { ex: 322, md: "- a", out: [ul(true, [plain("a")])] },
  { ex: 323, md: "- a\n  - b", out: [ul(true, [plain("a"), ul(true, [plain("b")])])] },
  { ex: 324, md: "1. ```\n   foo\n   ```\n\n   bar", out: [ol(1, false, [pre("foo"), p("bar")])] },
  { ex: 325, md: "* foo\n  * bar\n\n  baz", out: [ul(false, [p("foo"), ul(true, [plain("bar")]), p("baz")])] },
  {
    ex: 326,
    md: "- a\n  - b\n  - c\n\n- d\n  - e\n  - f",
    out: [ul(false, [p("a"), ul(true, [plain("b")], [plain("c")])], [p("d"), ul(true, [plain("e")], [plain("f")])])],
  },
]);

run("code spans", [
  { ex: 328, md: "`foo`", out: [p(code("foo"))] },
  { ex: 329, md: "`` foo ` bar ``", out: [p(code("foo ` bar"))] },
  { ex: 330, md: "` `` `", out: [p(code("``"))] },
  { ex: 331, md: "`  ``  `", out: [p(code(" `` "))] },
  { ex: 332, md: "` a`", out: [p(code(" a"))] },
  { ex: 333, md: "`\u00a0b\u00a0`", out: [p(code("\u00a0b\u00a0"))] },
  { ex: 334, md: "` `\n`  `", out: [p(code(" "), sb, code("  "))] },
  { ex: 335, md: "``\nfoo\nbar  \nbaz\n``", out: [p(code("foo bar   baz"))] },
  { ex: 336, md: "``\nfoo \n``", out: [p(code("foo "))] },
  { ex: 337, md: "`foo   bar \nbaz`", out: [p(code("foo   bar  baz"))] },
  { ex: 338, md: "`foo\\`bar`", out: [p(code("foo\\"), "bar`")] },
  { ex: 339, md: "``foo`bar``", out: [p(code("foo`bar"))] },
  { ex: 340, md: "` foo `` bar `", out: [p(code("foo `` bar"))] },
  { ex: 341, md: "*foo`*`", out: [p("*foo", code("*"))] },
  { ex: 342, md: "[not a `link](/foo`)", out: [p("[not a ", code("link](/foo"), ")")] },
  { ex: 343, md: '`<a href="`">`', out: [p(code('<a href="'), '">`')] },
  { ex: 344, md: '<a href="`">`', out: [p(raw('<a href="`">'), "`")] },
  { ex: 345, md: "`<https://foo.bar.`baz>`", out: [p(code("<https://foo.bar."), "baz>`")] },
  { ex: 346, md: "<https://foo.bar.`baz>`", out: [p(link("https://foo.bar.%60baz", "https://foo.bar.`baz"), "`")] },
  { ex: 347, md: "```foo``", out: [p("```foo``")] },
  { ex: 348, md: "`foo", out: [p("`foo")] },
  { ex: 349, md: "`foo``bar``", out: [p("`foo", code("bar"))] },
]);

run("emphasis and strong emphasis", [
  { ex: 350, md: "*foo bar*", out: [p(em("foo bar"))] },
  { ex: 351, md: "a * foo bar*", out: [p("a * foo bar*")] },
  { ex: 352, md: 'a*"foo"*', out: [p("a*\u201cfoo\u201d*")], note: "smart quotes" },
  { ex: 353, md: "* a *", out: [ul(true, [plain("a *")])] },
  { ex: 354, md: "foo*bar*", out: [p("foo", em("bar"))] },
  { ex: 355, md: "5*6*78", out: [p("5", em("6"), "78")] },
  { ex: 356, md: "_foo bar_", out: [p(em("foo bar"))] },
  { ex: 357, md: "_ foo bar_", out: [p("_ foo bar_")] },
  { ex: 359, md: "foo_bar_", out: [p("foo_bar_")] },
  { ex: 360, md: "5_6_78", out: [p("5_6_78")] },
  { ex: 361, md: "пристаням_стремятся_", out: [p("пристаням_стремятся_")] },
  { ex: 363, md: "foo-_(bar)_", out: [p("foo-", em("(bar)"))] },
  { ex: 364, md: "_foo*", out: [p("_foo*")] },
  { ex: 365, md: "*foo bar *", out: [p("*foo bar *")] },
  { ex: 366, md: "*foo bar\n*", out: [p("*foo bar", sb, "*")] },
  { ex: 367, md: "*(*foo)", out: [p("*(*foo)")] },
  { ex: 368, md: "*(*foo*)*", out: [p(em("(", em("foo"), ")"))] },
  { ex: 369, md: "*foo*bar", out: [p(em("foo"), "bar")] },
  { ex: 370, md: "_foo bar _", out: [p("_foo bar _")] },
  { ex: 371, md: "_(_foo)", out: [p("_(_foo)")] },
  { ex: 372, md: "_(_foo_)_", out: [p(em("(", em("foo"), ")"))] },
  { ex: 373, md: "_foo_bar", out: [p("_foo_bar")] },
  { ex: 374, md: "_пристаням_стремятся", out: [p("_пристаням_стремятся")] },
  { ex: 375, md: "_foo_bar_baz_", out: [p(em("foo_bar_baz"))] },
  { ex: 376, md: "_(bar)_.", out: [p(em("(bar)"), ".")] },
  { ex: 377, md: "**foo bar**", out: [p(strong("foo bar"))] },
  { ex: 378, md: "** foo bar**", out: [p("** foo bar**")] },
  { ex: 380, md: "foo**bar**", out: [p("foo", strong("bar"))] },
  { ex: 381, md: "__foo bar__", out: [p(strong("foo bar"))] },
  { ex: 382, md: "__ foo bar__", out: [p("__ foo bar__")] },
  { ex: 383, md: "__\nfoo bar__", out: [p("__", sb, "foo bar__")] },
  { ex: 385, md: "foo__bar__", out: [p("foo__bar__")] },
  { ex: 386, md: "5__6__78", out: [p("5__6__78")] },
  { ex: 388, md: "__foo, __bar__, baz__", out: [p(strong("foo, ", strong("bar"), ", baz"))] },
  { ex: 389, md: "foo-__(bar)__", out: [p("foo-", strong("(bar)"))] },
  { ex: 390, md: "**foo bar **", out: [p("**foo bar **")] },
  { ex: 391, md: "**(**foo)", out: [p("**(**foo)")] },
  { ex: 392, md: "*(**foo**)*", out: [p(em("(", strong("foo"), ")"))] },
  {
    ex: 393,
    md: "**Gomphocarpus (*Gomphocarpus physocarpus*, syn.\n*Asclepias physocarpa*)**",
    out: [p(strong("Gomphocarpus (", em("Gomphocarpus physocarpus"), ", syn.", sb, em("Asclepias physocarpa"), ")"))],
  },
  { ex: 394, md: '**foo "*bar*" foo**', out: [p(strong("foo \u201c", em("bar"), "\u201d foo"))], note: "smart quotes" },
  { ex: 395, md: "**foo**bar", out: [p(strong("foo"), "bar")] },
  { ex: 396, md: "__foo bar __", out: [p("__foo bar __")] },
  { ex: 397, md: "__(__foo)", out: [p("__(__foo)")] },
  { ex: 398, md: "_(__foo__)_", out: [p(em("(", strong("foo"), ")"))] },
  { ex: 399, md: "__foo__bar", out: [p("__foo__bar")] },
  { ex: 401, md: "__foo__bar__baz__", out: [p(strong("foo__bar__baz"))] },
  { ex: 402, md: "__(bar)__.", out: [p(strong("(bar)"), ".")] },
  { ex: 403, md: "*foo [bar](/url)*", out: [p(em("foo ", link("/url", "bar")))] },
  { ex: 404, md: "*foo\nbar*", out: [p(em("foo", sb, "bar"))] },
  { ex: 405, md: "_foo __bar__ baz_", out: [p(em("foo ", strong("bar"), " baz"))] },
  { ex: 406, md: "_foo _bar_ baz_", out: [p(em("foo ", em("bar"), " baz"))] },
  { ex: 407, md: "__foo_ bar_", out: [p(em(em("foo"), " bar"))] },
  { ex: 408, md: "*foo *bar**", out: [p(em("foo ", em("bar")))] },
  { ex: 409, md: "*foo **bar** baz*", out: [p(em("foo ", strong("bar"), " baz"))] },
  { ex: 410, md: "*foo**bar**baz*", out: [p(em("foo", strong("bar"), "baz"))], note: "the rule of 3 does not apply between two runs of two" },
  { ex: 411, md: "*foo**bar*", out: [p(em("foo**bar"))], note: "rule of 3" },
  { ex: 412, md: "***foo** bar*", out: [p(em(strong("foo"), " bar"))] },
  { ex: 413, md: "*foo **bar***", out: [p(em("foo ", strong("bar")))] },
  { ex: 414, md: "*foo**bar***", out: [p(em("foo", strong("bar")))] },
  { ex: 415, md: "foo***bar***baz", out: [p("foo", em(strong("bar")), "baz")] },
  { ex: 416, md: "foo******bar*********baz", out: [p("foo", strong(strong(strong("bar"))), "***baz")] },
  { ex: 417, md: "*foo **bar *baz* bim** bop*", out: [p(em("foo ", strong("bar ", em("baz"), " bim"), " bop"))] },
  { ex: 418, md: "*foo [*bar*](/url)*", out: [p(em("foo ", link("/url", em("bar"))))] },
  { ex: 419, md: "** is not an empty emphasis", out: [p("** is not an empty emphasis")] },
  { ex: 420, md: "**** is not an empty strong emphasis", out: [p("**** is not an empty strong emphasis")] },
  { ex: 421, md: "**foo [bar](/url)**", out: [p(strong("foo ", link("/url", "bar")))] },
  { ex: 422, md: "**foo\nbar**", out: [p(strong("foo", sb, "bar"))] },
  { ex: 423, md: "__foo _bar_ baz__", out: [p(strong("foo ", em("bar"), " baz"))] },
  { ex: 424, md: "__foo __bar__ baz__", out: [p(strong("foo ", strong("bar"), " baz"))] },
  { ex: 425, md: "____foo__ bar__", out: [p(strong(strong("foo"), " bar"))] },
  { ex: 426, md: "**foo **bar****", out: [p(strong("foo ", strong("bar")))] },
  { ex: 427, md: "**foo *bar* baz**", out: [p(strong("foo ", em("bar"), " baz"))] },
  { ex: 428, md: "**foo*bar*baz**", out: [p(strong("foo", em("bar"), "baz"))] },
  { ex: 429, md: "***foo* bar**", out: [p(strong(em("foo"), " bar"))] },
  { ex: 430, md: "**foo *bar***", out: [p(strong("foo ", em("bar")))] },
  { ex: 431, md: "**foo *bar **baz**\nbim* bop**", out: [p(strong("foo ", em("bar ", strong("baz"), sb, "bim"), " bop"))] },
  { ex: 432, md: "**foo [*bar*](/url)**", out: [p(strong("foo ", link("/url", em("bar"))))] },
  { ex: 433, md: "__ is not an empty emphasis", out: [p("__ is not an empty emphasis")] },
  { ex: 435, md: "foo ***", out: [p("foo ***")] },
  { ex: 436, md: "foo *\\**", out: [p("foo ", em("*"))] },
  { ex: 437, md: "foo *_*", out: [p("foo ", em("_"))] },
  { ex: 438, md: "foo *****", out: [p("foo *****")] },
  { ex: 439, md: "foo **\\***", out: [p("foo ", strong("*"))] },
  { ex: 440, md: "foo **_**", out: [p("foo ", strong("_"))] },
  { ex: 441, md: "**foo*", out: [p("*", em("foo"))] },
  { ex: 442, md: "*foo**", out: [p(em("foo"), "*")] },
  { ex: 443, md: "***foo**", out: [p("*", strong("foo"))] },
  { ex: 444, md: "****foo*", out: [p("***", em("foo"))] },
  { ex: 445, md: "**foo***", out: [p(strong("foo"), "*")] },
  { ex: 446, md: "*foo****", out: [p(em("foo"), "***")] },
  { ex: 447, md: "foo ___", out: [p("foo ___")] },
  { ex: 448, md: "foo _\\__", out: [p("foo ", em("_"))] },
  { ex: 449, md: "foo _*_", out: [p("foo ", em("*"))] },
  { ex: 453, md: "__foo_", out: [p("_", em("foo"))] },
  { ex: 454, md: "_foo__", out: [p(em("foo"), "_")] },
  { ex: 455, md: "___foo__", out: [p("_", strong("foo"))] },
  { ex: 459, md: "**foo**", out: [p(strong("foo"))] },
  { ex: 460, md: "*_foo_*", out: [p(em(em("foo")))] },
  { ex: 461, md: "__foo__", out: [p(strong("foo"))] },
  { ex: 462, md: "_*foo*_", out: [p(em(em("foo")))] },
  { ex: 463, md: "****foo****", out: [p(strong(strong("foo")))] },
  { ex: 464, md: "____foo____", out: [p(strong(strong("foo")))] },
  { ex: 465, md: "******foo******", out: [p(strong(strong(strong("foo"))))] },
  { ex: 466, md: "***foo***", out: [p(em(strong("foo")))] },
  { ex: 467, md: "_____foo_____", out: [p(em(strong(strong("foo"))))] },
  { ex: 468, md: "*foo _bar* baz_", out: [p(em("foo _bar"), " baz_")] },
  { ex: 469, md: "*foo __bar *baz bim__ bam*", out: [p(em("foo ", strong("bar *baz bim"), " bam"))] },
  { ex: 470, md: "**foo **bar baz**", out: [p("**foo ", strong("bar baz"))] },
  { ex: 471, md: "*foo *bar baz*", out: [p("*foo ", em("bar baz"))] },
  { ex: 472, md: "*[bar*](/url)", out: [p("*", link("/url", "bar*"))] },
  { ex: 473, md: "_foo [bar_](/url)", out: [p("_foo ", link("/url", "bar_"))] },
  { ex: 474, md: '*<img src="foo" title="*"/>', out: [p("*", raw('<img src="foo" title="*"/>'))] },
  { ex: 475, md: '**<a href="**">', out: [p("**", raw('<a href="**">'))] },
  { ex: 476, md: '__<a href="__">', out: [p("__", raw('<a href="__">'))] },
  { ex: 477, md: "*a `*`*", out: [p(em("a ", code("*")))] },
  { ex: 478, md: "_a `_`_", out: [p(em("a ", code("_")))] },
  { ex: 479, md: "**a<https://foo.bar/?q=**>", out: [p("**a", link("https://foo.bar/?q=**", "https://foo.bar/?q=**"))] },
  { ex: 480, md: "__a<https://foo.bar/?q=__>", out: [p("__a", link("https://foo.bar/?q=__", "https://foo.bar/?q=__"))] },
]);

run("GFM strikethrough", [
  { ex: "gfm 491", md: "~~Hi~~ Hello, world!", out: [p(strike("Hi"), " Hello, world!")] },
  { ex: "gfm 492", md: "This ~~has a\n\nnew paragraph~~.", out: [p("This ~~has a"), p("new paragraph~~.")] },
  { ex: "single tilde", md: "~one~ stays, ~ two ~ too", out: [p({ t: "Subscript", content: [{ t: "Text", text: "one" }] }, " stays, ~ two ~ too")], note: "a single tilde pair is pandoc's subscript; with spaces inside it stays text" },
  { ex: "strike with emphasis", md: "~~*a* b~~", out: [p(strike(em("a"), " b"))] },
]);

run("links", [
  { ex: 482, md: '[link](/uri "title")', out: [p(linkT("/uri", "title", "link"))] },
  { ex: 483, md: "[link](/uri)", out: [p(link("/uri", "link"))] },
  { ex: 484, md: "[](./target.md)", out: [p(link("./target.md"))] },
  { ex: 485, md: "[link]()", out: [p(link("", "link"))] },
  { ex: 486, md: "[link](<>)", out: [p(link("", "link"))] },
  { ex: 487, md: "[]()", out: [p(link(""))] },
  { ex: 488, md: "[link](/my uri)", out: [p("[link](/my uri)")] },
  { ex: 489, md: "[link](</my uri>)", out: [p(link("/my%20uri", "link"))] },
  { ex: 490, md: "[link](foo\nbar)", out: [p("[link](foo", sb, "bar)")] },
  { ex: 491, md: "[link](<foo\nbar>)", out: [p("[link](", raw("<foo\nbar>"), ")")] },
  { ex: 492, md: "[a](<b)c>)", out: [p(link("b)c", "a"))] },
  { ex: 493, md: "[link](<foo\\>)", out: [p("[link](<foo>)")] },
  { ex: 494, md: "[a](<b)c\n[a](<b)c>\n[a](<b>c)", out: [p("[a](<b)c", sb, "[a](<b)c>", sb, "[a](", raw("<b>"), "c)")] },
  { ex: 495, md: "[link](\\(foo\\))", out: [p(link("(foo)", "link"))] },
  { ex: 496, md: "[link](foo(and(bar)))", out: [p(link("foo(and(bar))", "link"))] },
  { ex: 497, md: "[link](foo(and(bar))", out: [p("[link](foo(and(bar))")] },
  { ex: 498, md: "[link](foo\\(and\\(bar\\))", out: [p(link("foo(and(bar)", "link"))] },
  { ex: 499, md: "[link](<foo(and(bar)>)", out: [p(link("foo(and(bar)", "link"))] },
  { ex: 500, md: "[link](foo\\)\\:)", out: [p(link("foo):", "link"))] },
  {
    ex: 501,
    md: "[link](#fragment)\n\n[link](https://example.com#fragment)\n\n[link](https://example.com?foo=3#frag)",
    out: [p(link("#fragment", "link")), p(link("https://example.com#fragment", "link")), p(link("https://example.com?foo=3#frag", "link"))],
  },
  { ex: 502, md: "[link](foo\\bar)", out: [p(link("foo%5Cbar", "link"))] },
  { ex: 503, md: "[link](foo%20b&auml;)", out: [p(link("foo%20b%C3%A4", "link"))] },
  { ex: 504, md: '[link]("title")', out: [p(link("%22title%22", "link"))] },
  {
    ex: 505,
    md: "[link](/url \"title\")\n[link](/url 'title')\n[link](/url (title))",
    out: [p(linkT("/url", "title", "link"), sb, linkT("/url", "title", "link"), sb, linkT("/url", "title", "link"))],
  },
  { ex: 506, md: '[link](/url "title \\"&quot;")', out: [p(linkT("/url", 'title ""', "link"))] },
  { ex: 507, md: '[link](/url\u00a0"title")', out: [p(link("/url%C2%A0%22title%22", "link"))] },
  { ex: 509, md: "[link](/url 'title \"and\" title')", out: [p(linkT("/url", 'title "and" title', "link"))] },
  { ex: 510, md: '[link](   /uri\n  "title"  )', out: [p(linkT("/uri", "title", "link"))] },
  { ex: 511, md: "[link] (/uri)", out: [p("[link] (/uri)")] },
  { ex: 512, md: "[link [foo [bar]]](/uri)", out: [p(link("/uri", "link [foo [bar]]"))] },
  { ex: 513, md: "[link] bar](/uri)", out: [p("[link] bar](/uri)")] },
  { ex: 514, md: "[link [bar](/uri)", out: [p("[link ", link("/uri", "bar"))] },
  { ex: 515, md: "[link \\[bar](/uri)", out: [p(link("/uri", "link [bar"))] },
  { ex: 516, md: "[link *foo **bar** `#`*](/uri)", out: [p(link("/uri", "link ", em("foo ", strong("bar"), " ", code("#"))))] },
  { ex: 517, md: "[![moon](moon.jpg)](/uri)", out: [p(link("/uri", img("moon.jpg", ["moon"])))] },
  { ex: 518, md: "[foo [bar](/uri)](/uri)", out: [p("[foo ", link("/uri", "bar"), "](/uri)")], note: "links do not nest" },
  { ex: 519, md: "[foo *[bar [baz](/uri)](/uri)*](/uri)", out: [p("[foo ", em("[bar ", link("/uri", "baz"), "](/uri)"), "](/uri)")] },
  { ex: 520, md: "x ![[[foo](uri1)](uri2)](uri3)", out: [p("x ", img("uri3", ["[", link("uri1", "foo"), "](uri2)"]))] },
  { ex: 521, md: "*[foo*](/uri)", out: [p("*", link("/uri", "foo*"))] },
  { ex: 522, md: "[foo *bar](baz*)", out: [p(link("baz*", "foo *bar"))] },
  { ex: 523, md: "*foo [bar* baz]", out: [p(em("foo [bar"), " baz]")] },
  { ex: 524, md: '[foo <bar attr="](baz)">', out: [p("[foo ", raw('<bar attr="](baz)">'))] },
  { ex: 525, md: "[foo`](/uri)`", out: [p("[foo", code("](/uri)"))] },
  { ex: 526, md: "[foo<https://example.com/?search=](uri)>", out: [p("[foo", link("https://example.com/?search=%5D(uri)", "https://example.com/?search=](uri)"))] },
]);

run("reference links", [
  { ex: 527, md: '[foo][bar]\n\n[bar]: /url "title"', out: [p(linkT("/url", "title", "foo"))] },
  { ex: 528, md: "[link [foo [bar]]][ref]\n\n[ref]: /uri", out: [p(link("/uri", "link [foo [bar]]"))] },
  { ex: 529, md: "[link \\[bar][ref]\n\n[ref]: /uri", out: [p(link("/uri", "link [bar"))] },
  { ex: 530, md: "[link *foo **bar** `#`*][ref]\n\n[ref]: /uri", out: [p(link("/uri", "link ", em("foo ", strong("bar"), " ", code("#"))))] },
  { ex: 532, md: "[foo [bar](/uri)][ref]\n\n[ref]: /uri", out: [p("[foo ", link("/uri", "bar"), "]", link("/uri", "ref"))] },
  { ex: 533, md: "[foo *bar [baz][ref]*][ref]\n\n[ref]: /uri", out: [p("[foo ", em("bar ", link("/uri", "baz")), "]", link("/uri", "ref"))] },
  { ex: 534, md: "*[foo*][ref]\n\n[ref]: /uri", out: [p("*", link("/uri", "foo*"))] },
  { ex: 535, md: "[foo *bar][ref]*\n\n[ref]: /uri", out: [p(link("/uri", "foo *bar"), "*")] },
  { ex: 538, md: '[foo][BaR]\n\n[bar]: /url "title"', out: [p(linkT("/url", "title", "foo"))] },
  { ex: 539, md: "[ẞ]\n\n[SS]: /url", out: [p(link("/url", "ẞ"))], note: "labels are case-folded" },
  { ex: 540, md: "[Foo\n  bar]: /url\n\n[Baz][Foo bar]", out: [p(link("/url", "Baz"))] },
  { ex: 541, md: '[foo] [bar]\n\n[bar]: /url "title"', out: [p("[foo] ", linkT("/url", "title", "bar"))] },
  { ex: 542, md: '[foo]\n[bar]\n\n[bar]: /url "title"', out: [p("[foo]", sb, linkT("/url", "title", "bar"))] },
  { ex: 543, md: "[foo]: /url1\n\n[foo]: /url2\n\n[bar][foo]", out: [p(link("/url1", "bar"))] },
  { ex: 544, md: "[bar][foo\\!]\n\n[foo!]: /url", out: [p("[bar][foo!]")] },
  { ex: 545, md: "[foo][ref[]\n\n[ref[]: /uri", out: [p("[foo][ref[]"), p("[ref[]: /uri")] },
  { ex: 548, md: "[foo][ref\\[]\n\n[ref\\[]: /uri", out: [p(link("/uri", "foo"))] },
  { ex: 550, md: "[]\n\n[]: /uri", out: [p("[]"), p("[]: /uri")] },
  { ex: 552, md: '[foo][]\n\n[foo]: /url "title"', out: [p(linkT("/url", "title", "foo"))] },
  { ex: 553, md: '[*foo* bar][]\n\n[*foo* bar]: /url "title"', out: [p(linkT("/url", "title", em("foo"), " bar"))] },
  { ex: 554, md: '[Foo][]\n\n[foo]: /url "title"', out: [p(linkT("/url", "title", "Foo"))] },
  { ex: 555, md: '[foo] \n[]\n\n[foo]: /url "title"', out: [p(linkT("/url", "title", "foo"), sb, "[]")] },
  { ex: 556, md: '[foo]\n\n[foo]: /url "title"', out: [p(linkT("/url", "title", "foo"))] },
  { ex: 557, md: '[*foo* bar]\n\n[*foo* bar]: /url "title"', out: [p(linkT("/url", "title", em("foo"), " bar"))] },
  { ex: 558, md: '[[*foo* bar]]\n\n[*foo* bar]: /url "title"', out: [p("[", linkT("/url", "title", em("foo"), " bar"), "]")] },
  { ex: 559, md: "[[bar [foo]\n\n[foo]: /url", out: [p("[[bar ", link("/url", "foo"))] },
  { ex: 561, md: '[foo] bar\n\n[foo]: /url', out: [p(link("/url", "foo"), " bar")] },
  { ex: 562, md: '\\[foo]\n\n[foo]: /url "title"', out: [p("[foo]")] },
  { ex: 563, md: "[foo*]: /url\n\n*[foo*]", out: [p("*", link("/url", "foo*"))] },
  { ex: 564, md: "[foo][bar]\n\n[foo]: /url1\n[bar]: /url2", out: [p(link("/url2", "foo"))] },
  { ex: 566, md: "[foo]()\n\n[foo]: /url1", out: [p(link("", "foo"))] },
  { ex: 567, md: "[foo](not a link)\n\n[foo]: /url1", out: [p(link("/url1", "foo"), "(not a link)")] },
  { ex: 568, md: "[foo][bar][baz]\n\n[baz]: /url", out: [p("[foo]", link("/url", "bar"))] },
  { ex: 569, md: "[foo][bar][baz]\n\n[baz]: /url1\n[bar]: /url2", out: [p(link("/url2", "foo"), link("/url1", "baz"))] },
  { ex: 570, md: "[foo][bar][baz]\n\n[baz]: /url1\n[foo]: /url2", out: [p("[foo]", link("/url1", "bar"))] },
]);

run("images", [
  { ex: 571, md: 'x ![foo](/url "title")', out: [p("x ", img("/url", ["foo"], "title"))] },
  { ex: 572, md: 'x ![foo *bar*](train.jpg "train & tracks")', out: [p("x ", img("train.jpg", ["foo ", em("bar")], "train & tracks"))] },
  { ex: 573, md: "x ![foo ![bar](/url)](/url2)", out: [p("x ", img("/url2", ["foo ", img("/url", ["bar"])]))] },
  { ex: 574, md: "x ![foo [bar](/url)](/url2)", out: [p("x ", img("/url2", ["foo ", link("/url", "bar")]))] },
  { ex: 576, md: "x ![foo](train.jpg)", out: [p("x ", img("train.jpg", ["foo"]))] },
  { ex: 577, md: 'My ![foo bar](/path/to/train.jpg  "title"   )', out: [p("My ", img("/path/to/train.jpg", ["foo bar"], "title"))] },
  { ex: 578, md: "x ![foo](<url>)", out: [p("x ", img("url", ["foo"]))] },
  { ex: 579, md: "x ![](/url)", out: [p("x ", img("/url", []))] },
  { ex: 580, md: "x ![foo][bar]\n\n[bar]: /url", out: [p("x ", img("/url", ["foo"]))] },
  { ex: 581, md: "x ![foo][bar]\n\n[BAR]: /url", out: [p("x ", img("/url", ["foo"]))] },
  { ex: 582, md: 'x ![foo][]\n\n[foo]: /url "title"', out: [p("x ", img("/url", ["foo"], "title"))] },
  { ex: 586, md: 'x ![foo]\n\n[foo]: /url "title"', out: [p("x ", img("/url", ["foo"], "title"))] },
  { ex: 590, md: 'x !\\[foo]\n\n[foo]: /url "title"', out: [p("x ![foo]")] },
  { ex: 591, md: 'x \\![foo]\n\n[foo]: /url "title"', out: [p("x !", linkT("/url", "title", "foo"))] },
  {
    ex: "figure",
    md: "![Train *at* dusk](train.jpg)",
    out: [{ t: "Figure", content: [plain(img("train.jpg", ["Train at dusk"]))], caption: ins(["Train ", em("at"), " dusk"]), numbered: true }],
    note: "texwright: a paragraph holding only an image is a figure",
  },
]);

run("autolinks", [
  { ex: 593, md: "<http://foo.bar.baz>", out: [p(link("http://foo.bar.baz", "http://foo.bar.baz"))] },
  { ex: 594, md: "<https://foo.bar.baz/test?q=hello&id=22&boolean>", out: [p(link("https://foo.bar.baz/test?q=hello&id=22&boolean", "https://foo.bar.baz/test?q=hello&id=22&boolean"))] },
  { ex: 595, md: "<irc://foo.bar:2233/baz>", out: [p(link("irc://foo.bar:2233/baz", "irc://foo.bar:2233/baz"))] },
  { ex: 596, md: "<MAILTO:FOO@BAR.BAZ>", out: [p(link("MAILTO:FOO@BAR.BAZ", "MAILTO:FOO@BAR.BAZ"))] },
  { ex: 597, md: "<a+b+c:d>", out: [p(link("a+b+c:d", "a+b+c:d"))] },
  { ex: 598, md: "<made-up-scheme://foo,bar>", out: [p(link("made-up-scheme://foo,bar", "made-up-scheme://foo,bar"))] },
  { ex: 599, md: "<https://../>", out: [p(link("https://../", "https://../"))] },
  { ex: 600, md: "<localhost:5001/foo>", out: [p(link("localhost:5001/foo", "localhost:5001/foo"))] },
  { ex: 602, md: "<https://example.com/\\[\\>", out: [p(link("https://example.com/%5C%5B%5C", "https://example.com/\\[\\"))] },
  { ex: 603, md: "<foo@bar.example.com>", out: [p(link("mailto:foo@bar.example.com", "foo@bar.example.com"))] },
  { ex: 604, md: "<foo+special@Bar.baz-bar0.com>", out: [p(link("mailto:foo+special@Bar.baz-bar0.com", "foo+special@Bar.baz-bar0.com"))] },
  { ex: 606, md: "<>", out: [p("<>")] },
  { ex: 608, md: "<m:abc>", out: [p("<m:abc>")] },
  { ex: 609, md: "<foo.bar.baz>", out: [p("<foo.bar.baz>")] },
  {
    ex: 601,
    md: "<https://foo.bar/baz bim>",
    out: [p("<", link("https://foo.bar/baz", "https://foo.bar/baz"), " bim>")],
    note: "texwright links the bare URL",
  },
  { ex: 610, md: "https://example.com", out: [p(link("https://example.com", "https://example.com"))], note: "texwright links bare URLs" },
  { ex: 611, md: "foo@bar.example.com", out: [p(link("mailto:foo@bar.example.com", "foo@bar.example.com"))], note: "texwright links e-mail addresses" },
  { ex: "linkify trailing punctuation", md: "See https://example.com/a_(b). Then www.example.com.", out: [p("See ", link("https://example.com/a_(b)", "https://example.com/a_(b)"), ". Then www.example.com.")] },
]);

run("raw HTML", [
  { ex: 612, md: "<a><bab><c2c>", out: [p(raw("<a>"), raw("<bab>"), raw("<c2c>"))] },
  { ex: 613, md: "<a/><b2/>", out: [p(raw("<a/>"), raw("<b2/>"))] },
  { ex: 614, md: '<a  /><b2\ndata="foo" >', out: [p(raw("<a  />"), raw('<b2\ndata="foo" >'))] },
  {
    ex: 615,
    md: "<a foo=\"bar\" bam = 'baz <em>\"</em>'\n_boolean zoop:33=zoop:33 />",
    out: [p(raw("<a foo=\"bar\" bam = 'baz <em>\"</em>'\n_boolean zoop:33=zoop:33 />"))],
  },
  { ex: 616, md: 'Foo <responsive-image src="foo.jpg" />', out: [p("Foo ", raw('<responsive-image src="foo.jpg" />'))] },
  { ex: 617, md: "<33> <__>", out: [p("<33> <__>")] },
  { ex: 618, md: '<a h*#ref="hi">', out: [p("<a h*#ref=\u201chi\u201d>")], note: "smart quotes" },
  { ex: 620, md: "< a><\nfoo><bar/ >\n<foo bar=baz\nbim!bop />", out: [p("< a><", sb, "foo><bar/ >", sb, "<foo bar=baz", sb, "bim!bop />")] },
  { ex: 622, md: "</a></foo >", out: [p(raw("</a>"), raw("</foo >"))] },
  { ex: 624, md: "foo <!-- this is a --\ncomment - with hyphens -->", out: [p("foo ", raw("<!-- this is a --\ncomment - with hyphens -->"))] },
  { ex: 625, md: "foo <!--> foo -->\n\nfoo <!---> foo -->", out: [p("foo ", raw("<!-->"), " foo -->"), p("foo ", raw("<!--->"), " foo -->")] },
  { ex: 626, md: "foo <?php echo $a; ?>", out: [p("foo ", raw("<?php echo $a; ?>"))] },
  { ex: 627, md: "foo <!ELEMENT br EMPTY>", out: [p("foo ", raw("<!ELEMENT br EMPTY>"))] },
  { ex: 628, md: "foo <![CDATA[>&<]]>", out: [p("foo ", raw("<![CDATA[>&<]]>"))] },
  { ex: 629, md: 'foo <a href="&ouml;">', out: [p("foo ", raw('<a href="&ouml;">'))] },
  { ex: 630, md: 'foo <a href="\\*">', out: [p("foo ", raw('<a href="\\*">'))] },
]);

run("line breaks and text", [
  { ex: 633, md: "foo  \nbaz", out: [p("foo", lb, "baz")] },
  { ex: 634, md: "foo\\\nbaz", out: [p("foo", lb, "baz")] },
  { ex: 635, md: "foo       \nbaz", out: [p("foo", lb, "baz")] },
  { ex: 636, md: "foo  \n     bar", out: [p("foo", lb, "bar")] },
  { ex: 637, md: "foo\\\n     bar", out: [p("foo", lb, "bar")] },
  { ex: 638, md: "*foo  \nbar*", out: [p(em("foo", lb, "bar"))] },
  { ex: 639, md: "*foo\\\nbar*", out: [p(em("foo", lb, "bar"))] },
  { ex: 640, md: "`code  \nspan`", out: [p(code("code   span"))] },
  { ex: 641, md: "`code\\\nspan`", out: [p(code("code\\ span"))] },
  { ex: 642, md: '<a href="foo  \nbar">', out: [p(raw('<a href="foo  \nbar">'))] },
  { ex: 644, md: "foo\\", out: [p("foo\\")] },
  { ex: 645, md: "foo  ", out: [p("foo")] },
  { ex: 646, md: "### foo\\", out: [h(3, "foo\\")] },
  { ex: 647, md: "### foo  ", out: [h(3, "foo")] },
  { ex: 648, md: "foo\nbaz", out: [p("foo", sb, "baz")] },
  { ex: 649, md: "foo \n baz", out: [p("foo", sb, "baz")] },
  { ex: 650, md: "hello $.;'there", out: [p("hello $.;'there")] },
  { ex: 651, md: "Foo χρῆν", out: [p("Foo χρῆν")] },
  { ex: 652, md: "Multiple     spaces", out: [p("Multiple     spaces")] },
]);

const cell = (...c: In[]): { content: Inline[] } => ({ content: ins(c) });

run("GFM tables", [
  {
    ex: "gfm 198",
    md: "| foo | bar |\n| --- | --- |\n| baz | bim |",
    out: [{ t: "Table", align: [null, null], head: [[cell("foo"), cell("bar")]], body: [[cell("baz"), cell("bim")]] }],
  },
  {
    ex: "gfm 199",
    md: "| abc | defghi |\n:-: | -----------:\nbar | baz",
    out: [{ t: "Table", align: ["center", "right"], head: [[cell("abc"), cell("defghi")]], body: [[cell("bar"), cell("baz")]] }],
  },
  {
    ex: "gfm 200",
    md: "| f\\|oo  |\n| ------ |\n| b `\\|` az |\n| b **\\|** im |",
    out: [{ t: "Table", align: [null], head: [[cell("f|oo")]], body: [[cell("b ", code("|"), " az")], [cell("b ", strong("|"), " im")]] }],
  },
  {
    ex: "gfm 201",
    md: "| abc | def |\n| --- | --- |\n| bar | baz |\n> bar",
    out: [{ t: "Table", align: [null, null], head: [[cell("abc"), cell("def")]], body: [[cell("bar"), cell("baz")]] }, quote(p("bar"))],
  },
  {
    ex: "gfm 202",
    md: "| abc | def |\n| --- | --- |\n| bar | baz |\nbar\n\nbar",
    out: [{ t: "Table", align: [null, null], head: [[cell("abc"), cell("def")]], body: [[cell("bar"), cell("baz")], [cell("bar"), cell()]] }, p("bar")],
  },
  { ex: "gfm 203", md: "| abc | def |\n| --- |\n| bar |", out: [p("| abc | def |", sb, "| — |", sb, "| bar |")], note: "not a table; --- is an em dash" },
  {
    ex: "gfm 204",
    md: "| abc | def |\n| --- | --- |\n| bar |\n| bar | baz | boo |",
    out: [{ t: "Table", align: [null, null], head: [[cell("abc"), cell("def")]], body: [[cell("bar"), cell()], [cell("bar"), cell("baz")]] }],
  },
  { ex: "gfm 205", md: "| abc | def |\n| --- | --- |", out: [{ t: "Table", align: [null, null], head: [[cell("abc"), cell("def")]], body: [] }] },
  {
    ex: "alignment",
    md: "a | b | c\n:-- | :-: | --:\n1 | 2 | 3",
    out: [{ t: "Table", align: ["left", "center", "right"], head: [[cell("a"), cell("b"), cell("c")]], body: [[cell("1"), cell("2"), cell("3")]] }],
  },
]);
