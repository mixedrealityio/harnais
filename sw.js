// Service de fond minimal : rend DavidTwentyAI installable comme application (Android Chrome).
// Aucun cache : chaque requête part au serveur, les mises à jour restent visibles au rechargement.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
