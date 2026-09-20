const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const serviceAccount = require('./firebase-key.json');

const appFirebase = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://trienshopeetool-default-rtdb.asia-southeast1.firebasedatabase.app/"
});
const db = getDatabase(appFirebase);

function extractCcnGroupKey(cardText) {
  const match = cardText.match(/^(\d{6})/);
  if (!match) return null;
  const bin = match[1];
  
  if (cardText.includes('|')) {
    const parts = cardText.split('|');
    if (parts.length >= 3) {
      let mm = parts[1].trim();
      let yy = parts[2].trim();
      if (mm.length === 1) mm = '0' + mm;
      if (yy.length === 4) yy = yy.substring(2);
      return `${bin} - ${mm}/${yy}`;
    }
  }
  return bin;
}

async function migrateCards() {
  console.log("Fetching existing cards...");
  const snap = await db.ref('ccn_cards').once('value');
  const oldData = snap.val() || {};
  
  const newData = {};
  let totalCards = 0;
  
  for (const [oldKey, cardsArray] of Object.entries(oldData)) {
    for (const card of cardsArray) {
      const newKey = extractCcnGroupKey(card);
      if (newKey) {
        if (!newData[newKey]) newData[newKey] = [];
        if (!newData[newKey].includes(card)) {
          newData[newKey].push(card);
          totalCards++;
        }
      }
    }
  }
  
  console.log(`Found ${totalCards} unique cards. Saving to database...`);
  await db.ref('ccn_cards').set(newData);
  console.log("Migration complete!");
  process.exit(0);
}

migrateCards().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
