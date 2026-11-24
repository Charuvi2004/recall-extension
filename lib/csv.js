// Export events in exactly the schema the Recall dashboard reads.
export const EVENT_COLUMNS = [
  "user_id", "ts", "event", "course_id", "video_id", "card_id", "rating", "review_number", "duration_sec",
];

export function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function eventsToCSV(events) {
  const lines = [EVENT_COLUMNS.join(",")];
  for (const e of events) lines.push(EVENT_COLUMNS.map((c) => csvCell(e[c])).join(","));
  return lines.join("\n") + "\n";
}
