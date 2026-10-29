import test from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { parseMathMarkdown, renderMathHTML } from "../src/math-markdown.mjs";

test("regression: Markdown consumes backslash math delimiters without protection", () => {
  assert.equal(marked.parse(String.raw`\(x_1\)`), "<p>(x_1)</p>\n");
  const parsed = parseMathMarkdown(String.raw`\(x_1\)`);
  assert.deepEqual(parsed.math,[{tex:"x_1",display:false}]);
});

for (const [name,source,display] of [
  ["single dollar",String.raw`Before $x_1^2 + \alpha$ after.`,false],
  ["parentheses",String.raw`Before \(x_1^2 + \alpha\) after.`,false],
  ["double dollar",String.raw`Before $$x_1^2 + \alpha$$ after.`,true],
  ["brackets",String.raw`Before \[x_1^2 + \alpha\] after.`,true],
]) test(`renders ${name} without Markdown corrupting TeX`, () => {
  const parsed = parseMathMarkdown(source);
  assert.deepEqual(parsed.math,[{tex:String.raw`x_1^2 + \alpha`,display}]);
  assert.match(parsed.html,/Before/); assert.match(parsed.html,/after/);
  const html=renderMathHTML(parsed.math[0]);
  assert.match(html,/class="katex/);assert.doesNotMatch(html,/class="katex-error"/);
  assert.equal(html.includes('class="katex-display"'),display);
});

test("multiline matrices and aligned equations retain row breaks and ampersands", () => {
  const tex=String.raw`\begin{aligned}
a_1 &= \frac{1}{2} \\
b_2 &= \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
\end{aligned}`;
  for(const source of [`$$\n${tex}\n$$`,`\\[\n${tex}\n\\]`]) {
    const parsed=parseMathMarkdown(source);
    assert.equal(parsed.math.length,1);assert.equal(parsed.math[0].tex,tex);
    assert.doesNotMatch(renderMathHTML(parsed.math[0]),/class="katex-error"/);
  }
});

test("math stays intact inside headings, emphasis, lists and table cells", () => {
  const parsed=parseMathMarkdown(String.raw`## Formula \(x_i\)

**Result $y_j$**

- First \(a_k\)
- Second $b_l$

| Parameter | Value |
|---|---|
| $x$ | \(\frac{1}{2}\) |
`);
  assert.equal(parsed.math.length,6);
  assert.match(parsed.html,/<h2>/);assert.match(parsed.html,/<strong>/);
  assert.match(parsed.html,/<ul>/);assert.match(parsed.html,/<table>/);
});

test("inline code, fenced code and indented code are not interpreted as formulas", () => {
  const parsed=parseMathMarkdown('`$x$ \\(y\\)`\n\n```latex\n$$a_1$$\n\\[b\\]\n```\n\n    $z$\n');
  assert.equal(parsed.math.length,0);
  assert.match(parsed.html,/<code>/);assert.match(parsed.html,/language-latex/);
});

test("raw HTML code blocks also remain literal", () => {
  const parsed=parseMathMarkdown('<code>$x$ \\(y\\)</code>\n\n<pre>$$z$$</pre>');
  assert.equal(parsed.math.length,0);
  assert.match(parsed.html,/<code>\$x\$/);
});

test("GFM table pipes inside formulas stay in their original cell", () => {
  const parsed=parseMathMarkdown(String.raw`| Formula | Value |
|---|---|
| $|x|$ | 1 |
| \(\begin{vmatrix}a&b\\c&d\end{vmatrix}\) | 2 |
| $P(A|B)$ | 3 |`);
  assert.equal(parsed.math.length,3);
  assert.equal(parsed.math[0].tex,"|x|");
  assert.equal(parsed.math[2].tex,"P(A|B)");
  assert.equal((parsed.html.match(/<td>/g)||[]).length,6);
  for(const formula of parsed.math)assert.doesNotMatch(renderMathHTML(formula),/class="katex-error"/);
});

test("less-than and greater-than relations are math, not raw HTML", () => {
  const parsed=parseMathMarkdown(String.raw`If \(a<b\) and $c>d$, then $$x<y$$.`);
  assert.equal(parsed.math.length,3);
  assert.deepEqual(parsed.math.map(m=>m.tex),["a<b","c>d","x<y"]);
  for(const formula of parsed.math)assert.doesNotMatch(renderMathHTML(formula),/class="katex-error"/);
});

test("dollar amounts and escaped currency remain ordinary text", () => {
  for(const source of ["Costs $5 and $10 today.","$5-$10",String.raw`Costs \$5 and \$10.`,"Costs $5 then $10; formula $x_1$."]) {
    const parsed=parseMathMarkdown(source);
    assert.equal(parsed.math.length,source.includes("formula")?1:0);
    if(parsed.math.length)assert.equal(parsed.math[0].tex,"x_1");
  }
  assert.equal(parseMathMarkdown("$2x + 3$").math[0].tex,"2x + 3");
});

test("escaped dollar inside a formula does not terminate it", () => {
  const parsed=parseMathMarkdown(String.raw`$\text{price: \$5} + x$`);
  assert.equal(parsed.math.length,1);
  assert.equal(parsed.math[0].tex,String.raw`\text{price: \$5} + x`);
  assert.doesNotMatch(renderMathHTML(parsed.math[0]),/class="katex-error"/);
});

test("every streaming prefix is safe and final delimiter completes the same formula", () => {
  for(const full of [String.raw`Answer \(\frac{x_i}{2}\) done.`,String.raw`Answer $x_i + y_j$ done.`,String.raw`$$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$$`,String.raw`\[\begin{pmatrix}a&b\\c&d\end{pmatrix}\]`]) {
    for(let i=0;i<=full.length;i++) {
      const parsed=parseMathMarkdown(full.slice(0,i));
      for(const formula of parsed.math)assert.doesNotThrow(()=>renderMathHTML(formula));
    }
    const parsed=parseMathMarkdown(full);
    assert.equal(parsed.math.length,1);
    assert.doesNotMatch(renderMathHTML(parsed.math[0]),/class="katex-error"/);
  }
});

test("math registry keeps raw formula HTML outside Markdown markup", () => {
  const parsed=parseMathMarkdown(String.raw`\(\text{<img src=x onerror=alert(1)>}\)`);
  assert.equal(parsed.math.length,1);
  assert.doesNotMatch(parsed.html,/img|onerror|alert/);
  assert.doesNotMatch(renderMathHTML(parsed.math[0]),/<img\b|<script\b/);
  const pending=parseMathMarkdown(String.raw`\(<img src=x onerror=alert(1)>`);
  assert.match(pending.html,/&lt;img/);assert.doesNotMatch(pending.html,/<img\b/);
});

test("KaTeX cannot activate injected links or trusted HTML", () => {
  for(const tex of [String.raw`\href{javascript:alert(1)}{click}`,String.raw`\htmlStyle{background:url(javascript:alert(1))}{x}`,String.raw`\includegraphics{https://example.com/track}`]) {
    const html=renderMathHTML({tex,display:false});
    assert.doesNotMatch(html,/<a\b|<img\b|<script\b|href="javascript:|style="[^"]*background:url/);
  }
});

test("invalid formulas degrade to visible errors and do not leak macros", () => {
  assert.match(renderMathHTML({tex:String.raw`\notACommand{x}`,display:false}),/katex/);
  renderMathHTML({tex:String.raw`\gdef\veaixTest{123}\veaixTest`,display:false});
  assert.match(renderMathHTML({tex:String.raw`\veaixTest`,display:false}),/veaixTest/);
  assert.equal(renderMathHTML(null),"");
});
