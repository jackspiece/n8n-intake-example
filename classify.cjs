"use strict";

// The original record stays attached to every result for review.
function classifyRecords(records) {
  const fields = ["external_id", "full_name", "email", "company"];
  const required = new Set(["external_id", "full_name", "email"]);
  const rows = records.map((original, index) => {
    const reasons = [];
    const normalized = {};
    const changes = [];
    const source = original && typeof original === "object" && !Array.isArray(original)
      ? original : {};
    if (source !== original) reasons.push("record_is_not_an_object");

    for (const field of fields) {
      const raw = source[field];
      if (raw === undefined && !required.has(field)) {
        normalized[field] = "";
        continue;
      }
      if (typeof raw !== "string") {
        reasons.push(raw === undefined ? "missing_" + field : "non_text_" + field);
        normalized[field] = null;
        continue;
      }
      let value = raw.trim();
      if (field === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        const at = value.indexOf("@");
        // Domain names are case insensitive. Preserve the local part.
        value = value.slice(0, at + 1) + value.slice(at + 1).toLowerCase();
      }
      normalized[field] = value;
      if (value !== raw) changes.push({ field, before: raw, after: value });
      if (!value && required.has(field)) reasons.push("missing_" + field);
    }
    if (normalized.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) {
      reasons.push("email_format_needs_review");
    }
    const extraFields = Object.keys(source).filter(field => !fields.includes(field));
    if (extraFields.length) reasons.push("unmapped_fields");
    return {
      source_row: index + 1,
      original,
      normalized,
      changes,
      reasons,
      ...(extraFields.length ? { unmapped_fields: extraFields } : {}),
    };
  });

  const byId = new Map();
  for (const row of rows) {
    const id = row.normalized.external_id;
    if (!id) continue;
    const group = byId.get(id) || [];
    group.push(row);
    byId.set(id, group);
  }

  // Quarantine the whole group if one ID refers to different records.
  // Keeping the first one would silently choose which version is correct.
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    const variants = new Set(group.map(row => JSON.stringify(row.normalized)));
    if (variants.size > 1 || group.some(row => row.reasons.length)) {
      for (const row of group) row.reasons.push("conflicting_id");
    }
  }

  const firstReady = new Map();
  for (const row of rows) {
    if (row.reasons.length) {
      row.status = "review";
    } else if (firstReady.has(row.normalized.external_id)) {
      row.status = "duplicate";
      row.duplicate_of_row = firstReady.get(row.normalized.external_id);
    } else {
      row.status = "ready";
      firstReady.set(row.normalized.external_id, row.source_row);
    }
  }
  return rows;
}

module.exports = { classifyRecords };
