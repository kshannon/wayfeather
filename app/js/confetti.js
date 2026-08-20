/* confetti.js — the Did it! celebration.

   One shared canvas over everything, pointer-events:none. burstAt() is called
   AFTER the visited state is already written, and returns immediately under
   reduced motion — the celebration can never be load-bearing for the change it
   celebrates. */

import { $, reduced, cssVar } from "./dom.js";

let cvs = null, ctx = null, parts = [], raf = 0, endAt = 0;

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

  const pal = [cssVar("--accent", "#0B6C8C"), cssVar("--soft", "#CCE5EF"),
               cssVar("--gold-bg", "#F2C14E"), "#FFFFFF"];
  const ox = rect.left + rect.width / 2, oy = rect.top + rect.height / 2;
  for (let i = 0; i < 26; i++) {
    const ang = (-Math.PI / 2) + (Math.random() - 0.5) * 2.0;
    const sp = 3.2 + Math.random() * 5.0;
    parts.push({
      x: ox + (Math.random() - 0.5) * rect.width * 0.7,
      y: oy + (Math.random() - 0.5) * 8,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      w: 4 + Math.random() * 5, h: 3 + Math.random() * 5,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.34,
      c: pal[i % pal.length]
    });
  }
  endAt = Date.now() + 720;
  if (!raf) raf = window.requestAnimationFrame(tick);
}

function tick() {
  raf = 0;
  if (!ctx) return;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  let alive = 0;
  const now = Date.now();
  const fade = Math.max(0, Math.min(1, (endAt - now) / 300));
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    p.vy += 0.30; p.vx *= 0.992; p.vy *= 0.992;
    p.x += p.vx; p.y += p.vy; p.r += p.vr;
    if (p.y > window.innerHeight + 30) continue;
    alive++;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(p.x, p.y); ctx.rotate(p.r);
    ctx.fillStyle = p.c;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
  if (alive && now < endAt) { raf = window.requestAnimationFrame(tick); return; }
  parts.length = 0;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  cvs.hidden = true;
}
