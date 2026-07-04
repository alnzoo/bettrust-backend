// ─── BETTRUST BACKEND SERVER ──────────────────────────────────────
// Serveur Node.js/Express à déployer sur Render.com
// Gère : API Anthropic (IA) + Stripe (paiements)
// Les clés secrètes restent ici, jamais dans le code front-end.

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// CORS — autorise ton site Netlify à appeler ce serveur
app.use(cors({
  origin: [
    "https://bettrust-app.netlify.app",
    "https://prono-betwise.netlify.app",
    "http://localhost:3000",
    "http://localhost:5173",
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// ── VARIABLES D'ENVIRONNEMENT ──────────────────────────────────────
// Ces valeurs sont à renseigner dans les "Environment Variables" de Render
// (jamais dans ce fichier en clair)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // sk-ant-...
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // sk_live_...
const ODDS_API_KEY      = process.env.ODDS_API_KEY;       // clé the-odds-api.com
const PORT              = process.env.PORT || 3001;

// ── HEALTH CHECK ───────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "BetTrust API OK", version: "1.0.0" });
});

// ── ANTHROPIC — ANALYSE IA ─────────────────────────────────────────
// Proxy sécurisé : reçoit le prompt du front, appelle Anthropic, renvoie la réponse
app.post("/api/analyze", async (req, res) => {
  const { messages, system, max_tokens = 1500, useWebSearch = true } = req.body;

  if (!messages || !system) {
    return res.status(400).json({ error: "messages et system sont requis" });
  }

  try {
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens,
      system,
      messages,
    };

    if (useWebSearch) {
      body.tools = [{ type: "web_search_20250305", name: "web_search" }];
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Anthropic error:", data);
      return res.status(response.status).json({ error: data.error?.message || "Erreur Anthropic" });
    }

    const text = data.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    res.json({ text });
  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({ error: "Erreur serveur lors de l'analyse IA" });
  }
});

// ── STRIPE — CRÉER SESSION DE PAIEMENT ─────────────────────────────
app.post("/api/create-checkout-session", async (req, res) => {
  const { email, interval = "month", trialDays = 4 } = req.body;

  if (!email) {
    return res.status(400).json({ error: "email est requis" });
  }

  // Price IDs fixes créés dans le dashboard Stripe
  const PRICE_IDS = {
    month: "price_1TpF3nAxeR2E4XmUzFMC7iEQ", // 24,90€/mois
        year:  "price_1TpKCPAxeR2E4XmUvXoChDm0",

  };

  const priceId = PRICE_IDS[interval] || PRICE_IDS.month;

  try {
    const Stripe = require("stripe");
    const stripe = Stripe(STRIPE_SECRET_KEY);

    const customers = await stripe.customers.list({ email, limit: 1 });
    const customer = customers.data.length > 0
      ? customers.data[0]
      : await stripe.customers.create({ email });

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      subscription_data: {
        trial_period_days: trialDays,
      },
      success_url: "https://bettrust-app.netlify.app?payment=success",
      cancel_url:  "https://bettrust-app.netlify.app?payment=cancelled",
    });

    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Erreur lors de la création du paiement" });
  }
});

// ── THE ODDS API — MATCHS EN TEMPS RÉEL ───────────────────────────
app.get("/api/odds/:sport", async (req, res) => {
  const { sport } = req.params;

  const SPORT_KEYS = {
    tennis: [
      "tennis_atp_wimbledon","tennis_wta_wimbledon",
      "tennis_atp_french_open","tennis_wta_french_open",
      "tennis_atp_us_open","tennis_wta_us_open",
      "tennis_atp_australian_open","tennis_wta_australian_open",
    ],
    football: [
      "soccer_france_ligue_one","soccer_france_ligue_two",
      "soccer_spain_la_liga","soccer_epl",
      "soccer_germany_bundesliga","soccer_italy_serie_a",
      "soccer_portugal_primeira_liga","soccer_netherlands_eredivisie",
      "soccer_belgium_first_div","soccer_uefa_champs_league",
      "soccer_uefa_europa_league",
    ],
  };

  const keys = SPORT_KEYS[sport];
  if (!keys) return res.status(400).json({ error: "Sport non supporté" });

  try {
    const results = [];
    for (const key of keys) {
      try {
        const url = `https://api.the-odds-api.com/v4/sports/${key}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&bookmakers=winamax,betclic,unibet,bet365,pinnacle`;
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data)) results.push(...data);
        }
      } catch(e) {}
    }
    res.json({ matches: results, count: results.length });
  } catch (err) {
    console.error("Odds API error:", err);
    res.status(500).json({ error: "Erreur Odds API" });
  }
});

// ── DÉMARRAGE ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ BetTrust API démarrée sur le port ${PORT}`);
  console.log(`   Anthropic: ${ANTHROPIC_API_KEY ? "✅ clé présente" : "❌ clé manquante"}`);
  console.log(`   Stripe:    ${STRIPE_SECRET_KEY ? "✅ clé présente" : "❌ clé manquante"}`);
  console.log(`   Odds API:  ${ODDS_API_KEY      ? "✅ clé présente" : "❌ clé manquante"}`);
});
