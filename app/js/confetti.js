/* confetti.js — the "Landed!" celebration, as a small burst of feathers.

   One shared canvas over everything, pointer-events:none. burstAt() is called
   AFTER the visited state is already written, and returns immediately under
   reduced motion — the celebration can never be load-bearing for the change it
   celebrates.

   Feathers, not rectangles (DESIGN §5): each particle is a two-arc vane with a
   rachis down the middle, in the matcha accent and the warm brown plus their
   light tints. Feathers fall slower than confetti and wander on the way down,
   so gravity is gentler and every particle carries its own sway. */

import { $, reduced, cssVar } from "./dom.js";

let cvs = null, ctx = null, parts = [], raf = 0, endAt = 0;

const LIFE = 1000;          // ms from burst to cleared canvas
const FADE = 340;           // ms of fade at the tail of it

export function burstAt(rect) {
  cvs = cvs || $("confetti");
  if (reduced() || !rect || !cvs || !cvs.getContext) return;

  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cvs.width = Math.round(w * dpr); cvs.height = Math.round(h * dpr);
  cvs.style.width = w + "px"; cvs.style.height = h + "px";
  ctx = cvs.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cvs.hidden = false;

  const pal = [cssVar("--accent", "#4B6630"), cssVar("--brown", "#6B4F3A"),
               cssVar("--soft", "#D7E3C5"), cssVar("--hair-2", "#D3C9B2")];
  const ox = rect.left + rect.width / 2, oy = rect.top + rect.height / 2;
  for (let i = 0; i < 22; i++) {
    const ang = (-Math.PI / 2) + (Math.random() - 0.5) * 2.0;
    const sp = 2.8 + Math.random() * 4.2;
    parts.push({
      x: ox + (Math.random() - 0.5) * rect.width * 0.7,
      y: oy + (Math.random() - 0.5) * 8,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      w: 5 + Math.random() * 4, h: 11 + Math.random() * 6,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.20,
      ph: Math.random() * Math.PI * 2,           // sway phase
      sw: 0.5 + Math.random() * 0.9,             // sway amplitude
      c: pal[i % pal.length]
    });
  }
  endAt = Date.now() + LIFE;
  if (!raf) raf = window.requestAnimationFrame(tick);
}

/* One feather, drawn around its own centre: two arcs for the vane, one line
   for the rachis. The caller has already translated and rotated. */
function feather(p) {
  const hw = p.w / 2, hh = p.h / 2;
  ctx.beginPath();
  ctx.moveTo(0, -hh);
  ctx.quadraticCurveTo(hw, -hh * 0.15, 0, hh);
  ctx.quadraticCurveTo(-hw, -hh * 0.15, 0, -hh);
  ctx.closePath();
  ctx.fillStyle = p.c;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -hh * 0.94);
  ctx.lineTo(0, hh * 0.98);
  ctx.strokeStyle = "rgba(31,27,21,.20)";
  ctx.lineWidth = 0.9;
  ctx.stroke();
}

function tick() {
  raf = 0;
  if (!ctx) return;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  let alive = 0;
  const now = Date.now();
  const fade = Math.max(0, Math.min(1, (endAt - now) / FADE));
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    p.vy += 0.13; p.vx *= 0.985; p.vy *= 0.985;
    p.ph += 0.13;
    p.x += p.vx + Math.sin(p.ph) * p.sw;
    p.y += p.vy;
    p.r += p.vr + Math.sin(p.ph) * 0.02;
    if (p.y > window.innerHeight + 30) continue;
    alive++;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(p.x, p.y); ctx.rotate(p.r);
    feather(p);
    ctx.restore();
  }
  if (alive && now < endAt) { raf = window.requestAnimationFrame(tick); return; }
  parts.length = 0;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  cvs.hidden = true;
}
