import { readFile, writeFile } from "node:fs/promises";
import { marked } from "marked";
const source = await readFile("docs/duty-management-prd.md", "utf8");
const previous = await readFile("docs/duty-management-prd.html", "utf8");
const head = previous
  .slice(0, previous.indexOf("</head>") + 7)
  .replaceAll("1.3", "1.4");
const rendered = await marked.parse(source, { gfm: true });
await writeFile(
  "docs/duty-management-prd.html",
  `${head}\n<body><div class="topbar"><strong>Fair Shifts</strong><span>אפיון המוצר · מקור: Markdown</span></div><div class="layout" style="display:block;max-width:1180px"><main>${rendered.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>")}</main></div></body></html>\n`
);
console.log("עותק HTML סונכרן מן האפיון");
