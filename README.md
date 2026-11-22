# Tennis Group Bot

A WhatsApp bot for a tennis group. It coordinates who's free to play, schedules matches with WhatsApp polls (auto-generating singles/doubles matchups and rotations, or opt-in Yes/No polls), passively tracks user-created manual tennis match polls, tracks match results and a leaderboard, syncs player ratings from TennisRecord, checks weather for outdoor play, and answers general questions using Claude. It uses [Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp integration.

# Development

Authors:

* Pramod Immaneni <pramod.immaneni@gmail.com>

Agents:

* Google Antigravity, Anthropic Claude

## Setup

1. **Install dependencies** (requires Node.js 18+):
   ```bash
   npm install
   ```

2. **Configure environment variables (`.env`)**:
   - Copy `.env.example` to `.env`.
   - `ANTHROPIC_API_KEY`: Get a key from [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) and set `ANTHROPIC_API_KEY=sk-ant-...` (paid API, separate from a claude.ai subscription).
   - `DEFAULT_MODEL` *(optional)*: Override the Claude model used for conversational AI.
   - `SUPERADMIN_ACCOUNT`: WhatsApp LID or phone number JID of the bot superadmin (required for DM-only group management and global booking pause/resume commands).
   - `CONFIG_DIR` / `DATA_DIR` *(optional)*: Override the directories for configuration files and persisted bot data (default to `config` and `data`).

3. **Configure groups, courts, and TennisRecord (`config/`)**:
   - **Groups (`config/groups.json`)**: Copy `config/groups.json.example` to `config/groups.json` to configure defaults, allowed groups, sport (`tennis`/`pickleball`), court booking strategy/schedule, preferred courts, member accounts, notification recipients, and inactivity windows. Superadmins can also manage groups via WhatsApp DM (`!groups`, `!addgroup`, `!removegroup`, `!groupconfig`, `!setgroupconfig`).
   - **Court Venues (`config/courts.json`)**: Copy `config/courts.json.example` to `config/courts.json` to configure SCVCC host URL, member booking credentials, `ignoredCourts`, `tentativeBookingTitles`, and `clubClosedTitles`.
   - **TennisRecord (`config/tennisrecord.json`)**: Copy `config/tennisrecord.json.example` to `config/tennisrecord.json` to customize rating sync settings (`url`, `certStatus`, `timeout`, `preferredLocation`/`nearbyCities`, and `refreshIntervalDays`, default 14).

4. **Default location & timezone**:
   - Default weather location (`DEFAULT_LOCATION` in `index.js` and `lib/commands/index.js`) defaults to `"San Jose, CA"`.
   - Time resolution is anchored to San Jose, CA (`America/Los_Angeles` / Pacific Time).

5. **Run it**
   ```bash
   npm start
   ```
   - On first startup, scan the QR code in your terminal (WhatsApp app → Settings → Linked Devices → Link a Device). Session auth is persisted in `auth_info_baileys/`.
   - Run the test suite anytime with `npm test`.

---

## Scheduling matches with polls

The bot supports bot-created match polls (one-off, future-scheduled, multi-time, and recurring) as well as user-created manual match polls:

### 1. Fixed-Spot & Auto-Sized Polls (Singles & Doubles)
Send `!poll 8 tomorrow 7pm` or `@tenbot create a poll for 8` (2 for singles; 4, 8, 12, 16, ... for doubles; or `auto` to size based on SCVCC court availability).
- The bot posts a native WhatsApp poll with an optional custom title (`--title="..."`) and optional future posting schedule (`at <postTime>`, e.g. `!poll 8 Friday 7pm at Thursday 6pm`).
- By default, the person requesting the poll is automatically added as **Player 1**, with open voting slots starting from **Player 2** (`Player 2` .. `Player N`). Use `--pre-allocate-slots` to pre-seed named slots from pre-booked court rosters.
- **Split Polls (> 12 spots)**: Because WhatsApp native polls support at most 12 options, larger polls (e.g. 16 or 20 players) automatically split into linked sibling polls (`Part 1`, `Part 2`, ... sharing a `parentPollId`, bounded by `maxInitialPolls` with demand-driven spillover). They are tracked, checked for reminders/lineups, status-grouped, and court-managed as a single logical session.
- **Lineup Modes (`--lineups=filled|fallback|none`)**:
  - `filled` (default): Automatically generates balanced matchups as soon as all spots are filled.
  - `fallback`: Automatically generates matchups at `--lineup-lead-time` before play (default `30m`) if no manual lineup was posted.
  - `none`: Manual lineups only.
- **Dry-Run Simulation**: Use `!simulatepoll` or `!simulaterecurring` to post an unsaved throwaway poll and preview slots and court availability.

### 2. Yes/No Opt-In Polls (Unspecified Player Count)
If no number of players is specified (e.g. `!poll tomorrow 9am` or `@tenbot create a poll for tonight 6pm`), or `opt-in` is passed:
- The bot creates a poll with two options: **"Yes"** and **"No"**.
- Players vote "Yes" to opt in.
- When ready, say `@tenbot generate matchups` (or `!matchups`, `!draw`, `!rematch`), and the bot generates singles (for 2 Yes voters) or doubles rotations (for 4, 8, 12... Yes voters), ignoring anyone who voted "No".

### 3. Multi-Time Polls
Specify comma-separated play times or days (e.g. `!poll Saturday 8am, 9:30am, 4pm` or with per-slot limits `!poll Saturday 8am(4), 9:30am(8), 4pm(unlimited)`):
- Includes each time option plus `"No, can't play"`.
- Supports `--single-vote` vs `--multi-vote` (default), and `--single-session` (default: avoids placing a player in multiple slot lineups) vs `--independent-sessions`.
- Matchups and internal slot caps can target a specific time slot (e.g. `!matchups 9am`, `!setslots 9:30am 4`).

### 4. Recurring Match Polls
Automate recurring single-time or multi-time polls via `!recurringpoll` (e.g. `!recurringpoll 4 7pm on weekdays at 8am`, `!recurringpoll 4 8am, 9:30am on weekends at 1 day before at 6pm`):
- Supports day expressions (`everyday`, `weekdays`, `weekends`, `mon-thu`, `tue,thu`), `--start-date` / `--end-date`, and `at <postTime>` posting schedules.
- Supports template management (`!modifyrecurringpoll`, `!pauserecurringpoll [until <date>]`, `!resumerecurringpoll`, `!cancelrecurringpoll`, `!recurringpolls`) and per-instance overrides (`!modifyinstance`, `!skipinstance`, `!unskipinstance`) without altering the recurring template.
- When `!modifyrecurringpoll` changes the match time or booking duration, upcoming unposted advance court bookings are automatically moved/updated on SCVCC (falling back to alternative available courts if needed, or warning and resetting for retry if none can be moved).

### 5. Manually Created Tennis Match Polls (Passive Tracking & Extra Player Resolution)
If a poll for scheduling matches is created manually by a user directly in WhatsApp:
- The bot **passively tracks** the match poll and its votes without making any changes to the poll or sending slot conflict warnings.
- The bot **will not automatically create matchups** when the poll is filled.
- The bot answers questions about the poll (e.g. `@tenbot who has voted for Saturday's poll?`, `@tenbot who is playing?`, `@tenbot how many spots left?`).
- **Poll Labels & Player Resolution Rules**:
  - **Label Check First (Starting Slot > 1)**: The bot performs a label check first. If the first label doesn't start with the first player (e.g. text like `3` or `Player 3`), the bot includes extra players equal to one less than the first label (e.g. `3 - 1 = 2` extra players: `cname`, `cname 2`).
  - **Valid Total Player Count Check (First Label Index 1 Only)**: Only if the first vote label has index 1 (starts with slot 1 / `Player 1` / opt-in) is the valid total player count check applied (2 for singles, multiples of 4 for doubles), and **only if all vote slots have been filled**. If voting is still in progress and not all slots are filled, extra players are not added.
  - **Extra Player Naming**: Extra player names are generated using the poll creator's name (`cname`): the first extra player is `cname`, the second is `cname 2`, the third is `cname 3`, and so on.
  - **Do Not Always Include Creator**: If a poll starts at slot 1 and already has a valid player count (e.g. 2 for singles, 4/8/12 for doubles), the creator is not automatically added unless they voted in the poll.
- **Matchup Generation on Demand**: If and only if users explicitly ask to create matchups on a manually created match poll (e.g. `@tenbot generate matchups`, `!matchups`, or `!draw`), the bot generates matchups using the exact same rules as bot-created polls.

### 6. Non-Match / General Polls
- Polls not related to tennis match scheduling (e.g. dinner options, ball brands, social plans) are **ignored completely and not tracked**.

---

## Time & Date Handling (San Jose, CA)

You can include a day, date, and/or time in your request (and an optional `at <postTime>` for scheduled poll creation):

```
@tenbot create a poll for 8 on Saturday at 9am
```
→ Poll titled `🎾 Creator's match: Vote for a spot! (8 spots -- Saturday 9am)`.

* **Timezone**: All times are resolved in San Jose, California (Pacific Time).
* **Past Day + Time Rejection**: If both a day and time are specified (e.g. `@tenbot create a poll for today at 9am` or `@tenbot create a poll for Saturday 9am` when it is Saturday evening) and that time has already passed, the bot **will not create the poll** and will ask the user to fix the day or time to an upcoming schedule.
* **Past Time-Only Rollover**: If only a start time was specified for creating the poll and the current time is greater than the start time, the bot automatically creates the poll for **the next day with that start time** (`Tomorrow <time>`).
* **Time & Date Formatting**: Times accept `am`/`pm` or 24h formats (e.g. `9am`, `6:30pm`, `18:00`). Day names (`today`, `tomorrow`, `tonight`, `Monday`–`Sunday`) and explicit dates (`10/25`, `2026-11-06`) are recognized.

---

## Multiple Polls, Multi-Group Support & Conflict Windows

Multiple polls can be created concurrently across different times, members, and WhatsApp groups.
* **90-Minute Separation**: If the same creator has other polls but the new poll's start time is **90 minutes or more** from other polls' start times, the bot creates the poll directly without requiring extra confirmation and includes the creator as Player 1.
* **Conflict Window (< 90 minutes)**: If an active match poll already exists within **less than 90 minutes** of a new poll's start time that includes the creator, the bot creates the new poll with **all spots open** (`Player 1` .. `Player <N>`) rather than auto-assigning the creator as Player 1.
* **Grouped Poll Status**: `!pollstatus`, `!activepolls`, `!upcomingpolls`, and `!allpolls` show voters and capacities, grouping split-poll parts (`Part 1`, `Part 2`) into one logical session block.
* **Group Targeting (`--group`)**: Authorized admins/superadmins can run poll, court, score, and configuration commands from DM using `--group="<groupName|JID>"` (or a configured group alias).

---

## Court Availability, Reservations & SCVCC Integration

The bot integrates directly with Silver Creek Valley Country Club (SCVCC) for both tennis (Courts 1–6) and pickleball (`pb`) courts:

* **Availability, Bookings & Webcam**:
  * `!courts [when] [time] [court] [pb]` — View open courts and slot durations.
  * `!courtbookings [when] [time] [court] [pb] [for <player>]` — View club reservations and players.
  * `!mybookings` — View upcoming reservations for configured member accounts.
  * `!webcam [video]` — Capture and send a live SCVCC court photo snapshot (or 10-second video clip with `video`).
* **Direct & Poll-Linked Bookings (`!bookcourt` / `!modifycourt` / `!cancelcourt`)**:
  * Book directly: `!bookcourt [Court <N>] <time> [when] [singles/doubles] [duration] [pb] [for <requester>] [with <players>]`.
  * Book for an existing poll: `!bookcourt <pollId> [all|<count>] [Court <N>] [duration]` — omitting count books courts needed to cover current votes; `all` books remaining courts up to full poll size; `<count>` books an exact number of additional courts; optional `Court <N>` targets a specific court; optional duration (`60min`, `1h`, `--booking-duration=60m`) overrides the booking duration. Accepts split-poll `parentPollId`.
  * Modify or cancel: `!modifycourt` updates reservation court, time, date, duration, format, or players (with `--group` for admins) and syncs linked polls; `!cancelcourt <id>` cancels by reservation ID.
  * Admin controls: `!pausecourtbookings [group|all]` / `!resumecourtbookings [group|all]` (plus superadmin `!pauseallcourtbookings` / `!resumeallcourtbookings`).
* **Releasing Poll Courts (`!releasecourt`)**:
  * `!releasecourt [pollId/when] <count|all|Court N> [--keep-size]` cancels SCVCC reservation(s) and updates the poll (supporting single polls, split polls via `parentPollId`, and multi-time polls).
  * By default, releasing courts shrinks poll capacity proportionally and closes/deletes the poll if all courts are released. Pass `--keep-size` (or `--no-resize` / `--preserve-size`) to cancel the court reservation(s) while keeping the poll size unchanged and voting open.
* **Automated Poll Court Strategies & Protections**:
  * Configurable via poll flags or `config/groups.json`: `--courts-strategy=book|lookup|none` (default `none`), `--booking-strategy=standard|advanced` (e.g. `--booking-schedule="-7days 7:00AM"`), `--booking-duration=<30|60|90|120>` (or shorthand like `60min`, `1h`, `1.5h`, `2h`; default `90` mins; precedence: poll flag > recurring schedule > `groups.json` `bookingDuration` > `90`), `--pre-book-courts`, `--max-courts`, `--booking-court-preference`, `--look-around`, `--booking-players`, `--skip-court` / `--unskip-court`, and `!advancedbookings`.
  * **Tentative & Club Closed Detection**: Honors `tentativeBookingTitles` when sizing auto polls, and rejects poll creation / aborts booking when club titles match `clubClosedTitles`.
  * **Auto-Release on Low Turnout**: Automatically releases unused pre-booked courts if player signups are insufficient before playtime (automatically disabled when a poll is stopped with `!stoppoll`).

---

## Poll Lifecycle, Reminders & Modifications on WhatsApp

* **Cancelling & Deleting Polls**: `!cancelpoll [pollId]` / `!deletepoll` (defaults to the latest active poll if ID is omitted, or accepts conversational `@tenbot cancel the poll`) cancels the poll, releases any booked SCVCC courts, and **deletes the poll message(s) from WhatsApp**. `!clearallpolls` clears bot memory while leaving WhatsApp messages intact.
* **Stopping, Resuming & Limiting Slots**:
  * `!stoppoll [pollId]` / `!resumepoll [pollId]` pauses or resumes voting, reminders, and automatic court releases without deleting the poll.
  * `!setslots` adjusts internal player limits for an active poll, a multi-time slot, or a future recurring instance without recreating the WhatsApp poll.
* **Modifying Polls (`!modifyinstance` / `@tenbot ...`)**: Updates spots, time, title, booking duration (`--booking-duration=60m` or `60min`), courts, skipped courts, or voting/lineup flags on an active poll (re-posting and deleting the older WhatsApp poll when options/title change, or updating settings and linked SCVCC reservations in-place).
* **Deleted in WhatsApp Sync**: When a poll is deleted for everyone directly in the WhatsApp app, the bot detects revocation/deletion events across `messages.upsert`, `messages.update`, and `messages.delete` and cleans up active poll state.
* **Automated Reminders & Quiet Hours**: Sends scheduled reminder notifications (`64h`, `32h`, `16h`, `8h`, `4h`, `2h`, `1h` before play time) respecting group quiet hours (`!quiethours`, default `22:00-07:00`). Supports manual `!remind`, `!forceremind` (`--force` to bypass quiet hours), `!pausereminders`, and `!resumereminders`.

---

## Matchup Rotations, Lineups & Court Balancing

Once a fixed poll fills, a fallback lead-time triggers, or an opt-in/manual poll draw is requested:

```
🎾 All spots filled! Here are today's matchups:

Set 1:
  Court 1: Mike & Sara vs John & Alex
  Court 2: Priya & Ben vs Tom & Lisa

Set 2:
  Court 1: Mike & Ben vs Tom & Alex
  Court 2: Priya & John vs Sara & Lisa
```

- **Singles & Doubles**: Supports 2 players (singles) or multiples of 4 (doubles across 1+ courts).
- **Rotations**: Lowest-repeat draws ensure players partner with different teammates each set and face different opponents.
- **Pair Preferences**: Supports keeping specific players on the same team (e.g. `!matchups keeping Mike and Sara on same team`).
- **Freshness across weeks**: Past partnerships from the last 3 weeks are remembered in `data/pair-history.json` and weighted to avoid repeat pairings across sessions.
- **Even courts**: The draw balances pairings so court rating sums are within **0.49** of each other.
- **Slot Conflicts & Manual Lineups**: In bot fixed-spot polls, `--slot-check` (default on) warns voters who pick an already-claimed slot. Manual lineups posted in chat (including minor name typos) are recognized to avoid duplicate fallback draws.

---

## Player Ratings, Profiles & Activity

Every player carries a rating between **2.50 and 4.50**, formatted to two decimals:
- **Initial Rating**: When a player is first encountered, the bot looks up their estimated dynamic rating or NTRP benchmark rating on [TennisRecord.com](https://www.tennisrecord.com/). If not found, their rating starts at **3.0**.
- **Bi-Weekly Sync & Profiles**: Set your full name for TennisRecord lookup with `!fullname` (admin `!setfullname`), manage nicknames with `!alias` / `!aliases` / `!deletealias`, and sync group membership with `!syncmembers`.
- **User Rating Adjustments**: Users can update their own rating anytime:
  - `@tenbot my rating is 4.0` or `@tenbot set my rating to 3.5`
  - Command: `!setrating 4.0` (or `!myrating 4.0`; admins can set others with `!setrating <player> = <rating>`)
  - `!resetrating [player]` resets to the baseline TennisRecord rating; `!unsetrating [player] [rating]` marks a player as having no TennisRecord profile (pauses auto-updates).
  - Admins can run `!refreshratings`, `!trconfig`, and `!certstatus` / `!suspendcert` / `!resumecert` to manage TennisRecord SSL/config.
- **Rating Movement**: Ratings adjust dynamically after match scores are reported:
  - Higher-rated pairing wins: `0.01 × game margin`
  - Underdog wins (upset): `gap × (game margin / 12)`
- Ratings are saved in `data/ratings.json` and viewed with `!ratings`.
- **Player Activity & Inactivity Checks**: Tracks played, voted, and messaged timestamps per player (`!activity`, `!latestactivity`). `!inactiveplayers [period]` lists inactive members, and `!checkinactivity` runs 50%/75%/100% milestone outreach based on each group's configured `inactivityPeriod`.

---

## Match Scores, Leaderboards & Casual Availability

- **Logging Scores**: Results can be logged via `!score <winner> def <loser> <score>` or in plain conversational text addressed to `@tenbot`:

```
@tenbot Mike & Sara beat John & Alex 6-4
```
or simply:
```
@tenbot we won 6-4
```
(If no score is mentioned, e.g. `@tenbot we won`, it logs a default 6-3 set.)
- **Score History & Edits**: Group-scoped match history is kept over a rolling 2-week window and queried with `!scores [recent|today|yesterday|<day>|<date>|<start to end>]`. Scores can be corrected or removed via `!editscore` and `!deletescore`, cleanly reverting rating changes.
- **Points Leaderboard**: `!leaderboard` (current calendar month) and `!leaderboard --all` (all retained scores) rank players by **1 point per game won + 2 points per set won** (tiebreaker: fewer games lost).
- **Casual Availability**: `!free [when]`, `!notfree`, and `!clearfree` track ad-hoc player availability.

---

## Weather, Conversational AI & Admin Tools

- **Weather Forecast**: `!weather [location]` provides a 3-day outdoor playability forecast (defaults to San Jose, CA).
- **Conversational AI (Claude)**: Responds to `@tenbot` (and minor trigger prefix variations) using tool calling over polls, courts, scores, ratings, and recent 2-week chat context.
- **Diagnostics & Superadmin Group Management**: `!ping`, `!help [command]`, `!reset`, and DM-only superadmin commands (`!groups`, `!groupconfig`, `!addgroup`, `!removegroup`, `!setgroupconfig`) to manage group settings in `config/groups.json`.

---

## Commands Summary

| Command | Description |
|---|---|
| `!poll [size\|auto] [when] [at <postTime>]` | Create or schedule a fixed, auto, opt-in, or multi-time match poll |
| `!simulatepoll` / `!simulaterecurring` | Preview a mock unsaved poll and court availability |
| `!recurringpoll` / `!recurringpolls` | Create, view, pause, resume, or manage recurring poll schedules |
| `!modifyinstance` / `!skipinstance` / `!unskipinstance` | Override, skip, or restore specific poll instances |
| `!matchups [poll\|time]` / `!draw` / `!rematch` | Generate balanced singles/doubles matchups and rotations |
| `!stoppoll` / `!resumepoll` / `!setslots` | Pause/resume voting & auto court releases, or adjust slot limits |
| `!cancelpoll` / `!clearallpolls` | Cancel poll (releases courts & deletes from WhatsApp) or clear bot memory |
| `!pollstatus` / `!activepolls` / `!upcomingpolls` | View live vote counts, split-poll session groups, and statuses |
| `!courts` / `!courtbookings` / `!mybookings` / `!webcam` | Check SCVCC court availability, reservations, or live court webcam |
| `!bookcourt` / `!modifycourt` / `!cancelcourt` | Book direct or poll-linked courts (`[all\|<count>] [Court <N>]`), modify, or cancel |
| `!releasecourt [poll] <count\|all\|Court N> [--keep-size]` | Release poll courts (optionally keeping poll size unchanged with `--keep-size`) |
| `!pausecourtbookings` / `!resumecourtbookings` | Pause or resume court bookings for a group (or all groups for superadmins) |
| `!remind` / `!forceremind` / `!pausereminders` / `!quiethours` | Manage automated match reminders and quiet hours |
| `!free [when]` / `!notfree` / `!clearfree` | Manage casual player availability |
| `!score` / `!scores` / `!editscore` / `!deletescore` | Log, query, edit, or delete match scores |
| `!leaderboard [--all]` | View monthly (or rolling 2-week) points standings |
| `!ratings` / `!setrating` / `!resetrating` / `!unsetrating` | View or adjust player ratings (2.50–4.50) |
| `!fullname` / `!alias` / `!aliases` / `!syncmembers` | Set full names, manage aliases, and sync group roster |
| `!activity` / `!latestactivity` / `!inactiveplayers` / `!checkinactivity` | View player activity and run inactivity milestone checks |
| `!weather [location]` | View outdoor tennis weather forecast |
| `!groups` / `!groupconfig` / `!setgroupconfig` | (Superadmin DM) List and configure managed WhatsApp groups |
| `!help [command]` / `!ping` / `!reset` | Show command help, check connectivity, or clear conversation memory |
