#!/usr/bin/env python3
"""
Phase 2 patch for woofparade.js — restores PDF v1.4 verbatim copy for:
  - S07 sizing help intro + 3 outcomes (clean / borderline / no match)
  - S10 COD path opener
  - S11 Pay now confirmation
  - S12 custom-in-chat (intro + Branch A form / Branch B chat-through)
  - S16 talk to human
  - S18 refund SOS
  - S19 stop / unsubscribe — "walks away slowly"
  - S20 international — explicit opt-in language
  - S21 bulk SOS
  - S22 press SOS

Safe to re-run.
"""
import pathlib
import sys

HANDLER_PATH = pathlib.Path('handlers/woofparade.js')

if not HANDLER_PATH.exists():
    print(f"ERROR: {HANDLER_PATH} not found. Run from your ~/vaani-app directory.")
    sys.exit(1)

content = HANDLER_PATH.read_text()
original = content
applied = []
skipped = []

def patch(old, new, label):
    global content
    if old in content:
        content = content.replace(old, new, 1)
        applied.append(label)
        return True
    skipped.append(label)
    return False

# ════════════════════════════════════════════════════════════════════════
# S07 — Sizing help intro (PDF v1.4)
# ════════════════════════════════════════════════════════════════════════
# PDF: "No stress — we'll get the fit just right 🐾 Do you have your pup's measurements handy?"

old_s07_intro = """  await sendMessage(from,
    `Easy — let's find the perfect fit for your pup ${PAW}\\n\\n` +
    `I'll need 3 measurements:\\n` +
    `1. *Back length* (base of neck → base of tail) in inches\\n` +
    `2. *Chest girth* (widest part of chest, behind front legs) in inches\\n` +
    `3. *Neck girth* (where collar sits) in inches\\n\\n` +
    `Got them handy?`,
    waToken, phoneNumberId);
  await sendButtons(from, 'Choose:',
    [SIZE_BTN.YES_HAVE, SIZE_BTN.REMIND, SIZE_BTN.HOOMAN],
    waToken, phoneNumberId);"""
new_s07_intro = """  // S07 PDF v1.4: "No stress — we'll get the fit just right 🐾 Do you have your pup's measurements handy?"
  await sendButtons(from,
    `No stress — we'll get the fit just right ${PAW}\\nDo you have your pup's measurements handy?`,
    [SIZE_BTN.YES_HAVE, SIZE_BTN.REMIND, SIZE_BTN.HOOMAN],
    waToken, phoneNumberId);"""
patch(old_s07_intro, new_s07_intro, "S07 intro → PDF verbatim")

# S07 "Yes, I have them" — PDF spec asks for back/chest/neck (NO armhole)
old_s07_yes = """  await sendMessage(from,
    `Lovely. Send all 3 in one message like this:\\n\\n*Back 18, Chest 22, Neck 14*`,
    waToken, phoneNumberId);"""
new_s07_yes = """  // S07 PDF v1.4: ask for back/chest/neck only (armhole is custom-only — see S12)
  await sendMessage(from,
    `Here's our size chart ${PAW}\\nTap to zoom in — measurements you'll need below.\\n\\n` +
    `Pop them in here:\\n` +
    `• Back length (neck base to tail base)\\n` +
    `• Chest (widest part behind front legs)\\n` +
    `• Neck (around the base)\\n\\n` +
    `In inches please. Like:\\n*Back 14, Chest 18, Neck 12*`,
    waToken, phoneNumberId);"""
patch(old_s07_yes, new_s07_yes, "S07 'Yes, I have them' → PDF verbatim")

# S07 — Clean match outcome (PDF: "That's a Size M for your pup 🐾 Want to go ahead?")
old_s07_clean = """  if (match.outcome === 'clean') {
    await sendMessage(from,
      `✅ Best size for your pup: *${match.size}*\\n\\n` +
      `Back: ${parsed.back}", Chest: ${parsed.chest}", Neck: ${parsed.neck}" ${PAW}`,
      waToken, phoneNumberId);
    await sendButtons(from, "Shall I add it to your shortlist?",
      [`Add ${match.size}`, SIZE_BTN.HOOMAN, PRODUCT_BTN.BACK_TO_MENU],
      waToken, phoneNumberId);
  }"""
new_s07_clean = """  if (match.outcome === 'clean') {
    // S07 PDF v1.4 clean match: "That's a Size M for your pup 🐾 Want to go ahead?"
    await sendButtons(from,
      `That's a Size *${match.size}* for your pup ${PAW}\\nWant to go ahead?`,
      [`Add ${match.size} to shortlist`, SIZE_BTN.TALK_DESIGNER],
      waToken, phoneNumberId);
  }"""
patch(old_s07_clean, new_s07_clean, "S07 clean-match → PDF verbatim")

# S07 — Borderline outcome
# PDF: "Looks like a Size M for your pup 🐾 Quick note — their length (22 in) is slightly over the M (20 in). Could go either way:
#       • M = snugger fit  • L = roomier fit  Which feels right?"
old_s07_border = """  } else if (match.outcome === 'borderline') {
    await sendMessage(from,
      `Your pup sits between two sizes ${PAW}\\n\\n` +
      `*${match.size}* will fit snug. *${match.otherSize}* will be a touch roomy.\\n${match.note}\\n\\nWhich would you like?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [`Add ${match.size}`, `Add ${match.otherSize}`, SIZE_BTN.TALK_DESIGNER],
      waToken, phoneNumberId);
  }"""
new_s07_border = """  } else if (match.outcome === 'borderline') {
    // S07 PDF v1.4 borderline: snugger vs roomier, "Which feels right?"
    await sendMessage(from,
      `Looks like a Size *${match.size}* for your pup ${PAW}\\n\\n` +
      `Quick note — they're slightly over the ${match.size}. Could go either way:\\n\\n` +
      `• *${match.size}* = snugger fit\\n` +
      `• *${match.otherSize}* = roomier fit\\n\\n` +
      `Which feels right?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [`Add ${match.size}`, `Add ${match.otherSize}`, SIZE_BTN.TALK_DESIGNER],
      waToken, phoneNumberId);
  }"""
patch(old_s07_border, new_s07_border, "S07 borderline-match → PDF verbatim")

# S07 — No match outcome
# PDF: "Hmm — your pup's measurements are outside our standard sizes 🐾 But Anouttama can custom-make
#       something pawfect for them. Want me to set that up?"
old_s07_nomatch = """  } else {
    await sendMessage(from,
      `Your pup's measurements are outside our standard sizes ${PAW}\\n\\n` +
      `Back: ${parsed.back}", Chest: ${parsed.chest}", Neck: ${parsed.neck}"\\n\\n` +
      `We can custom-make this for them. Would you like to go ahead?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [SIZE_BTN.YES_CUSTOM, SIZE_BTN.TALK_DESIGNER, PRODUCT_BTN.BACK_TO_MENU],
      waToken, phoneNumberId);
  }"""
new_s07_nomatch = """  } else {
    // S07 PDF v1.4 no match: route to custom
    await sendMessage(from,
      `Hmm — your pup's measurements are outside our standard sizes ${PAW}\\n\\n` +
      `But Anouttama can custom-make something pawfect for them.\\n\\n` +
      `Want me to set that up?`,
      waToken, phoneNumberId);
    await sendButtons(from, 'Choose:',
      [SIZE_BTN.YES_CUSTOM, SIZE_BTN.TALK_DESIGNER],
      waToken, phoneNumberId);
  }"""
patch(old_s07_nomatch, new_s07_nomatch, "S07 no-match → PDF verbatim")

# ════════════════════════════════════════════════════════════════════════
# S07 — "Talk to my hooman" branch (PDF: "Got it 🐾 Apurv from our team will reach out shortly to help you get the sizing right.")
# ════════════════════════════════════════════════════════════════════════
# Currently routes to handleTalkToHuman with generic copy. Per PDF S07 Branch C, message should mention sizing specifically.
# This is currently in handleTalkToHuman generically. Keep generic for now (S16 mentioned), but improve S16 copy below.

# ════════════════════════════════════════════════════════════════════════
# S10 — COD path opener (PDF v1.4)
# PDF: "Sure! I'll need a delivery address. Could you share: 1. Full name 2. Address 3. City + State 4. PIN code 5. Phone (different from WhatsApp, if any)"
# But ALSO S35 pincode check runs FIRST (before address collection).
# Note: current code does pincode check AFTER address parse (line 1302). PDF spec runs it earlier when possible —
# but practically we don't have a PIN until address is collected. Current order is acceptable; just fix the copy.
# ════════════════════════════════════════════════════════════════════════

# Find current ADDRESS_PROMPT
old_addr_prompt_pattern = "const ADDRESS_PROMPT"
if old_addr_prompt_pattern in content:
    # Locate the definition and update it to match PDF
    import re
    m = re.search(r"const ADDRESS_PROMPT\s*=\s*([`'\"]).*?\1\s*;", content, re.DOTALL)
    if m:
        old_full = m.group(0)
        new_full = (
            "const ADDRESS_PROMPT =\n"
            "  // S10 PDF v1.4: \"Sure! I'll need a delivery address...\"\n"
            "  `Sure! I'll need a delivery address.\\n\\n` +\n"
            "  `Could you share:\\n` +\n"
            "  `1. Full name\\n` +\n"
            "  `2. Address (house/flat, street, area)\\n` +\n"
            "  `3. City + State\\n` +\n"
            "  `4. PIN code\\n` +\n"
            "  `5. Alternate phone (different from WhatsApp, optional)`;"
        )
        content = content.replace(old_full, new_full, 1)
        applied.append("S10 ADDRESS_PROMPT → PDF verbatim (5 fields)")
    else:
        skipped.append("S10 ADDRESS_PROMPT — regex didn't match definition")

# ════════════════════════════════════════════════════════════════════════
# S11 — Pay now confirmation (PDF v1.4)
# PDF: "Payment confirmed! 🎉 Order #12345 is on its way to being a showstopper. Tracking link will land here once it ships (usually 1–2 days)."
# Currently the confirmation copy is in handleCheckoutConfirm — update to PDF voice.
# ════════════════════════════════════════════════════════════════════════

old_s11_confirm = """  await sendMessage(from,
    `✅ *Order placed!* ${PAW}\\n\\n` +
    `*Order ID*: ${orderId}\\n` +
    `*Total*: ${formatPrice(co.grand)}\\n` +
    `*Payment*: ${co.paymentMethod === 'cod' ? 'Cash on Delivery' : 'Pay now (link incoming)'}\\n\\n` +
    `Estimated delivery: 4–8 days.\\n` +
    `Apurv will WhatsApp you shortly with tracking once it ships.`,
    waToken, phoneNumberId);"""
new_s11_confirm = """  // S10/S11 PDF v1.4: COD = "Order locked in for COD"; Paid = "Payment confirmed!"
  const isPaid = co.paymentMethod !== 'cod';
  if (isPaid) {
    await sendMessage(from,
      `Payment confirmed! 🎉\\n` +
      `Order #${orderId} is on its way to being a showstopper.\\n` +
      `Tracking link will land here once it ships (usually 1–2 days).`,
      waToken, phoneNumberId);
  } else {
    await sendMessage(from,
      `Thanks! Order locked in for COD ${PAW}\\n` +
      `Our team will confirm and dispatch within 1–2 days.\\n` +
      `You'll get a tracking link on WhatsApp once it ships.`,
      waToken, phoneNumberId);
  }"""
patch(old_s11_confirm, new_s11_confirm, "S10/S11 order confirmation → PDF verbatim (COD vs Paid)")

# ════════════════════════════════════════════════════════════════════════
# S12 — Custom Fit intro (PDF v1.4)
# PDF: "Custom designs starting from ₹300+ over base price 🐾 Two ways we can do this — pick what's easier:"
# Buttons: "📝 Fill the form (2 mins, easier)" / "💬 Chat it through with me"
# ════════════════════════════════════════════════════════════════════════

old_s12_intro = """  await sendMessage(from,
    `Custom fits are our favourite ${PAW}\\n\\n` +
    `Two ways to go ahead:\\n` +
    `1. *Fill our quick form* on the website (faster, has fabric swatches)\\n` +
    `2. *Chat it through here* — share pup name, measurements, and fabric preference`,
    waToken, phoneNumberId);
  await sendButtons(from, 'How would you like to start?',
    ['Use website form', 'Chat it through', PRODUCT_BTN.BACK_TO_MENU],"""
new_s12_intro = """  // S12 PDF v1.4 intro
  await sendButtons(from,
    `Custom designs starting from ₹300+ over base price ${PAW}\\n` +
    `Two ways we can do this — pick what's easier:`,
    ['Fill the form', 'Chat it through with me', PRODUCT_BTN.BACK_TO_MENU],"""
patch(old_s12_intro, new_s12_intro, "S12 intro → PDF verbatim")

# Update the button trigger labels too
old_chat_trigger = "  if (trimmed === 'Chat it through') {"
new_chat_trigger = "  if (trimmed === 'Chat it through' || trimmed === 'Chat it through with me') {"
patch(old_chat_trigger, new_chat_trigger, "S12 'Chat it through with me' trigger added")

old_form_trigger = "  if (trimmed === 'Use website form') {"
new_form_trigger = "  if (trimmed === 'Use website form' || trimmed === 'Fill the form') {"
patch(old_form_trigger, new_form_trigger, "S12 'Fill the form' trigger added")

# S12 Branch A — "Fill the form" copy (PDF v1.4: "Pawfect — here's the link 🐾 ...Anouttama will reach out shortly")
old_s12_form = '`Lovely ${PAW} Fill the quick form here:\\nhttps://thewoofparade.com/pages/custom-order\\n\\nAnouttama will pick up from there.`'
new_s12_form = "`Pawfect — here's the link ${PAW}\\nhttps://thewoofparade.com/pages/custom-order\\n\\nOnce you submit, I'll pick it up here and Anouttama will reach out shortly.`"
patch(old_s12_form, new_s12_form, "S12 Branch A form copy → PDF verbatim")

# S12 Branch B step 1 — pup name + fit type question
# PDF: "Pawfect 🐾 Just two quick messages from me. First up: 1. What's your pup's name? 2. What kind of fit are you after?"
# Buttons: [🩱 Kurta] [👗 Frock] [✨ Lehenga] [🎀 Bandana] [🐾 Not sure yet]
# Currently the bot asks only for the name. Per PDF, ask for fit + name together.

old_s12_chat_start = """  await sendMessage(from,
    `Lovely ${PAW} What's your pup's name?`,
    waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade custom_chat_start]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), custom: { source: 'chat', awaitingPupName: true } },
  });"""
new_s12_chat_start = """  // S12 PDF v1.4 Branch B step 1: ask pup name + fit together
  await sendMessage(from,
    `Pawfect ${PAW} Just two quick messages from me.\\n\\n` +
    `First up:\\n` +
    `1. What's your pup's name?\\n` +
    `2. What kind of fit are you after? (Kurta, Frock, Lehenga, Bandana, or "not sure yet")\\n\\n` +
    `Send both in one message — like: *Mochi, Kurta*`,
    waToken, phoneNumberId);
  await upsertConversation(tenant.id, from, [
    ...history,
    { role: 'user', content: text },
    { role: 'assistant', content: '[woofparade custom_chat_start]' },
  ], {
    ...cart,
    woofparade: { ...(cart.woofparade || {}), custom: { source: 'chat', awaitingPupName: true } },
  });"""
patch(old_s12_chat_start, new_s12_chat_start, "S12 Branch B step 1 → PDF verbatim")

# S12 Branch B step 2 — full measurements + fabric ask
# PDF: "Lovely — Mochi's about to look like a showstopper 🐾 Now pop in everything in one message:
#       • Back length • Chest • Neck • Armhole • Fabric / style preference • Occasion or theme (optional) • Weight in kg (optional)"
old_s12_measurements_ask = """  await sendMessage(from,
    `Lovely name ${PAW} Now share *${pupName}*'s measurements in one message:\\n\\n` +
    `*Back __, Chest __, Neck __, Armhole __* (inches)`,
    waToken, phoneNumberId);"""
new_s12_measurements_ask = """  // S12 PDF v1.4 Branch B step 2: full intake in one message
  await sendMessage(from,
    `Lovely — *${pupName}*'s about to look like a showstopper ${PAW}\\n\\n` +
    `Now pop in everything in one message:\\n` +
    `• Back length (neck base to tail base)\\n` +
    `• Chest (widest part behind front legs)\\n` +
    `• Neck (around the base)\\n` +
    `• Armhole (around the front leg)\\n` +
    `• Fabric / style preference (or 'not sure yet')\\n` +
    `• Occasion or theme (optional)\\n` +
    `• Weight in kg (optional)\\n\\n` +
    `Like: *Back 14, Chest 18, Neck 12, Armhole 6, Red Banarasi, Diwali, 8kg*`,
    waToken, phoneNumberId);"""
patch(old_s12_measurements_ask, new_s12_measurements_ask, "S12 Branch B step 2 → PDF verbatim")

# ════════════════════════════════════════════════════════════════════════
# S16 — Talk to human (PDF v1.4)
# PDF: "Of course! Apurv from our team will be with you shortly. What's the best time to reach out, and what should I tell them you'd like to chat about?"
# ════════════════════════════════════════════════════════════════════════

old_s16 = """  await sendMessage(from,
    `On it ${PAW} Apurv will WhatsApp you within the next hour or two.\\n\\n` +
    `Meanwhile, anything else I can help with?`,
    waToken, phoneNumberId);
  await sendButtons(from, 'Or:',
    [PRODUCT_BTN.BACK_TO_MENU, POSTPURCHASE_BTN.TRACK],
    waToken, phoneNumberId);"""
new_s16 = """  // S16 PDF v1.4: "Of course! Apurv from our team will be with you shortly..."
  await sendMessage(from,
    `Of course! Apurv from our team will be with you shortly ${PAW}\\n\\n` +
    `What's the best time to reach out, and what should I tell them you'd like to chat about?`,
    waToken, phoneNumberId);"""
patch(old_s16, new_s16, "S16 talk-to-human → PDF verbatim")

# ════════════════════════════════════════════════════════════════════════
# S18 — Refund / complaint SOS (PDF v1.4)
# PDF: "I'm so sorry to hear that 🐾 Let me get our team on it right away — they'll reach out to you shortly."
# No outcome promise; no "Apurv will reach out within 1-2 hours" specifics.
# ════════════════════════════════════════════════════════════════════════

old_s18 = """  await sendMessage(from,
    `I'm really sorry to hear that ${PAW} Let me get our team on this right away.\\n\\n` +
    `Apurv will reach out within 1–2 hours to make this right. ` +
    `Please share any photos or order ID you have — we'll need them.`,
    waToken, phoneNumberId);
  await sendButtons(from, 'While Apurv reaches out:',
    [POSTPURCHASE_BTN.TRACK, PRODUCT_BTN.BACK_TO_MENU],
    waToken, phoneNumberId);"""
new_s18 = """  // S18 PDF v1.4: no outcome promise, just empathy + escalation
  await sendMessage(from,
    `I'm so sorry to hear that ${PAW} Let me get our team on it right away — they'll reach out to you shortly.`,
    waToken, phoneNumberId);"""
patch(old_s18, new_s18, "S18 refund/complaint → PDF verbatim (no outcome promise)")

# ════════════════════════════════════════════════════════════════════════
# S19 — Stop / unsubscribe (PDF v1.4)
# PDF: "Okay... I'll stop. *walks away slowly* 🐾 You're unsubscribed. But if you change your mind, I'll be here."
# ════════════════════════════════════════════════════════════════════════

old_s19 = "`Got it — I'll step back ${PAW} If you ever want to chat again about your pup's wardrobe, just send \"hi\". Take care!`"
new_s19 = "`Okay... I'll stop. *walks away slowly* ${PAW}\\nYou're unsubscribed.\\n\\nBut if you change your mind, I'll be here.`"
patch(old_s19, new_s19, "S19 stop/unsubscribe → PDF verbatim (walks away slowly)")

# ════════════════════════════════════════════════════════════════════════
# S20 — International (PDF v1.4 explicit opt-in)
# PDF: "Right now we ship pan-India only 🇮🇳 We'll let you know the moment international shipping launches!
#       Want me to save your contact and WhatsApp you when international shipping goes live?
#       (We'll only message you about that — nothing else.)"
# ════════════════════════════════════════════════════════════════════════

old_s20 = """  await sendMessage(from,
    `We currently ship only within India ${PAW}\\n\\n` +
    `If you're abroad and want us to figure out international shipping for you, drop me your country and I'll loop our team in — they'll WhatsApp you with options.`,
    waToken, phoneNumberId);
  await sendButtons(from, 'Want our team to reach out?',
    [ORDER_OPS_BTN.YES_WHATSAPP, ORDER_OPS_BTN.NO_THANKS],
    waToken, phoneNumberId);"""
new_s20 = """  // S20 PDF v1.4: explicit opt-in language, scoped to international launch only
  await sendButtons(from,
    `Right now we ship pan-India only 🇮🇳\\n\\n` +
    `We'll let you know the moment international shipping launches! ` +
    `Want me to save your contact and WhatsApp you when international shipping goes live? ` +
    `(We'll only message you about that — nothing else.)`,
    [ORDER_OPS_BTN.YES_WHATSAPP, ORDER_OPS_BTN.NO_THANKS],
    waToken, phoneNumberId);"""
patch(old_s20, new_s20, "S20 international → PDF verbatim (explicit opt-in)")

# ════════════════════════════════════════════════════════════════════════
# S21 — Bulk / wholesale (PDF v1.4)
# PDF: "For bulk orders, we'll reach out within a day, personally. Could you share your contact + a bit about your business? 🐾"
# ════════════════════════════════════════════════════════════════════════

old_s21 = """  await sendMessage(from,
    `Lovely — wholesale & bulk is its own conversation ${PAW}\\n\\n` +
    `Apurv will reach out within a day with our trade pricing and minimums.`,
    waToken, phoneNumberId);"""
new_s21 = """  // S21 PDF v1.4
  await sendMessage(from,
    `For bulk orders, we'll reach out within a day, personally.\\n\\n` +
    `Could you share your contact + a bit about your business? ${PAW}`,
    waToken, phoneNumberId);"""
patch(old_s21, new_s21, "S21 bulk inquiry → PDF verbatim")

# ════════════════════════════════════════════════════════════════════════
# S22 — Press / collab (PDF v1.4)
# PDF: "Lovely to hear from you! For press or collaborations, please email [press email — TBC] — our team will get right back to you 🐾"
# ════════════════════════════════════════════════════════════════════════

old_s22 = """  await sendMessage(from,
    `Thanks for reaching out ${PAW}\\n\\n` +
    `For press, collabs and interviews, please write to *${PRESS_EMAIL}* — Kashmira will get back personally.`,
    waToken, phoneNumberId);"""
new_s22 = """  // S22 PDF v1.4 — TODO: KASHMIRA CONFIRM press email (default: hello@thewoofparade.com)
  await sendMessage(from,
    `Lovely to hear from you! ${PAW}\\n\\n` +
    `For press or collaborations, please email *${PRESS_EMAIL}* — our team will get right back to you.`,
    waToken, phoneNumberId);"""
patch(old_s22, new_s22, "S22 press inquiry → PDF verbatim")

# ════════════════════════════════════════════════════════════════════════
# Write back
# ════════════════════════════════════════════════════════════════════════

if content == original:
    print("\n⚠️ No changes applied — file unchanged.")
    print("\nSkipped:")
    for line in skipped:
        print(f"  ✗ {line}")
else:
    HANDLER_PATH.write_text(content)
    print(f"\n✅ Patched {HANDLER_PATH}")
    print(f"   Original: {len(original)} chars")
    print(f"   Patched:  {len(content)} chars")
    print(f"   Delta:    {len(content) - len(original):+d}")
    print(f"\nApplied ({len(applied)}):")
    for line in applied:
        print(f"  ✓ {line}")
    if skipped:
        print(f"\nSkipped ({len(skipped)}):")
        for line in skipped:
            print(f"  ✗ {line}")
    print("\nNext: node --check handlers/woofparade.js && git diff handlers/woofparade.js | head -100")
