/* Theatre search for the Log Show / Add-to-Watchlist forms, served from Vercel alongside the
   app (same reasoning as api/film-search.js: same-origin, no CORS header to add, ships with an
   ordinary `git push`, no separate deploy). Backed by Ticketmaster's Discovery API
   (developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2), filtered to its Arts &
   Theatre segment - there's no dedicated stage-show catalogue with an open API the way TMDb
   covers films, so this is ticketed-event data rather than a curated show database: a
   long-closed or non-touring production may not turn up. Has a real free tier (5,000 calls/day)
   and a plain API-key-in-query-string auth model - no OAuth dance.

   Needs a free Ticketmaster API key set as the TICKETMASTER_API_KEY environment variable on this
   Vercel project - see psn-proxy/README.md. Without it every request 401s from Ticketmaster's
   side, not this file's. */
export const config = { runtime: 'edge' };

const TM_EVENTS = 'https://app.ticketmaster.com/discovery/v2/events.json';
const TM_ATTRACTIONS = 'https://app.ticketmaster.com/discovery/v2/attractions.json';

function apiKey(){
  const key = process.env.TICKETMASTER_API_KEY;
  if(!key) throw Object.assign(new Error("Show search isn't configured - add TICKETMASTER_API_KEY as a Vercel environment variable"), {status:503});
  return key;
}

/* Ticketmaster's own images array carries several crops/resolutions per event, no single
   "the poster" - the widest one reads best as a thumbnail here, same idea as picking TMDb's own
   fixed poster size in film-search.js, just without a fixed size to ask for up front. */
function pickImage(images){
  if(!images || !images.length) return '';
  const sorted = [...images].sort((a,b)=>(b.width||0)-(a.width||0));
  return (sorted[0]||{}).url || '';
}

function simplify(e){
  const venue = e._embedded && e._embedded.venues && e._embedded.venues[0];
  return {
    id: e.id,
    title: e.name || '',
    venue: venue ? [venue.name, venue.city && venue.city.name].filter(Boolean).join(', ') : '',
    date: (e.dates && e.dates.start && e.dates.start.localDate) || '',
    image: pickImage(e.images),
  };
}

/* the same show sells tickets as a separate event per performance/venue date, so a plain
   keyword search comes back with the same title many times over - keeps just the first
   (Ticketmaster's own relevance order) result per title, case-insensitively, same as picking
   one representative result per film already works in film-search.js */
function dedupeByTitle(shows){
  const seen = new Set();
  const out = [];
  for(const s of shows){
    const key = s.title.toLowerCase().trim();
    if(!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function fetchEvents(key, {keyword, attractionId, countryCode}){
  const url = new URL(TM_EVENTS);
  url.searchParams.set('apikey', key);
  if(keyword) url.searchParams.set('keyword', keyword);
  if(attractionId) url.searchParams.set('attractionId', attractionId);
  url.searchParams.set('classificationName', 'Arts & Theatre');
  url.searchParams.set('size', '20');
  if(countryCode) url.searchParams.set('countryCode', countryCode);
  const res = await fetch(url.toString());
  if(!res.ok) throw new Error('Show search returned '+res.status);
  const data = await res.json();
  return (data._embedded && data._embedded.events) || [];
}

/* an open-ended West End residency (Mamma Mia! at the Novello, say) can exist as a Ticketmaster
   "attraction" - a real, sellable listing on ticketmaster.co.uk - without a plain keyword search
   on /events.json turning up any of its individual performances: the two searches don't share
   the same relevance ranking or coverage. Looking the keyword up as an attraction first, then
   asking for that attraction's own events by id, catches the ones a keyword-only events search
   quietly drops. Best-effort - a Ticketmaster hiccup here still leaves the plain keyword
   searches below to fall back on, so it never turns a working search into a broken one. */
async function fetchAttractionIds(key, q, countryCode){
  try{
    const url = new URL(TM_ATTRACTIONS);
    url.searchParams.set('apikey', key);
    url.searchParams.set('keyword', q);
    url.searchParams.set('classificationName', 'Arts & Theatre');
    url.searchParams.set('size', '5');
    if(countryCode) url.searchParams.set('countryCode', countryCode);
    const res = await fetch(url.toString());
    if(!res.ok) return [];
    const data = await res.json();
    const attractions = (data._embedded && data._embedded.attractions) || [];
    return attractions.map(a=>a.id).filter(Boolean);
  }catch(e){ return []; }
}

/* Ticketmaster's Discovery API is US-centric by default: a plain keyword search with no
   countryCode can bury (or drop entirely) a title that's also touring/running elsewhere, which
   is exactly the case for most of what gets logged here (West End shows). Runs the GB-scoped
   search first (plus the attraction lookup above) so a London show wins the title-dedupe below,
   then tops up with an unscoped search for anything GB didn't have (a show seen abroad, on a
   trip) - so this stays useful for logging a show from anywhere, not just London. */
async function searchShows(q, debug){
  if(!q) return {shows: []};
  const key = apiKey();
  const [gb, everywhere, attractionIds] = await Promise.all([
    fetchEvents(key, {keyword:q, countryCode:'GB'}),
    fetchEvents(key, {keyword:q, countryCode:null}),
    fetchAttractionIds(key, q, 'GB'),
  ]);
  // no countryCode here: the attraction itself was already found via a GB-scoped search above,
  // filtering its events by country again risks dropping the very dates that search was meant
  // to surface if Ticketmaster tags them differently than a plain events search would
  const byAttraction = attractionIds.length
    ? (await Promise.all(attractionIds.map(id=>fetchEvents(key, {attractionId:id}).catch(()=>[])))).flat()
    : [];
  const events = [...gb, ...byAttraction, ...everywhere];
  const result = {shows: dedupeByTitle(events.map(simplify).filter(s=>s.title))};
  // ?debug=1 returns what each tier actually found, so a search that still comes up empty can
  // be diagnosed (a bad classification filter, a country mismatch, etc.) without guessing blind
  if(debug) result.debug = {attractionIds, counts:{gb:gb.length, byAttraction:byAttraction.length, everywhere:everywhere.length}};
  return result;
}

export default async function handler(request){
  const url = new URL(request.url);
  const q = (url.searchParams.get('q')||'').trim();
  const debug = url.searchParams.get('debug')==='1';
  try{
    const data = await searchShows(q, debug);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': debug ? 'no-store' : 'public, max-age=3600',
      },
    });
  }catch(e){
    return new Response(JSON.stringify({error: e.message || 'unexpected error'}), {
      status: e.status || 500,
      headers: {'Content-Type': 'application/json'},
    });
  }
}
