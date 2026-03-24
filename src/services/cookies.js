// ─── Cookie Service ─────────────────────────────────────────────────────────
// Read/write/validate both cookies. getDailyExpiry() for daily reset.

import { v4 as uuidv4 } from 'uuid';

/**
 * Calculate daily cookie expiry: next occurrence of 23:29 UTC (4:59 AM IST)
 * Expires 1 minute BEFORE the 5:00 AM IST publish
 */
export function getDailyExpiry() {
  const now = new Date();
  const expiry = new Date();
  expiry.setUTCHours(23, 29, 0, 0);
  if (now.getTime() >= expiry.getTime()) {
    expiry.setUTCDate(expiry.getUTCDate() + 1);
  }
  return expiry;
}

/**
 * Get IST date string (YYYY-MM-DD) for the current day in IST timezone
 */
export function getISTDateString() {
  const now = new Date();
  // IST = UTC + 5:30
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
}

/**
 * Read the permanent browser cookie (gateforge_browser)
 * Returns { browserId, firstVisit } or null
 */
export function readBrowserCookie(request) {
  try {
    const raw = request.cookies?.gateforge_browser;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Set the permanent browser cookie (1-year expiry)
 */
export function setBrowserCookie(reply, data) {
  const oneYear = new Date();
  oneYear.setFullYear(oneYear.getFullYear() + 1);

  reply.setCookie('gateforge_browser', JSON.stringify(data), {
    path: '/',
    httpOnly: false,  // JS needs to read browserId
    sameSite: 'lax',
    expires: oneYear
  });
}

/**
 * Ensure browser cookie exists; create new browserId if missing
 */
export function ensureBrowserCookie(request, reply) {
  let browserData = readBrowserCookie(request);

  if (!browserData) {
    browserData = {
      browserId: uuidv4(),
      firstVisit: new Date().toISOString()
    };
    setBrowserCookie(reply, browserData);
  }

  return browserData;
}

/**
 * Read the daily cookie (gateforge_daily)
 * Returns { date, setAttempted, status, score, ... } or null
 */
export function readDailyCookie(request) {
  try {
    const raw = request.cookies?.gateforge_daily;
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Check if it's from today (IST)
    const today = getISTDateString();
    if (data.date !== today) return null; // Expired — different day
    return data;
  } catch {
    return null;
  }
}

/**
 * Set the daily cookie (expires at 4:59 AM IST next day)
 */
export function setDailyCookie(reply, data) {
  const expiry = getDailyExpiry();

  reply.setCookie('gateforge_daily', JSON.stringify(data), {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    expires: expiry
  });
}

/**
 * Get seconds until daily reset (4:59 AM IST = 23:29 UTC)
 */
export function getSecondsUntilReset() {
  const now = new Date();
  const expiry = getDailyExpiry();
  return Math.max(0, Math.floor((expiry.getTime() - now.getTime()) / 1000));
}
