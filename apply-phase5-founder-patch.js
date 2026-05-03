#!/usr/bin/env node
// apply-phase5-founder-patch.js
//
// Adds two new founder commands to founder.js:
//   - namespace <brand> <uuid>  — set Meta WABA template namespace
//   - templates <brand>          — show approval status of all 6 templates
//
// Run from ~/vaani-app/ with:
//   node apply-phase5-founder-patch.js
//
// Creates founder.js.bak-pre-phase5 backup. Idempotent (safe to re-run).

const fs = require('fs');
const path = require('path');

const FOUNDER_PATH = path.join(__dirname, 'founder.js');
const BACKUP_PATH = path.join(__dirname, 'founder.js.bak-pre-phase5');

if (!fs.existsSync(FOUNDER_PATH)) {
  console.error(`❌ founder.js not found at ${FOUNDER_PATH}`);
  process.exit(1);
}

let content = fs.readFileSync(FOUNDER_PATH, 'utf8');

// Idempotency check — if already patched, exit early
if (content.includes('cmdNamespace') && content.includes('cmdTemplates')) {
  console.log('✓ Already patched (cmdNamespace + cmdTemplates present). Nothing to do.');
  process.exit(0);
}

// Backup
fs.writeFileSync(BACKUP_PATH, content);
console.log(`✓ Backup created: ${BACKUP_PATH}`);

// ─── EDIT 1: Add 'namespace ' and 'templates ' to KNOWN_PREFIXES ────────
// Find: "    'notify ',\n"  (added by Phase 4)
// Add after: "    'namespace ',\n    'templates ',\n"
const oldPrefix = `    'notify ',\n`;
const newPrefix = `    'notify ',\n    'namespace ',\n    'templates ',\n`;

if (!content.includes(oldPrefix)) {
  console.error('❌ Could not find Phase 4 "notify" prefix anchor.');
  console.error('   Make sure Phase 4 patches were applied first.');
  process.exit(1);
}
content = content.replace(oldPrefix, newPrefix);
console.log('✓ Added namespace + templates to KNOWN_PREFIXES');

// ─── EDIT 2: Add help lines ─────────────────────────────────────────────
const oldHelp = `    '• \`notify <brand> <phone>\` — set brand-owner alert number',\n`;
const newHelp = oldHelp +
  `    '• \`namespace <brand> <uuid>\` — set Meta WABA template namespace',\n` +
  `    '• \`templates <brand>\` — show WhatsApp template approval status',\n`;

if (!content.includes(oldHelp)) {
  console.error('❌ Could not find Phase 4 help line anchor.');
  process.exit(1);
}
content = content.replace(oldHelp, newHelp);
console.log('✓ Added help lines for new commands');

// ─── EDIT 3: Append cmdNamespace + cmdTemplates functions ───────────────
// Insert before module.exports
const exportMarker = 'module.exports = {';
if (!content.includes(exportMarker)) {
  console.error('❌ Could not find module.exports anchor.');
  process.exit(1);
}

const newFunctions = `
// ─── COMMAND: namespace <brand> <uuid> ─────────────────────────────────────
// Sets the Meta WABA template namespace for a tenant. Required before any
// template messages can be sent. Get the UUID from Meta WhatsApp Manager
// → API Settings → Namespace.
async function cmdNamespace(slug, uuidArg) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return \`❌ No brand found matching "\${slug}".\`;
  if (!uuidArg) return '❌ Usage: \`namespace <brand> <uuid>\` or \`namespace <brand> clear\`';

  const name = brandName(tenant);

  if (uuidArg.toLowerCase() === 'clear' || uuidArg.toLowerCase() === 'none') {
    await pool.query(
      \`UPDATE tenants SET template_namespace = NULL WHERE id = $1\`,
      [tenant.id]
    );
    return \`✅ *\${name}* — template namespace cleared. Brand alerts will fall back to freeform.\`;
  }

  // Validate UUID-ish format (Meta uses 32-char hex with dashes, but be lenient)
  const cleaned = uuidArg.trim();
  if (cleaned.length < 16 || cleaned.length > 64) {
    return \`❌ Namespace "\${uuidArg}" doesn't look right. Should be a UUID like \\\`5a3c2b1e-9f8d-4567-...\\\`.\`;
  }

  await pool.query(
    \`UPDATE tenants SET template_namespace = $1 WHERE id = $2\`,
    [cleaned, tenant.id]
  );
  return [
    \`✅ *\${name}* — template namespace set.\`,
    '',
    \`Namespace: \\\`\${cleaned}\\\`\`,
    '',
    \`_Run \\\`templates \${slug}\\\` to see template approval status._\`
  ].join('\\n');
}

// ─── COMMAND: templates <brand> ────────────────────────────────────────────
// Shows approval status of all 6 Vaani templates for this tenant's WABA.
async function cmdTemplates(slug) {
  const tenant = await resolveBrand(slug);
  if (!tenant) return \`❌ No brand found matching "\${slug}".\`;

  const name = brandName(tenant);
  const namespace = tenant.template_namespace;
  const approved = tenant.templates_approved || {};

  const ALL_TEMPLATES = [
    'vaani_threshold_70',
    'vaani_threshold_90',
    'vaani_threshold_100',
    'vaani_topup_confirmed',
    'vaani_subscription_paused',
    'vaani_subscription_unpaused',
  ];

  const lines = [\`📋 *\${name}* — WhatsApp Templates\`, ''];

  if (!namespace) {
    lines.push(\`⚠️ No template namespace set.\`);
    lines.push(\`Run: \\\`namespace \${slug} <uuid>\\\`\`);
    lines.push('');
    lines.push(\`Find UUID in Meta WhatsApp Manager → API Settings.\`);
    return lines.join('\\n');
  }

  lines.push(\`Namespace: \\\`\${namespace.slice(0, 12)}...\\\`\`);
  lines.push('');

  const statusEmoji = (s) => {
    if (s === 'approved') return '✅';
    if (s === 'pending') return '⏳';
    if (s === 'rejected') return '❌';
    if (s === 'paused') return '⏸️';
    return '⚪';
  };

  for (const tpl of ALL_TEMPLATES) {
    const status = approved[tpl] || 'unset';
    lines.push(\`\${statusEmoji(status)} \${tpl} — \${status}\`);
  }

  lines.push('');
  lines.push(\`_To mark approved: edit DB directly or use Meta WhatsApp Manager._\`);
  return lines.join('\\n');
}

`;

content = content.replace(exportMarker, newFunctions + '\n' + exportMarker);
console.log('✓ Added cmdNamespace + cmdTemplates functions');

// ─── EDIT 4: Add command routing in handleFounderCommand ───────────────
// Find the existing "if (lower.startsWith('notify '))" block and add new branches after it
const oldRouting = `  if (lower.startsWith('notify ')) {
    const parts = t.slice(7).trim().split(/\\s+/);
    if (parts.length < 2) return '❌ Usage: \`notify <brand> <phone>\` or \`notify <brand> clear\`';
    return await cmdNotify(parts[0], parts[1]);
  }
`;

const newRouting = oldRouting +
`
  if (lower.startsWith('namespace ')) {
    const parts = t.slice(10).trim().split(/\\s+/);
    if (parts.length < 2) return '❌ Usage: \`namespace <brand> <uuid>\` or \`namespace <brand> clear\`';
    return await cmdNamespace(parts[0], parts[1]);
  }

  if (lower.startsWith('templates ')) {
    const slug = t.slice(10).trim();
    if (!slug) return '❌ Usage: \`templates <brand>\`';
    return await cmdTemplates(slug);
  }
`;

if (!content.includes(oldRouting)) {
  console.error('❌ Could not find Phase 4 notify routing anchor.');
  console.error('   founder.js may have been modified. Manual patch needed.');
  process.exit(1);
}
content = content.replace(oldRouting, newRouting);
console.log('✓ Added command routing for namespace + templates');

// Write the patched file
fs.writeFileSync(FOUNDER_PATH, content);
console.log('');
console.log('✅ Phase 5 founder.js patch applied successfully.');
console.log('');
console.log('New commands available:');
console.log('  namespace <brand> <uuid>  → set Meta WABA template namespace');
console.log('  templates <brand>          → show template approval status');
console.log('');
console.log('Test syntax: node -e "require(\'./founder\')"');
