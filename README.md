# Signal Bot (Options Alerts)

Posts clean Discord **embeds** for call/put option setups based on Yahoo Finance market data.

## Requirements
- Node.js 20+ (Recommended: Node 22+ because yahoo-finance2 prints a warning on Node < 22)

## Install & Run (Windows PowerShell)
```powershell
npm install
copy .env.example .env
# Fill DISCORD_TOKEN + CHANNEL_ID
npm start
```

## How to get DISCORD_TOKEN
Discord Developer Portal → Your Application → Bot → Reset Token → copy.

## How to get CHANNEL_ID
Discord → Settings → Advanced → Developer Mode ON → Right-click channel → Copy Channel ID

## Invite the bot
Developer Portal → OAuth2 → URL Generator  
Scopes: **bot**  
Bot permissions: **View Channels**, **Send Messages** (optional: Embed Links, Read Message History)

Open the generated URL in your browser and invite to your server.

## Settings (important)
- USE_EMBEDS=true → posts as a proper embed (recommended)
- USE_TREND_FILTER=false → disables chart-based trend filter (if you want max compatibility)
- SMALL_ACCOUNT_ONLY=true → only alerts with approx contract cost <= SMALL_ACCOUNT_MAX_COST

## Common issue: "Missing Access"
- Bot is not in the server OR wrong CHANNEL_ID OR no permissions in that channel.

## Disclaimer
This bot is for educational/demo purposes only. **Not financial advice.**
