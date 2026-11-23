import { strFromU8, unzipSync } from "fflate";

// Render the same saved Word file, including its protocols, declarations and signatures.
// Only the text of Word runs is emitted. All tags/attributes in the HTML are ours.
export function printableContract(file: Uint8Array) {
  const entries = unzipSync(file, { filter: f => ["word/document.xml", "word/numbering.xml"].includes(f.name) });
  const doc = strFromU8(entries["word/document.xml"]).replace(/<w:fldSimple\b[^>]*w:instr="\s*NUMPAGES\s*"[^>]*>[\s\S]*?<\/w:fldSimple>/g, "<w:r><w:t>________</w:t></w:r>");
  const numbering = strFromU8(entries["word/numbering.xml"]);
  const numbered = new Set<string>();
  for (const n of numbering.matchAll(/<w:num w:numId="(\d+)">\s*<w:abstractNumId w:val="(\d+)"/g)) {
    const start = numbering.indexOf(`<w:abstractNum w:abstractNumId="${n[2]}">`);
    const definition = numbering.slice(start, numbering.indexOf("</w:lvl>", start));
    if (definition.includes('<w:numFmt w:val="decimal"')) numbered.add(n[1]);
  }
  const counts = new Map<string, number>();
  function paragraph(xml: string) {
    const id = xml.match(/<w:numId w:val="(\d+)"/)?.[1];
    let marker = "";
    if (id) {
      const next = (counts.get(id) || 0) + 1;
      counts.set(id, next);
      marker = numbered.has(id) ? next + ". " : "• ";
    }
    const classes = [
      xml.includes("<w:pageBreakBefore") && "new-page",
      xml.includes("<w:keepNext") && "keep",
      xml.includes('<w:jc w:val="center"') && "center",
      id && "list",
    ].filter(Boolean).join(" ");
    const body = Array.from(xml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g), match => {
      const run = match[1];
      // BuildContract escapes field text before writing XML. Forward only escaped text nodes.
      let text = Array.from(run.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:br\b[^>]*\/>|<w:tab\s*\/>/g),
        m => m[1] ?? (m[0].startsWith("<w:br") ? "<br>" : "&#9;")).join("");
      if (/<w:b\s*\/>/.test(run)) text = "<b>" + text + "</b>";
      if (/<w:strike\s*\/>/.test(run)) text = "<s>" + text + "</s>";
      if (/<w:u\s/.test(run)) text = "<u>" + text + "</u>";
      return text;
    }).join("");
    return `<p class="${classes}">${marker}${body || "<br>"}</p>`;
  }
  const markup = Array.from(doc.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<\/?w:(tbl|tr|tc)(?:\s[^>]*)?>/g), m => {
    if (!m[1]) return paragraph(m[0]);
    const name = { tbl: "table", tr: "tr", tc: "td" }[m[1]];
    return `<${m[0].startsWith("</") ? "/" : ""}${name}>`;
  }).join("");
  return `<!doctype html><html lang="bg"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Договор за наем</title><style>
@page{size:A4;margin:16mm}*{box-sizing:border-box}body{max-width:185mm;margin:1rem auto;font:11pt/1.28 Arial,sans-serif;color:#111;padding:0 4mm}p{margin:0 0 .2em;overflow-wrap:anywhere;white-space:pre-wrap}.center{text-align:center}.list{margin-left:1.5em}.keep{break-after:avoid}table{width:100%;border-collapse:collapse;margin:.5em 0}td{border:1px solid #888;padding:.2em .3em;vertical-align:top}tr{break-inside:avoid}button{font:inherit;padding:.6em 1em;margin-bottom:1em}@media print{body{max-width:none;margin:0;padding:0}button{display:none}.new-page{break-before:page}}</style><button type="button" onclick="window.print()">Печат на договора</button><main>${markup}</main></html>`;
}
