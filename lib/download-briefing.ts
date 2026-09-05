const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

export function downloadBriefing({ date, summary, facts, status, sourceTimes }: {
  date: string; summary: string; facts: string[]; status: string; sourceTimes: string[];
}) {
  const document = `<!doctype html><html lang="en-IE"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A Day in Ireland · ${escapeHtml(date)}</title><style>body{max-width:44rem;margin:3rem auto;padding:0 1.5rem;font:18px/1.6 system-ui;color:#19392d;background:#fafbf5}h1{font:2.5rem Georgia}a{color:#205846}small{display:block}footer{border-top:1px solid #abbcaf;margin-top:2rem}</style><main><h1>A Day in Ireland</h1><p>${escapeHtml(date)} · ${escapeHtml(status)}</p><p>${escapeHtml(summary)}</p><ul>${facts.map((fact)=>`<li>${escapeHtml(fact)}</li>`).join("")}</ul><p>This is a saved national snapshot. It does not update. Missing sources remain unavailable; observations describe reporting locations.</p><ul>${sourceTimes.map((time)=>`<li>${escapeHtml(time)}</li>`).join("")}</ul><footer><p>Sources: <a href="https://www.met.ie/latest-reports">Met Éireann</a>, <a href="https://www.smartgriddashboard.com/">EirGrid</a>. <a href="https://day.illek.ie/data">Methodology and attribution</a>.</p><p>For decisions involving safety or travel, check the official provider. No visitor location is included.</p><a href="https://day.illek.ie/">See Ireland now</a></footer></main></html>`;
  const url = URL.createObjectURL(new Blob([document], { type: "text/html;charset=utf-8" }));
  const link = window.document.createElement("a"); link.href = url; link.download = `ireland-${new Date().toISOString().slice(0, 10)}.html`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
