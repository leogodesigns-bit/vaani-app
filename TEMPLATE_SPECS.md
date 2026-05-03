# Vaani WhatsApp Templates — Submission Specs

These 6 templates need to be submitted to **each tenant's WABA** via Meta WhatsApp Manager.
Submitting to Ikaa's WABA first (app ID 1252841333690762, WABA accessible from Meta Business Suite).

## Submission URL
https://business.facebook.com/wa/manage/message-templates/

Or directly: Meta Business Suite → WhatsApp Manager → Message Templates → Create Template

---

## All templates use:
- **Category:** UTILITY (these are billing/usage notifications, NOT marketing)
- **Language:** English
- **Header:** None (keeps it simple, faster approval)
- **Footer:** None (optional, skip)

---

## 1. vaani_threshold_70

**Name:** `vaani_threshold_70`
**Category:** Utility
**Language:** English

**Body:**
```
{{1}}: 70% of Vaani conversations used this month.

{{2}} of {{3}} chats used.
{{4}} remaining.

You're tracking on plan. Top up anytime by replying TOPUP.
```

**Variables:**
- {{1}} = Brand name (e.g. "Ikaa Jewellery")
- {{2}} = Used count (e.g. "700")
- {{3}} = Total cap (e.g. "1000")
- {{4}} = Remaining (e.g. "300")

**Sample for review:**
- {{1}}: Ikaa Jewellery
- {{2}}: 700
- {{3}}: 1000
- {{4}}: 300

---

## 2. vaani_threshold_90

**Name:** `vaani_threshold_90`
**Category:** Utility
**Language:** English

**Body:**
```
{{1}}: 90% of Vaani conversations used this month.

{{2}} of {{3}} chats used.
{{4}} remaining.

To avoid pause, reply TOPUP for 250 more chats (₹500).
```

**Variables:**
- {{1}} = Brand name
- {{2}} = Used count
- {{3}} = Total cap
- {{4}} = Remaining

**Sample for review:**
- {{1}}: Ikaa Jewellery
- {{2}}: 900
- {{3}}: 1000
- {{4}}: 100

---

## 3. vaani_threshold_100

**Name:** `vaani_threshold_100`
**Category:** Utility
**Language:** English

**Body:**
```
{{1}}: monthly chat cap reached.

{{2}} of {{3}} chats used.

Vaani will pause new conversations until top-up or next billing cycle. Reply TOPUP to add 250 chats (₹500) and resume immediately.
```

**Variables:**
- {{1}} = Brand name
- {{2}} = Used count
- {{3}} = Total cap

**Sample for review:**
- {{1}}: Ikaa Jewellery
- {{2}}: 1000
- {{3}}: 1000

---

## 4. vaani_topup_confirmed

**Name:** `vaani_topup_confirmed`
**Category:** Utility
**Language:** English

**Body:**
```
Top-up confirmed for {{1}}.

+250 chats added. New balance: {{2}} chats.

Top-ups expire 3 months from purchase date. Vaani is back online.
```

**Variables:**
- {{1}} = Brand name
- {{2}} = New balance count

**Sample for review:**
- {{1}}: Ikaa Jewellery
- {{2}}: 350

---

## 5. vaani_subscription_paused

**Name:** `vaani_subscription_paused`
**Category:** Utility
**Language:** English

**Body:**
```
{{1}}: Vaani subscription paused.

The bot will not respond to customers until reactivated. Reply RESUME to reactivate, or contact Leogo support.
```

**Variables:**
- {{1}} = Brand name

**Sample for review:**
- {{1}}: Ikaa Jewellery

---

## 6. vaani_subscription_unpaused

**Name:** `vaani_subscription_unpaused`
**Category:** Utility
**Language:** English

**Body:**
```
{{1}}: Vaani subscription resumed.

The bot is back online and responding to customers. Welcome back.
```

**Variables:**
- {{1}} = Brand name

**Sample for review:**
- {{1}}: Ikaa Jewellery

---

## Submission tips for fast approval

1. **Use Utility category** (not Marketing) — Utility approves in hours; Marketing can take days or get rejected
2. **No promotional language** ("amazing!", "best deal", emojis like 🎉) — these flag as Marketing
3. **Variable samples must be realistic** — Meta rejects nonsense like "{{1}} = test"
4. **Keep it factual** — these are billing confirmations, not sales pitches
5. **Submit all 6 in same session** — easier to track approval batch

## Where to find template_namespace

After your first template is created (even before approval), in Meta WhatsApp Manager:
- Go to WhatsApp Manager → API Settings (or Account Tools)
- Look for "Namespace" or "Template Namespace" — UUID format like `5a3c2b1e-9f8d-...`
- This goes into `tenants.template_namespace` column
