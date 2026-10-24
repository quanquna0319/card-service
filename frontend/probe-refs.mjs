const urls = ["https://beautifului.dev","https://beui.dev","https://rareui.com","https://transitions.dev"];
for (const u of urls) {
  try {
    const c = new AbortController(); const t = setTimeout(()=>c.abort(), 15000);
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language":"en-US,en;q=0.9" }, signal: c.signal, redirect: "follow" });
    clearTimeout(t);
    const txt = await r.text();
    console.log(u, r.status, txt.length, "|", (txt.match(/<title>([^<]*)<\/title>/i)?.[1]||"").slice(0,80));
  } catch(e) { console.log(u, "ERR", e.message); }
}
