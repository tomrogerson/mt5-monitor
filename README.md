# MT5 Monitor

A private, phone-first dashboard for live MT5 trades across many accounts. Dark mode only. The Overview tab adds up accounts running the same bot, and each bot has its own tab.

How it works: a small **collector** runs on the PC that has your MT5 terminals. It reads each terminal (read-only, it never places orders) every ~2 seconds and sends the numbers to the **dashboard**, which runs on an always-on host (Render) and shows them on your phone.

## 1. Try the dashboard locally (demo data)
    npm install
    npm run demo        # http://localhost:3000, password: demo

## 2. Put it on GitHub
Create a private repo, then upload the contents of this folder (not the folder itself). `.gitignore` keeps secrets and local files out.

## 3. Deploy on Render
1. New > Web Service > Git Provider > pick the repo.
2. Language: Docker. Instance: the $7 one (not Free, it sleeps). Add a disk named `data`, mount path `/data`, 1 GB.
3. Environment variables:
   - `DASHBOARD_PASSWORD` a long password for logging in
   - `SESSION_SECRET` a long random string
   - `PROVIDER` = `push`
   - `INGEST_TOKEN` a different long random string (24+ characters). The collector needs the same value.
   - `EXPECTED_ACCOUNTS` = how many accounts you will report (optional, makes the "Live 14 of 15" count right)
   - `TIMEZONE` = `Europe/London`
4. Health check path: `/healthz`. Deploy, then open the HTTPS address and log in.
5. On your phone: Share > Add to Home Screen.

(`render.yaml` pre-fills most of this if you use New > Blueprint instead.)

## 4. Set up the collector (on the PC with the terminals)
1. Install Python 3.10+ from python.org (tick "Add Python to PATH").
2. Copy the `collector` folder to e.g. `C:\MT5Monitor\collector`.
3. In that folder: `pip install -r requirements.txt`
4. Copy `config.example.json` to `config.json` and fill in:
   - `server_url`: your Render address
   - `token`: the same value as `INGEST_TOKEN`
   - `terminals`: one line per terminal. `name` is what shows on the dashboard (`Gold 01`, `USDJPY 02`, `GBPUSD 03`, the name decides which tab it appears under). `path` is the full path to that terminal's `terminal64.exe`.
5. Test one terminal first (it prints what it would send):
       python collector.py --name "Gold 01" --path "C:\...\terminal64.exe" --dry-run
   Check the balance, equity and positions match the terminal.
6. Double-click `start.bat` to run all of them. Leave the window open. To run at startup, put a shortcut to `start.bat` in the Windows Startup folder.

Notes:
- Each terminal must be running and logged in. The collector attaches to it, it doesn't log in.
- If closed-trade times look off by an hour or more, set `"server_utc_offset_hours": 3` (your broker's offset) on that terminal in `config.json`.
- An account that hasn't reported for 20 seconds shows as disconnected.

## Grouping
The bot is chosen from the account name using the `match` patterns (default: gold/xau, usdjpy/jpy, gbpusd/gbp). Add `"group"` to a terminal in the collector config to force it, or define your own `groups` in `accounts.json`. Anything unmatched appears under "Other".

## Other data sources
`PROVIDER=metaapi` (cloud, needs a MetaApi token) and `PROVIDER=mtapinet` (experimental) are also built in. See `.env.example`.

## Behaviour
- The dashboard records equity every minute for the 24h curve, whether or not a page is open.
- Accounts in different currencies are added together without conversion, and a notice says so.
- "Today" starts at midnight in `TIMEZONE`.

## Status
Tested with demo data, unit tests (`npm test`) and a stand-in MT5 library for the collector. Not yet run against real terminals, so expect a small fix or two on first use.
