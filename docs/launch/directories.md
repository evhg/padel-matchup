# Assistant directories: the texts to paste

Week six of the launch calendar lists the MCP server in Smithery, Glama and mcp.so. The official registry entry already exists (`sh.kicksma/kicksmash`, published from `server.json`). Each directory form takes some subset of the block below; nothing here needs a company. The forms that want a GitHub login use the owner's; everything else the session files. Nothing is posted without the owner's tap.

## The block

**Name:** Kicksmash

**Namespace / id:** `sh.kicksma/kicksmash`

**Endpoint:** `https://kicksma.sh/mcp` (streamable HTTP, stateless JSON; reading needs no key, creating a match or booking a lesson uses a key the assistant can mint itself with `create_api_key`)

**Manifest:** `https://kicksma.sh/.well-known/mcp.json` · **OpenAPI:** `https://kicksma.sh/api/openapi.json` · **llms.txt:** `https://kicksma.sh/llms.txt`

**Homepage:** `https://kicksma.sh/developers` · **Repository:** `https://github.com/evhg/padel-matchup`

**Licence:** Apache-2.0 (code), CC BY 4.0 (public data)

**Tagline (under 80 characters):** Padel matches for people and their assistants: create, share one link, join.

**Short description (under 160 characters):** Organise padel from any assistant: create a match or an americano, share one link, join, find courts, coaches and level-verified games in three languages.

**Long description:**

Kicksmash is an open padel match-up service that people and their assistants use the same way. One link organises a match in WhatsApp; a card does it in Telegram or Discord; the MCP server does it from any assistant. Create a match or a tournament (americano, mexicano, King of the Court, with the exact rotation and live standings), share the link, join with a first name, record the score. Find public matches, clubs, coaches and recurring Opens by city; book a lesson with a coach who accepted you; read a player's signed, portable level. English, Russian and Spanish from day one; public data is CC BY 4.0; the code is open source; every AI crawler is welcome in robots.txt. It runs without an app or an account, and it is built and maintained by an assistant with a human approving anything that leaves the system.

**Categories / tags:** sports · scheduling · community · padel · calendar · booking

**Tools (15):**

| Tool | What it does |
|---|---|
| `about_kicksmash` | What the service is and how the pieces fit, in plain text |
| `get_match` | One match or tournament by code: time, place, roster, format, standings |
| `find_matches` | Public matches by city, date and level |
| `get_group` | A group and its weekly slot |
| `generate_schedule` | The exact americano, mexicano or King of the Court rotation for N players and courts |
| `create_match` | A match or tournament from a time, a place and a format (key needed) |
| `join_match` | Take a seat, or the waitlist, with a first name (key needed) |
| `create_api_key` | Mint a key for the assistant's user, instantly |
| `find_clubs` | Live club pages by city, with booking links and free courts today where shared |
| `find_coaches` | Coaches by city or club, with their booking link |
| `coach_slots` | A coach's free lesson times |
| `request_coach` | Ask a coach to take you as a student |
| `book_lesson` | Book a free time with a coach who accepted you (key needed) |
| `cancel_lesson` | Cancel inside the coach's rules (key needed) |
| `find_series` | Recurring Opens by city, with the next edition and the podiums |

**Resources:** `kicksmash://docs/reference` (the model-facing reference) · `kicksmash://docs/openapi`

**Example prompts:**

- "Set up an americano for eight of us on Saturday at 19:00 at Warehaus in Phuket and give me the link."
- "Who is playing padel near Rawai this week around level 3.5?"
- "Which padel clubs in Singapore have a free court tonight?"
- "Book me a lesson with coach Benji on Friday afternoon."

## Per directory

- **Smithery** (smithery.ai): add a remote server by URL; the listing takes the tagline, the long description, the tags and the repository. Owner's GitHub login for the form; the session prepares the fields.
- **Glama** (glama.ai/mcp/servers): servers are indexed from public repositories and claimed with GitHub; the claim takes the endpoint, the description and the licence.
- **mcp.so**: a submission form with name, endpoint, description, repository and tags; no login for the basic listing.

Claude's connector directory and ChatGPT's app catalogue stay parked until a company exists.
