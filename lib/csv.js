/**
 * Dependency-free CSV parser + Apollo.io column auto-mapper.
 * ES module — used by popup.js.
 */
import { APOLLO_COLUMN_MAP, uid } from "./constants.js";

/**
 * Parses CSV text into { headers: string[], rows: string[][] }.
 * Handles quoted fields, escaped quotes (""), commas and newlines inside quotes,
 * and both \n and \r\n line endings.
 */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  // Normalize BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // skip, \n will terminate the row (handles \r\n)
    } else {
      field += ch;
    }
  }
  // flush last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const cleaned = rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
  if (cleaned.length === 0) return { headers: [], rows: [] };

  const headers = cleaned[0].map((h) => h.trim());
  const dataRows = cleaned.slice(1);
  return { headers, rows: dataRows };
}

/** Normalizes a header string for fuzzy matching against APOLLO_COLUMN_MAP. */
function norm(h) {
  return (h || "").toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Attempts to auto-map CSV headers to canonical lead fields using APOLLO_COLUMN_MAP.
 * Returns a mapping object { canonicalField: headerIndex | null }.
 */
export function autoMapColumns(headers) {
  const normalized = headers.map(norm);
  const mapping = {};
  for (const [canonical, aliases] of Object.entries(APOLLO_COLUMN_MAP)) {
    let foundIdx = null;
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias);
      if (idx !== -1) {
        foundIdx = idx;
        break;
      }
    }
    // fallback: partial/contains match
    if (foundIdx === null) {
      for (let i = 0; i < normalized.length; i++) {
        if (aliases.some((a) => normalized[i].includes(a))) {
          foundIdx = i;
          break;
        }
      }
    }
    mapping[canonical] = foundIdx;
  }
  return mapping;
}

/**
 * Builds lead objects from parsed CSV rows using a column mapping
 * (canonicalField -> headerIndex|null, as produced by autoMapColumns or edited by the user).
 */
export function buildLeads(headers, rows, mapping) {
  const leads = [];
  for (const row of rows) {
    const get = (field) => {
      const idx = mapping[field];
      if (idx === null || idx === undefined || idx === -1) return "";
      return (row[idx] || "").trim();
    };

    const email = get("email");
    if (!email || !email.includes("@")) continue; // skip rows without a usable email

    let firstName = get("firstName");
    let lastName = get("lastName");
    let fullName = get("fullName");
    if (!fullName) fullName = [firstName, lastName].filter(Boolean).join(" ");
    if (!firstName && fullName) firstName = fullName.split(" ")[0];
    if (!lastName && fullName) lastName = fullName.split(" ").slice(1).join(" ");

    const city = get("city");
    const state = get("state");
    const country = get("country");
    const location = [city, state, country].filter(Boolean).join(", ");

    leads.push({
      id: uid(),
      firstName: firstName || "",
      lastName: lastName || "",
      fullName: fullName || email.split("@")[0],
      email,
      title: get("title"),
      company: get("company"),
      industry: get("industry"),
      description: get("description"),
      city,
      state,
      country,
      location,
      website: get("website"),
      linkedin: get("linkedin"),
      status: "pending",
      subject: "",
      body: "",
      error: "",
      sentAt: null
    });
  }
  return leads;
}

/** Converts an array of log rows into a downloadable CSV string. */
export function toCSV(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(esc).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => esc(row[h])).join(","));
  }
  return lines.join("\r\n");
}
