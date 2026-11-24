// Settings you may want to change before a pilot.

// Review limits (from the strategy doc: cap at 10 cards a day).
export const DAILY_CAP = 10;

// Leitner schedule: days until the next review for each box.
export const INTERVALS_DAYS = [1, 3, 7, 14, 30];

// Clip shown when a student forgets a card: seconds before / after the flag.
export const CLIP_BEFORE_SEC = 20;
export const CLIP_AFTER_SEC = 40;

// Optional: a Google Form that opens when someone uninstalls, so uninstalls can be counted
// without a server. Create a form with a short-answer question "user_id", choose
// "Get pre-filled link", and paste that link here with the answer replaced by {USER_ID}.
// Example: "https://docs.google.com/forms/d/e/XXXX/viewform?usp=pp_url&entry.123456={USER_ID}"
export const UNINSTALL_FORM_URL = "";
