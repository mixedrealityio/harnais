// contextWindow (→ contextLength) : entrée+sortie ; maxOutput envoyé en max_tokens (Anthropic, DeepSeek, Z.ai), sinon 16 384
// maxOutput : sans lui DeepSeek et Z.ai coupent plus tôt (8 000 et 65 536), Anthropic l'exige
const MODELS_DATA = {
  "text": [
    { "id": "gpt-6-astra",                 "label": "GPT-6 Astra",       "editeur": "openai",    "inputPer1M": 10,    "outputPer1M": 50,  "longContextThreshold": 272001, "longInputPer1M": 20, "longOutputPer1M": 75, "contextWindow": 1050000, "maxOutput": 128000, "description": "Modèle OpenAI le plus puissant pour les tâches complexes. Au-delà de 272 000 jetons d'entrée, le tarif passe à 20 $ / 75 $ par million." },
    { "id": "gpt-6.1-sol",                 "label": "GPT-6.1 Sol",       "editeur": "openai",    "inputPer1M": 2,     "outputPer1M": 10,  "longContextThreshold": 272001, "longInputPer1M": 4, "longOutputPer1M": 15, "contextWindow": 1050000, "maxOutput": 128000, "description": "Modèle OpenAI proche d'Astra, à coût réduit. Au-delà de 272 000 jetons d'entrée, le tarif passe à 4 $ / 15 $ par million." },
    { "id": "gpt-6.1-terra",               "label": "GPT-6.1 Terra",     "editeur": "openai",    "inputPer1M": 1,     "outputPer1M": 5,   "longContextThreshold": 272001, "longInputPer1M": 2, "longOutputPer1M": 7.5, "contextWindow": 1050000, "maxOutput": 128000, "description": "Modèle OpenAI équilibré entre intelligence et coût, moitié prix de GPT-6.1 Sol. Au-delà de 272 000 jetons d'entrée, le tarif passe à 2 $ / 7,50 $ par million." },
    { "id": "gpt-6-luna",                 "label": "GPT-6 Luna",        "editeur": "openai",    "inputPer1M": 0.1,   "outputPer1M": 0.5, "longContextThreshold": 272001, "longInputPer1M": 0.2, "longOutputPer1M": 0.75, "contextWindow": 1050000, "maxOutput": 128000, "description": "Modèle OpenAI rapide et très économique. Au-delà de 272 000 jetons d'entrée, le tarif passe à 0,20 $ / 0,75 $ par million." },
    { "id": "gpt-5.6-sol",                 "label": "GPT-5.6 Sol",       "editeur": "openai",    "inputPer1M": 5,     "outputPer1M": 30,  "contextWindow": 1050000, "maxOutput": 128000, "description": "Modèle frontière d'OpenAI pour le travail professionnel complexe (contexte 1M)." },
    { "id": "gpt-5.6-terra",               "label": "GPT-5.6 Terra",     "editeur": "openai",    "inputPer1M": 2.5,   "outputPer1M": 15,  "contextWindow": 1050000, "maxOutput": 128000, "description": "GPT-5.6 équilibré entre intelligence et coût." },
    { "id": "gpt-5.6-luna",                "label": "GPT-5.6 Luna",      "editeur": "openai",    "inputPer1M": 1,     "outputPer1M": 6,   "contextWindow": 1050000, "maxOutput": 128000, "description": "GPT-5.6 optimisé pour les usages sensibles au coût." },
    { "id": "gpt-5.5-2026-04-23",          "label": "GPT-5.5",           "editeur": "openai",    "inputPer1M": 5,     "outputPer1M": 30,  "contextWindow": 1050000, "maxOutput": 128000, "description": "Dernière génération OpenAI, performances de pointe en raisonnement et créativité." },
    { "id": "gpt-5.4-2026-03-05",          "label": "GPT-5.4",           "editeur": "openai",    "inputPer1M": 2.5,   "outputPer1M": 15,  "contextWindow": 1050000, "maxOutput": 128000, "description": "Dernière génération OpenAI, performances de pointe en raisonnement et créativité." },
    { "id": "gpt-5.2-2025-12-11",          "label": "GPT-5.2",           "editeur": "openai",    "inputPer1M": 1.75,  "outputPer1M": 14, "contextWindow": 400000, "maxOutput": 128000, "description": "Modèle avancé avec raisonnement amélioré et large fenêtre de contexte." },
    { "id": "gpt-4.1-2025-04-14",         "label": "GPT-4.1",            "editeur": "openai",    "inputPer1M": 2,     "outputPer1M": 8,  "contextWindow": 1047576, "maxOutput": 32768, "description": "Modèle phare d'OpenAI, excellent en codage et suivi d'instructions complexes." },
    { "id": "gpt-5.4-mini-2026-03-17",     "label": "GPT-5.4 Mini",      "editeur": "openai",    "inputPer1M": 0.75,  "outputPer1M": 4.5,"contextWindow": 400000, "maxOutput": 128000, "description": "Modèle mini le plus puissant d'OpenAI, excellent pour codage, usage d'outils et sous-agents." },
    { "id": "gpt-5.4-nano-2026-03-17",     "label": "GPT-5.4 Nano",      "editeur": "openai",    "inputPer1M": 0.2,   "outputPer1M": 1.25,"contextWindow": 400000, "maxOutput": 128000, "description": "Version ultra-rapide et économique de GPT-5.4, idéale pour classification, extraction et sous-agents." },
    { "id": "claude-fable-5-1",            "label": "Claude Fable 5.1",  "editeur": "anthropic", "inputPer1M": 10,    "outputPer1M": 50, "contextWindow": 1000000, "maxOutput": 128000, "description": "Modèle Anthropic le plus puissant pour les tâches longues et très complexes." },
    { "id": "claude-opus-5-5",             "label": "Claude Opus 5.5",   "editeur": "anthropic", "inputPer1M": 4,     "outputPer1M": 20, "contextWindow": 1000000, "maxOutput": 128000, "description": "Modèle Anthropic recommandé pour la plupart des travaux complexes et de longue durée." },
    { "id": "claude-sonnet-5-5",           "label": "Claude Sonnet 5.5", "editeur": "anthropic", "inputPer1M": 2,     "outputPer1M": 10, "contextWindow": 1000000, "maxOutput": 128000, "description": "Modèle Anthropic rapide, avec un excellent équilibre entre qualité et coût." },
    { "id": "claude-haiku-5-5",            "label": "Claude Haiku 5.5",  "editeur": "anthropic", "inputPer1M": 0.1,   "outputPer1M": 0.5, "longContextThreshold": 100001, "longInputPer1M": 0.5, "longOutputPer1M": 2.5, "contextWindow": 1000000, "maxOutput": 128000, "description": "Modèle Anthropic le plus rapide et le plus économique, pour les tâches courantes et les réponses courtes. Au-delà de 100 000 jetons d'entrée, le tarif passe à 0,50 $ / 2,50 $ par million." },
    { "id": "claude-fable-5",              "label": "Claude Fable 5",    "editeur": "anthropic", "inputPer1M": 10,    "outputPer1M": 50, "contextWindow": 1000000, "maxOutput": 128000, "description": "Nouvelle classe d'intelligence d'Anthropic (Claude 5), pensée pour les agents de longue durée et les tâches les plus complexes." },
    { "id": "claude-opus-4-8",             "label": "Claude Opus 4.8",   "editeur": "anthropic", "inputPer1M": 5,     "outputPer1M": 25, "contextWindow": 1000000, "maxOutput": 128000, "description": "Pour le codage agentique complexe et le travail en entreprise." },
    { "id": "claude-sonnet-5",             "label": "Claude Sonnet 5",   "editeur": "anthropic", "inputPer1M": 2,     "outputPer1M": 10, "contextWindow": 1000000, "maxOutput": 128000, "description": "La meilleure combinaison vitesse / intelligence d'Anthropic." },
    { "id": "claude-opus-4-7",             "label": "Claude Opus 4.7",   "editeur": "anthropic", "inputPer1M": 5,     "outputPer1M": 25, "contextWindow": 1000000, "maxOutput": 128000, "description": "Modèle le plus puissant d'Anthropic, excelle en analyse approfondie et tâches complexes." },
    { "id": "claude-opus-4-6",             "label": "Claude Opus 4.6",   "editeur": "anthropic", "inputPer1M": 5,     "outputPer1M": 25, "contextWindow": 1000000, "maxOutput": 128000, "description": "Version antérieure du modèle le plus puissant d'Anthropic, excelle en analyse approfondie et tâches complexes." },
    { "id": "claude-sonnet-4-5-20250929",  "label": "Claude Sonnet 4.5", "editeur": "anthropic", "inputPer1M": 3,     "outputPer1M": 15, "contextWindow": 200000, "maxOutput": 64000, "description": "Équilibre optimal entre performance et coût, très bon en rédaction et codage." },
    { "id": "claude-haiku-4-5-20251001",   "label": "Claude Haiku 4.5",  "editeur": "anthropic", "inputPer1M": 1,     "outputPer1M": 5,  "contextWindow": 200000, "maxOutput": 64000, "description": "Modèle rapide et abordable, parfait pour les réponses courtes et le traitement en masse." },
    { "id": "gemini-4-argon",              "label": "Gemini 4 Argon",    "editeur": "google",    "inputPer1M": 2,     "outputPer1M": 10, "priceAfterDate": "2026-12-01", "inputPer1MAfter": 4, "outputPer1MAfter": 20, "contextWindow": 1048576, "maxOutput": 65536, "description": "Modèle phare de Google, pour le raisonnement difficile : code, maths, sciences, agents en plusieurs étapes. Tarif de lancement jusqu'au 30 novembre 2026 ; ensuite 4 $ / 20 $ par million de jetons." },
    { "id": "gemini-3.8-flash",            "label": "Gemini 3.8 Flash",  "editeur": "google",    "inputPer1M": 0.75,  "outputPer1M": 3.75, "priceAfterDate": "2027-01-01", "inputPer1MAfter": 1.5, "outputPer1MAfter": 7.5, "contextWindow": 1048576, "maxOutput": 65536, "description": "Nouveau modèle Flash de Google. Tarif promotionnel jusqu'au 31 décembre 2026 ; ensuite 1,50 $ / 7,50 $ par million de jetons." },
    { "id": "gemini-3.6-flash",            "label": "Gemini 3.6 Flash",  "editeur": "google",    "inputPer1M": 0.75,  "outputPer1M": 3.75, "priceAfterDate": "2027-01-01", "inputPer1MAfter": 1.5, "outputPer1MAfter": 7.5, "contextWindow": 1048576, "maxOutput": 65536, "description": "Modèle Flash de Google, qui remplace Gemini 3.5 Flash. Tarif promotionnel jusqu'au 31 décembre 2026 ; ensuite 1,50 $ / 7,50 $ par million de jetons." },
    { "id": "gemini-3.5-flash",            "label": "Gemini 3.5 Flash",  "editeur": "google",    "inputPer1M": 1.5,   "outputPer1M": 9,  "contextWindow": 1048576, "description": "Ancien identifiant, redirigé par Google vers Gemini 3.6 Flash ; conservé pour le coût des conversations existantes." },
    { "id": "gemini-3.5-flash-lite",       "label": "Gemini 3.5 Flash Lite", "editeur": "google", "inputPer1M": 0.3, "outputPer1M": 2.5, "contextWindow": 1048576, "maxOutput": 65536, "description": "Modèle Google à faible latence pour les traitements simples et en grand volume." },
    { "id": "gemini-3.1-pro-preview",      "label": "Gemini 3.1 Pro",    "editeur": "google",    "inputPer1M": 2,     "outputPer1M": 12, "contextWindow": 1048576, "maxOutput": 65536, "description": "Dernier modèle Pro de Google, performant en raisonnement multimodal et long contexte." },
    { "id": "gemini-3-flash-preview",      "label": "Gemini 3 Flash",    "editeur": "google",    "inputPer1M": 0.5,   "outputPer1M": 3.0, "contextWindow": 1048576, "description": "Retiré de DavidTwentyAI le 2026-10-10 (remplacé par Gemini 3.8 Flash) ; conservé pour le coût des conversations existantes." },
    { "id": "gemini-3.1-flash-lite",       "label": "Gemini 3.1 Flash Lite",  "editeur": "google",    "inputPer1M": 0.25,  "outputPer1M": 1.5, "contextWindow": 1048576, "maxOutput": 65536, "description": "Modèle ultra-rapide et économique de Google, bon rapport qualité-prix." },
    { "id": "gemma-4-31b-it",             "label": "Gemma 4 (31b)",      "editeur": "google",   "inputPer1M": 0,      "outputPer1M": 0,"contextWindow": 262144, "description": "Le modèle dense de Google, conçu pour une qualité maximale à un prix dérisoire. Temporairement gratuit." },
    { "id": "mistral-large-4",            "label": "Mistral Large 4",   "editeur": "mistral",   "inputPer1M": 0.68,  "outputPer1M": 2.09, "priceAfterDate": "2026-10-20", "inputPer1MAfter": 1.36, "outputPer1MAfter": 4.18, "contextWindow": 1048576, "maxOutput": 262144, "description": "Nouveau modèle phare de Mistral (1 050 milliards de paramètres, MoE). Multimodal (texte + image), raisonnement hybride, contexte de 1 million de tokens. Tarif de lancement : 50 % de remise pendant deux semaines, jusqu'au 19 octobre 2026. Cocorico." },
    { "id": "mistral-medium-3-5",         "label": "Mistral Medium 3.5", "editeur": "mistral",   "inputPer1M": 1.5,   "outputPer1M": 7.5,"contextWindow": 262144, "description": "Le modèle multimodal de pointe avec raisonnement." },
    { "id": "mistral-large-latest",        "label": "Mistral Large 3",   "editeur": "mistral",   "inputPer1M": 0.5,   "outputPer1M": 1.5,  "contextWindow": 262144, "description": "L'ancien modèle phare de Mistral, toujours performant et très économique." },
    { "id": "mistral-small-latest",        "label": "Mistral Small 4",   "editeur": "mistral",   "inputPer1M": 0.15,  "outputPer1M": 0.6,"contextWindow": 262144, "description": "Petit modèle économique, très rapide, avec raisonnement, parfait pour les tâches simples." },
    { "id": "ministral-8b-latest",         "label": "Ministral 8B",      "editeur": "mistral",   "inputPer1M": 0.15,  "outputPer1M": 0.15,"contextWindow": 262144, "description": "Modèle compact (8B) optimisé pour la rapidité d'exécution et l'edge computing." },
    { "id": "deepseek-flash",              "label": "DeepSeek V4.1 Flash", "editeur": "deepseek", "inputPer1M": 0.3,   "outputPer1M": 1.2, "contextWindow": 1048576, "maxOutput": 393216, "description": "Modèle DeepSeek actuel, multimodal et économique : version V4.1-Flash-1017 depuis le 17 octobre 2026. Prix affiché en heure de pointe ; hors pointe : 0,15 $ / 0,60 $." },
    { "id": "deepseek-chat",               "label": "DeepSeek V3.2",     "editeur": "deepseek",  "inputPer1M": 0.14,  "outputPer1M": 0.28, "contextWindow": 131072, "description": "Ancien identifiant DeepSeek, conservé pour compatibilité avec les conversations existantes." },
    { "id": "deepseek-v4-pro",             "label": "DeepSeek V4 Pro",   "editeur": "deepseek",  "inputPer1M": 1.32,  "outputPer1M": 3.96, "contextWindow": 1048576, "maxOutput": 393216, "description": "Modèle DeepSeek le plus puissant. Prix affiché en heure de pointe ; hors pointe : 0,66 $ / 1,98 $." },
    { "id": "deepseek-v4-flash",           "label": "DeepSeek V4 Flash", "editeur": "deepseek",  "inputPer1M": 0.3,   "outputPer1M": 1.2, "contextWindow": 1048576, "maxOutput": 393216, "description": "Ancien identifiant, servi par V4.1 Flash (version 1017) au prix de Flash. Prix de pointe ; hors pointe : 0,15 $ / 0,60 $." },
    { "id": "grok-4.7",                    "label": "Grok 4.7",           "editeur": "grok",      "inputPer1M": 2,     "outputPer1M": 6, "longContextThreshold": 200000, "longInputPer1M": 4, "longOutputPer1M": 12, "contextWindow": 500000, "description": "Nouveau modèle phare de xAI pour le code et les tâches complexes. Le tarif double à partir de 200 000 jetons d'entrée." },
    { "id": "grok-4.5",                    "label": "Grok 4.5",           "editeur": "grok",      "inputPer1M": 2,     "outputPer1M": 6, "longContextThreshold": 200000, "longInputPer1M": 4, "longOutputPer1M": 12, "contextWindow": 500000, "description": "Modèle xAI pour le codage et les tâches agentiques. Le tarif double à partir de 200 000 jetons d'entrée." },
    { "id": "grok-4.3",                    "label": "Grok 4.3",           "editeur": "grok",      "inputPer1M": 1.25,  "outputPer1M": 2.50, "longContextThreshold": 200000, "longInputPer1M": 2.5, "longOutputPer1M": 5, "contextWindow": 1000000, "description": "Modèle xAI performant en analyse. Le tarif double à partir de 200 000 jetons d'entrée." },
    { "id": "grok-4.20-0309-reasoning",    "label": "Grok 4.20",         "editeur": "grok",      "inputPer1M": 1.25,  "outputPer1M": 2.50, "longContextThreshold": 200000, "longInputPer1M": 2.5, "longOutputPer1M": 5, "contextWindow": 1000000, "description": "Modèle xAI à grand contexte. Le tarif double à partir de 200 000 jetons d'entrée." },
    { "id": "grok-4-1-fast-reasoning",     "label": "Grok 4.1 Fast",     "editeur": "grok",      "inputPer1M": 1.25,  "outputPer1M": 2.50, "longContextThreshold": 200000, "longInputPer1M": 2.5, "longOutputPer1M": 5, "contextWindow": 1000000, "description": "Retiré par xAI le 15 mai 2026 (ses requêtes vont à Grok 4.3) ; conservé pour le coût des conversations existantes." },
    { "id": "glm-5.3",                     "label": "GLM-5.3",            "editeur": "zai",       "inputPer1M": 1.4,   "outputPer1M": 4.4,  "contextWindow": 1000000, "maxOutput": 131072, "description": "Nouveau modèle phare de Z.ai, avec raisonnement toujours actif." },
    { "id": "glm-5.3-flash",               "label": "GLM-5.3 Flash",      "editeur": "zai",       "inputPer1M": 0.15,  "outputPer1M": 0.5,  "contextWindow": 1000000, "maxOutput": 131072, "description": "Version multimodale rapide et économique de GLM-5.3, avec raisonnement toujours actif." },
    { "id": "glm-5.3-flashx",              "label": "GLM-5.3 FlashX",     "editeur": "zai",       "inputPer1M": 0.37,  "outputPer1M": 1.25, "contextWindow": 1000000, "maxOutput": 131072, "description": "Version accélérée de GLM-5.3 Flash, avec raisonnement toujours actif." },
    { "id": "glm-5.2",                     "label": "GLM-5.2",           "editeur": "zai",       "inputPer1M": 1.4,   "outputPer1M": 4.4,  "contextWindow": 1000000, "maxOutput": 131072, "description": "Dernier modèle phare de Zhipu AI, excellent en codage sur les tâches longues (mode raisonnement activable)." },
    { "id": "glm-5-turbo",                 "label": "GLM-5 Turbo",       "editeur": "zai",       "inputPer1M": 1.2,   "outputPer1M": 4.0,  "contextWindow": 200000, "maxOutput": 131072, "description": "Version rapide de GLM-5, bon compromis performance / latence (mode raisonnement activable)." },
    { "id": "glm-5.1",                     "label": "GLM-5.1",           "editeur": "zai",       "inputPer1M": 1.4,   "outputPer1M": 4.4,  "contextWindow": 200000, "maxOutput": 131072, "description": "Modèle codage le plus puissant de Zhipu AI, 200K de contexte, avec mode raisonnement activable." },
    { "id": "glm-5",                       "label": "GLM-5",             "editeur": "zai",       "inputPer1M": 1,     "outputPer1M": 3.2,  "contextWindow": 200000, "maxOutput": 131072, "description": "Modèle phare de Zhipu AI (744B MoE), rival des meilleurs modèles mondiaux (mode raisonnement activable)." },
    { "id": "glm-4.7-flash",               "label": "GLM-4.7 Flash",     "editeur": "zai",       "inputPer1M": 0,     "outputPer1M": 0,    "contextWindow": 200000, "maxOutput": 131072, "description": "Modèle ultra-rapide de Zhipu, gratuit, bon pour les tâches simples." }
  ],
  "image": [
    { "id": "gemini-3-pro-image",            "label": "Nano Banana Pro", "editeur": "google", "inputPer1M": 2,   "outputPer1M": 12, "imageOutput": 0.134, "imagePricing": { "1K": 0.134, "2K": 0.134, "4K": 0.24 }, "description": "Génération d'images via Gemini Pro, haute qualité et bonne compréhension des prompts." },
    { "id": "gemini-3.1-flash-image",        "label": "Nano Banana 2",  "editeur": "google", "inputPer1M": 0.5, "outputPer1M": 3,  "imageOutput": 0.067, "imagePricing": { "1K": 0.067, "2K": 0.101, "4K": 0.151 }, "description": "Génération d'images rapide et économique basée sur Gemini Flash." },
    { "id": "gemini-3.1-flash-lite-image",   "label": "Nano Banana 2 Lite", "editeur": "google", "inputPer1M": 0.25, "outputPer1M": 1.5, "imageOutput": 0.0336, "imagePricing": { "1K": 0.0336 }, "description": "Génération et retouche d'images à très faible latence, la moins chère de Google (résolution 1K)." },
    { "id": "gpt-image-2.5-sunburst",        "label": "GPT Image 2.5 Sunburst", "editeur": "openai", "inputPer1M": 5, "imageInputPer1M": 8, "imageOutputPer1M": 30, "outputPer1M": 0, "imageOutput": 0.1248, "imagePricing": { "low": { "1024x1024": 0.00816, "1024x1536": 0.01224, "1536x1024": 0.012 }, "medium": { "1024x1024": 0.03168, "1024x1536": 0.04752, "1536x1024": 0.04704 }, "high": { "1024x1024": 0.1248, "1024x1536": 0.1872, "1536x1024": 0.18624 } }, "description": "Modèle OpenAI le plus avancé pour générer et retoucher des images. Entrée texte : 5 $/M, image de référence : 8 $/M et sortie image : 30 $/M." },
    { "id": "gpt-image-2.5-flare",           "label": "GPT Image 2.5 Flare", "editeur": "openai", "inputPer1M": 5, "imageInputPer1M": 8, "imageOutputPer1M": 30, "outputPer1M": 0, "imageOutput": 0.1248, "imagePricing": { "low": { "1024x1024": 0.00816, "1024x1536": 0.01224, "1536x1024": 0.012 }, "medium": { "1024x1024": 0.03168, "1024x1536": 0.04752, "1536x1024": 0.04704 }, "high": { "1024x1024": 0.1248, "1024x1536": 0.1872, "1536x1024": 0.18624 } }, "description": "Modèle OpenAI rapide pour la génération et la retouche d'images. Entrée texte : 5 $/M, image de référence : 8 $/M et sortie image : 30 $/M." },
    { "id": "gpt-image-2",                   "label": "GPT Image 2",    "editeur": "openai",     "inputPer1M": 5,   "outputPer1M": 0,  "imageOutput": 0.211, "imagePricing": { "low": { "1024x1024": 0.006, "1024x1536": 0.005, "1536x1024": 0.005 }, "medium": { "1024x1024": 0.053, "1024x1536": 0.041, "1536x1024": 0.041 }, "high": { "1024x1024": 0.211, "1024x1536": 0.165, "1536x1024": 0.165 } }, "description": "Dernière génération GPT Image d'OpenAI, fidélité supérieure et support de résolutions libres." },
    { "id": "gpt-image-1.5",                 "label": "GPT Image 1.5",  "editeur": "openai",     "inputPer1M": 5,   "outputPer1M": 10, "imageOutput": 0.133, "imagePricing": { "low": { "1024x1024": 0.009, "1024x1536": 0.013, "1536x1024": 0.013 }, "medium": { "1024x1024": 0.034, "1024x1536": 0.05, "1536x1024": 0.05 }, "high": { "1024x1024": 0.133, "1024x1536": 0.2, "1536x1024": 0.2 } }, "description": "Modèle de génération d'images d'OpenAI, excellent en réalisme et créativité." },
    { "id": "gpt-image-1-mini",              "label": "GPT Image 1 Mini", "editeur": "openai",   "inputPer1M": 2,   "outputPer1M": 0,  "imageOutput": 0.036, "imagePricing": { "low": { "1024x1024": 0.005, "1024x1536": 0.006, "1536x1024": 0.006 }, "medium": { "1024x1024": 0.011, "1024x1536": 0.015, "1536x1024": 0.015 }, "high": { "1024x1024": 0.036, "1024x1536": 0.052, "1536x1024": 0.052 } }, "description": "Version mini de GPT Image, nettement moins chère, idéale pour les itérations rapides." }
  ],
  "search": [
    { "id": "sonar",                "label": "Sonar",               "editeur": "perplexity", "inputPer1M": 1, "outputPer1M": 1, "requestPer1k": 5, "description": "Retiré de DavidTwentyAI le 10 octobre 2026 : Sonar ne répond plus depuis la fin de son API (Sonar Pro le remplace) ; conservé pour le coût des conversations existantes." },
    { "id": "sonar-pro",            "label": "Sonar Pro",            "editeur": "perplexity", "inputPer1M": 0.1, "outputPer1M": 0.5, "requestPer1k": 1, "description": "Recherche web rapide avec sources. Depuis la fin de l'API Sonar (27 septembre 2026), Perplexity le sert par son Agent API au niveau « fast » : GPT-6 Luna et une recherche. 1 $ les 1 000 recherches." },
    { "id": "sonar-reasoning-pro",  "label": "Sonar Reasoning Pro",  "editeur": "perplexity", "inputPer1M": 0.1, "outputPer1M": 0.5, "requestPer1k": 1, "description": "Recherche web en plusieurs étapes pour les questions complexes. Depuis la fin de l'API Sonar (27 septembre 2026), Perplexity le sert par son Agent API au niveau « low » : GPT-6 Luna, jusqu'à 5 recherches ou pages lues. 1 $ les 1 000 recherches, 0,50 $ les 1 000 pages lues." }
  ],
  "tts": [
    { "id": "gpt-4o-mini-tts",                  "label": "OpenAI (gpt-4o-mini-tts)",          "editeur": "openai",  "prix": "$0.60 / $12 par 1M jetons", "pricing": { "type": "estimatedMinute", "perMinute": 0.015 },                              "description": "Synthèse vocale rapide et expressive d'OpenAI. Coût estimé d'après la durée audio." },
    { "id": "gemini-3.8-flash-tts",             "label": "Google (Gemini 3.8 Flash TTS)",     "editeur": "google",  "prix": "$0.50 / $9 par 1M jetons jusqu'au 31/12/2026, puis $1 / $18", "pricing": { "type": "tokens", "inputPer1M": 0.5, "outputPer1M": 9, "audioTokensPerSecond": 25, "afterDate": "2027-01-01", "inputPer1MAfter": 1, "outputPer1MAfter": 18 }, "description": "Synthèse vocale Google de haute qualité pour les voix expressives et les textes longs." },
    { "id": "gemini-3.8-flash-lite-tts",        "label": "Google (Gemini 3.8 Flash-Lite TTS)", "editeur": "google", "prix": "$0.50 / $6 par 1M jetons jusqu'au 31/12/2026, puis $1 / $12", "pricing": { "type": "tokens", "inputPer1M": 0.5, "outputPer1M": 6, "audioTokensPerSecond": 25, "afterDate": "2027-01-01", "inputPer1MAfter": 1, "outputPer1MAfter": 12 }, "description": "Synthèse vocale Google rapide et économique pour les usages courants." },
    { "id": "gemini-3.1-flash-tts-preview",      "label": "Google (Gemini 3.1 Flash TTS)",     "editeur": "google",  "prix": "$1 / $20 par 1M jetons",   "pricing": { "type": "tokens", "inputPer1M": 1, "outputPer1M": 20, "audioTokensPerSecond": 25 },   "description": "Ancien modèle TTS preview de Google, conservé pour compatibilité." },
    { "id": "gemini-2.5-flash-preview-tts",      "label": "Google (Gemini 2.5 Flash TTS)",     "editeur": "google",  "prix": "$0.50 / $10 par 1M jetons", "pricing": { "type": "tokens", "inputPer1M": 0.5, "outputPer1M": 10, "audioTokensPerSecond": 25 }, "description": "Synthèse vocale de Google via Gemini, voix naturelles multilingues." },
    { "id": "voxtral-mini-tts-3-0",              "label": "Mistral (Voxtral TTS 3)",           "editeur": "mistral", "prix": "$13/1M car.",          "pricing": { "type": "characters", "per1M": 13 },                                         "description": "Synthèse vocale de Mistral (Voxtral 3, en préversion publique), avec sa voix française Marie." },
    { "id": "voxtral-mini-tts-2603",             "label": "Mistral (Voxtral Mini TTS)",        "editeur": "mistral", "prix": "$16/1M car.",          "pricing": { "type": "characters", "per1M": 16 },                                         "description": "Retiré de DavidTwentyAI le 2026-10-30 (remplacé par Voxtral TTS 3) ; conservé pour le coût des lectures passées." },
    { "id": "system-tts",                        "label": "Système (navigateur)",              "editeur": "system",  "prix": "Gratuit",                "pricing": { "type": "free" },                                                               "description": "Synthèse vocale native du navigateur (voix du système)." }
  ],
  "stt": [
    { "id": "gpt-transcribe",          "label": "OpenAI (GPT Transcribe)",        "editeur": "openai",  "prix": "$0.0045/min", "pricing": { "type": "minute", "perMinute": 0.0045 }, "description": "Nouveau modèle de transcription audio d'OpenAI, plus économique que Whisper." },
    { "id": "whisper-1",              "label": "OpenAI (Whisper)",              "editeur": "openai",  "prix": "$0.006/min",                 "pricing": { "type": "minute", "perMinute": 0.006 },                                                                                   "description": "Transcription audio OpenAI. Modèle encore disponible, arrêt annoncé le 26 février 2027." },
    { "id": "gemini-3.5-transcribe",  "label": "Google (Gemini 3.5 Transcribe)", "editeur": "google", "prix": "≈ $0.005/min", "pricing": { "type": "audioTokens", "audioInputPer1M": 2, "audioTokensPerSecond": 25, "outputPer1M": 12, "estimatedOutputTokensPerMinute": 175 }, "description": "Modèle Google spécialisé dans la transcription, avec détection de langue et mise en forme intelligente." },
    { "id": "gemini-3.1-flash-lite",  "label": "Google (Gemini 3.1 Flash Lite)", "editeur": "google",  "prix": "$0.50 audio / $1.50 sortie", "pricing": { "type": "audioTokens", "audioInputPer1M": 0.5, "audioTokensPerSecond": 32, "outputPer1M": 1.5 }, "description": "Transcription audio via Gemini Flash Lite, rapide et polyvalent." },
    { "id": "voxtral-mini-transcribe-3-0",  "label": "Mistral (Voxtral Mini Transcribe 3)",  "editeur": "mistral", "prix": "$0.0035/min", "pricing": { "type": "minute", "perMinute": 0.0035 }, "description": "Transcription de Mistral (Voxtral 3, en préversion publique), précise, rapide et économique." },
    { "id": "voxtral-small-transcribe-3-0", "label": "Mistral (Voxtral Small Transcribe 3)", "editeur": "mistral", "prix": "$0.004/min",  "pricing": { "type": "minute", "perMinute": 0.004 },  "description": "Le modèle de transcription le plus précis de Mistral (Voxtral 3, en préversion publique), un peu plus lent." },
    { "id": "voxtral-mini-latest",     "label": "Mistral (Voxtral Mini 2)",       "editeur": "mistral", "prix": "$0.003/min",                 "pricing": { "type": "minute", "perMinute": 0.003 },                                                                                   "description": "Retiré de DavidTwentyAI le 2026-10-30 (remplacé par Voxtral Mini Transcribe 3) ; conservé pour le coût des transcriptions passées." }
  ]
};

// Tarifs de cache en USD/M tokens, explicites par modèle ; sans tarif confirmé, tarif ordinaire (aucune remise inventée)
const MODEL_CACHE_PRICING = {
  'gpt-6-astra': { cachedInputPer1M: 1, cacheWritePer1M: 12.5, longCachedInputPer1M: 2, longCacheWritePer1M: 25 },
  'gpt-6.1-sol': { cachedInputPer1M: 0.1, cacheWritePer1M: 2.5, longCachedInputPer1M: 0.2, longCacheWritePer1M: 5 },
  'gpt-6.1-terra': { cachedInputPer1M: 0.05, cacheWritePer1M: 1.25, longCachedInputPer1M: 0.1, longCacheWritePer1M: 2.5 },
  'gpt-6-luna': { cachedInputPer1M: 0.01, cacheWritePer1M: 0.125, longCachedInputPer1M: 0.02, longCacheWritePer1M: 0.25 },
  // Sol : prix promotionnel annoncé jusqu'au 21/11/2026 au moins ; ne pas inventer son prix futur
  'gpt-5.6-sol': { inputPer1M: 4, outputPer1M: 20, cachedInputPer1M: 0.4, cacheWritePer1M: 5, longContextThreshold: 272001, longInputPer1M: 8, longOutputPer1M: 30, longCachedInputPer1M: 0.8, longCacheWritePer1M: 10 },
  'gpt-5.6-terra': { inputPer1M: 2, outputPer1M: 12, cachedInputPer1M: 0.2, cacheWritePer1M: 2.5, longContextThreshold: 272001, longInputPer1M: 4, longOutputPer1M: 18, longCachedInputPer1M: 0.4, longCacheWritePer1M: 5 },
  'gpt-5.6-luna': { inputPer1M: 0.2, outputPer1M: 1.2, cachedInputPer1M: 0.02, cacheWritePer1M: 0.25, longContextThreshold: 272001, longInputPer1M: 0.4, longOutputPer1M: 1.8, longCachedInputPer1M: 0.04, longCacheWritePer1M: 0.5 },
  'gpt-5.5-2026-04-23': { cachedInputPer1M: 0.5, cacheWritePer1M: 5, longContextThreshold: 272001, longInputPer1M: 10, longOutputPer1M: 45, longCachedInputPer1M: 1, longCacheWritePer1M: 10 },
  'gpt-5.4-2026-03-05': { cachedInputPer1M: 0.25, cacheWritePer1M: 2.5, longContextThreshold: 272001, longInputPer1M: 5, longOutputPer1M: 22.5, longCachedInputPer1M: 0.5, longCacheWritePer1M: 5 },
  'gpt-5.2-2025-12-11': { cachedInputPer1M: 0.175, cacheWritePer1M: 1.75 },
  'gpt-4.1-2025-04-14': { cachedInputPer1M: 0.5, cacheWritePer1M: 2 },
  'gpt-5.4-mini-2026-03-17': { cachedInputPer1M: 0.075, cacheWritePer1M: 0.75 },
  'gpt-5.4-nano-2026-03-17': { cachedInputPer1M: 0.02, cacheWritePer1M: 0.2 },
  'claude-fable-5-1': { cachedInputPer1M: 0.25, cacheWritePer1M: 12.5, cacheWrite1hPer1M: 20 },
  'claude-opus-5-5': { cachedInputPer1M: 0.2, cacheWritePer1M: 5, cacheWrite1hPer1M: 8 },
  // Opus 5.5 et Sonnet 5.5 : lecture du cache à 0,05 fois l'entrée
  'claude-sonnet-5-5': { cachedInputPer1M: 0.1, cacheWritePer1M: 2.5, cacheWrite1hPer1M: 4 },
  // Haiku 5.5 : deux grilles selon la longueur du prompt (au-delà de 100 000 jetons)
  'claude-haiku-5-5': { cachedInputPer1M: 0.01, cacheWritePer1M: 0.125, cacheWrite1hPer1M: 0.2, longCachedInputPer1M: 0.05, longCacheWritePer1M: 0.625, longCacheWrite1hPer1M: 1 },
  'claude-fable-5': { cachedInputPer1M: 1, cacheWritePer1M: 12.5, cacheWrite1hPer1M: 20 },
  'claude-opus-4-8': { cachedInputPer1M: 0.5, cacheWritePer1M: 6.25, cacheWrite1hPer1M: 10 },
  // Sonnet 5 : 2 $ / 10 $ est le tarif normal
  'claude-sonnet-5': { cachedInputPer1M: 0.2, cacheWritePer1M: 2.5, cacheWrite1hPer1M: 4 },
  'claude-opus-4-7': { cachedInputPer1M: 0.5, cacheWritePer1M: 6.25, cacheWrite1hPer1M: 10 },
  'claude-opus-4-6': { cachedInputPer1M: 0.5, cacheWritePer1M: 6.25, cacheWrite1hPer1M: 10 },
  'claude-sonnet-4-5-20250929': { cachedInputPer1M: 0.3, cacheWritePer1M: 3.75, cacheWrite1hPer1M: 6 },
  'claude-haiku-4-5-20251001': { cachedInputPer1M: 0.1, cacheWritePer1M: 1.25, cacheWrite1hPer1M: 2 },
  // Argon : cache implicite seulement (le cache explicite est refusé)
  'gemini-4-argon': { cachedInputPer1M: 0.1, cachedInputPer1MAfter: 0.2 },
  'gemini-3.8-flash': { cachedInputPer1M: 0.075, cachedInputPer1MAfter: 0.15 },
  'gemini-3.6-flash': { cachedInputPer1M: 0.075, cachedInputPer1MAfter: 0.15 },
  'gemini-3.5-flash': { cachedInputPer1M: 0.15 },
  'gemini-3.5-flash-lite': { cachedInputPer1M: 0.03 },
  'gemini-3.1-pro-preview': { cachedInputPer1M: 0.2, longContextThreshold: 200001, longInputPer1M: 4, longOutputPer1M: 18, longCachedInputPer1M: 0.4 },
  'gemini-3-flash-preview': { cachedInputPer1M: 0.05 },
  'gemini-3.1-flash-lite': { cachedInputPer1M: 0.025 },
  'gemma-4-31b-it': { cachedInputPer1M: 0 },
  'mistral-large-4': { cachedInputPer1M: 0.07, cachedInputPer1MAfter: 0.14 },
  'mistral-medium-3-5': { cachedInputPer1M: 0.15, cacheWritePer1M: 1.5 },
  'mistral-large-latest': { cachedInputPer1M: 0.05, cacheWritePer1M: 0.5 },
  'mistral-small-latest': { cachedInputPer1M: 0.015, cacheWritePer1M: 0.15 },
  'ministral-8b-latest': { cachedInputPer1M: 0.015, cacheWritePer1M: 0.15 },
  'deepseek-flash': { cachedInputPer1M: 0.006, cacheWritePer1M: 0.3, offPeakCachedInputPer1M: 0.003, offPeakInputPer1M: 0.15, offPeakOutputPer1M: 0.6 },
  'deepseek-v4-pro': { cachedInputPer1M: 0.044, cacheWritePer1M: 1.32, offPeakCachedInputPer1M: 0.022, offPeakInputPer1M: 0.66, offPeakOutputPer1M: 1.98 },
  'deepseek-v4-flash': { cachedInputPer1M: 0.006, cacheWritePer1M: 0.3, offPeakCachedInputPer1M: 0.003, offPeakInputPer1M: 0.15, offPeakOutputPer1M: 0.6 },
  'grok-4.7': { cachedInputPer1M: 0.5, longCachedInputPer1M: 1 },
  'grok-4.5': { cachedInputPer1M: 0.3, longCachedInputPer1M: 0.6 },
  'grok-4.3': { cachedInputPer1M: 0.2, longCachedInputPer1M: 0.4 },
  'grok-4.20-0309-reasoning': { cachedInputPer1M: 0.2, longCachedInputPer1M: 0.4 },
  'grok-4-1-fast-reasoning': { cachedInputPer1M: 0.2, longCachedInputPer1M: 0.4 },
  'glm-5.3': { cachedInputPer1M: 0.26 },
  'glm-5.3-flash': { cachedInputPer1M: 0.03 },
  'glm-5.3-flashx': { cachedInputPer1M: 0.075 },
  'glm-5.2': { cachedInputPer1M: 0.26 },
  'glm-5.1': { cachedInputPer1M: 0.26 },
  'glm-5': { cachedInputPer1M: 0.2 },
  'glm-4.7-flash': { cachedInputPer1M: 0 }
};
for (const model of MODELS_DATA.text) {
    if (MODEL_CACHE_PRICING[model.id]) Object.assign(model, MODEL_CACHE_PRICING[model.id]);
}

// Modèle absent : pas de réglage de raisonnement ; levels, default, mandatory, binary, thinking, send, onModel/offModel : voir api.js
const MODEL_REASONING = (() => {
  const OPENAI_6 = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  const OPENAI_5 = ['none', 'low', 'medium', 'high', 'xhigh'];
  const CLAUDE_ADAPTIVE = { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium', mandatory: true, thinking: 'adaptive' };
  const CLAUDE_BUDGET = { levels: ['minimal', 'low', 'medium', 'high'], default: 'medium', thinking: 'budget' };
  // Niveaux acceptés par chaque modèle : ai.google.dev/gemini-api/docs/thinking
  const GEMINI_3 = { levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' };
  const BINARY = { levels: ['minimal', 'high'], default: 'high', binary: true };
  return {
    'gpt-6-astra': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium', mandatory: true },
    'gpt-6.1-sol': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium', mandatory: true },
    'gpt-6.1-terra': { levels: OPENAI_6, default: 'medium', mandatory: true },
    'gpt-6-luna': { levels: OPENAI_6, default: 'medium', mandatory: true },
    'gpt-5.6-sol': { levels: OPENAI_6, default: 'medium' },
    'gpt-5.6-terra': { levels: OPENAI_6, default: 'medium' },
    'gpt-5.6-luna': { levels: OPENAI_6, default: 'medium' },
    'gpt-5.5-2026-04-23': { levels: OPENAI_5, default: 'medium' },
    'gpt-5.4-2026-03-05': { levels: OPENAI_5, default: 'medium' },
    'gpt-5.2-2025-12-11': { levels: OPENAI_5, default: 'medium' },
    'gpt-5.4-mini-2026-03-17': { levels: OPENAI_5, default: 'medium' },
    'gpt-5.4-nano-2026-03-17': { levels: OPENAI_5, default: 'medium' },
    'claude-fable-5-1': CLAUDE_ADAPTIVE,
    'claude-opus-5-5': CLAUDE_ADAPTIVE,
    'claude-sonnet-5-5': CLAUDE_ADAPTIVE,
    'claude-haiku-5-5': CLAUDE_ADAPTIVE,
    'claude-fable-5': CLAUDE_ADAPTIVE,
    'claude-opus-4-8': CLAUDE_ADAPTIVE,
    'claude-sonnet-5': CLAUDE_ADAPTIVE,
    'claude-opus-4-7': CLAUDE_ADAPTIVE,
    'claude-opus-4-6': CLAUDE_BUDGET,
    'claude-sonnet-4-5-20250929': CLAUDE_BUDGET,
    // Argon : low, medium (défaut) ou high ; minimal refusé, réflexion toujours active
    'gemini-4-argon': { levels: ['low', 'medium', 'high'], default: 'medium', mandatory: true },
    'gemini-3.8-flash': { levels: ['low', 'medium', 'high'], default: 'medium', mandatory: true },
    'gemini-3.6-flash': GEMINI_3,
    'gemini-3.5-flash': GEMINI_3,
    'gemini-3.5-flash-lite': GEMINI_3,
    // Pro : pas de minimal, réflexion toujours active
    'gemini-3.1-pro-preview': { levels: ['low', 'medium', 'high'], default: 'medium', mandatory: true },
    'gemini-3-flash-preview': GEMINI_3,
    'gemini-3.1-flash-lite': GEMINI_3,
    'gemma-4-31b-it': BINARY,
    'mistral-large-4': BINARY,
    'mistral-medium-3-5': BINARY,
    'mistral-small-latest': BINARY,
    'deepseek-flash': { levels: ['none', 'low', 'high', 'max'], default: 'high', mandatory: true },
    'deepseek-v4-pro': { levels: ['none', 'low', 'high', 'max'], default: 'high', mandatory: true },
    'deepseek-v4-flash': { levels: ['none', 'low', 'high', 'max'], default: 'high', mandatory: true },
    'deepseek-chat': { ...BINARY, onModel: 'deepseek-reasoner' },
    'grok-4.7': { levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium', mandatory: true },
    'grok-4.5': { levels: ['low', 'medium', 'high'], default: 'medium', mandatory: true },
    'grok-4.3': { levels: ['none', 'low', 'medium', 'high'], default: 'medium' },
    'grok-4.20-0309-reasoning': { ...BINARY, offModel: 'grok-4.20-0309-non-reasoning' },
    'glm-5.3': { levels: ['low', 'high', 'max'], default: 'max', mandatory: true },
    'glm-5.3-flash': { levels: ['low', 'high', 'max'], default: 'max', mandatory: true },
    'glm-5.3-flashx': { levels: ['low', 'high', 'max'], default: 'max', mandatory: true },
    'glm-5.2': BINARY,
    'glm-5-turbo': BINARY,
    'glm-5.1': BINARY,
    'glm-5': BINARY
  };
})();
for (const model of MODELS_DATA.text) {
    if (MODEL_REASONING[model.id]) model.reasoning = MODEL_REASONING[model.id];
}

// Audio : seules les remises publiées par Google ; DavidTwentyAI ne crée aucun stockage de cache payant
for (const model of MODELS_DATA.tts) {
    if (['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'].includes(model.id)) {
        Object.assign(model.pricing, { cachedInputPer1M: 0.125, cachedInputPer1MAfter: 0.25 });
    }
}
for (const model of MODELS_DATA.stt) {
    if (model.id === 'gemini-3.1-flash-lite') {
        Object.assign(model.pricing, { cachedAudioInputPer1M: 0.05, textInputPer1M: 0.25, cachedTextInputPer1M: 0.025 });
    }
}
