# Plan de travail : Atrium (repartir du zip)

*Rédigé le 12/11/2026. À lire avec `RAPPORT-atrium.md`.*

**Objectif.** Partir du code de `atrium-main.zip` pour en faire un projet :

1. qui se lance avec **une seule commande Docker**, pour que n'importe qui puisse travailler dessus ;
2. où l'on peut **brancher des IA** : Claude, OpenAI, Mistral ou un modèle local ;
3. sur lequel plusieurs **instances Claude peuvent travailler la nuit sans se gêner** ni rien casser.

---

## A. Règles pour les instances Claude (à copier dans `CLAUDE.md`)

Ces règles passent avant tout le reste. Une instance qui ne peut pas les respecter s'arrête et l'écrit dans son rapport.

1. **Interdit : la production.** Ne jamais lancer `deploy/compose.yaml`. Ne jamais se connecter à un vrai serveur mail, à un vrai domaine ou à une vraie base de données. On travaille seulement dans la stack de dev Docker.
2. **Interdit : les vrais secrets.** Pas de vraie clé d'API, pas de vrai mot de passe. Pour les tests, on utilise des valeurs factices et des providers IA simulés (« mock »).
3. **Une tâche = une branche = un worktree.** Branche `night/<ID-tâche>`. Ne jamais commiter sur `main`, ne jamais faire de force-push.
4. **Réserver sa tâche avant de commencer.** Dans `TASKS.md`, passer la tâche en `[~] (instance X, date)`. Si elle est déjà prise, en choisir une autre.
5. **Avant de dire « fini »** : `make test` et `make lint` passent dans Docker, et la tâche a ses propres tests.
6. **Pas de nouvelle dépendance sans justification**, écrite dans le rapport. Pas de dépendance qui n'a pas de version fixe.
7. **Rapport obligatoire** : `reports/<ID>.md`, avec ce qui a été fait, ce qui a été testé, ce qui reste, et les questions pour l'humain.
8. **Bloqué plus de 30 min** sur une tâche : écrire pourquoi dans le rapport, remettre la tâche en `[ ]`, et en prendre une autre.
9. **Ne pas réécrire le code des autres branches.** Si deux tâches touchent le même fichier, celle qui arrive en second attend (voir les dépendances).
10. **Règles reprises d'Atrium, non négociables** : ne jamais supprimer un mail (supprimer = mettre à la corbeille, gardé au moins 30 jours) ; ne jamais casser la compatibilité avec les clients Nextcloud (DAV, OCS, login flow).

---

## B. Les étapes

Légende : 🔒 = à faire **avant** tout le reste, par **une seule** instance. ⚡ = peut tourner en parallèle avec les autres tâches ⚡.

### Phase 0 : mettre le terrain en place 🔒 (une instance, d'abord)

- **P0-1. Créer le dépôt Git** à partir du zip : commit initial « import atrium-main 2026-11-08 », sans `dist/` ni `node_modules`.
- **P0-2. Retirer les données personnelles** :
  - le domaine de production, les IP du réseau local, l'adresse Gmail, les noms ;
  - le dossier `memory/` complet : l'archiver hors du dépôt, et garder seulement un résumé des leçons techniques dans `docs/lessons.md`.
  - Tout ce qui est propre à une installation passe en variables d'environnement (`ATRIUM_DOMAIN`, `ATRIUM_NTFY_URL`…).
- **P0-3. Stack de dev en une commande** : `docker compose up` doit lancer Atrium (Bun + PHP-FPM), PostgreSQL, Redis et GreenMail (faux serveur mail), avec :
  - deux comptes de démo et des mails de démo déjà chargés ;
  - le code monté en direct, sans rebuild à chaque changement ;
  - aucune variable personnelle obligatoire (un `.env.example` complet suffit) ;
  - des images qui marchent aussi sur un CPU sans AVX (Bun baseline) **et** sur ARM si possible.
- **P0-4. `Makefile`** avec les commandes `make up`, `make down`, `make test` (PHPUnit + `bun test` + vitest), `make lint`, `make build` et `make reset` (base de démo propre). Tout s'exécute dans Docker, rien n'est installé sur la machine.
- **P0-5. Intégration continue** : un workflow GitHub Actions (ou équivalent) qui lance `make lint test` sur chaque branche.
- **P0-6. Fichiers pour les agents** :
  - `CLAUDE.md` et `AGENTS.md` : règles de la section A, où se trouve quoi, comment tester ;
  - `TASKS.md` : la liste des tâches ci-dessous avec leurs ID ;
  - le dossier `reports/`.
- **P0-7. README Atrium** : ce que c'est, comment lancer en dev, comment contribuer. Remplace le README de Nextcloud.
- **P0-8. Créer l'équipe d'agents** décrite en section D : les fichiers `.claude/agents/*.md`, le script `night.sh` et le journal `docs/agents-journal.md`. Commencer avec l'équipe proposée, puis ajouter, fusionner ou supprimer des agents selon ce qui marche.

✅ **Phase terminée quand** : un clone frais suivi de `make up` donne un Atrium où l'on peut se connecter avec le compte démo, `make test` passe, et l'équipe d'agents (P0-8) a fait au moins une tâche complète (dev → test → relecture).

### Phase 1 : nettoyer et sécuriser ⚡

- **P1-1. Mettre à jour la doc** : `deploy/README.md` (Bun/FPM au lieu d'Apache), le tableau des ADR, les cases de la phase 3 dans la todo, le commentaire en double dans le Dockerfile.
- **P1-2. Uploads « chunked »** (`server/php.ts`) : ne plus charger tout le corps de la requête en RAM. Passer par un fichier temporaire sur disque ou par une limite de taille. Ajouter un test avec un envoi de plus de 2 Go qui ne doit pas faire planter le conteneur.
- **P1-3. Limites dans Bun** : un `idleTimeout` raisonnable, et une taille maximale de requête configurable (`ATRIUM_MAX_BODY`).
- **P1-4. Cache d'authentification** (`server/agent/auth.ts`) : invalider le cache quand un jeton est révoqué ou qu'une session se déconnecte, ou réduire sa durée de vie. Ajouter un test « jeton révoqué → refusé tout de suite ».
- **P1-5. Webhooks** : bloquer les adresses internes (localhost, 10/8, 172.16/12, 192.168/16, link-local), sauf si l'admin les autorise dans une liste blanche (`ATRIUM_WEBHOOK_ALLOW`).
- **P1-6. Tests React** : des tests de base pour le shell et pour Mail (affichage de la liste, ouverture d'un mail, envoi d'un brouillon), avec vitest et un faux serveur.
- **P1-7. Test de bout en bout** : un test Playwright qui se connecte, ouvre Mail, Calendar et Files, et vérifie qu'aucune page n'est vide.

### Phase 2 : brancher des IA (comptes Claude ou autres) ⚡ après P0

Il y a **deux sens** possibles, et il faut les deux :

- **Sens 1 :** une IA externe (Claude Code, Claude Desktop, claude.ai, Cursor, Codex…) se connecte à Atrium pour agir sur les données. C'est la couche agent MCP, qui existe déjà.
- **Sens 2 :** Atrium appelle lui-même une IA, pour trier les mails, résumer, rédiger. Il lui faut alors une **clé d'API**.

> ⚠️ Un abonnement Claude (Pro/Max) **ne peut pas** servir de clé d'API à une autre application. Pour le sens 2, il faut une clé de l'API Anthropic (console.anthropic.com), ou une clé OpenAI, Mistral, etc. Pour le sens 1, en revanche, l'abonnement Claude suffit : c'est Claude qui se connecte à Atrium.

**Sens 2 : les providers IA dans Atrium**

- **P2-1. Couche « providers »** en TypeScript (`server/ai/`). Une seule interface (`complete`, `stream`, `tools`) pour :
  - Anthropic (Claude) ;
  - OpenAI ;
  - Mistral ;
  - tout endpoint compatible OpenAI (OpenRouter, LiteLLM…) ;
  - **Ollama**, pour un modèle local et gratuit.
  - Plus un provider **mock** pour les tests.
- **P2-2. Page Réglages > IA** :
  - ajouter un provider avec sa clé et choisir les modèles ;
  - un provider pour toute l'instance (admin) et/ou par utilisateur ;
  - clés **chiffrées** en base (avec le crypto de Nextcloud ou un secret d'instance), jamais renvoyées en clair à l'interface ;
  - un bouton « tester la connexion ».
- **P2-3. Budgets et suivi** : un plafond par jour et par mois pour chaque provider et chaque usage, un compteur de tokens et de coût, et des pauses automatiques sur erreur. On reprend la logique qui marche déjà dans `TriageService`.
- **P2-4. Brancher le tri des mails sur cette couche** à la place du service « tollgate » codé en dur. Le schéma `mail-v2` reste compatible, et le provider est choisi dans les réglages.
- **P2-5. Choix du modèle par tâche** : un petit modèle pas cher pour le tri, un plus gros pour les résumés et les brouillons. C'est configurable.

**Sens 1 : connecter Claude et les autres agents à Atrium**

- **P2-6. Boîte « Connecter un agent »** améliorée : des instructions prêtes à copier pour :
  - Claude Code (`claude mcp add --transport http atrium <url> --header "Authorization: Bearer <token>"`) ;
  - Claude Desktop ;
  - Cursor, Codex ;
  - un script REST simple.
- **P2-7. OAuth 2.1 pour le MCP** (comme le prévoit la spec MCP). Il permet d'ajouter Atrium comme **connecteur personnalisé dans claude.ai** et dans d'autres clients qui ne gèrent pas les jetons copiés à la main. Atrium a déjà une app `oauth2` à réutiliser ou à étendre : découverte (`/.well-known/oauth-authorization-server`), PKCE, et un écran de consentement qui affiche les permissions de l'agent.
- **P2-8. Plusieurs agents par utilisateur**, chacun avec ses permissions, ses jetons, son journal d'activité et son bouton pause. Une page « Activité des agents » montre qui a fait quoi, avec un lien vers chaque approbation.

### Phase 3 : outils agents pour toutes les apps ⚡ (dans l'ordre de l'ADR 0009)

Chaque app reçoit des outils CRUD, des événements et des tests, sur le modèle de `server/agent/mail/`.

- **P3-1. Daily Todo** : boards, jour, items (créer, cocher, déplacer) + événements `todo.*`.
- **P3-2. Calendar + Tasks** : événements, récurrences, tâches, agendas délégués **découvrables** (l’un des points qui gênaient l’agent d’origine) + événements `calendar.*` et `task.*` (par exemple « commence dans 15 min »).
- **P3-3. Contacts** : CRUD avec des champs simples (nom, email, téléphone), sans exposer le vCard brut.
- **P3-4. Files** : lister, lire, écrire, partager (le partage passe par une approbation).
- **P3-5. Notes**, puis **Activity** (lecture seule).
- **P3-6. Recherche transversale** : un outil `search`, qui cherche dans toutes les apps auxquelles l'agent a accès.
- **P3-7. Annuler une action d'agent** depuis le journal d'activité.

### Phase 4 : finir les apps portées en React ⚡

On reprend les trous listés dans la `todo.md` d'origine.

- **P4-1. Mail** : fils de discussion, autocomplétion des contacts, rédaction en HTML, tags, mise en attente (snooze), boîte unifiée, filtres Sieve, annulation d'une suppression.
- **P4-2. Calendar** : rendez-vous, participants, abonnements, ouverture des anciennes URLs d'événement.
- **P4-3. Tasks** : tâches récurrentes, tri par glisser-déposer, partage.
- **P4-4. Files** : versions, commentaires, tags, demandes de fichiers, modèles, stockage externe.
- **P4-5. Dashboard** : widgets JS et widget météo.
- **P4-6. Dernières pages de réglages** encore en Vue : Disponibilité, Flow, Stockage externe, Passkeys.

### Phase 5 : nouvelles fonctionnalités (le « mail organiser ») ⚡ après P2-1 à P2-4

- **P5-1. Résumé quotidien** : chaque matin, « ce qui demande une réponse ou une action aujourd'hui », dans Atrium et/ou par notification.
- **P5-2. Brouillons de réponse proposés par l'IA**, qui passent par une approbation. Rien ne part sans un clic humain.
- **P5-3. Règles de rangement** en langage naturel (« les factures → dossier Admin ») : l'IA propose la règle, l'humain la valide, et elle s'applique ensuite sans IA.
- **P5-4. Détection d'arnaques** : alerte quand le nom affiché ne correspond pas au domaine de l'adresse, en plus du score `suspicious`.
- **P5-5. Désinscription assistée** des newsletters (lien `List-Unsubscribe`, avec confirmation).
- **P5-6. Assistant intégré** : un panneau de chat dans Atrium qui utilise le provider choisi (P2) **et** les outils MCP (P3), avec les mêmes permissions et approbations qu'un agent externe.
- **P5-7. Mails → tâches et agenda** : « ce mail contient un rendez-vous → créer l'événement ? »

### Phase 6 : installable par tout le monde

- **P6-1. Compose de production générique** : le domaine, le proxy (Caddy fourni par défaut, avec HTTPS automatique) et les ressources passent par `.env`.
- **P6-2. Images publiées** sur un registre (GHCR), en amd64 baseline et arm64, avec des versions taguées.
- **P6-3. Sauvegarde et restauration** en une commande (`make backup`, `make restore`), testées.
- **P6-4. Guide d'installation**, et de migration depuis un Nextcloud existant.

---

## C. Organiser les nuits de travail

1. **Nuit 1** : **une seule instance** fait toute la phase 0. Tant que la stack Docker et `make test` ne marchent pas, les autres travailleraient à l'aveugle.
2. **Nuit 2 et suivantes** : 3 à 5 instances en parallèle, par exemple :
   - instance A : P1 (sécurité, doc, tests) ;
   - instance B : P2-1 → P2-5 (providers IA) ;
   - instance C : P2-6 → P2-8 (connexion des agents, OAuth) ;
   - instance D : P3 (outils agents, une app après l'autre) ;
   - instance E : P4 (finir les apps React).
3. **Le matin**, toi (ou une instance « relecteur ») :
   - lire `reports/` ;
   - lancer `make test` sur chaque branche ;
   - fusionner ce qui est bon dans `main` ;
   - répondre aux questions laissées dans les rapports.
4. **Fusionner souvent** : de petites branches, fusionnées chaque matin, pour éviter les conflits.
5. **Ne rien mettre en ligne automatiquement.** La mise en production reste une action humaine.

---

## D. L'équipe d'agents : une expérience

Ce projet sert aussi de **terrain d'essai** pour faire travailler des agents ensemble. L'instance qui fait P0-8 crée les agents. **Toute instance peut en créer d'autres si elle en a besoin**, à condition de les décrire dans le journal.

### D.1 Comment créer un agent

Un agent = un fichier dans `.claude/agents/<nom>.md`, à la racine du dépôt :

```markdown
---
name: testeur
description: Lance make test dans Docker, écrit les tests manquants et signale les échecs. À utiliser après chaque modification de code.
tools: Read, Grep, Glob, Bash, Edit, Write
model: sonnet
---
Tu es le testeur du projet Atrium. Tu ne modifies jamais le code de production,
seulement les tests. Tu lances `make test` dans Docker et tu rends un rapport court :
ce qui passe, ce qui casse, et pourquoi.
```

- `description` : c'est elle qui décide quand Claude choisit cet agent. Elle doit dire **quand** l'utiliser.
- `tools` : seulement ce dont l'agent a besoin. Un relecteur n'a pas besoin de `Edit` ni de `Write`.
- `model` : Opus pour réfléchir, Sonnet pour le travail courant, Haiku pour les tâches simples et répétitives.
- Le corps du fichier, c'est son rôle et ses règles. Il doit toujours rappeler les règles de la section A.

### D.2 L'équipe de départ

| Agent | Rôle | Outils | Modèle |
| --- | --- | --- | --- |
| `chef` | Lit `TASKS.md`, choisit la prochaine tâche, la confie aux autres, décide si elle est finie, met à jour `TASKS.md` | Read, Grep, Glob, Bash, Edit | opus |
| `dev` | Code une tâche sur sa branche `night/<ID>`, en suivant le code existant | tous | opus |
| `testeur` | Écrit les tests de la tâche, lance `make test` / `make lint` dans Docker, rend un rapport | Read, Grep, Glob, Bash, Edit, Write | sonnet |
| `relecteur` | Relit le diff de la branche : bugs, sécurité, règles de la section A (« ne jamais supprimer un mail », compatibilité des clients). Il ne corrige pas, il signale. | Read, Grep, Glob, Bash | opus |
| `doc` | Met à jour README, ADR et `TASKS.md`, et écrit `reports/<ID>.md` | Read, Grep, Glob, Edit, Write | sonnet |

**Le cycle d'une tâche :**

```
chef → dev → testeur ──échec──→ dev (avec le rapport du testeur)
                │
                └─ OK → relecteur ──problème──→ dev
                              │
                              └─ OK → doc → chef : tâche [x], branche prête à fusionner
```

- Une tâche fait **3 allers-retours au maximum**. Ensuite, le chef la marque « bloquée » et note pourquoi dans le rapport.
- Le chef **ne fusionne pas dans `main`**. Il marque la branche « prête », et la fusion reste humaine (section C).

### D.3 Le travail de nuit : `night.sh`

Un script qui lance **N instances `chef`**, chacune dans **son conteneur Docker** et **son worktree Git** :

```bash
./night.sh 3        # 3 chefs en parallèle, chacun prend une tâche libre dans TASKS.md
```

Pour chaque instance :

1. `git worktree add ../atrium-<ID> -b night/<ID>` ;
2. démarrer un conteneur isolé : sans accès à la prod, sans vraies clés, sans le réseau local, avec une limite de CPU et de RAM ;
3. à l'intérieur, lancer `claude -p "Tu es le chef. Lis CLAUDE.md, TASKS.md et PLAN.md. Prends une tâche libre et mène-la avec l'équipe."` ;
4. arrêter l'instance au bout d'un temps ou d'un budget maximum (par exemple 3 h ou un nombre de tours), et écrire le journal dans `logs/<ID>.log`.

Les permissions élargies (pas de confirmation à chaque commande) sont autorisées **seulement dans ce conteneur**, jamais sur la machine hôte.

### D.4 Le journal de l'expérience : `docs/agents-journal.md`

À chaque tâche, le chef ajoute quelques lignes :

- la tâche, les agents utilisés, le nombre d'allers-retours, la durée ;
- ce qui a bien marché, et ce qui a coincé (agent mal choisi, description trop vague, conflit de fichiers…) ;
- les agents **créés, modifiés ou supprimés**, et pourquoi (par exemple « ajouté `docker-expert` parce que le dev perdait du temps sur le compose ») ;
- une idée d'amélioration pour la nuit suivante.

Le matin, ce journal permet de décider : garder l'équipe, la réduire (moins d'agents = moins de coût), ou spécialiser certains agents (un `mail-dev`, un `react-dev`…).

### D.5 Règles pour créer de nouveaux agents

- Créer un agent seulement s'il fait un **travail qui se répète** et que les autres font mal. Pas d'agent pour une tâche unique.
- **10 agents maximum.** Au-delà, en fusionner.
- Un nouvel agent hérite des règles de la section A et a le moins d'outils possible.
- Le décrire dans le journal (D.4) dès sa création.

---

## E. Ce qu'il me faut de toi avant de lancer

1. **Le droit de reprendre ce code** : l'archive contient la prod, le domaine et les mails de son propriétaire. Si ce n'est pas toi, il faut son accord. La licence AGPL autorise le fork, mais les données personnelles doivent partir (P0-2).
2. **Le serveur** : CPU (x86 ou ARM, AVX ou non), RAM, et le système qui fera tourner les instances Claude.
3. **Où héberger le dépôt** : GitHub, Gitea ou autre, et s'il est public ou privé.
4. **Les clés IA de test** que les instances pourront utiliser, ou bien « mock uniquement » (recommandé pour les nuits sans surveillance).
