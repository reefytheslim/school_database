#!/usr/bin/env node
/*
 * Exports the active schools from Firestore to public/schools.json
 * (the file the main app downloads and searches locally).
 *
 * In GitHub Actions the service account key comes from the
 * FIREBASE_SERVICE_ACCOUNT secret (the full JSON text of the key).
 *
 * Local test:
 *   node export_schools.js --key ./serviceAccountKey.json
 *
 * Output item fields:
 *   id  Firestore document ID of the school
 *   n   school name (for display)
 *   q   normalized school name (for searching)
 *   s   sector name
 *   p   health center (PHC) name
 *   t   school type (to tell apart schools that share a name)
 */

const fs = require('fs');
const path = require('path');

// Collection and field names (same as in import_schools.js)
const SCHOOLS_COLLECTION = 'schools';
const SECTORS_COLLECTION = 'sectors';
const SECTOR_NAME_FIELD = 'sector_name';
const PHC_COLLECTION = 'health_centers';
const PHC_NAME_FIELD = 'phc_name';

const OUTPUT_DIR = 'public';
const OUTPUT_FILE = 'schools.json';

function cleanText(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digitsToWestern(s) {
  return s
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
}

// Must stay identical to the normalization used by the apps' search functions
function normalizeArabic(s) {
  return digitsToWestern(cleanText(s))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ی/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * schoolDocs: [{ id, data }]   sectorNames / phcNames: Map(id -> name)
 */
function buildOutput(schoolDocs, sectorNames, phcNames, warnings) {
  const items = [];
  for (const { id, data } of schoolDocs) {
    const name = cleanText(data.school_name);
    if (!name) {
      warnings.push(`school ${id}: empty school_name, skipped`);
      continue;
    }
    const sectorId = data.sector_ref ? data.sector_ref.id : null;
    const phcId = data.phc_ref ? data.phc_ref.id : null;
    const sector = sectorId ? sectorNames.get(sectorId) : '';
    const phc = phcId ? phcNames.get(phcId) : '';
    if (!sector) warnings.push(`school ${id} (${name}): sector name not found`);
    if (!phc) warnings.push(`school ${id} (${name}): health center name not found`);

    items.push({
      id,
      n: name,
      q: normalizeArabic(name),
      s: sector || '',
      p: phc || '',
      t: cleanText(data.school_type),
    });
  }
  items.sort(
    (a, b) =>
      a.s.localeCompare(b.s, 'ar') ||
      a.p.localeCompare(b.p, 'ar') ||
      a.n.localeCompare(b.n, 'ar'),
  );
  return items;
}

async function main() {
  const args = process.argv.slice(2);
  const keyIndex = args.indexOf('--key');
  let serviceAccount;
  if (keyIndex >= 0) {
    serviceAccount = JSON.parse(fs.readFileSync(path.resolve(args[keyIndex + 1]), 'utf8'));
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    console.error('No credentials: set FIREBASE_SERVICE_ACCOUNT or pass --key <file>');
    process.exit(1);
  }

  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();

  const [sectorsSnap, phcSnap, schoolsSnap] = await Promise.all([
    db.collection(SECTORS_COLLECTION).get(),
    db.collection(PHC_COLLECTION).get(),
    db
      .collection(SCHOOLS_COLLECTION)
      .where('is_active', '==', true)
      .select('school_name', 'school_type', 'sector_ref', 'phc_ref')
      .get(),
  ]);

  const sectorNames = new Map(sectorsSnap.docs.map((d) => [d.id, cleanText(d.get(SECTOR_NAME_FIELD))]));
  const phcNames = new Map(phcSnap.docs.map((d) => [d.id, cleanText(d.get(PHC_NAME_FIELD))]));
  const schoolDocs = schoolsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));

  const warnings = [];
  const items = buildOutput(schoolDocs, sectorNames, phcNames, warnings);

  if (items.length === 0) {
    // Fail the run so an empty list is never published over a good one
    console.error('No active schools found. Nothing published.');
    process.exit(1);
  }

  const output = {
    generated_at: new Date().toISOString(),
    count: items.length,
    schools: items,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, OUTPUT_FILE);
  fs.writeFileSync(file, JSON.stringify(output), 'utf8');

  console.log(`Wrote ${items.length} schools to ${file} (${fs.statSync(file).size} bytes)`);
  console.log(`Sectors: ${sectorsSnap.size}, health centers: ${phcSnap.size}`);
  if (warnings.length) {
    console.log(`${warnings.length} warning(s):`);
    warnings.slice(0, 30).forEach((w) => console.log('  ' + w));
    if (warnings.length > 30) console.log(`  ...and ${warnings.length - 30} more`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { normalizeArabic, buildOutput };
