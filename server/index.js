const express = require("express");
const RSSParser = require("rss-parser");
const fetch = require("node-fetch");
const path = require("path");

// ─── CONFIG ───
const PORT = process.env.PORT || 3000;
const CRAWL_INTERVAL = (parseInt(process.env.CRAWL_INTERVAL) || 30) * 1000;
const MAX_NEWS = parseInt(process.env.MAX_NEWS_ITEMS) || 200;
// Optional: Grok API key for server-side AI. If not set, AI runs client-side via Puter.js (free)
const GROK_API_KEY = process.env.GROK_API_KEY || "";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const rssParser = new RSSParser({
  timeout: 8000,
  headers: { "User-Agent": "NexusIntel/1.0" },
});

// ─── STATE ───
let newsItems = [];
let activeTopic = null;
let customTopics = [];
let lastCrawl = null;
let crawlRunning = false;
let aiUsageToday = { date: "", count: 0 };

const CATEGORIES = [
  "CONFLICT","ENERGY","MARKETS","DIPLOMACY",
  "SANCTIONS","HUMANITARIAN","CYBER","CIVIL_UNREST"
];

// ─── PRESET TOPICS ───
const PRESET_TOPICS = {
  "iran-war": {
    name: "2026 Iran War",
    keywords: ["iran war","iran conflict","strait of hormuz","iran oil","iran missiles","hezbollah","irgc","tehran strikes","iran ceasefire","operation epic fury"],
    feeds: [
      "https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml",
      "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml",
      "https://www.aljazeera.com/xml/rss/all.xml",
      "https://feeds.reuters.com/reuters/worldNews",
      "https://rss.cnn.com/rss/edition_world.rss",
      "https://www.theguardian.com/world/middleeast/rss",
      "https://www.france24.com/en/middle-east/rss",
    ],
  },
  "ukraine-russia": {
    name: "Ukraine / Russia",
    keywords: ["ukraine","russia","zelensky","putin","donbas","crimea","nato","kyiv","kharkiv","frontline"],
    feeds: [
      "https://feeds.bbci.co.uk/news/world/europe/rss.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/Europe.xml",
      "https://feeds.reuters.com/reuters/worldNews",
      "https://www.aljazeera.com/xml/rss/all.xml",
      "https://www.theguardian.com/world/russia/rss",
    ],
  },
  "global-economy": {
    name: "Global Economy",
    keywords: ["inflation","fed rate","oil prices","stock market","recession","gdp","bond","treasury","central bank","trade war","tariff"],
    feeds: [
      "https://feeds.reuters.com/reuters/businessNews",
      "https://feeds.bbci.co.uk/news/business/rss.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
      "https://www.ft.com/?format=rss",
      "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    ],
  },
  "china-taiwan": {
    name: "China / Taiwan",
    keywords: ["china","taiwan","xi jinping","south china sea","strait","pla","semiconductor","chips","asean","indo-pacific"],
    feeds: [
      "https://feeds.bbci.co.uk/news/world/asia/rss.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/AsiaPacific.xml",
      "https://www.aljazeera.com/xml/rss/all.xml",
      "https://feeds.reuters.com/reuters/worldNews",
    ],
  },
  "ai-tech": {
    name: "AI & Technology",
    keywords: ["artificial intelligence","openai","google ai","deepmind","regulation","chips","nvidia","llm","agi","autonomous"],
    feeds: [
      "https://feeds.arstechnica.com/arstechnica/technology-lab",
      "https://www.theverge.com/rss/index.xml",
      "https://feeds.reuters.com/reuters/technologyNews",
      "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
    ],
  },
};

// ─── RSS CRAWLING ───
async function crawlFeeds(topic) {
  if (crawlRunning) return;
  crawlRunning = true;
  const config = PRESET_TOPICS[topic?.id] || topic;
  if (!config || !config.feeds || !config.keywords) {
    crawlRunning = false;
    return;
  }

  const newItems = [];
  const existingTitles = new Set(newsItems.map(n => n.title.toLowerCase().slice(0, 50)));

  for (const feedUrl of config.feeds) {
    try {
      const feed = await rssParser.parseURL(feedUrl);
      const sourceName = feed.title || new URL(feedUrl).hostname;
      
      for (const entry of (feed.items || []).slice(0, 15)) {
        const title = (entry.title || "").trim();
        if (!title || existingTitles.has(title.toLowerCase().slice(0, 50))) continue;
        
        const text = `${title} ${entry.contentSnippet || ""} ${entry.content || ""}`.toLowerCase();
        const matched = config.keywords.some(kw => text.includes(kw.toLowerCase()));
        if (!matched) continue;

        existingTitles.add(title.toLowerCase().slice(0, 50));
        newItems.push({
          id: `rss-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
          title: title.slice(0, 120),
          summary: (entry.contentSnippet || "").slice(0, 200),
          source: sourceName.replace(/ - .*$/, "").replace(/RSS.*$/i, "").trim() || "News",
          url: entry.link || "",
          pubDate: entry.isoDate || entry.pubDate || new Date().toISOString(),
          ts: new Date(entry.isoDate || entry.pubDate || Date.now()).getTime(),
          // Will be categorized by AI or heuristic
          cat: null,
          region: null,
          impact: null,
          connections: [],
        });
      }
    } catch (err) {
      console.log(`Feed error (${feedUrl}): ${err.message}`);
    }
  }

  // Categorize new items
  if (newItems.length > 0) {
    const categorized = await categorizeItems(newItems);
    newsItems = [...categorized, ...newsItems].slice(0, MAX_NEWS);
    // Re-compute connections
    computeConnections();
  }

  lastCrawl = new Date().toISOString();
  crawlRunning = false;
  console.log(`[CRAWL] ${newItems.length} new items | Total: ${newsItems.length} | ${new Date().toLocaleTimeString()}`);
}

// ─── CATEGORIZATION ───
async function categorizeItems(items) {
  // Try Grok first, fall back to heuristic
  if (GROK_API_KEY && GROK_API_KEY !== "your_grok_api_key_here") {
    try {
      const titles = items.map(it => it.title).join("\n");
      const resp = await callGrok(
        `Categorize each news headline. Return ONLY a JSON array with one object per headline: {"cat":"CATEGORY","region":"REGION","impact":1-10}

Categories: CONFLICT, ENERGY, MARKETS, DIPLOMACY, SANCTIONS, HUMANITARIAN, CYBER, CIVIL_UNREST
Regions: Middle East, Europe, Asia-Pacific, North America, Africa, Latin America, Global

Headlines:\n${titles}\n\nReturn ONLY the JSON array, no other text.`
      );
      if (resp) {
        const match = resp.match(/\[[\s\S]*\]/);
        if (match) {
          const cats = JSON.parse(match[0]);
          return items.map((it, i) => ({
            ...it,
            cat: CATEGORIES.includes(cats[i]?.cat) ? cats[i].cat : heuristicCategory(it.title),
            region: cats[i]?.region || heuristicRegion(it.title),
            impact: Math.min(10, Math.max(1, cats[i]?.impact || 5)),
          }));
        }
      }
    } catch (e) {
      console.log("Grok categorize error:", e.message);
    }
  }
  
  // Heuristic fallback
  return items.map(it => ({
    ...it,
    cat: heuristicCategory(it.title + " " + it.summary),
    region: heuristicRegion(it.title + " " + it.summary),
    impact: heuristicImpact(it.title),
  }));
}

function heuristicCategory(text) {
  const t = text.toLowerCase();
  if (/strike|attack|military|missile|troops|bomb|kill|war|battle|navy|army|deploy/.test(t)) return "CONFLICT";
  if (/oil|gas|energy|crude|brent|fuel|opec|pipeline|lng|barrel/.test(t)) return "ENERGY";
  if (/stock|market|dow|nasdaq|s&p|inflation|economy|gdp|trade|bank|rate|price/.test(t)) return "MARKETS";
  if (/talk|negotiate|diplomat|ceasefire|treaty|summit|mediat|peace|sanction/.test(t)) return "DIPLOMACY";
  if (/sanction|embargo|restrict|freeze|ban|blacklist/.test(t)) return "SANCTIONS";
  if (/humanitarian|refugee|civilian|casualt|death|hospital|aid|displaced|crisis/.test(t)) return "HUMANITARIAN";
  if (/cyber|hack|digital|internet|malware|ransomware/.test(t)) return "CYBER";
  if (/protest|unrest|riot|demonstrat|opposition|revolt/.test(t)) return "CIVIL_UNREST";
  return "CONFLICT";
}

function heuristicRegion(text) {
  const t = text.toLowerCase();
  if (/iran|iraq|israel|syria|lebanon|gulf|saudi|yemen|houthi|hormuz|qatar|uae|bahrain|kuwait|tehran|hezbollah/.test(t)) return "Middle East";
  if (/europe|eu |germany|france|uk |britain|nato|brussels|merz|macron/.test(t)) return "Europe";
  if (/china|japan|india|asia|taiwan|korea|pakistan|australia|asean/.test(t)) return "Asia-Pacific";
  if (/us |trump|america|washington|pentagon|congress|biden|wall street/.test(t)) return "North America";
  if (/africa|nigeria|ethiopia|sudan|sahel/.test(t)) return "Africa";
  if (/brazil|mexico|latin|venezuela|colombia/.test(t)) return "Latin America";
  return "Global";
}

function heuristicImpact(text) {
  const t = text.toLowerCase();
  if (/breaking|urgent|war|killed|nuclear|crisis|emergency|collapse|surge|crash/.test(t)) return 9;
  if (/attack|strike|sanctions|major|significant|record|historic/.test(t)) return 8;
  if (/tension|concern|warn|threat|escalat|deploy/.test(t)) return 7;
  return 6;
}

// ─── CONNECTION COMPUTATION ───
function computeConnections() {
  // For each item, find which other categories it relates to
  newsItems.forEach(item => {
    const text = `${item.title} ${item.summary}`.toLowerCase();
    const conns = new Set();
    
    CATEGORIES.forEach(cat => {
      if (cat === item.cat) return;
      // Check if item's text mentions themes from other categories
      const catKeywords = {
        CONFLICT: /military|attack|strike|war|troops|battle/,
        ENERGY: /oil|gas|energy|fuel|crude|pipeline/,
        MARKETS: /market|stock|inflation|economy|price|trade/,
        DIPLOMACY: /diplomat|negotiat|talk|peace|treaty/,
        SANCTIONS: /sanction|embargo|restrict|ban/,
        HUMANITARIAN: /civilian|death|refugee|hospital|aid/,
        CYBER: /cyber|hack|digital/,
        CIVIL_UNREST: /protest|unrest|riot/,
      };
      if (catKeywords[cat]?.test(text)) conns.add(cat);
    });
    
    item.connections = [...conns].slice(0, 3);
  });
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
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-3-mini-fast",
        messages,
        max_tokens: 2000,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.log("Grok error:", e.message);
    return null;
  }
}

// ─── API ROUTES ───

// Get all news
app.get("/api/news", (req, res) => {
  const { region, cat, limit } = req.query;
  let items = [...newsItems];
  if (region && region !== "All") items = items.filter(n => n.region === region || n.region === "Global");
  if (cat) items = items.filter(n => n.cat === cat);
  if (limit) items = items.slice(0, parseInt(limit));
  res.json({ items, lastCrawl, activeTopic, total: newsItems.length });
});

// Get topics
app.get("/api/topics", (req, res) => {
  const presets = Object.entries(PRESET_TOPICS).map(([id, t]) => ({ id, name: t.name, type: "preset" }));
  const custom = customTopics.map(t => ({ id: t.id, name: t.name, type: "custom" }));
  res.json({ topics: [...presets, ...custom], active: activeTopic?.id || null });
});

// Set active topic
app.post("/api/topics/activate", (req, res) => {
  const { topicId } = req.body;
  if (PRESET_TOPICS[topicId]) {
    activeTopic = { id: topicId, ...PRESET_TOPICS[topicId] };
  } else {
    const ct = customTopics.find(t => t.id === topicId);
    if (ct) activeTopic = ct;
  }
  newsItems = []; // Clear for new topic
  crawlFeeds(activeTopic);
  res.json({ ok: true, topic: activeTopic?.name });
});

// Create custom topic
app.post("/api/topics/custom", (req, res) => {
  const { name, keywords } = req.body;
  if (!name || !keywords || !keywords.length) return res.status(400).json({ error: "Need name and keywords" });
  
  const id = `custom-${Date.now()}`;
  const topic = {
    id,
    name,
    keywords: keywords.map(k => k.toLowerCase().trim()),
    feeds: [
      // Use major general news feeds for custom topics
      "https://feeds.reuters.com/reuters/worldNews",
      "https://feeds.bbci.co.uk/news/world/rss.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
      "https://www.aljazeera.com/xml/rss/all.xml",
      "https://www.theguardian.com/world/rss",
      "https://feeds.reuters.com/reuters/businessNews",
      "https://rss.cnn.com/rss/edition_world.rss",
    ],
    type: "custom",
  };
  customTopics.push(topic);
  res.json({ ok: true, topic });
});

// Delete custom topic
app.delete("/api/topics/custom/:id", (req, res) => {
  customTopics = customTopics.filter(t => t.id !== req.params.id);
  if (activeTopic?.id === req.params.id) activeTopic = null;
  res.json({ ok: true });
});

// AI Summary
app.post("/api/ai/summary", async (req, res) => {
  const { region } = req.body;
  const today = new Date().toDateString();
  if (aiUsageToday.date !== today) aiUsageToday = { date: today, count: 0 };
  if (aiUsageToday.count >= 10) return res.json({ text: "Daily AI limit reached (10/day). Resets at midnight.", limited: true });
  
  const items = region && region !== "All" 
    ? newsItems.filter(n => n.region === region || n.region === "Global").slice(0, 25)
    : newsItems.slice(0, 25);
  
  const headlines = items.map(n => `[${n.cat}] ${n.title} — ${n.source}`).join("\n");
  
  const result = await callGrok(
    `Current tracked news (${region || "all regions"}):\n\n${headlines}\n\nProvide:\n1. SITUATION SUMMARY — comprehensive overview\n2. NEW DEVELOPMENTS — what changed in last hours\n3. HOW EVENTS CONNECT — cascade chains and escalation patterns\n4. KEY TAKEAWAYS — 5 critical points\n\nBe specific, cite actual events.`,
    "You are a senior intelligence analyst producing classified briefings. Terse, professional, factual. Reference specific events by name."
  );
  
  aiUsageToday.count++;
  res.json({ text: result || "AI unavailable. Check your GROK_API_KEY in .env", remaining: 10 - aiUsageToday.count });
});

// AI Prediction
app.post("/api/ai/predict", async (req, res) => {
  const { region } = req.body;
  const today = new Date().toDateString();
  if (aiUsageToday.date !== today) aiUsageToday = { date: today, count: 0 };
  if (aiUsageToday.count >= 10) return res.json({ text: "Daily AI limit reached (10/day).", limited: true });
  
  const items = region && region !== "All"
    ? newsItems.filter(n => n.region === region || n.region === "Global").slice(0, 25)
    : newsItems.slice(0, 25);
  
  const headlines = items.map(n => `[${n.cat}|${n.region}] ${n.title} (impact:${n.impact})`).join("\n");
  
  const result = await callGrok(
    `Based on these events:\n\n${headlines}\n\nProvide a STRUCTURED prediction:\n\n▸ SHORT-TERM (48-72h)\n- Military:\n- Diplomatic:\n- Energy/Markets (specific prices):\n\n▸ MEDIUM-TERM (1-2 weeks)\n- Escalation trajectory:\n- Economic cascade (oil, stocks, currencies):\n- Humanitarian:\n\n▸ SCENARIO MATRIX\n- Scenario A [%]: [name] — [desc]\n- Scenario B [%]: [name] — [desc]\n- Scenario C [%]: [name] — [desc]\n\n▸ WILDCARDS\n- 3 black swan events\n\n▸ CONFIDENCE: [level + reasoning]`,
    "You are a geopolitical forecasting analyst at a top intelligence agency. Specific numbers, named actors, dates. No hedging — commit to assessments."
  );
  
  aiUsageToday.count++;
  res.json({ text: result || "AI unavailable. Check GROK_API_KEY.", remaining: 10 - aiUsageToday.count });
});

// AI usage status
app.get("/api/ai/status", (req, res) => {
  const today = new Date().toDateString();
  if (aiUsageToday.date !== today) aiUsageToday = { date: today, count: 0 };
  res.json({ used: aiUsageToday.count, limit: 10, remaining: 10 - aiUsageToday.count });
});

// ─── CRAWL LOOP ───
let crawlTimer = null;
function startCrawlLoop() {
  if (crawlTimer) clearInterval(crawlTimer);
  crawlTimer = setInterval(() => {
    if (activeTopic) crawlFeeds(activeTopic);
  }, CRAWL_INTERVAL);
}

// ─── START ───
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║       NEXUS INTEL — Intelligence Server      ║
║──────────────────────────────────────────────║
║  Dashboard: http://localhost:${PORT}             ║
║  API:       http://localhost:${PORT}/api/news    ║
║  Grok AI:   ${GROK_API_KEY && GROK_API_KEY !== "your_grok_api_key_here" ? "✓ Connected" : "✗ Not configured"}                     ║
║  Crawl:     Every ${CRAWL_INTERVAL/1000}s                          ║
╚══════════════════════════════════════════════╝
  `);
  
  // Auto-start with Iran War topic
  activeTopic = { id: "iran-war", ...PRESET_TOPICS["iran-war"] };
  crawlFeeds(activeTopic);
  startCrawlLoop();
});
