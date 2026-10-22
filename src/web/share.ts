// The share card: the month's result as a 1080×1350 PNG (portrait fits X, Instagram, WhatsApp), drawn in the browser.
// Phones get the native share sheet with the image attached; desktops download it and copy the text.
export interface ShareData {
  name: string; score: number; rank: number | null; total: number | null;
  matches: number; dates: number; headline: string | null; reality: string; url: string;
}

const W = 1080, H = 1350, PAD = 90;
const DISPLAY = '"Bricolage Grotesque Variable", system-ui, sans-serif', BODY = '"Inter Variable", system-ui, sans-serif';

export const shareText = (d: ShareData) =>
  `${d.name} got ${d.score} 💋 in one month in Sex and the City${d.rank ? `, #${d.rank.toLocaleString()} on the leaderboard` : ""}. Make a character and beat that:`;

export async function drawCard(d: ShareData): Promise<Blob> {
  await Promise.all([`800 100px ${DISPLAY}`, `600 40px ${BODY}`].map(f => document.fonts.load(f)));
  const c = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#ff5a7a"); bg.addColorStop(1, "#b0124a");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = "white"; g.textBaseline = "alphabetic";

  // Wrap `text` to `width`, at most `lines` lines (the last one ellipsised); returns the y after it.
  const wrap = (text: string, y: number, font: string, lh: number, width = W - 2 * PAD, lines = 3) => {
    g.font = font;
    const out: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width <= width) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
    if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].replace(/\s*\S*$/, "…"); }
    out.forEach((l, k) => g.fillText(l, PAD, y + k * lh));
    return y + out.length * lh;
  };

  // Shrink one line's font until it fits `width`.
  const fit = (text: string, x: number, y: number, weight: number, size: number, family: string, width = W - 2 * PAD) => {
    do g.font = `${weight} ${size}px ${family}`; while (g.measureText(text).width > width && (size -= 2) > 20);
    g.fillText(text, x, y);
  };
  const FOOTER = H - 80, BOTTOM = FOOTER - 70; // nothing above the footer may pass BOTTOM

  g.globalAlpha = 0.85; g.font = `700 40px ${DISPLAY}`; g.fillText("Sex and the City", PAD, 140); g.globalAlpha = 1;
  let y = wrap(`${d.name}'s month`, 250, `800 68px ${DISPLAY}`, 76, W - 2 * PAD, 2);

  g.font = `800 360px ${DISPLAY}`;
  const big = String(d.score), bigW = g.measureText(big).width;
  g.fillText(big, PAD - 10, y + 300);
  g.font = "140px system-ui"; g.fillText("💋", PAD + bigW + 10, y + 270);
  g.font = `600 42px ${BODY}`; g.globalAlpha = 0.9; g.fillText("body count in 30 days", PAD, y + 370); g.globalAlpha = 1;
  y += 470;

  if (d.rank) {
    g.fillStyle = "white"; g.beginPath(); g.roundRect(PAD, y - 62, W - 2 * PAD, 92, 46); g.fill();
    g.fillStyle = "#c2185b";
    fit(`🏆 #${d.rank.toLocaleString()} of ${d.total!.toLocaleString()} on the leaderboard`, PAD + 34, y, 800, 46, DISPLAY, W - 2 * PAD - 68);
    g.fillStyle = "white"; y += 100;
  }
  g.font = `600 40px ${BODY}`; g.fillText(`📱 ${d.matches} matches   🍷 ${d.dates} dates`, PAD, y); y += 80;
  if (d.headline && y + 54 < BOTTOM) y = wrap(`“${d.headline}”`, y, `italic 700 42px ${DISPLAY}`, 54, W - 2 * PAD, y + 108 < BOTTOM ? 2 : 1) + 16;
  if (y + 36 < BOTTOM) { g.globalAlpha = 0.85; wrap(d.reality, Math.max(y, BOTTOM - 42), `500 30px ${BODY}`, 40, W - 2 * PAD, 1); g.globalAlpha = 1; }

  fit(`Beat ${d.name.split(" ")[0]} → ${d.url.replace(/^https?:\/\//, "")}`, PAD, FOOTER, 800, 44, DISPLAY);
  return new Promise(resolve => c.toBlob(b => resolve(b!), "image/png"));
}

// Share sheet with the image where the browser supports it; otherwise download the PNG and copy the text.
export async function share(d: ShareData): Promise<"shared" | "downloaded"> {
  const blob = await drawCard(d), file = new File([blob], "sex-and-the-city.png", { type: "image/png" });
  const text = shareText(d);
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: `${text} ${d.url}` }); return "shared"; }
    catch (e) { if ((e as Error).name === "AbortError") return "shared"; } // cancelled is fine; other errors fall through
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: file.name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  await navigator.clipboard?.writeText(`${text} ${d.url}`).catch(() => {});
  return "downloaded";
}

export const xIntent = (d: ShareData) =>
  `https://x.com/intent/post?text=${encodeURIComponent(shareText(d))}&url=${encodeURIComponent(d.url)}`;
