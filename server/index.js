const express = require("express");
const RSSParser = require("rss-parser");
const fetch = require("node-fetch");
const path = require("path");
const Database = require("better-sqlite3");

// ─── CONFIG ───
const PORT = process.env.PORT || 3000;
const CRAWL_INTERVAL = (parseInt(process.env.CRAWL_INTERVAL) || 30) * 1000;
const MAX_NEWS = parseInt(process.env.MAX_NEWS_ITEMS) || 500;
const GROK_API_KEY = process.env.GROK_API_KEY || "";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const rssParser = new RSSParser({ timeout: 8000, headers: { "User-Agent": "NexusIntel/2.0" } });

// ─── DATABASE ───
const db = new Database(path.join(__dirname, "..", "nexus.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT DEFAULT '',
    source TEXT DEFAULT '',
    url TEXT DEFAULT '',
    cat TEXT DEFAULT 'CONFLICT',
    region TEXT DEFAULT 'Global',
    impact INTEGER DEFAULT 5,
    connections TEXT DEFAULT '[]',
    ts INTEGER NOT NULL,
    topic_id TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_news_topic ON news(topic_id);
  CREATE INDEX IF NOT EXISTS idx_news_ts ON news(ts);

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    start_date TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );
`);

const insertNews = db.prepare(`INSERT OR IGNORE INTO news (id,title,summary,source,url,cat,region,impact,connections,ts,topic_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const getNews = db.prepare(`SELECT * FROM news WHERE topic_id = ? ORDER BY ts DESC LIMIT ?`);
const getNewsSince = db.prepare(`SELECT * FROM news WHERE topic_id = ? AND ts >= ? ORDER BY ts DESC`);
const getNewsCount = db.prepare(`SELECT COUNT(*) as count FROM news WHERE topic_id = ?`);
const insertWorkspace = db.prepare(`INSERT OR REPLACE INTO workspaces (id,name,topic_id,start_date,created_at) VALUES (?,?,?,?,?)`);
const getWorkspaces = db.prepare(`SELECT * FROM workspaces ORDER BY created_at DESC`);

// ─── CATEGORIES ───
const CATEGORIES = ["CONFLICT","ENERGY","MARKETS","DIPLOMACY","SANCTIONS","HUMANITARIAN","CYBER","CIVIL_UNREST"];

// ─── TOPICS ───
const PRESET_TOPICS = {
  "iran-war": {
    name: "2026 Iran War",
    keywords: ["iran","israel","strait of hormuz","oil","missiles","hezbollah","irgc","tehran","ceasefire","hormuz","houthi","pentagon","missile","strike","troops","navy","carrier","bomb","war","airstrike","\u{1F1EE}\u{1F1F7}","\u{1F1EE}\u{1F1F1}","\u{1F1FA}\u{1F1F8}","\u{1F1F1}\u{1F1E7}","\u{1F1FE}\u{1F1EA}","\u{1F1EE}\u{1F1F6}","\u{1F1F8}\u{1F1E6}","\u{1F1E6}\u{1F1EA}","\u{1F1F6}\u{1F1E6}","\u{1F1F0}\u{1F1FC}","\u{1F1E7}\u{1F1ED}","BREAKING","breaking"],
    feeds: [
      "https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml",
      "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml",
      "https://www.aljazeera.com/xml/rss/all.xml",
      "https://www.theguardian.com/world/middleeast/rss",
      "https://www.france24.com/en/middle-east/rss",
      "https://news.google.com/rss/search?q=iran+war+when:1d&hl=en-US&gl=US&ceid=US:en",
      "https://news.google.com/rss/search?q=strait+of+hormuz+when:1d&hl=en-US&gl=US&ceid=US:en",
      "https://news.google.com/rss/search?q=middle+east+conflict+when:1d&hl=en-US&gl=US&ceid=US:en",
    ],
    telegram: ["myLordBebo","disclosetv"],
  },
  "ukraine-russia": {
    name: "Ukraine / Russia",
    keywords: ["ukraine","russia","zelensky","putin","donbas","crimea","nato","kyiv","kharkiv","frontline","\u{1F1FA}\u{1F1E6}","\u{1F1F7}\u{1F1FA}","BREAKING"],
    feeds: [
      "https://feeds.bbci.co.uk/news/world/europe/rss.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/Europe.xml",
      "https://www.aljazeera.com/xml/rss/all.xml",
      "https://www.theguardian.com/world/russia/rss",
      "https://news.google.com/rss/search?q=ukraine+russia+war+when:1d&hl=en-US&gl=US&ceid=US:en",
    ],
    telegram: ["myLordBebo","disclosetv"],
  },
  "global-economy": {
    name: "Global Economy",
    keywords: ["inflation","fed rate","oil prices","stock market","recession","gdp","bond","treasury","central bank","trade war","tariff"],
    feeds: [
      "https://feeds.bbci.co.uk/news/business/rss.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
      "https://www.cnbc.com/id/100003114/device/rss/rss.html",
      "https://news.google.com/rss/search?q=global+economy+markets+when:1d&hl=en-US&gl=US&ceid=US:en",
    ],
    telegram: [],
  },
  "china-taiwan": {
    name: "China / Taiwan",
    keywords: ["china","taiwan","xi jinping","south china sea","strait","pla","semiconductor","chips","asean","indo-pacific","\u{1F1E8}\u{1F1F3}"],
    feeds: [
      "https://feeds.bbci.co.uk/news/world/asia/rss.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/AsiaPacific.xml",
      "https://www.aljazeera.com/xml/rss/all.xml",
      "https://news.google.com/rss/search?q=china+taiwan+when:1d&hl=en-US&gl=US&ceid=US:en",
    ],
    telegram: [],
  },
  "ai-tech": {
    name: "AI & Technology",
    keywords: ["artificial intelligence","openai","google ai","deepmind","regulation","chips","nvidia","llm","agi","autonomous"],
    feeds: [
      "https://feeds.arstechnica.com/arstechnica/technology-lab",
      "https://www.theverge.com/rss/index.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
      "https://news.google.com/rss/search?q=artificial+intelligence+when:1d&hl=en-US&gl=US&ceid=US:en",
    ],
    telegram: [],
  },
};

let customTopics = [];
let activeTopic = null;
let lastCrawl = null;
let crawlRunning = false;
let aiUsageToday = { date: "", count: 0 };

// ─── TELEGRAM SCRAPER ───
async function scrapeTelegram(channels, keywords) {
  const items = [];
  for (const channel of (channels || [])) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch("https://t.me/s/" + channel, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const html = await res.text();
      const msgRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)<\/div>/gs;
      const timeRegex = /<time[^>]*datetime="([^"]*)"[^>]*>/g;
      const messages = []; let match;
      while ((match = msgRegex.exec(html)) !== null) messages.push(match[1].replace(/<[^>]*>/g, "").trim());
      const times = [];
      while ((match = timeRegex.exec(html)) !== null) times.push(match[1]);
      messages.forEach((msg, i) => {
        if (msg.length < 20) return;
        const text = msg.toLowerCase();
        const matched = keywords.length === 0 || keywords.some(kw => text.includes(kw.toLowerCase())) || text.length > 50;
        if (!matched) return;
        items.push({
          id: "tg-" + channel + "-" + (times[i] || Date.now()) + "-" + i,
          title: msg.slice(0, 150),
          summary: msg.slice(0, 400),
          source: "@" + channel,
          url: "https://t.me/" + channel,
          pubDate: times[i] || new Date().toISOString(),
          ts: times[i] ? new Date(times[i]).getTime() : Date.now(),
          cat: null, region: null, impact: null, connections: [],
        });
      });
      console.log("[TELEGRAM] @" + channel + ": " + messages.length + " messages found");
    } catch (err) {
      console.log("[TELEGRAM] @" + channel + " error: " + err.message);
    }
  }
  return items;
}

// ─── HISTORICAL GOOGLE NEWS ───
async function fetchHistoricalNews(keywords, startDate) {
  const items = [];
  const dateStr = startDate.toISOString().split("T")[0];
  for (const kw of keywords.slice(0, 5)) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(kw)}+after:${dateStr}&hl=en-US&gl=US&ceid=US:en`;
      const feed = await rssParser.parseURL(url);
      for (const entry of (feed.items || []).slice(0, 20)) {
        const title = (entry.title || "").trim();
        if (!title) continue;
        items.push({
          id: "hist-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
          title: title.slice(0, 150),
          summary: (entry.contentSnippet || "").slice(0, 400),
          source: (feed.title || "Google News").replace(/ - .*$/, "").trim(),
          url: entry.link || "",
          pubDate: entry.isoDate || entry.pubDate || new Date().toISOString(),
          ts: new Date(entry.isoDate || entry.pubDate || Date.now()).getTime(),
          cat: null, region: null, impact: null, connections: [],
        });
      }
    } catch (e) { console.log("[HISTORICAL] Error for keyword '" + kw + "': " + e.message); }
  }
  console.log("[HISTORICAL] Found " + items.length + " items since " + dateStr);
  return items;
}

// ─── RSS CRAWLING ───
async function crawlFeeds(topic) {
  if (crawlRunning) return;
  crawlRunning = true;
  const config = PRESET_TOPICS[topic?.id] || topic;
  if (!config || !config.feeds || !config.keywords) { crawlRunning = false; return; }

  const existingCount = getNewsCount.get(topic.id)?.count || 0;
  const newItems = [];
  const existingTitles = new Set();
  const existing = getNews.get(topic.id, 1000);
  existing.forEach(n => existingTitles.add(n.title.toLowerCase().slice(0, 50)));

  // RSS feeds
  for (const feedUrl of config.feeds) {
    try {
      const feed = await rssParser.parseURL(feedUrl);
      const sourceName = (feed.title || new URL(feedUrl).hostname).replace(/ - .*$/, "").replace(/RSS.*$/i, "").trim() || "News";
      for (const entry of (feed.items || []).slice(0, 15)) {
        const title = (entry.title || "").trim();
        if (!title || existingTitles.has(title.toLowerCase().slice(0, 50))) continue;
        const text = (title + " " + (entry.contentSnippet || "")).toLowerCase();
        const matched = config.keywords.some(kw => text.includes(kw.toLowerCase()));
        if (!matched) continue;
        existingTitles.add(title.toLowerCase().slice(0, 50));
        newItems.push({
          id: "rss-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
          title: title.slice(0, 150), summary: (entry.contentSnippet || "").slice(0, 400),
          source: sourceName, url: entry.link || "",
          ts: new Date(entry.isoDate || entry.pubDate || Date.now()).getTime(),
          cat: null, region: null, impact: null, connections: [],
        });
      }
    } catch (err) { console.log("Feed error (" + feedUrl + "): " + err.message); }
  }

  // Telegram
  const tgItems = await scrapeTelegram(config.telegram, config.keywords);
  const tgNew = tgItems.filter(it => !existingTitles.has(it.title.toLowerCase().slice(0, 50)));
  tgNew.forEach(it => existingTitles.add(it.title.toLowerCase().slice(0, 50)));
  newItems.push(...tgNew);

  // Categorize and save
  if (newItems.length > 0) {
    const categorized = await categorizeItems(newItems);
    categorized.forEach(item => {
      computeItemConnections(item);
      insertNews.run(item.id, item.title, item.summary, item.source, item.url, item.cat, item.region, item.impact, JSON.stringify(item.connections), item.ts, topic.id);
    });
  }

  lastCrawl = new Date().toISOString();
  crawlRunning = false;
  const totalNow = getNewsCount.get(topic.id)?.count || 0;
  if (newItems.length > 0) console.log("[CRAWL] " + newItems.length + " new | Total: " + totalNow + " | " + new Date().toLocaleTimeString());
}

// ─── CATEGORIZATION ───
async function categorizeItems(items) {
  if (GROK_API_KEY && GROK_API_KEY !== "your_grok_api_key_here") {
    try {
      const titles = items.map(it => it.title).join("\n");
      const resp = await callGrok("Categorize each headline. Return ONLY a JSON array: [{\"cat\":\"CATEGORY\",\"region\":\"REGION\",\"impact\":1-10}]\n\nCategories: CONFLICT, ENERGY, MARKETS, DIPLOMACY, SANCTIONS, HUMANITARIAN, CYBER, CIVIL_UNREST\nRegions: Middle East, Europe, Asia-Pacific, North America, Africa, Latin America, Global\n\nHeadlines:\n" + titles + "\n\nONLY the JSON array.");
      if (resp) {
        const match = resp.match(/\[[\s\S]*\]/);
        if (match) {
          const cats = JSON.parse(match[0]);
          return items.map((it, i) => ({ ...it,
            cat: CATEGORIES.includes(cats[i]?.cat) ? cats[i].cat : heuristicCategory(it.title + " " + it.summary),
            region: cats[i]?.region || heuristicRegion(it.title + " " + it.summary),
            impact: Math.min(10, Math.max(1, cats[i]?.impact || 5)),
          }));
        }
      }
    } catch (e) { console.log("Grok categorize error:", e.message); }
  }
  return items.map(it => ({ ...it,
    cat: heuristicCategory(it.title + " " + it.summary),
    region: heuristicRegion(it.title + " " + it.summary),
    impact: heuristicImpact(it.title),
  }));
}

function heuristicCategory(text) {
  const t = text.toLowerCase();
  if (/oil|gas|energy|crude|brent|fuel|opec|pipeline|lng|barrel|petrol|diesel/.test(t)) return "ENERGY";
  if (/stock|market|dow|nasdaq|s.p|inflation|economy|gdp|trade|bank|rate|price|mortgage|recession|dollar|euro/.test(t)) return "MARKETS";
  if (/sanction|embargo|restrict|freeze|ban|blacklist|tariff/.test(t)) return "SANCTIONS";
  if (/protest|unrest|riot|demonstrat|opposition|revolt|march|rally/.test(t)) return "CIVIL_UNREST";
  if (/humanitarian|refugee|civilian|casualt|hospital|aid|displaced|famine|hunger/.test(t)) return "HUMANITARIAN";
  if (/cyber|hack|digital|internet|malware|ransomware/.test(t)) return "CYBER";
  if (/talk|negotiate|diplomat|ceasefire|treaty|summit|mediat|peace|deal|envoy|ambassador/.test(t)) return "DIPLOMACY";
  if (/strike|attack|military|missile|troops|bomb|kill|war|battle|navy|army|deploy/.test(t)) return "CONFLICT";
  return "CONFLICT";
}

function heuristicRegion(text) {
  const t = text.toLowerCase();
  if (/\u{1F1EE}\u{1F1F7}|\u{1F1EE}\u{1F1F1}|\u{1F1F1}\u{1F1E7}|\u{1F1EE}\u{1F1F6}|\u{1F1F8}\u{1F1E6}|\u{1F1E6}\u{1F1EA}|\u{1F1F6}\u{1F1E6}|\u{1F1F0}\u{1F1FC}|\u{1F1E7}\u{1F1ED}|\u{1F1FE}\u{1F1EA}/u.test(text)) return "Middle East";
  if (/\u{1F1FA}\u{1F1E6}|\u{1F1F7}\u{1F1FA}/u.test(text)) return "Europe";
  if (/\u{1F1FA}\u{1F1F8}/u.test(text)) return "North America";
  if (/\u{1F1E8}\u{1F1F3}|\u{1F1EF}\u{1F1F5}|\u{1F1EE}\u{1F1F3}|\u{1F1F0}\u{1F1F7}/u.test(text)) return "Asia-Pacific";
  if (/iran|iraq|israel|syria|lebanon|gulf|saudi|yemen|houthi|hormuz|qatar|uae|bahrain|kuwait|tehran|hezbollah/.test(t)) return "Middle East";
  if (/europe|eu |germany|france|uk |britain|nato|brussels/.test(t)) return "Europe";
  if (/china|japan|india|asia|taiwan|korea|pakistan|australia/.test(t)) return "Asia-Pacific";
  if (/us |trump|america|washington|pentagon|congress|wall street/.test(t)) return "North America";
  if (/africa|nigeria|ethiopia|sudan/.test(t)) return "Africa";
  return "Global";
}

function heuristicImpact(text) {
  const t = text.toLowerCase();
  if (/breaking|urgent|war|killed|nuclear|crisis|emergency|collapse|surge|crash/.test(t)) return 9;
  if (/attack|strike|sanctions|major|significant|record|historic/.test(t)) return 8;
  if (/tension|concern|warn|threat|escalat|deploy/.test(t)) return 7;
  return 6;
}

function computeItemConnections(item) {
  const text = (item.title + " " + item.summary).toLowerCase();
  const conns = new Set();
  const catKw = {
    CONFLICT: /military|attack|strike|war|troops|battle/,
    ENERGY: /oil|gas|energy|fuel|crude|pipeline/,
    MARKETS: /market|stock|inflation|economy|price|trade/,
    DIPLOMACY: /diplomat|negotiat|talk|peace|treaty/,
    SANCTIONS: /sanction|embargo|restrict|ban/,
    HUMANITARIAN: /civilian|death|refugee|hospital|aid/,
    CYBER: /cyber|hack|digital/,
    CIVIL_UNREST: /protest|unrest|riot/,
  };
  CATEGORIES.forEach(cat => { if (cat !== item.cat && catKw[cat]?.test(text)) conns.add(cat); });
  item.connections = [...conns].slice(0, 3);
}

// ─── GROK API ───
async function callGrok(prompt, systemPrompt) {
  if (!GROK_API_KEY || GROK_API_KEY === "your_grok_api_key_here") return null;
  try {
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + GROK_API_KEY },
      body: JSON.stringify({ model: "grok-3-mini-fast", messages, max_tokens: 2000, temperature: 0.3 }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) { console.log("Grok error:", e.message); return null; }
}

// ─── API ROUTES ───
app.get("/api/news", (req, res) => {
  const { region, limit, since } = req.query;
  const topicId = activeTopic?.id || "iran-war";
  let items;
  if (since) {
    items = getNewsSince.all(topicId, parseInt(since));
  } else {
    items = getNews.all(topicId, parseInt(limit) || 500);
  }
  items = items.map(n => ({ ...n, connections: JSON.parse(n.connections || "[]") }));
  if (region && region !== "All") items = items.filter(n => n.region === region || n.region === "Global");
  const total = getNewsCount.get(topicId)?.count || 0;
  res.json({ items, lastCrawl, activeTopic: activeTopic?.id, total });
});

app.get("/api/topics", (req, res) => {
  const presets = Object.entries(PRESET_TOPICS).map(([id, t]) => ({ id, name: t.name, type: "preset" }));
  const custom = customTopics.map(t => ({ id: t.id, name: t.name, type: "custom" }));
  res.json({ topics: [...presets, ...custom], active: activeTopic?.id || null });
});

app.post("/api/topics/activate", async (req, res) => {
  const { topicId } = req.body;
  if (PRESET_TOPICS[topicId]) {
    activeTopic = { id: topicId, ...PRESET_TOPICS[topicId] };
  } else {
    const ct = customTopics.find(t => t.id === topicId);
    if (ct) activeTopic = ct;
  }
  crawlFeeds(activeTopic);
  res.json({ ok: true, topic: activeTopic?.name });
});

app.post("/api/topics/custom", (req, res) => {
  const { name, keywords } = req.body;
  if (!name || !keywords || !keywords.length) return res.status(400).json({ error: "Need name and keywords" });
  const id = "custom-" + Date.now();
  const topic = {
    id, name, keywords: keywords.map(k => k.toLowerCase().trim()),
    feeds: [
      "https://feeds.bbci.co.uk/news/world/rss.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
      "https://www.aljazeera.com/xml/rss/all.xml",
      "https://www.theguardian.com/world/rss",
      "https://news.google.com/rss/search?q=" + encodeURIComponent(keywords.join("+")) + "+when:1d&hl=en-US&gl=US&ceid=US:en",
    ],
    telegram: ["myLordBebo", "disclosetv"],
    type: "custom",
  };
  customTopics.push(topic);
  res.json({ ok: true, topic });
});

// ─── WORKSPACE: Collect from a start date ───
app.post("/api/workspace/collect", async (req, res) => {
  const { startDate, topicId } = req.body;
  const config = PRESET_TOPICS[topicId] || customTopics.find(t => t.id === topicId);
  if (!config) return res.status(400).json({ error: "Unknown topic" });

  const start = new Date(startDate);
  const wsId = "ws-" + Date.now();
  insertWorkspace.run(wsId, config.name + " from " + startDate, topicId, startDate, Date.now());

  // Fetch historical news
  res.json({ ok: true, wsId, message: "Collecting historical news..." });

  // Do the heavy lifting async
  const historical = await fetchHistoricalNews(config.keywords, start);
  if (historical.length > 0) {
    const categorized = await categorizeItems(historical);
    const existingTitles = new Set();
    const existing = getNews.all(topicId, 5000);
    existing.forEach(n => existingTitles.add(n.title.toLowerCase().slice(0, 50)));
    let added = 0;
    categorized.forEach(item => {
      if (existingTitles.has(item.title.toLowerCase().slice(0, 50))) return;
      computeItemConnections(item);
      insertNews.run(item.id, item.title, item.summary, item.source, item.url, item.cat, item.region, item.impact, JSON.stringify(item.connections), item.ts, topicId);
      added++;
    });
    console.log("[WORKSPACE] Collected " + added + " historical items since " + startDate);
  }
});

app.get("/api/workspaces", (req, res) => {
  res.json({ workspaces: getWorkspaces.all() });
});

// ─── AI ENDPOINTS ───
app.post("/api/ai/summary", async (req, res) => {
  const { region } = req.body;
  const today = new Date().toDateString();
  if (aiUsageToday.date !== today) aiUsageToday = { date: today, count: 0 };
  if (aiUsageToday.count >= 20) return res.json({ text: "Daily limit reached.", limited: true });
  const topicId = activeTopic?.id || "iran-war";
  let items = getNews.all(topicId, 30).map(n => ({ ...n, connections: JSON.parse(n.connections || "[]") }));
  if (region && region !== "All") items = items.filter(n => n.region === region || n.region === "Global");
  const headlines = items.slice(0, 25).map(n => "[" + n.cat + "] " + n.title + " — " + n.source).join("\n");
  const result = await callGrok("Current tracked news (" + (region || "all regions") + "):\n\n" + headlines + "\n\nProvide:\n1. SITUATION SUMMARY\n2. NEW DEVELOPMENTS\n3. HOW EVENTS CONNECT — cascade chains\n4. KEY TAKEAWAYS — 5 points\n\nBe specific. Professional intel briefing.", "You are a senior intelligence analyst. Terse, professional, factual.");
  aiUsageToday.count++;
  res.json({ text: result || "Grok unavailable. Try Puter.js button.", remaining: 20 - aiUsageToday.count });
});

app.post("/api/ai/predict", async (req, res) => {
  const { region } = req.body;
  const today = new Date().toDateString();
  if (aiUsageToday.date !== today) aiUsageToday = { date: today, count: 0 };
  if (aiUsageToday.count >= 20) return res.json({ text: "Daily limit reached.", limited: true });
  const topicId = activeTopic?.id || "iran-war";
  let items = getNews.all(topicId, 30).map(n => ({ ...n, connections: JSON.parse(n.connections || "[]") }));
  if (region && region !== "All") items = items.filter(n => n.region === region || n.region === "Global");
  const headlines = items.slice(0, 25).map(n => "[" + n.cat + "|" + n.region + "] " + n.title + " (impact:" + n.impact + ")").join("\n");
  const result = await callGrok("Events:\n\n" + headlines + "\n\nStructured prediction:\n\n▸ SHORT-TERM (48-72h)\n- Military:\n- Diplomatic:\n- Energy/Markets:\n\n▸ MEDIUM-TERM (1-2 weeks)\n- Escalation:\n- Economic cascade:\n- Humanitarian:\n\n▸ SCENARIO MATRIX\n- A [%]: [name]\n- B [%]: [name]\n- C [%]: [name]\n\n▸ WILDCARDS\n\n▸ CONFIDENCE:", "Geopolitical forecasting analyst. Specific numbers, names, dates. No markdown.");
  aiUsageToday.count++;
  res.json({ text: result || "Grok unavailable. Try Puter.js.", remaining: 20 - aiUsageToday.count });
});

app.get("/api/ai/status", (req, res) => {
  const today = new Date().toDateString();
  if (aiUsageToday.date !== today) aiUsageToday = { date: today, count: 0 };
  res.json({ used: aiUsageToday.count, limit: 20, remaining: 20 - aiUsageToday.count });
});

// ─── CRAWL LOOP ───
let crawlTimer = null;
function startCrawlLoop() {
  if (crawlTimer) clearInterval(crawlTimer);
  crawlTimer = setInterval(() => { if (activeTopic) crawlFeeds(activeTopic); }, CRAWL_INTERVAL);
}

// ─── START ───
app.listen(PORT, () => {
  console.log("\n" +
    "\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\n" +
    "\u2551       NEXUS INTEL \u2014 Intelligence Server      \u2551\n" +
    "\u2551\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2551\n" +
    "\u2551  Dashboard: http://localhost:" + PORT + "             \u2551\n" +
    "\u2551  API:       http://localhost:" + PORT + "/api/news    \u2551\n" +
    "\u2551  Grok AI:   " + (GROK_API_KEY && GROK_API_KEY !== "your_grok_api_key_here" ? "\u2713 Connected" : "\u2717 Not configured") + "                     \u2551\n" +
    "\u2551  Database:  \u2713 SQLite (persistent)            \u2551\n" +
    "\u2551  Crawl:     Every " + CRAWL_INTERVAL / 1000 + "s                          \u2551\n" +
    "\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\n");
  activeTopic = { id: "iran-war", ...PRESET_TOPICS["iran-war"] };
  crawlFeeds(activeTopic);
  startCrawlLoop();
});
