# MacroTalk 🍽️💬

A phone app for tracking calories and macros by **talking to Claude**, similar to Cal AI.
Type, speak, or snap a photo of what you ate. Claude estimates the calories, protein, carbs, fat and fiber and logs each item for you.

It's a Progressive Web App (PWA). It runs in your phone's browser and installs to your home screen like a native app. There's no backend: your food log stays on your phone, and your messages go straight to the Anthropic API.

## Features

- **Chat logging**: say "chicken burrito bowl and a Diet Coke" and each item gets logged with its macros
- **Photo logging**: tap 📷 and take a picture of your plate or a nutrition label
- **Voice**: tap 🎤 and talk. You can also turn on *Read Claude's replies aloud* in Settings
- **Corrections in plain English**: "actually it was 3 eggs" or "delete the toast"
- **Goal setting**: "I'm 30, 175 lb, 5'9", active, want to lose fat. Set my goals." Claude calculates the targets and saves them
- **Today dashboard**: calorie ring, macro progress bars, and meals grouped by breakfast, lunch, dinner and snack. Tap an entry to edit or delete it by hand
- **History**: calorie chart for the last 7 or 30 days, with daily averages
- **Export/import** your data as JSON
- Works offline for viewing your log; logging needs a connection

## What you need

An **Anthropic API key**. Create one at <https://console.anthropic.com/settings/keys> and add a few dollars of credit. You pay per use. A typical text log costs about a cent or less, and photos cost a bit more. Choose **Haiku** in Settings for the cheapest option or **Opus** for the best accuracy.

## Put it on your phone

The app is just static files, so it needs to be hosted somewhere over HTTPS. This repo publishes it with GitHub Pages (free for public repos):

1. Every push to `main` that changes `macro-tracker/` runs the *Publish MacroTalk to gh-pages* workflow, which copies the app to the `gh-pages` branch.
2. GitHub Pages serves that branch at
   `https://<your-username>.github.io/learning_git/`
   (If the site doesn't appear, go to **Settings → Pages** and set the source to *Deploy from a branch → `gh-pages` / root*.)
3. Open that link on your phone:
   - **iPhone (Safari):** Share button → **Add to Home Screen**
   - **Android (Chrome):** ⋮ menu → **Add to Home screen** / **Install app**
4. Open the app, paste your API key in **Settings**, and start logging.

Other free static hosts (Netlify Drop, Cloudflare Pages, Vercel) also work. Just upload the `macro-tracker/` folder.

### Run it locally

```bash
cd macro-tracker
python3 -m http.server 8000
# open http://localhost:8000
```

## Privacy

- Your API key, food log, and goals are stored only in your browser's local storage on that device.
- Chat messages and photos are sent only to `api.anthropic.com`.
- Anyone who opens the hosted URL gets their own empty copy. They can't see your data or use your key.
- Clearing your browser's site data wipes the log, so use **Settings → Export** now and then as a backup.

## How it works

`app.js` calls the Claude Messages API with tools for `log_food`, `get_log`, `update_entry`, `delete_entries`, and `set_goals`. Claude decides what to log, the app runs the tools against local storage, and the dashboard updates. Each day starts a fresh conversation to keep requests small and cheap.

| File | What it is |
|---|---|
| `index.html` | Screens: Today, Chat, History, Settings |
| `styles.css` | Mobile-first styling (light and dark mode) |
| `app.js` | Storage, Claude tool loop, voice/photo input, rendering |
| `sw.js` | Service worker for offline use and installability |
| `manifest.webmanifest`, `icons/` | Home-screen app metadata |
| `../.github/workflows/macro-tracker-publish.yml` | Publishes this folder to the `gh-pages` branch |

## Notes

- Voice input uses the browser's speech recognition. It works in Chrome on Android and in Safari on iOS. If it isn't available, use the mic button on your keyboard.
- The numbers are AI estimates, like any photo or text-based tracker. For packaged foods, mention the brand or photograph the label for the best accuracy.
