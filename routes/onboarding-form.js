const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// ───────────────────────────────────────────────────────────
// Per-IP rate limit (mirrors the pattern in routes/onboarding.js).
// ───────────────────────────────────────────────────────────
const ipBuckets = new Map();
const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_LIMIT = 20;
function ipAllowed(ip) {
  const now = Date.now();
  const arr = (ipBuckets.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  if (arr.length >= IP_LIMIT) { ipBuckets.set(ip, arr); return false; }
  arr.push(now);
  ipBuckets.set(ip, arr);
  return true;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function clean(v, max) {
  return (typeof v === 'string') ? v.trim().slice(0, max) : '';
}

function cleanArr(v, max, perMax) {
  if (!Array.isArray(v)) return [];
  return v.map(x => clean(x, perMax)).filter(Boolean).slice(0, max);
}

function pickEnum(v, allowed) {
  return allowed.includes(v) ? v : null;
}

function hasVaani(services)  { return services.includes('vaani_whatsapp') || services.includes('vaani_instagram'); }
function hasSocial(services) { return services.includes('social_media'); }
function hasShopify(services){ return services.includes('shopify_website'); }

// ───────────────────────────────────────────────────────────
// GET / — render the multi-step form for ?lead=N
// ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const leadId = parseInt(req.query.lead);
  if (!Number.isFinite(leadId)) {
    return res.status(400).send(notFoundPage('Missing or invalid lead reference.'));
  }

  try {
    const lr = await pool.query(
      'SELECT id, name, business_name, services_interested FROM onboarding_submissions WHERE id = $1',
      [leadId]
    );
    const lead = lr.rows[0];
    if (!lead) {
      return res.status(404).send(notFoundPage('This onboarding link is no longer valid. Please contact the Leogo team.'));
    }

    const services = lead.services_interested || [];

    // Has the client already submitted?
    const dr = await pool.query(
      'SELECT created_at FROM onboarding_details WHERE lead_id = $1',
      [leadId]
    );
    if (dr.rowCount > 0) {
      return res.send(alreadySubmittedPage(lead, dr.rows[0].created_at));
    }

    res.send(renderForm(lead, services));
  } catch (err) {
    console.error('[onboarding-form] GET error:', err && err.message);
    res.status(500).send(notFoundPage('Something went wrong loading your onboarding form. Please try again.'));
  }
});

// ───────────────────────────────────────────────────────────
// POST /submit — accept the assembled form payload
// ───────────────────────────────────────────────────────────
router.post('/submit', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    if (!ipAllowed(ip)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    const b = req.body || {};
    const leadId = parseInt(b.lead_id);
    if (!Number.isFinite(leadId)) {
      return res.status(400).json({ ok: false, error: 'invalid_lead' });
    }

    const lr = await pool.query(
      'SELECT id, services_interested FROM onboarding_submissions WHERE id = $1',
      [leadId]
    );
    const lead = lr.rows[0];
    if (!lead) return res.status(404).json({ ok: false, error: 'lead_not_found' });

    const services = lead.services_interested || [];

    // Build per-service JSONB blobs — only when the lead actually
    // selected that service.
    let vaani = null, social = null, shopify = null;

    if (hasVaani(services)) {
      const v = b.vaani_details || {};
      const vaaniServices = Array.isArray(v.services)
        ? [...new Set(v.services.filter(s => ['whatsapp','instagram'].includes(s)))]
        : [];
      vaani = {
        services:         vaaniServices,
        whatsapp_number:  vaaniServices.includes('whatsapp')  ? clean(v.whatsapp_number, 30)                       : '',
        instagram_handle: vaaniServices.includes('instagram') ? clean(v.instagram_handle, 80).replace(/^@/, '')    : '',
        meta_access:      pickEnum(v.meta_access, ['yes','no','not_sure']),
        shopify_url:      clean(v.shopify_url, 200),
        language:         pickEnum(v.language, ['english','hindi','marathi','other']),
        persona_name:     clean(v.persona_name, 80)
      };
    }

    if (hasSocial(services)) {
      const s = b.social_details || {};
      const contentCreation = pickEnum(s.content_creation, ['full_service','editing_only']);
      social = {
        instagram_handle: clean(s.instagram_handle, 80).replace(/^@/, ''),
        tone:             pickEnum(s.tone, ['fun','professional','mix']),
        competitors:      cleanArr(s.competitors, 10, 120).map(x => x.replace(/^@/, '')),
        content_creation: contentCreation,
        city:             contentCreation === 'full_service' ? clean(s.city, 80) : ''
      };
    }

    if (hasShopify(services)) {
      const sh = b.shopify_details || {};
      shopify = {
        has_domain:    pickEnum(sh.has_domain, ['yes','no']),
        domain:        clean(sh.domain, 200),
        categories:    clean(sh.categories, 2000),
        references:    cleanArr(sh.references, 10, 200),
        has_logo:      pickEnum(sh.has_logo, ['yes','no']),
        brand_colors:  clean(sh.brand_colors, 200)
      };
    }

    const uploadedFiles = cleanArr(b.uploaded_files, 5, 500);
    const finalNotes = clean(b.final_notes, 2000);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);

    try {
      const ins = await pool.query(
        `INSERT INTO onboarding_details
           (lead_id, vaani_details, social_details, shopify_details,
            uploaded_files, final_notes, client_ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id`,
        [leadId,
         vaani   ? JSON.stringify(vaani)   : null,
         social  ? JSON.stringify(social)  : null,
         shopify ? JSON.stringify(shopify) : null,
         uploadedFiles.length ? JSON.stringify(uploadedFiles) : null,
         finalNotes || null,
         ip || null,
         ua || null]
      );

      // Auto-progress the parent lead's status to 'onboarding_submitted'.
      // Best-effort: a failure here must not fail the client's submission.
      // COALESCE so we don't overwrite an existing contacted_at timestamp.
      try {
        await pool.query(
          `UPDATE onboarding_submissions
              SET status = 'onboarding_submitted',
                  contacted_at = COALESCE(contacted_at, NOW())
            WHERE id = $1`,
          [leadId]
        );
      } catch (updErr) {
        console.error('[onboarding-form] lead status update failed:', updErr && updErr.message);
      }

      return res.json({ ok: true, id: ins.rows[0].id });
    } catch (insErr) {
      // 23505 = unique_violation on lead_id
      if (insErr && insErr.code === '23505') {
        return res.status(409).json({ ok: false, error: 'already_submitted' });
      }
      throw insErr;
    }
  } catch (err) {
    console.error('[onboarding-form] POST error:', err && err.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;

// ═══════════════════════════════════════════════════════════
// HTML rendering
// ═══════════════════════════════════════════════════════════

const SHARED_STYLES = `
:root{--cream:#FAF7F2;--ink:#1A1714;--warm:#C4783A;--warm-light:#F0E0CC;--warm-dark:#9E5E28;--muted:#8A7E74;--border:#E5DDD4;--green:#2D6A4F;--green-light:#D8EDE4;--card-bg:#F4EFE8}
*{margin:0;padding:0;box-sizing:border-box}html{scroll-behavior:smooth;overflow-x:hidden}img,video{max-width:100%;height:auto;display:block}
body{background:#faf6f1;color:var(--ink);font-family:'DM Sans',sans-serif;font-weight:300;min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased;position:relative}
body::before{content:'';position:fixed;inset:0;background:url('/images/paper-texture.jpg') center/cover;opacity:.2;z-index:-1;pointer-events:none}

nav{padding:1.8rem 4rem;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(250,247,242,.92);backdrop-filter:blur(12px);z-index:100}
.logo{font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:700;letter-spacing:-.01em;color:var(--ink);text-decoration:none}.logo span{color:var(--warm)}
.nav-meta{font-size:.78rem;color:var(--muted);letter-spacing:.04em}

.btn-primary{display:inline-flex;align-items:center;justify-content:center;gap:.55rem;background:var(--warm);color:white;padding:.95rem 1.8rem;border-radius:100px;font-size:.82rem;letter-spacing:.08em;text-transform:uppercase;font-weight:500;text-decoration:none;transition:background .2s,transform .2s,opacity .2s;border:none;cursor:pointer;font-family:'DM Sans',sans-serif}
.btn-primary:hover:not(:disabled){background:var(--warm-dark);transform:translateY(-1px)}
.btn-primary:disabled{opacity:.5;cursor:not-allowed;transform:none}
.btn-outline{display:inline-flex;align-items:center;justify-content:center;background:transparent;color:var(--ink);padding:.9rem 1.6rem;border-radius:100px;font-size:.82rem;letter-spacing:.08em;text-transform:uppercase;font-weight:500;border:1.5px solid var(--border);cursor:pointer;font-family:'DM Sans',sans-serif;transition:border-color .2s,transform .2s}
.btn-outline:hover{border-color:var(--ink);transform:translateY(-1px)}

.container{max-width:780px;margin:0 auto;padding:0 2rem}
.page-hero{padding:4rem 0 1.4rem;text-align:center}
.page-hero .greeting{display:inline-block;font-size:.68rem;letter-spacing:.18em;text-transform:uppercase;color:var(--warm);margin-bottom:1.2rem;font-weight:500}
.page-hero h1{font-family:'Playfair Display',serif;font-size:clamp(2.1rem,4.5vw,3.3rem);font-weight:400;letter-spacing:-.02em;line-height:1.1;margin-bottom:1rem}
.page-hero h1 em{font-style:italic;color:var(--warm)}
.page-hero .lede{font-size:1rem;color:var(--muted);line-height:1.7;max-width:560px;margin:0 auto}

.progress-wrap{max-width:480px;margin:1.6rem auto 0}
.progress-bar{background:rgba(196,120,58,.16);height:6px;border-radius:100px;overflow:hidden}
.progress-fill{background:linear-gradient(90deg,var(--warm),var(--warm-dark));height:100%;width:0;border-radius:100px;transition:width .35s ease}
.progress-label{font-size:.74rem;color:var(--muted);margin-top:.7rem;letter-spacing:.04em;text-align:center}
.progress-label strong{color:var(--ink);font-weight:600}

.form-section{padding:1rem 0 4rem}
.form-card{max-width:620px;margin:0 auto;background:rgba(255,255,255,.72);backdrop-filter:blur(20px) saturate(150%);-webkit-backdrop-filter:blur(20px) saturate(150%);border:1px solid rgba(180,155,130,.3);border-radius:22px;padding:2.6rem 2.4rem;box-shadow:0 4px 24px rgba(150,120,80,.08)}
.step{display:none}.step.active{display:block}

.step-tag{display:inline-block;font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;color:var(--warm);font-weight:600;margin-bottom:.6rem}
.step h2{font-family:'Playfair Display',serif;font-size:1.6rem;font-weight:500;color:var(--ink);margin-bottom:.5rem;letter-spacing:-.01em;line-height:1.2}
.step p.intro{font-size:.92rem;color:var(--muted);line-height:1.6;margin-bottom:1.6rem}

.form-row{margin-bottom:1.1rem}
.form-label{display:block;font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:.5rem;font-weight:500}
.form-label .opt{text-transform:none;letter-spacing:0;color:var(--muted);font-size:.7rem;font-weight:400;margin-left:.3rem;opacity:.75}
.form-input,.form-select,.form-textarea{width:100%;padding:.92rem 1.1rem;border:1.5px solid var(--border);border-radius:12px;font-size:.95rem;font-family:'DM Sans',sans-serif;background:rgba(255,255,255,.7);color:var(--ink);transition:border-color .2s;font-weight:400}
.form-input:focus,.form-select:focus,.form-textarea:focus{outline:none;border-color:var(--warm)}
.form-input::placeholder,.form-textarea::placeholder{color:var(--muted)}
.form-textarea{resize:vertical;min-height:96px;line-height:1.55}
.form-select{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%238A7E74' d='M6 8L0 0h12z'/></svg>");background-repeat:no-repeat;background-position:right 1.1rem center;padding-right:2.6rem;cursor:pointer}
.input-prefix-text{position:relative}.input-prefix-text .at{position:absolute;left:1rem;top:50%;transform:translateY(-50%);color:var(--muted);font-size:.95rem;pointer-events:none}.input-prefix-text input{padding-left:2.1rem}

.radio-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.55rem}
.radio-grid.two{grid-template-columns:1fr 1fr}
@media(max-width:520px){.radio-grid{grid-template-columns:1fr}}
.radio-option{position:relative;cursor:pointer}
.radio-option input{position:absolute;opacity:0;pointer-events:none}
.radio-option .chip{display:flex;align-items:center;justify-content:center;padding:.78rem .9rem;border:1.5px solid var(--border);border-radius:10px;background:rgba(255,255,255,.6);transition:all .18s ease;font-size:.86rem;color:var(--ink);font-weight:400;text-align:center;line-height:1.2}
.radio-option:hover .chip{border-color:var(--warm-light);background:rgba(255,255,255,.8)}
.radio-option input:checked + .chip{border-color:var(--warm);background:rgba(196,120,58,.08);color:var(--ink);font-weight:500}
.radio-option input:focus-visible + .chip{box-shadow:0 0 0 3px rgba(196,120,58,.18)}

.checkbox-row{display:flex;align-items:flex-start;gap:.6rem;font-size:.86rem;color:var(--ink);cursor:pointer;margin:.4rem 0 1rem;line-height:1.5;padding:.85rem 1rem;border:1.5px solid var(--border);border-radius:10px;background:rgba(255,255,255,.5);transition:border-color .15s,background .15s}
.checkbox-row:hover{border-color:var(--warm-light);background:rgba(255,255,255,.7)}
.checkbox-row input{margin-top:.25rem;accent-color:var(--warm)}

.repeat-list{display:flex;flex-direction:column;gap:.5rem}
.conditional{display:none;margin-top:.7rem}
.conditional.show{display:block}

.form-error{font-size:.75rem;color:#C44A4A;margin-top:.45rem;min-height:1em;line-height:1.4}
.form-helper{font-size:.72rem;color:var(--muted);margin-top:.4rem;line-height:1.45}
.global-error{background:rgba(196,74,74,.08);border:1px solid rgba(196,74,74,.3);color:#9E2A2A;border-radius:10px;padding:.7rem .9rem;font-size:.82rem;margin-bottom:1rem;display:none;line-height:1.45}
.global-error.show{display:block}

.step-nav{display:flex;justify-content:space-between;gap:.8rem;margin-top:2rem;padding-top:1.4rem;border-top:1px solid var(--border)}
.step-nav .spacer{flex:1}
.step-nav button{flex:0 0 auto;min-width:9.5rem}
.step-nav .btn-primary{padding:.9rem 1.6rem;font-size:.78rem}

.success-state{text-align:center;padding:1.8rem 0}
.success-state .check{width:64px;height:64px;border-radius:50%;background:var(--green-light);color:var(--green);display:flex;align-items:center;justify-content:center;font-size:2rem;margin:0 auto 1.4rem}
.success-state h2{font-family:'Playfair Display',serif;font-size:1.6rem;font-weight:500;color:var(--ink);margin-bottom:.7rem;letter-spacing:-.01em}
.success-state p{font-size:.94rem;color:var(--muted);line-height:1.65;max-width:420px;margin:0 auto 1.4rem}

footer{border-top:1px solid var(--border);padding:2.4rem 4rem;display:flex;align-items:center;justify-content:space-between;gap:2rem;margin-top:2rem;font-size:.74rem;color:var(--muted)}
footer .logo{font-size:1.1rem}

@media(max-width:768px){
  nav{padding:1.1rem 1.4rem}
  footer{flex-direction:column;text-align:center;padding:2rem 1.5rem}
  .container{padding:0 1.2rem}
  .form-card{padding:2rem 1.4rem;border-radius:18px}
  .step-nav{flex-wrap:wrap}.step-nav button{flex:1 1 auto}
}
`;

function pageShell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="preload" as="image" href="/images/paper-texture.jpg">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400;1,600&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>${SHARED_STYLES}</style>
</head>
<body>
<nav>
  <a href="/" class="logo">vaani<span>.</span></a>
  <div class="nav-meta">Client onboarding</div>
</nav>
${bodyHtml}
<footer>
  <div><a href="/" class="logo">vaani<span>.</span></a></div>
  <div>© 2026 Leogo Designs · Made with ♥ in Pune</div>
</footer>
</body>
</html>`;
}

function notFoundPage(message) {
  return pageShell('Onboarding — Leogo Designs', `
<main>
  <section class="page-hero container">
    <span class="greeting">Client Onboarding</span>
    <h1>Hmm, that didn't work</h1>
    <p class="lede">${escapeHtml(message)}</p>
  </section>
  <section class="form-section container">
    <div class="form-card" style="text-align:center">
      <p style="color:var(--muted);font-size:.92rem;line-height:1.6;margin-bottom:1.4rem">If you think you're seeing this in error, message us on WhatsApp and we'll send you a fresh link.</p>
      <a class="btn-primary" href="https://wa.me/919403345612">Chat on WhatsApp →</a>
    </div>
  </section>
</main>`);
}

function alreadySubmittedPage(lead, when) {
  const dateStr = new Date(when).toLocaleDateString('en-IN', { dateStyle: 'medium' });
  return pageShell('Onboarding submitted — Leogo Designs', `
<main>
  <section class="page-hero container">
    <span class="greeting">Already received</span>
    <h1>Thanks, <em>${escapeHtml(lead.name.split(' ')[0])}</em> — we've got everything</h1>
    <p class="lede">Your onboarding details for ${escapeHtml(lead.business_name)} came through on ${escapeHtml(dateStr)}. Our team will be in touch on WhatsApp soon.</p>
  </section>
  <section class="form-section container">
    <div class="form-card success-state">
      <div class="check">✓</div>
      <h2>Submission received</h2>
      <p>If anything needs to change, message us on WhatsApp and we'll update it on our end.</p>
      <a class="btn-primary" href="https://wa.me/919403345612" style="display:inline-flex;width:auto;padding:.9rem 1.8rem">Message us on WhatsApp →</a>
    </div>
  </section>
</main>`);
}

function renderForm(lead, services) {
  const showVaani   = hasVaani(services);
  const showSocial  = hasSocial(services);
  const showShopify = hasShopify(services);

  const steps = [];
  if (showVaani)   steps.push('vaani');
  if (showSocial)  steps.push('social');
  if (showShopify) steps.push('shopify');
  steps.push('final');

  const firstName = (lead.name || '').split(' ')[0] || 'there';

  return pageShell(`Onboarding — ${lead.business_name}`, `
<main>
  <section class="page-hero container">
    <span class="greeting">Client onboarding · ${escapeHtml(lead.business_name)}</span>
    <h1>Welcome, <em>${escapeHtml(firstName)}</em></h1>
    <p class="lede">A few details so we can build exactly what you need. This usually takes 5 minutes — you can come back to any step before submitting.</p>
    <div class="progress-wrap">
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <p class="progress-label">Step <strong id="stepNum">1</strong> of <strong id="stepTotal">${steps.length}</strong></p>
    </div>
  </section>

  <section class="form-section container">
    <div class="form-card" id="formCard">
      <div class="global-error" id="globalError"></div>
      <form id="onboardForm" autocomplete="on" novalidate data-steps="${steps.join(',')}">
        <input type="hidden" name="lead_id" value="${lead.id}">

        ${showVaani ? renderVaaniStep(services) : ''}
        ${showSocial ? renderSocialStep() : ''}
        ${showShopify ? renderShopifyStep() : ''}
        ${renderFinalStep()}
      </form>

      <div class="success-state" id="successState" style="display:none">
        <div class="check">✓</div>
        <h2>All set, ${escapeHtml(firstName)}.</h2>
        <p>We've received your onboarding details. Our team will reach out on WhatsApp within one working day with next steps.</p>
        <a class="btn-primary" href="https://wa.me/919403345612" style="display:inline-flex;width:auto;padding:.9rem 1.8rem">Message us on WhatsApp →</a>
      </div>
    </div>
  </section>
</main>

<script>
${formScript()}
</script>`);
}

function renderVaaniStep(services) {
  const waChecked = services.includes('vaani_whatsapp')  ? 'checked' : '';
  const igChecked = services.includes('vaani_instagram') ? 'checked' : '';
  return `
<section class="step" data-step="vaani">
  <span class="step-tag">Vaani · AI sales bot</span>
  <h2>Tell us about your channel</h2>
  <p class="intro">A few specifics so we can spin up your bot on the right channel with the right tone.</p>

  <div class="form-row">
    <label class="form-label">Which Vaani services do you need?</label>
    <div class="radio-grid two">
      <label class="radio-option"><input type="checkbox" id="v_svc_wa" ${waChecked} data-vaani-svc="whatsapp"><span class="chip">WhatsApp Bot</span></label>
      <label class="radio-option"><input type="checkbox" id="v_svc_ig" ${igChecked} data-vaani-svc="instagram"><span class="chip">Instagram Bot</span></label>
    </div>
    <p class="form-helper">Pick one or both — we've pre-selected based on what you told us earlier.</p>
  </div>

  <div class="form-row conditional" id="v_wa_block">
    <label class="form-label" for="v_whatsapp">WhatsApp business number</label>
    <input class="form-input" id="v_whatsapp" placeholder="+91 98765 43210" maxlength="30">
    <p class="form-helper">The number we'll set Vaani up on. Add country code.</p>
  </div>

  <div class="form-row conditional" id="v_ig_block">
    <label class="form-label" for="v_ig_handle">Instagram handle for the bot</label>
    <div class="input-prefix-text">
      <span class="at">@</span>
      <input class="form-input" id="v_ig_handle" placeholder="yourbrand" maxlength="80">
    </div>
    <p class="form-helper">The Instagram account Vaani will respond from.</p>
  </div>

  <div class="form-row">
    <label class="form-label">Do you have Meta Business Manager access?</label>
    <div class="radio-grid">
      <label class="radio-option"><input type="radio" name="v_meta" value="yes"><span class="chip">Yes</span></label>
      <label class="radio-option"><input type="radio" name="v_meta" value="no"><span class="chip">No</span></label>
      <label class="radio-option"><input type="radio" name="v_meta" value="not_sure"><span class="chip">Not sure</span></label>
    </div>
    <p class="form-helper">If unsure, we'll walk you through it.</p>
  </div>

  <div class="form-row">
    <label class="form-label" for="v_shopify">Shopify store URL <span class="opt">(if applicable)</span></label>
    <input class="form-input" id="v_shopify" placeholder="yourstore.myshopify.com" maxlength="200">
  </div>

  <div class="form-row">
    <label class="form-label" for="v_lang">Preferred language</label>
    <select class="form-select" id="v_lang">
      <option value="" disabled selected>Pick a language</option>
      <option value="english">English</option>
      <option value="hindi">Hindi</option>
      <option value="marathi">Marathi</option>
      <option value="other">Other</option>
    </select>
  </div>

  <div class="form-row">
    <label class="form-label" for="v_persona">What should we name your bot persona?</label>
    <input class="form-input" id="v_persona" placeholder="e.g. Aria, Rio, Jhilmil" maxlength="80">
    <p class="form-helper">The name customers see when chatting with you.</p>
  </div>
</section>`;
}

function renderSocialStep() {
  return `
<section class="step" data-step="social">
  <span class="step-tag">Social Media Management</span>
  <h2>Your social style</h2>
  <p class="intro">So we know who you're talking to, how you sound, and what you'd love to look like.</p>

  <div class="form-row">
    <label class="form-label" for="s_ig">Instagram handle</label>
    <div class="input-prefix-text">
      <span class="at">@</span>
      <input class="form-input" id="s_ig" placeholder="yourbrand" maxlength="80">
    </div>
  </div>

  <div class="form-row">
    <label class="form-label" for="s_tone">Content language & tone</label>
    <select class="form-select" id="s_tone">
      <option value="" disabled selected>Pick a tone</option>
      <option value="fun">Fun &amp; Casual</option>
      <option value="professional">Professional</option>
      <option value="mix">Mix of both</option>
    </select>
  </div>

  <div class="form-row">
    <label class="form-label" for="s_competitors_text">2–3 competitor handles for reference</label>
    <textarea class="form-textarea" id="s_competitors_text" placeholder="@brand_one&#10;@brand_two&#10;@brand_three" maxlength="600"></textarea>
    <p class="form-helper">One per line, or separated by commas. Brands whose feed energy you'd love to match.</p>
  </div>

  <div class="form-row">
    <label class="form-label">Content creation</label>
    <div class="radio-grid two">
      <label class="radio-option"><input type="radio" name="s_creation" value="full_service" data-toggle-target="s_city_block" data-toggle-when="full_service"><span class="chip">Full service — we shoot &amp; edit</span></label>
      <label class="radio-option"><input type="radio" name="s_creation" value="editing_only" data-toggle-target="s_city_block" data-toggle-when="full_service"><span class="chip">Editing only — we'll send raw videos</span></label>
    </div>
  </div>

  <div class="form-row conditional" id="s_city_block">
    <label class="form-label" for="s_city">Your city</label>
    <input class="form-input" id="s_city" placeholder="Pune, Mumbai, Bengaluru…" maxlength="80">
    <p class="form-helper">Helps us plan shoots in the right place.</p>
  </div>
</section>`;
}

function renderShopifyStep() {
  return `
<section class="step" data-step="shopify">
  <span class="step-tag">Shopify Website</span>
  <h2>About your store</h2>
  <p class="intro">A bit of context so we can scope the build right.</p>

  <div class="form-row">
    <label class="form-label">Do you have a domain?</label>
    <div class="radio-grid two">
      <label class="radio-option"><input type="radio" name="sh_domain" value="yes" data-toggle-target="sh_domain_input"><span class="chip">Yes</span></label>
      <label class="radio-option"><input type="radio" name="sh_domain" value="no" data-toggle-target="sh_domain_input"><span class="chip">No, not yet</span></label>
    </div>
    <div class="conditional" id="sh_domain_input">
      <label class="form-label" for="sh_domain_value" style="margin-top:.6rem">What's the domain?</label>
      <input class="form-input" id="sh_domain_value" placeholder="yourbrand.com" maxlength="200">
    </div>
  </div>

  <div class="form-row">
    <label class="form-label" for="sh_categories">Product categories</label>
    <textarea class="form-textarea" id="sh_categories" placeholder="What types of products will you sell? Group them however makes sense to you." maxlength="2000"></textarea>
  </div>

  <div class="form-row">
    <label class="form-label" for="sh_refs_text">2–3 reference websites you like</label>
    <textarea class="form-textarea" id="sh_refs_text" placeholder="https://reference-one.com&#10;https://reference-two.com&#10;https://reference-three.com" maxlength="800"></textarea>
    <p class="form-helper">One per line. Sites whose design, flow, or vibe you'd love to take inspiration from.</p>
  </div>

  <div class="form-row">
    <label class="form-label">Do you have a logo?</label>
    <div class="radio-grid two">
      <label class="radio-option"><input type="radio" name="sh_logo" value="yes"><span class="chip">Yes</span></label>
      <label class="radio-option"><input type="radio" name="sh_logo" value="no"><span class="chip">Not yet</span></label>
    </div>
  </div>

  <div class="form-row">
    <label class="form-label" for="sh_colors">Brand colors <span class="opt">(if known)</span></label>
    <input class="form-input" id="sh_colors" placeholder="e.g. terracotta, cream, dusty green, or hex codes" maxlength="200">
  </div>
</section>`;
}

function renderFinalStep() {
  return `
<section class="step" data-step="final">
  <span class="step-tag">Last step</span>
  <h2>Files & anything else</h2>
  <p class="intro">Drop links to logo/brand files (Google Drive, Dropbox, WeTransfer, anything that works). Or leave it blank and we'll ask separately.</p>

  <div class="form-row">
    <label class="form-label" for="f_files">Brand files link <span class="opt">(optional)</span></label>
    <input class="form-input" id="f_files" placeholder="https://drive.google.com/..." maxlength="500">
    <p class="form-helper">A folder link works best.</p>
  </div>

  <div class="form-row">
    <label class="form-label" for="f_notes">Any final notes? <span class="opt">(optional)</span></label>
    <textarea class="form-textarea" id="f_notes" placeholder="Deadlines, must-haves, references, dreams — anything." maxlength="2000"></textarea>
  </div>
</section>`;
}

// Client-side JS for step navigation + submission.
function formScript() {
  return `
(function(){
  const $ = id => document.getElementById(id);
  const form = $('onboardForm');
  const stepKeys = (form.dataset.steps || '').split(',').filter(Boolean);
  const stepEls = stepKeys.map(k => document.querySelector('.step[data-step="' + k + '"]'));
  const globalError = $('globalError');
  let current = 0;

  // Inject nav buttons into each step.
  stepEls.forEach((el, idx) => {
    const nav = document.createElement('div');
    nav.className = 'step-nav';
    const isLast = idx === stepEls.length - 1;
    nav.innerHTML =
      (idx > 0 ? '<button type="button" class="btn-outline" data-back>← Back</button>' : '<span class="spacer"></span>') +
      '<span class="spacer"></span>' +
      '<button type="' + (isLast ? 'submit' : 'button') + '" class="btn-primary" ' + (isLast ? 'id="submitBtn"' : 'data-next') + '>' +
        (isLast ? 'Submit onboarding →' : 'Next →') +
      '</button>';
    el.appendChild(nav);
  });

  // Radio-driven conditional reveals (e.g. "domain: yes" or "creation: full_service").
  document.querySelectorAll('[data-toggle-target]').forEach(el => {
    el.addEventListener('change', () => {
      const tgt = document.getElementById(el.dataset.toggleTarget);
      if (!tgt) return;
      const expect = el.dataset.toggleWhen || 'yes';
      tgt.classList.toggle('show', el.value === expect && el.checked);
    });
  });

  // Checkbox-driven conditional reveals for the Vaani sub-services. Honors
  // pre-checked state set server-side based on the lead's earlier picks.
  const vWa = $('v_svc_wa'), vIg = $('v_svc_ig');
  const vWaBlock = $('v_wa_block'), vIgBlock = $('v_ig_block');
  function syncVaani() {
    if (vWaBlock) vWaBlock.classList.toggle('show', !!(vWa && vWa.checked));
    if (vIgBlock) vIgBlock.classList.toggle('show', !!(vIg && vIg.checked));
  }
  if (vWa) vWa.addEventListener('change', syncVaani);
  if (vIg) vIg.addEventListener('change', syncVaani);
  syncVaani();

  function parseLines(text) {
    return (text || '').split(/[\\n,]/).map(s => s.trim()).filter(Boolean).slice(0, 10);
  }

  function showStep(i) {
    stepEls.forEach((el, idx) => el.classList.toggle('active', idx === i));
    $('stepNum').textContent = (i + 1);
    $('progressFill').style.width = (((i + 1) / stepEls.length) * 100) + '%';
    globalError.classList.remove('show');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.addEventListener('click', e => {
    if (e.target.matches('[data-next]'))  { current = Math.min(current + 1, stepEls.length - 1); showStep(current); }
    if (e.target.matches('[data-back]'))  { current = Math.max(current - 1, 0); showStep(current); }
  });

  // Collect payload from active sections.
  function collect() {
    const out = { lead_id: form.elements.lead_id.value };

    if (stepKeys.includes('vaani')) {
      const vaaniSvcs = [];
      if (vWa && vWa.checked) vaaniSvcs.push('whatsapp');
      if (vIg && vIg.checked) vaaniSvcs.push('instagram');
      out.vaani_details = {
        services:         vaaniSvcs,
        whatsapp_number:  vaaniSvcs.includes('whatsapp')  ? $('v_whatsapp').value.trim()                          : '',
        instagram_handle: vaaniSvcs.includes('instagram') ? $('v_ig_handle').value.trim().replace(/^@/, '')       : '',
        meta_access:      (document.querySelector('input[name="v_meta"]:checked') || {}).value || null,
        shopify_url:      $('v_shopify').value.trim(),
        language:         $('v_lang').value || null,
        persona_name:     $('v_persona').value.trim()
      };
    }
    if (stepKeys.includes('social')) {
      const creation = (document.querySelector('input[name="s_creation"]:checked') || {}).value || null;
      out.social_details = {
        instagram_handle: $('s_ig').value.trim().replace(/^@/, ''),
        tone:             $('s_tone').value || null,
        competitors:      parseLines($('s_competitors_text').value).map(x => x.replace(/^@/, '')),
        content_creation: creation,
        city:             creation === 'full_service' ? $('s_city').value.trim() : ''
      };
    }
    if (stepKeys.includes('shopify')) {
      out.shopify_details = {
        has_domain:    (document.querySelector('input[name="sh_domain"]:checked') || {}).value || null,
        domain:        $('sh_domain_value').value.trim(),
        categories:    $('sh_categories').value.trim(),
        references:    parseLines($('sh_refs_text').value),
        has_logo:      (document.querySelector('input[name="sh_logo"]:checked') || {}).value || null,
        brand_colors:  $('sh_colors').value.trim()
      };
    }
    const filesLink = $('f_files').value.trim();
    out.uploaded_files = filesLink ? [filesLink] : [];
    out.final_notes = $('f_notes').value.trim();
    return out;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('submitBtn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    globalError.classList.remove('show');

    try {
      const res = await fetch('/onboarding/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collect())
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'submission_failed');

      form.style.display = 'none';
      $('successState').style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      const map = {
        already_submitted: 'You\\'ve already submitted this form — please refresh to see your confirmation.',
        rate_limited:      'Too many attempts in a short window. Please try again in a few minutes.',
        invalid_lead:      'This onboarding link looks broken. Please contact the Leogo team.',
        lead_not_found:    'This onboarding link is no longer valid. Please contact the Leogo team.'
      };
      globalError.textContent = map[err.message] || 'Couldn\\'t submit right now. Please try again or message us on WhatsApp.';
      globalError.classList.add('show');
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  showStep(0);
})();
`;
}
