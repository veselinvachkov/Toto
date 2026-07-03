// Renders a polished, shareable "You won" card for a winning ticket onto a
// canvas. All iconography is vector-drawn (no emoji) and the card is rendered at
// 3x for crisp, high-resolution output. Used by MyTickets to let winners
// download the card and share it on X.

import { fmtUsdc } from './format';

export interface WinCardData {
  ticketId: number;
  roundId: number;
  game: number;        // 0 = 5/35, 1 = 6/49
  numbers: number[];
  payout: string;      // formatted USDC amount (e.g. "1234.50")
}

type Ctx = CanvasRenderingContext2D;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// Ball gradient stops mirrored from index.css (.ball-*). Keyed by number bucket.
function ballStops(n: number): [string, string, string, string] {
  if (n <= 10) return ['#fda4af', '#f87171', '#dc2626', '#991b1b']; // red
  if (n <= 20) return ['#fed7aa', '#fb923c', '#ea580c', '#9a3412']; // orange
  if (n <= 30) return ['#fef3c7', '#fbbf24', '#d97706', '#78350f']; // gold
  if (n <= 40) return ['#bbf7d0', '#4ade80', '#16a34a', '#14532d']; // green
  return ['#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'];               // blue
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

/** Draw a Lucide-style stroked icon (24x24 viewBox) centered at (cx, cy). */
function drawStrokeIcon(
  ctx: Ctx,
  paths: string[],
  cx: number,
  cy: number,
  size: number,
  stroke: string | CanvasGradient,
  lineWidth = 2,
) {
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of paths) ctx.stroke(new Path2D(d));
  ctx.restore();
}

// Lucide "trophy" icon path data (24x24).
const TROPHY_PATHS = [
  'M6 9H4.5a2.5 2.5 0 0 1 0-5H6',
  'M18 9h1.5a2.5 2.5 0 0 0 0-5H18',
  'M4 22h16',
  'M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22',
  'M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22',
  'M18 2H6v7a6 6 0 0 0 12 0V2Z',
];

function drawTrophy(ctx: Ctx, cx: number, cy: number, size: number) {
  const grad = ctx.createLinearGradient(cx, cy - size / 2, cx, cy + size / 2);
  grad.addColorStop(0, '#fef3c7');
  grad.addColorStop(0.5, '#fbbf24');
  grad.addColorStop(1, '#d97706');
  // Soft glow halo behind the trophy.
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.95);
  halo.addColorStop(0, 'rgba(251,191,36,0.28)');
  halo.addColorStop(1, 'rgba(251,191,36,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.95, 0, Math.PI * 2);
  ctx.fill();
  drawStrokeIcon(ctx, TROPHY_PATHS, cx, cy, size, grad, 1.6);
}

function drawBall(ctx: Ctx, cx: number, cy: number, r: number, n: number) {
  const [c0, c1, c2, c3] = ballStops(n);
  const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, r * 0.1, cx, cy, r * 1.15);
  grad.addColorStop(0, c0);
  grad.addColorStop(0.3, c1);
  grad.addColorStop(0.7, c2);
  grad.addColorStop(1, c3);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = r * 0.45;
  ctx.shadowOffsetY = r * 0.2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  // Glossy highlight.
  const gloss = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.45, 0, cx - r * 0.35, cy - r * 0.45, r * 0.95);
  gloss.addColorStop(0, 'rgba(255,255,255,0.6)');
  gloss.addColorStop(0.7, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = gloss;
  ctx.fill();

  // Thin rim for definition.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = r * 0.04;
  ctx.stroke();

  // Number.
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(r * 0.82)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = r * 0.18;
  ctx.fillText(String(n), cx, cy + r * 0.04);
  ctx.restore();
}

/** Set ctx.font to the largest size <= maxPx whose text fits within maxWidth. */
function fitFont(ctx: Ctx, text: string, weight: number, maxPx: number, maxWidth: number) {
  let px = maxPx;
  do {
    ctx.font = `${weight} ${px}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    px -= 2;
  } while (px > 24);
}

// Tasteful, deterministic vector confetti (rotated rounded bars) in the header.
const CONFETTI: Array<{ x: number; y: number; rot: number; c: string; w: number; h: number }> = [
  { x: 150, y: 70, rot: 0.5, c: '#6366f1', w: 26, h: 9 },
  { x: 320, y: 50, rot: -0.7, c: '#fbbf24', w: 22, h: 8 },
  { x: 900, y: 56, rot: 0.9, c: '#22c55e', w: 24, h: 9 },
  { x: 1060, y: 78, rot: -0.4, c: '#a855f7', w: 22, h: 8 },
  { x: 1010, y: 150, rot: 0.6, c: '#60a5fa', w: 20, h: 8 },
  { x: 200, y: 150, rot: -0.9, c: '#f87171', w: 20, h: 8 },
];

function drawConfetti(ctx: Ctx) {
  ctx.save();
  ctx.globalAlpha = 0.5;
  for (const p of CONFETTI) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.c;
    roundRect(ctx, -p.w / 2, -p.h / 2, p.w, p.h, p.h / 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Render the win card. Returns the canvas, rendered at `scale`x the 1200x675
 * design for high-resolution export (default 3x => 3600x2025).
 */
export function drawWinCard(data: WinCardData, scale = 3): HTMLCanvasElement {
  const W = 1200;
  const H = 675;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';

  // Background.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0a0e1a');
  bg.addColorStop(1, '#0f1525');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Aurora glows.
  const glow = (x: number, y: number, rad: number, color: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  glow(140, -80, 560, 'rgba(99,102,241,0.22)');
  glow(W - 100, -20, 520, 'rgba(251,191,36,0.12)');
  glow(W / 2, H + 140, 620, 'rgba(168,85,247,0.16)');

  // Inset panel for depth.
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.015)';
  ctx.strokeStyle = 'rgba(129,140,248,0.35)';
  ctx.lineWidth = 2;
  roundRect(ctx, 28, 28, W - 56, H - 56, 28);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  drawConfetti(ctx);

  // ---- Header row ----
  // Brand mark: small gradient "ball" + wordmark.
  const markX = 62, markY = 70, markR = 13;
  const mg = ctx.createRadialGradient(markX - 4, markY - 5, 2, markX, markY, markR * 1.2);
  mg.addColorStop(0, '#818cf8');
  mg.addColorStop(1, '#4338ca');
  ctx.beginPath();
  ctx.arc(markX, markY, markR, 0, Math.PI * 2);
  ctx.fillStyle = mg;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 30px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('TOTO', markX + markR + 12, markY + 11);

  // Meta (right aligned).
  ctx.fillStyle = '#8b95b3';
  ctx.font = `500 20px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(
    `${data.game === 0 ? '5 / 35' : '6 / 49'}    Round #${data.roundId}    Ticket #${data.ticketId}`,
    W - 62, markY + 9,
  );

  // ---- Trophy + headline ----
  drawTrophy(ctx, W / 2, 178, 92);

  ctx.textAlign = 'center';
  // Eyebrow.
  ctx.fillStyle = '#fbbf24';
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText('CONGRATULATIONS', W / 2, 268);
  // Headline.
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 70px ${FONT}`;
  ctx.fillText('YOU WON', W / 2, 336);

  // ---- Balls row ----
  const nums = data.numbers;
  const r = nums.length > 6 ? 44 : 50;
  const gap = r * 2.55;
  const totalW = (nums.length - 1) * gap;
  const startX = W / 2 - totalW / 2;
  const ballY = 430;
  nums.forEach((n, i) => drawBall(ctx, startX + i * gap, ballY, r, n));

  // ---- Payout ----
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8b95b3';
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText('PAYOUT', W / 2, 530);

  const payoutText = `${fmtUsdc(data.payout)} USDC`;
  fitFont(ctx, payoutText, 800, 80, W - 220);
  ctx.fillStyle = '#22c55e';
  ctx.save();
  ctx.shadowColor = 'rgba(34,197,94,0.5)';
  ctx.shadowBlur = 26;
  ctx.fillText(payoutText, W / 2, 596);
  ctx.restore();

  // ---- Footer ----
  ctx.fillStyle = '#6b7494';
  ctx.font = `500 20px ${FONT}`;

  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}
