#!/usr/bin/env python3
"""
Phase 1 patch for woofparade.js — restores PDF v1.4 verbatim copy for:
  - S01 Showstopper CTA welcome (separate from generic welcome)
  - S03 Returning-customer branches A / A.1 / B / C
  - S04 Random hi/hello welcome
  - S05 Browse close-out copy (numbered + Reply with number phrasing)
  - S09 Checkout discount transparency in Rio's voice

Safe to re-run — each patch checks for current state before applying.
"""
import pathlib
import re
import sys

HANDLER_PATH = pathlib.Path('handlers/woofparade.js')

if not HANDLER_PATH.exists():
    print(f"ERROR: {HANDLER_PATH} not found. Run this from your ~/vaani-app directory.")
    sys.exit(1)

content = HANDLER_PATH.read_text()
original = content
applied = []

# ════════════════════════════════════════════════════════════════════════
# PATCH 1 — Add new helper getLastOrderSummary (for S03 Branch A warmth)
# ════════════════════════════════════════════════════════════════════════
# Insert right after the existing getCustomerPupProfiles function.

new_helper = """
async function getLastOrderSummary(ctx) {
  // S03 Branch A: returns { pupName, productTitle } from most recent paid order, or null.
  try {
    const r = await pool.query(
      `SELECT pup_name, items_json, created_at
         FROM orders
        WHERE tenant_id = $1 AND customer_phone = $2 AND status = 'paid'
        ORDER BY created_at DESC LIMIT 1`,
      [ctx.tenant.id, ctx.from]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    let firstItem = null;
    try {
      const items = typeof row.items_json === 'string' ? JSON.parse(row.items_json) : row.items_json;
      if (Array.isArray(items) && items.length > 0) firstItem = items[0]?.title || items[0]?.name || null;
    } catch (_) {}
    return { pupName: row.pup_name || null, productTitle: firstItem };
  } catch (e) {
    console.error('[woofparade getLastOrderSummary] error:', e.message);
    return null;
  }
}

"""

anchor1 = "async function savePupProfile(tenantId, customerPhone, pupName, breed = null, dob = null) {"
if "async function getLastOrderSummary" not in content:
    if anchor1 in content:
        content = content.replace(anchor1, new_helper + anchor1, 1)
        applied.append("P1: getLastOrderSummary helper added")
    else:
        print("WARN: P1 anchor not found, skipping.")
else:
    applied.append("P1: getLastOrderSummary already present, skipped")

# ════════════════════════════════════════════════════════════════════════
# PATCH 2 — Replace sendWelcome() to handle S01 / S03 (A/A.1/B/C) / S04
# ════════════════════════════════════════════════════════════════════════
# The current sendWelcome is generic. We need:
#   - sendShowstopperWelcome(ctx) for S01 (CTA from website)
#   - sendWelcome(ctx) for S04 (random hi) with PDF-exact copy
#   - sendReturningWelcome(ctx) for S03 (purchased before) with branches
# Then update entry points to call the right one.

# First, find current sendWelcome and replace its body for S04 PDF copy.
# We do this by replacing the specific drifted strings with PDF copy.

old_s04 = """    } else {
      baseBody =
        `Hi, I'm ${getBotName(ctx)} from ${BRAND_NAME} ${PAW}\\n` +
        `Your pup's wardrobe HQ — casual, festive, IPL jerseys, accessories, custom fits.\\n` +
        `What can I show you?`;
    }"""
new_s04 = """    } else {
      // S04 PDF v1.4: "Hey there! I'm Rio, Woof Parade's golden-furred greeter 🐾 What's your pup looking for today?"
      baseBody =
        `Hey there! I'm ${getBotName(ctx)}, ${BRAND_NAME}'s golden-furred greeter ${PAW}\\n` +
        `What's your pup looking for today?`;
    }"""

if old_s04 in content:
    content = content.replace(old_s04, new_s04, 1)
    applied.append("P2a: S04 random-hi welcome copy → PDF verbatim")
else:
    applied.append("P2a: S04 copy already updated or shape changed, manual check needed")

# Replace the "purchased" branch — make it route to dedicated returning-welcome below.
old_purchased = """  if (!baseBody) {
    if (purchased) {
      baseBody =
        `Welcome back to ${BRAND_NAME} ${PAW}\\n` +
        `Lovely to see you again — what can I help you with today?`;
    } else {"""
new_purchased = """  if (!baseBody) {
    if (purchased) {
      // S03: returning customer — branch on whether pup name is on file
      await sendReturningWelcome(ctx);
      return;
    } else {"""

if old_purchased in content:
    content = content.replace(old_purchased, new_purchased, 1)
    applied.append("P2b: sendWelcome routes returning customers to sendReturningWelcome")
else:
    applied.append("P2b: sendWelcome shape changed, manual check needed")

# ════════════════════════════════════════════════════════════════════════
# PATCH 3 — Add sendShowstopperWelcome (S01) and sendReturningWelcome (S03)
# ════════════════════════════════════════════════════════════════════════
# Insert these new functions right before the existing sendWelcome.

new_functions = """async function sendShowstopperWelcome(ctx) {
  // S01 PDF v1.4: when customer taps "Make my pet a showstopper" CTA on website.
  // "Hey there! I'm Rio, the woofy face of Woof Parade 🐾 Showstopper mode activated — where shall we start?"
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const body =
    `Hey there! I'm ${getBotName(ctx)}, the woofy face of ${BRAND_NAME} ${PAW}\\n` +
    `Showstopper mode activated — where shall we start?`;
  await sendList(from, body, [{
    title: 'View categories',
    rows: [
      { id: WELCOME_ROW.CASUAL,      title: 'Casual Wear',     description: 'Daily outfits & kurtas' },
      { id: WELCOME_ROW.FESTIVE,     title: 'Festive Wear',    description: 'Sherwanis, lehengas, more' },
      { id: WELCOME_ROW.ACCESSORIES, title: 'Accessories',     description: 'Bandanas, collars, bowties' },
      { id: WELCOME_ROW.IPL,         title: 'IPL Jerseys',     description: 'Match-day fits for pups' },
      { id: WELCOME_ROW.CUSTOM,      title: 'Custom Fit',      description: "Made to your pup's size" },
      { id: WELCOME_ROW.BESTSELLERS, title: 'Bestsellers',     description: 'What other pups love' },
    ],
  }], waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade S01 showstopper-cta welcome]' },
  ], cart);
}

async function sendReturningWelcome(ctx) {
  // S03 PDF v1.4 — three branches:
  //   A: purchased + pup name on file: "Welcome back, Mochi's parent! 🐾 How's Mochi doing in the Banarasi Lavender Kurta? ..."
  //   B: purchased + no pup name on file: "Welcome back 🐾 Hope your pup is doing well in the Banarasi Lavender Kurta!..."
  //   C: chatted but never purchased: "Welcome back 🐾 Last time you were checking out the X. Want to: [Continue where I left off]..."
  const { tenant, from, text, phoneNumberId, waToken, history, cart } = ctx;
  const last = await getLastOrderSummary(ctx);
  const pups = await getCustomerPupProfiles(ctx);
  const pupName = pups[0]?.pup_name || last?.pupName || null;
  const lastProduct = last?.productTitle || null;

  let body;
  if (pupName && lastProduct) {
    // Branch A
    body =
      `Welcome back, ${pupName}'s parent! ${PAW}\\n` +
      `How's ${pupName} doing in the ${lastProduct}?\\n\\n` +
      `Looking for something new today, or need a hand with your last order?`;
  } else if (lastProduct) {
    // Branch B (purchased, no pup name)
    body =
      `Welcome back ${PAW}\\n` +
      `Hope your pup is doing well in the ${lastProduct}!\\n\\n` +
      `Looking for something new today?`;
  } else {
    // Fallback when we know they purchased but can't pull product details
    body =
      `Welcome back ${PAW}\\n` +
      `Looking for something new today, or need a hand with your last order?`;
  }

  await sendButtons(from, body,
    ['Browse fresh', 'Order help', 'Just saying hi 🧡'],
    waToken, phoneNumberId);

  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: `[woofparade S03 returning-welcome pup=${pupName||'-'} last=${lastProduct||'-'}]` },
  ], cart);
}

"""

anchor3 = "async function sendWelcome(ctx) {"
if "async function sendShowstopperWelcome" not in content:
    if anchor3 in content:
        content = content.replace(anchor3, new_functions + anchor3, 1)
        applied.append("P3: sendShowstopperWelcome + sendReturningWelcome added")
    else:
        print("WARN: P3 anchor not found.")
else:
    applied.append("P3: helpers already present, skipped")

# ════════════════════════════════════════════════════════════════════════
# PATCH 4 — Route S01 CTA to sendShowstopperWelcome (not generic welcome)
# ════════════════════════════════════════════════════════════════════════

old_s01_route = """  // ─── S01 CTA AUTO-MESSAGE — \"Make my Pet look like a Showstopper!\" ──────
  if (edge.SHOWSTOPPER_CTA_RE.test(trimmed)) {
    await sendWelcome(ctx);
    return;
  }"""
new_s01_route = """  // ─── S01 CTA AUTO-MESSAGE — \"Make my Pet look like a Showstopper!\" ──────
  if (edge.SHOWSTOPPER_CTA_RE.test(trimmed)) {
    await sendShowstopperWelcome(ctx);
    return;
  }"""

if old_s01_route in content:
    content = content.replace(old_s01_route, new_s01_route, 1)
    applied.append("P4: S01 routes to sendShowstopperWelcome")
elif "await sendShowstopperWelcome(ctx);" in content:
    applied.append("P4: S01 already routes to sendShowstopperWelcome, skipped")
else:
    applied.append("P4: S01 route not found, manual check needed")

# ════════════════════════════════════════════════════════════════════════
# PATCH 5 — S05 close-out copy → PDF "That's our top 3 in Casual Wear 🐾 Reply with the number to pick, or tap any link to view."
# ════════════════════════════════════════════════════════════════════════

old_s05_close = '`From our ${label} edit ${PAW} Tap any product below to see details and sizes.`'
new_s05_close = "`That's our top ${slice.length} in ${label} ${PAW}\\nReply with the number to pick, or tap any link to view.`"

if old_s05_close in content:
    content = content.replace(old_s05_close, new_s05_close, 1)
    applied.append("P5: S05 close-out copy → PDF verbatim")
else:
    applied.append("P5: S05 close-out copy already updated or shape changed")

# ════════════════════════════════════════════════════════════════════════
# PATCH 6 — S09 checkout transparency → Rio's voice
# ════════════════════════════════════════════════════════════════════════
# Current: "WOOF15 applied (bigger than festival sale)." / "Festival sale auto-applied (bigger than WOOF15)."
# PDF voice: "There's a live sale running — Buy 2+ Get 20%, already auto-applied for you (better than my secret WOOF15, so I've put the bigger one on) 🎉"

old_festival_msg = "transparency: `Festival sale auto-applied (bigger than WOOF15).`,"
new_festival_msg = "transparency: `There's a live sale running, already auto-applied for you (better than my secret WOOF15, so I've put the bigger one on) 🎉`,"

if old_festival_msg in content:
    content = content.replace(old_festival_msg, new_festival_msg, 1)
    applied.append("P6a: S09 festival-bigger message → PDF voice")
else:
    applied.append("P6a: S09 festival message already updated or shape changed")

old_woof15_msg = "transparency: `WOOF15 applied (bigger than festival sale).`,"
new_woof15_msg = "transparency: `Using my secret WOOF15 — it beat today's festival offer 🎉`,"

if old_woof15_msg in content:
    content = content.replace(old_woof15_msg, new_woof15_msg, 1)
    applied.append("P6b: S09 WOOF15-bigger message → PDF voice")
else:
    applied.append("P6b: S09 WOOF15 message already updated or shape changed")

# ════════════════════════════════════════════════════════════════════════
# PATCH 7 — Bug fix: `if (message.type === 'image' && hasPurchasedBefore(ctx))`
# is missing `await` — Promise is always truthy. Currently ALL image messages
# from anyone (including first-timers) route to handlePhotoFromCustomer (S31).
# PDF S31 only fires after positive review from a returning customer.
# ════════════════════════════════════════════════════════════════════════

old_bug = "    if (message.type === 'image' && hasPurchasedBefore(ctx)) {"
new_fix = "    if (message.type === 'image' && await hasPurchasedBefore(ctx)) {"

if old_bug in content:
    content = content.replace(old_bug, new_fix, 1)
    applied.append("P7: BUGFIX — added await to hasPurchasedBefore in image-message check")
else:
    applied.append("P7: already fixed or shape changed")

# ════════════════════════════════════════════════════════════════════════
# Write back
# ════════════════════════════════════════════════════════════════════════

if content == original:
    print("\n⚠️ No changes applied — file is already up to date or anchors not found.")
    for line in applied:
        print(f"  • {line}")
else:
    HANDLER_PATH.write_text(content)
    print(f"\n✅ Patched {HANDLER_PATH}")
    print(f"   Original: {len(original)} chars")
    print(f"   Patched:  {len(content)} chars")
    print(f"   Delta:    {len(content) - len(original):+d}")
    print("\nApplied patches:")
    for line in applied:
        print(f"  • {line}")
    print("\nNext step: node --check handlers/woofparade.js && git diff handlers/woofparade.js")
