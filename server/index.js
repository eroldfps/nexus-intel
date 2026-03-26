{
  "name": "nexus-intel",
  "version": "1.0.0",
  "description": "NEXUS INTEL — Geopolitical Intelligence Dashboard",
  "main": "server/index.js",
  "scripts": {
    "start": "node server/index.js",
    "dev": "node server/index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "rss-parser": "^3.13.0",
    "node-fetch": "^2.7.0"
  }
}
```
4. Click **"Commit changes"**

**File 2: `server/index.js`**
1. Click **"Add file"** → **"Create new file"**
2. In the filename box type: `server/index.js` ← **typing the slash automatically creates the folder!**
3. Open the `nexus-intel-final.zip` on your computer, find `server/index.js`, open it with Notepad, copy ALL the content
4. Paste it into GitHub
5. Click **"Commit changes"**

**File 3: `public/index.html`**
1. Click **"Add file"** → **"Create new file"**
2. In the filename box type: `public/index.html` ← this creates the `public` folder
3. Open `public/index.html` from the zip with Notepad, copy ALL content
4. Paste into GitHub
5. Click **"Commit changes"**

**File 4: `.env.example`**
1. **"Add file"** → **"Create new file"**
2. Filename: `.env.example`
3. Paste:
```
PORT=3000
CRAWL_INTERVAL=30
MAX_NEWS_ITEMS=200
```
4. Commit

**That's it — 4 files.** Your repo should now look like:
```
public/
  └── index.html
server/
  └── index.js
.env.example
package.json
README.md
