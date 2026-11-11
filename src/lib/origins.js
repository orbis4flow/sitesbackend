/* Which browser origins may call the API.

   Two sources, either of which is enough:

     * CORS_ORIGINS in the environment — the fixed list, and the
       fallback that keeps the main sites working if the database
       cannot be read
     * the Domains table — every host marked live in the console, with
       or without www, over https

   The second is what makes a new site a console job instead of a
   deploy: add the domain, set it live, and within a minute (at once,
   on this instance) the API answers it. Pausing a domain takes it away
   the same way, except where the environment still lists it.

   The table is read into memory and refreshed in the background, so
   the check on each request costs nothing. An origin the cache does not
   know triggers one early refresh, at most every few seconds, so a
   domain set live a moment ago is not refused for a whole minute. */
import { originAllowed } from '../config/env.js';
import { admin } from './supabase.js';

const REFRESH_MS = 60 * 1000;
const RETRY_MS = 5 * 1000;

let live = new Set();
let loadedAt = 0;
let inflight = null;

export function refreshDomains() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await admin.from('domains').select('host').eq('status', 'live');
      if (error) throw error;
      live = new Set((data || []).map(d => String(d.host).toLowerCase().replace(/^www\./, '')));
      loadedAt = Date.now();
    } catch {
      /* Keep the last good list. Stamp the attempt so a database that is
         down is retried every few seconds, not on every request. */
      loadedAt = Date.now() - REFRESH_MS + RETRY_MS;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function hostOf(origin) {
  let url;
  try { url = new URL(origin); } catch { return null; }
  if (url.protocol !== 'https:' || url.port) return null;
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

/* Synchronous: the env list or the cached table. */
export function originKnown(origin) {
  if (!origin) return false;
  if (originAllowed(origin)) return true;
  const host = hostOf(origin);
  return !!host && live.has(host);
}

/* For the CORS check: a miss is given one fresh look at the table. */
export async function originPermitted(origin) {
  if (originKnown(origin)) return true;
  if (!hostOf(origin)) return false;
  if (Date.now() - loadedAt > RETRY_MS) await refreshDomains();
  return originKnown(origin);
}

export function liveDomains() {
  return [...live];
}

/* Load now, and keep it fresh. unref() so the timer never holds the
   process open on shutdown. */
refreshDomains();
setInterval(() => {
  if (Date.now() - loadedAt >= REFRESH_MS) refreshDomains();
}, RETRY_MS).unref();
