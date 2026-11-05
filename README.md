# Ghostrun

Real-life manhunt you can play anywhere in the world: a campus, a neighbourhood, a park. Hunters chase ghosts on a pastel 3D map; ghosts get pinged on a schedule and must send a photo hint at every ping. Born at Chandigarh University.

**Play now:** https://playghostrun.vercel.app

## Modes
- **Quick** (15 min): no pings, pure hide and seek
- **1 hour** and **Endless**: pings start at 15 / 20 / 25 min depending on player count (4–5 / 6–7 / 8+), and the gap drops by 5 min with every catch, down to 5 min

## Stack
- Vite + MapLibre GL on OpenFreeMap vector tiles (custom pastel style)
- Supabase Postgres: all game rules run server-side in security-definer functions; tables are closed to the browser, raw locations never leave the server except as scheduled pings
- Self-hosted fonts (Fredoka, Kanit), no analytics or session replay
- Deployed on Vercel with a strict Content Security Policy

## Privacy
Locations and photo hints are deleted when a game ends; whole games are deleted after 24 hours. Players must be 13+.

Built by Bhavishay Mehendiratta. Developed with help from Claude (Anthropic).
