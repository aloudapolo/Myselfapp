# Myself

Mon dashboard perso pour iPhone : tâches, projets et raccourcis vers mes apps.

- **En ligne** : hébergé sur Cloudflare (dossier `public/`, config dans `wrangler.jsonc`).
- **Installer** : ouvrir le lien dans Safari → bouton Partager → « Sur l'écran d'accueil ».
- **Données** : stockées sur l'appareil (localStorage). Export/import JSON dans les réglages.

Stack : HTML/CSS/JS sans dépendance, PWA (manifest + service worker).

## Assistant IA (bouton ✦ au-dessus du +)

- Modèle : Claude Haiku 5.5 (`claude-haiku-5-5`), appelé par le Worker sur `POST /api/ai` (protégé par le code d'accès).
- La clé API Anthropic est un **secret du Worker** nommé `ANTHROPIC_API_KEY` (Cloudflare > Workers > myselfapp > Settings > Variables and Secrets). Jamais dans le code.
- L'IA lit : tâches et projets (envoyés par l'appli), MyGym (profil + programme), le dernier MyBrief, les totaux Binvio.
- Elle ne fait que **proposer** des tâches : l'appli affiche une carte Ajouter / Modifier / Ignorer.
- Garde-fou : 300 appels IA par jour (compteur `meta.ai_usage`).
- Dictée : reconnaissance vocale de Safari (fr-FR) si dispo, sinon micro du clavier iOS.
