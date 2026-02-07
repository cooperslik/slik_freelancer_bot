/**
 * Streamtime API Explorer — Phase 6
 * Fixed: conditionMatchTypeId needs to be numeric (1=AND, 2=OR)
 */

require("dotenv").config();

const API_BASE = "https://api.streamtime.net/v1";
const API_KEY = process.env.STREAMTIME_API_KEY;

if (!API_KEY) {
  console.error("❌ Set STREAMTIME_API_KEY in your .env file first");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function searchById(viewId) {
  const url = `${API_BASE}/search?search_view=${viewId}&include_statistics=false`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        offset: 0,
        maxResults: 2,
        filterGroupCollection: {
          conditionMatchTypeId: 1,
          filterGroups: [],
          filterGroupCollections: [],
        },
      }),
    });

    const text = await res.text();

    if (res.ok) {
      const json = JSON.parse(text);
      const results = json.searchResults || [];

      let dataType = "Unknown";
      if (results.length > 0) {
        const keys = Object.keys(results[0]);
        if (keys.includes("jobStatus") && keys.includes("fullName")) dataType = "JOBS";
        else if (keys.includes("minutes") && keys.includes("loggedTimeStatus")) dataType = "TIME";
        else if (keys.includes("invoiceStatus")) dataType = "INVOICES";
        else if (keys.includes("quoteStatus")) dataType = "QUOTES";
        else if (keys.includes("companyStatus")) dataType = "COMPANIES";
        else if (keys.includes("contactStatus")) dataType = "CONTACTS";
        else if (keys.includes("jobItemStatus") && keys.includes("jobId")) dataType = "JOB_ITEMS";
        else if (keys.includes("jobItemId") && keys.includes("userId")) dataType = "JOB_ITEM_USERS";
        else if (keys.includes("userStatus")) dataType = "USERS";
        else if (keys.includes("loggedExpenseStatus")) dataType = "EXPENSES";
        else dataType = `keys: ${keys.slice(0, 8).join(", ")}`;
      }

      console.log(`  ${viewId} → ✅ ${dataType} (${results.length} results)`);
      return { viewId, dataType, results };
    } else {
      console.log(`  ${viewId} → ❌ ${res.status}: ${text.substring(0, 120)}`);
      return null;
    }
  } catch (err) {
    console.log(`  ${viewId} → ❌ ${err.message}`);
    return null;
  }
}

async function run() {
  console.log("🔍 Testing search_view IDs 7-22 with numeric conditionMatchTypeId...\n");

  const found = {};
  for (let i = 7; i <= 22; i++) {
    const result = await searchById(i);
    if (result) found[i] = result;
    await new Promise((r) => setTimeout(r, 800));
  }
  // Also try 25
  const r25 = await searchById(25);
  if (r25) found[25] = r25;

  // Show full samples for the key ones
  console.log("\n\n═══ DETAILED SAMPLES ═══\n");
  for (const [id, result] of Object.entries(found)) {
    if (["JOBS", "TIME", "JOB_ITEM_USERS", "JOB_ITEMS"].includes(result.dataType)) {
      console.log(`\n── search_view=${id} (${result.dataType}) ──`);
      if (result.results.length > 0) {
        console.log("Keys:", Object.keys(result.results[0]));
        console.log(JSON.stringify(result.results[0], null, 2).substring(0, 3000));
      }
    }
  }

  console.log("\n✅ Done!");
}

run().catch(console.error);
