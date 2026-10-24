import fs from "node:fs";
import path from "node:path";

const root = "D:/gpt/card-service/frontend/src";
const items = ["utils","button","card","dialog","input","label","select","separator","switch","table","tabs","tooltip","dropdown-menu","badge","skeleton","sonner"];
const base = "https://ui.shadcn.com/r/styles/new-york/";
const results = [];
for (const it of items) {
  try {
    const res = await fetch(base + it + ".json", { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) { results.push([it, "HTTP " + res.status]); continue; }
    const j = await res.json();
    for (const f of j.files ?? []) {
      const rel = f.path.replace(/^ui\//, "components/ui/").replace(/^lib\//, "lib/");
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.content, "utf8");
      results.push([it, "wrote " + rel + " (" + f.content.length + ")"]);
    }
    if ((j.files ?? []).length === 0) results.push([it, "no files"]);
  } catch (e) { results.push([it, "ERR " + e.message]); }
}
for (const [a,b] of results) console.log(a.padEnd(16), b);
